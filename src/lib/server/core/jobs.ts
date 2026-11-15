import PostalMime from 'postal-mime';
import { sha256, stableId } from './crypto';
import { reconcileReceipts, type Receipt } from './ingest';
import { readBounded } from './storage';
import { ServiceError, type RuntimeEnv } from './types';
import {prepareAttachments,storeAttachments} from './attachment-ingest';
import {mailHtmlPlainText} from './mail-html';

export interface ParseJob {
  id: string; mailbox_id: string; payload_json: string; lease_token: string;
  attempts: number; max_attempts: number;
}

export async function claimParseJob(env: RuntimeEnv, now: number): Promise<ParseJob | null> {
  const lease = crypto.randomUUID();
  // A single UPDATE + RETURNING is the claim. A SELECT followed by an unconditional UPDATE is unsafe.
  return env.DB.prepare(`UPDATE jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1
    WHERE id=(SELECT j.id FROM jobs j JOIN mailboxes m ON m.id=j.mailbox_id
      WHERE j.kind='parse_email' AND j.state='pending' AND j.available_at<=? AND j.attempts<j.max_attempts
      AND m.status='active' ORDER BY j.available_at,j.id LIMIT 1) AND state='pending' RETURNING *`)
    .bind(lease,now+60_000,now).first<ParseJob>();
}

