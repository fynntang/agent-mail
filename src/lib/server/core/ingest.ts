import { sha256 } from './crypto';
import { normalizeRecipient, readBounded } from './storage';
import { ServiceError, type RuntimeEnv } from './types';

export interface Receipt {
  id: string; mailbox_id: string; raw_object_id: string; object_key: string;
  envelope_from: string; envelope_to: string; received_at: number;
}

/** All acknowledgement-critical persistence is awaited in the native email event. */
export async function ingestEmail(message: ForwardableEmailMessage, env: RuntimeEnv): Promise<string | null> {
  const recipient = normalizeRecipient(message.to, env.MAIL_DOMAIN);
  const mailbox = recipient ? await env.DB.prepare(`SELECT m.id, m.max_message_bytes FROM mailbox_addresses a
    JOIN mailboxes m ON m.id=a.mailbox_id WHERE a.address=? AND a.status='active' AND m.status='active'`)
    .bind(recipient).first<{id: string; max_message_bytes: number}>() : null;
  if (!mailbox) { message.setReject('Unknown or inactive mailbox'); return null; }
  // Also cap a misconfigured mailbox limit to protect Worker memory while parsing MIME.
  const limit = Math.min(mailbox.max_message_bytes, 10 * 1024 * 1024);
  if (message.rawSize > limit) { message.setReject('Message exceeds mailbox size limit'); return null; }
  let data: Uint8Array;
  try { data = await readBounded(message.raw, limit); }
  catch (error) {
    if (error instanceof ServiceError && error.code === 'message_too_large') {
      message.setReject('Message exceeds mailbox size limit'); return null;
    }
    throw error;
  }
  const now = Date.now();
  const receipt: Receipt = {
    id: crypto.randomUUID(), mailbox_id: mailbox.id, raw_object_id: crypto.randomUUID(),
    object_key: '', envelope_from: message.from, envelope_to: recipient!, received_at: now
  };
  receipt.object_key = `${mailbox.id}/raw/${receipt.id}.eml`;
  const created=await env.DB.batch([
    env.DB.prepare(`INSERT INTO objects(id,mailbox_id,object_key,purpose,content_type,created_at)
      SELECT ?,?,?,'raw_email','message/rfc822',? WHERE EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status='active')`)
      .bind(receipt.raw_object_id,mailbox.id,receipt.object_key,now,mailbox.id),
    env.DB.prepare(`INSERT INTO ingest_receipts(id,mailbox_id,raw_object_id,envelope_from,envelope_to,received_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM objects WHERE id=? AND mailbox_id=?)`)
      .bind(receipt.id,mailbox.id,receipt.raw_object_id,message.from,recipient,now,receipt.raw_object_id,mailbox.id)
  ]);
  if(created[0].meta.changes!==1) {message.setReject('Unknown or inactive mailbox');return null;}
  const digest = await sha256(data);
  const stored = await env.MAIL_BLOBS.put(receipt.object_key, data, {
    onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'message/rfc822' },
    customMetadata: { mailboxId: mailbox.id, receiptId: receipt.id, objectId: receipt.raw_object_id, sha256: digest }
  });
  if (!stored) throw new ServiceError('raw_object_conflict');
  await finalizeReceipt(env, receipt, data.byteLength, digest, now);
  return receipt.id;
}

/** Idempotent finalization also covers R2 success followed by D1 failure. Never downgrade indexed receipts. */
export async function finalizeReceipt(env: RuntimeEnv, receipt: Receipt, size: number, digest: string, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE objects SET state='ready',size_bytes=?,sha256=?,ready_at=COALESCE(ready_at,?)
      WHERE mailbox_id=? AND id=? AND state IN('pending','ready')`).bind(size,digest,now,receipt.mailbox_id,receipt.raw_object_id),
    env.DB.prepare(`UPDATE ingest_receipts SET status='stored',error_code=NULL WHERE mailbox_id=? AND id=? AND status='pending_blob'`)
      .bind(receipt.mailbox_id,receipt.id),
    env.DB.prepare(`INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,payload_json,available_at,created_at)
      SELECT ?,?,'parse_email',?,?,?,? WHERE EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status IN('active','paused'))
      ON CONFLICT(mailbox_id,kind,dedupe_key) DO NOTHING`)
      .bind(receipt.id,receipt.mailbox_id,receipt.id,JSON.stringify({receiptId:receipt.id}),now,now,receipt.mailbox_id)
  ]);
}

export async function reconcileReceipts(env: RuntimeEnv, now: number): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT r.*,o.object_key FROM ingest_receipts r JOIN objects o
    ON o.id=r.raw_object_id AND o.mailbox_id=r.mailbox_id
    WHERE r.status='pending_blob' AND r.received_at<? ORDER BY r.received_at,r.id LIMIT 10`).bind(now-30_000).all<Receipt>();
  let recovered = 0;
  for (const receipt of results) {
    const object = await env.MAIL_BLOBS.get(receipt.object_key);
    if (!object) {
      if (receipt.received_at < now-86_400_000) {
        await env.DB.batch([
          env.DB.prepare(`UPDATE ingest_receipts SET status='failed',error_code='raw_object_missing'
            WHERE id=? AND mailbox_id=? AND status='pending_blob'`).bind(receipt.id,receipt.mailbox_id),
          env.DB.prepare(`UPDATE objects SET state='failed' WHERE id=? AND mailbox_id=? AND state='pending'`)
            .bind(receipt.raw_object_id,receipt.mailbox_id)
        ]);
      }
      continue;
    }
    if (object.size > 10*1024*1024 || object.customMetadata?.receiptId !== receipt.id
      || object.customMetadata?.mailboxId !== receipt.mailbox_id || object.customMetadata?.objectId !== receipt.raw_object_id) {
      await object.body.cancel(); throw new ServiceError('raw_object_metadata_mismatch');
    }
    const bytes = await readBounded(object.body,10*1024*1024);
    const digest = await sha256(bytes);
    if (digest !== object.customMetadata.sha256) throw new ServiceError('raw_object_checksum_mismatch');
    await finalizeReceipt(env,receipt,bytes.byteLength,digest,now);
    recovered++;
  }
  return recovered;
}