/** Every D1 publication statement uses the same lease predicate inside one atomic batch. */
export async function parseEmail(env: RuntimeEnv, job: ParseJob): Promise<boolean> {
  const payload: unknown = JSON.parse(job.payload_json);
  if (!payload || typeof payload !== 'object' || !('receiptId' in payload) || typeof payload.receiptId !== 'string') {
    throw new ServiceError('invalid_job_payload');
  }
  const receipt = await env.DB.prepare(`SELECT r.*,o.object_key,o.sha256,o.size_bytes FROM ingest_receipts r
    JOIN objects o ON o.id=r.raw_object_id AND o.mailbox_id=r.mailbox_id
    WHERE r.id=? AND r.mailbox_id=? AND o.state='ready' AND r.status IN('stored','indexed')`)
    .bind(payload.receiptId,job.mailbox_id).first<Receipt & {sha256: string; size_bytes: number}>();
  if (!receipt) throw new ServiceError('receipt_not_ready');
  const raw = await env.MAIL_BLOBS.get(receipt.object_key);
  if (!raw) throw new ServiceError('raw_object_missing');
  const bytes = await readBounded(raw.body,10*1024*1024);
  if (await sha256(bytes) !== receipt.sha256) throw new ServiceError('raw_object_checksum_mismatch');
  const parsed = await PostalMime.parse(bytes,{attachmentEncoding:'arraybuffer',forceRfc822Attachments:true,
    maxNestingDepth:32,maxHeadersSize:1024*1024,maxPartCount:200,maxRfc822NestingDepth:0,maxForwardedAddresses:100});
  const attachments=await prepareAttachments(parsed.attachments,receipt.mailbox_id,receipt.id);
  // Derived formats are versioned, so a retry never overwrites a prior parser's immutable body.
  const html=parsed.html??null,htmlTooLarge=html!==null&&new TextEncoder().encode(html).byteLength>512*1024;
  let text=parsed.text??null,htmlFailure:string|undefined=htmlTooLarge?'too_large':undefined;
  if(text===null&&html!==null&&!htmlTooLarge){
    try{text=mailHtmlPlainText(html);}
    catch{htmlFailure='unavailable';}
  }
  // Original markup remains private data. Only the Owner HTML service may clean and render it.
  const body = JSON.stringify({text,html:htmlTooLarge?null:html,htmlExtracted:true,attachmentsExtracted:true,
    ...(htmlFailure?{htmlStatus:htmlFailure}:{})});
  const bodyHash = await sha256(body);
  const bodyId = await stableId(`body:v3:${receipt.mailbox_id}:${receipt.id}`);
  const bodyKey = `${receipt.mailbox_id}/body/v3/${receipt.id}.json`;
  const stored = await env.MAIL_BLOBS.put(bodyKey,body,{
    onlyIf: {etagDoesNotMatch:'*'}, httpMetadata:{contentType:'application/json'},
    customMetadata:{sha256:bodyHash,receiptId:receipt.id,mailboxId:receipt.mailbox_id,purpose:'body',format:'v3'}
  });
  if (!stored) {
    const existing = await env.MAIL_BLOBS.get(bodyKey);
    if (!existing || existing.customMetadata?.receiptId !== receipt.id || existing.customMetadata?.mailboxId !== receipt.mailbox_id
      || existing.customMetadata?.purpose !== 'body' || existing.customMetadata?.format !== 'v3'
      || existing.customMetadata?.sha256 !== bodyHash || await sha256(await readBounded(existing.body,16*1024*1024)) !== bodyHash) {
      if (existing && !existing.bodyUsed) await existing.body.cancel();
      throw new ServiceError('body_object_conflict');
    }
  }
  await storeAttachments(env,receipt.mailbox_id,receipt.id,attachments);
  const now = Date.now();
  const guard = `EXISTS(SELECT 1 FROM jobs j JOIN mailboxes m ON m.id=j.mailbox_id WHERE j.id=? AND j.mailbox_id=? AND j.state='running' AND j.lease_token=? AND j.lease_until>? AND m.status='active')`;
  const args = [job.id,job.mailbox_id,job.lease_token,now];
  const subject = parsed.subject?.slice(0,2048) ?? null;
  const statements = [
    env.DB.prepare(`INSERT INTO objects(id,mailbox_id,object_key,purpose,state,size_bytes,sha256,content_type,created_at,ready_at)
      SELECT ?,?,?,'body','ready',?,?,'application/json',?,? WHERE ${guard} ON CONFLICT(id) DO NOTHING`)
      .bind(bodyId,job.mailbox_id,bodyKey,new TextEncoder().encode(body).byteLength,bodyHash,now,now,...args),
    env.DB.prepare(`INSERT INTO threads(id,mailbox_id,subject,last_message_at,created_at)
      SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT(id) DO NOTHING`)
      .bind(receipt.id,job.mailbox_id,subject,receipt.received_at,receipt.received_at,...args),
    env.DB.prepare(`INSERT INTO messages(id,mailbox_id,thread_id,ingest_receipt_id,raw_object_id,body_object_id,
      rfc_message_id,in_reply_to,subject,preview,direction,parse_state,attachments_state,size_bytes,received_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,'inbound','ready','ready',?,? WHERE ${guard} ON CONFLICT(mailbox_id,ingest_receipt_id) DO NOTHING`)
      .bind(receipt.id,job.mailbox_id,receipt.id,receipt.id,receipt.raw_object_id,bodyId,
        parsed.messageId?.slice(0,998)??null,parsed.inReplyTo?.slice(0,998)??null,subject,
        (text??'').replace(/\s+/g,' ').slice(0,512),receipt.size_bytes,receipt.received_at,...args)
  ];
  for(const attachment of attachments){
    statements.push(
      env.DB.prepare(`INSERT INTO objects(id,mailbox_id,object_key,purpose,state,size_bytes,sha256,content_type,created_at,ready_at)
        SELECT ?,?,?,'attachment','ready',?,?,?,?,? WHERE ${guard} ON CONFLICT(id) DO NOTHING`)
        .bind(attachment.objectId,job.mailbox_id,attachment.key,attachment.bytes.byteLength,attachment.sha256,attachment.contentType,now,now,...args),
      env.DB.prepare(`INSERT INTO attachments(id,mailbox_id,message_id,object_id,part_id,filename,disposition,content_id,scan_status)
        SELECT ?,?,?,?,?,?,?,?,'unscanned' WHERE ${guard} ON CONFLICT(message_id,part_id) DO NOTHING`)
        .bind(attachment.id,job.mailbox_id,receipt.id,attachment.objectId,attachment.partId,attachment.filename,attachment.disposition,attachment.contentId,...args)
    );
  }
  statements.push(env.DB.prepare(`UPDATE messages SET attachments_state='ready' WHERE id=? AND mailbox_id=? AND ${guard}`)
    .bind(receipt.id,job.mailbox_id,...args));
  const addresses: {kind:string; address:string; name?:string; ordinal:number}[] = [];
  if (parsed.from?.address) addresses.push({kind:'from',address:parsed.from.address,name:parsed.from.name,ordinal:0});
  // Flatten address groups while preserving their order. Parsed headers are data, never authorization inputs.
  type Address = { address?: string; name?: string; group?: Address[] };
  const flatten = (list: Address[]): Address[] => list.flatMap(a => a.group ? flatten(a.group) : [a]);
  for (const [kind,list] of [['to',parsed.to],['cc',parsed.cc],['bcc',parsed.bcc],['reply_to',parsed.replyTo]] as const) {
    flatten(list??[]).filter(a=>a.address).forEach((a,i)=>addresses.push({kind,address:a.address!,name:a.name,ordinal:i}));
  }
  addresses.push({kind:'envelope_to',address:receipt.envelope_to,ordinal:0});
  // Bound metadata work even for messages with pathological recipient headers.
  if (addresses.length > 100) throw new ServiceError('too_many_header_addresses');
  for (const address of addresses) {
    statements.push(env.DB.prepare(`INSERT INTO message_addresses(id,mailbox_id,message_id,kind,ordinal,address,display_name)
      SELECT ?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(message_id,kind,ordinal) DO NOTHING`)
      .bind(await stableId(`${receipt.id}:${address.kind}:${address.ordinal}`),job.mailbox_id,receipt.id,
        address.kind,address.ordinal,address.address.slice(0,254),address.name?.slice(0,512)??null,...args));
  }
  statements.push(
    env.DB.prepare(`UPDATE ingest_receipts SET status='indexed',error_code=NULL WHERE id=? AND mailbox_id=? AND ${guard}`)
      .bind(receipt.id,job.mailbox_id,...args),
    env.DB.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at)
      SELECT ?,?,'app',?,'message.received',?,?,? WHERE ${guard} ON CONFLICT(mailbox_id,source,source_event_id) DO NOTHING`)
      .bind(receipt.id,job.mailbox_id,receipt.id,JSON.stringify({messageId:receipt.id}),receipt.received_at,now,...args),
    env.DB.prepare(`UPDATE jobs SET state='done',lease_token=NULL,lease_until=NULL,last_error_code=NULL
      WHERE id=? AND mailbox_id=? AND state='running' AND lease_token=? AND lease_until>?
      AND EXISTS(SELECT 1 FROM mailboxes WHERE id=jobs.mailbox_id AND status='active')`).bind(...args)
  );
  const results = await env.DB.batch(statements);
  return results.at(-1)!.meta.changes === 1;
}

export async function runScheduled(env: RuntimeEnv, now = Date.now()): Promise<{recovered:number; completed:number; failed:number}> {
  const recovered = await reconcileReceipts(env,now);
  // Only parse jobs are reclaimable in this release. Outbound jobs must never be retried here.
  await env.DB.prepare(`UPDATE jobs SET state=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'pending' END,
    available_at=?,lease_token=NULL,lease_until=NULL,last_error_code='lease_expired'
    WHERE kind='parse_email' AND state='running' AND lease_until<=?`).bind(now,now).run();
  let completed=0, failed=0;
  for (let i=0;i<5;i++) {
    const job = await claimParseJob(env,Date.now());
    if (!job) break;
    try { if (await parseEmail(env,job)) completed++; }
    catch (error) {
      failed++;
      const code = error instanceof ServiceError ? error.code : 'parse_failed';
      const failedAt = Date.now();
      await env.DB.prepare(`UPDATE jobs SET state=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'pending' END,
        available_at=?,lease_token=NULL,lease_until=NULL,last_error_code=?
        WHERE id=? AND mailbox_id=? AND state='running' AND lease_token=? AND lease_until>?`)
        .bind(failedAt+Math.min(3_600_000,1000*2**Math.min(job.attempts,12)),code,job.id,job.mailbox_id,job.lease_token,failedAt).run();
    }
  }
  return {recovered,completed,failed};
}
