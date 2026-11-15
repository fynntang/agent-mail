import {createHash,randomUUID} from 'node:crypto';

/** Authorized-reader fixture; native MIME parsing is covered separately by ingest tests. */
export async function seedAttachment(runtime,mailboxId,messageId,{bytes=new Uint8Array([0,255,128,1,2,3]),filename='测试附件.bin',
  contentType='application/octet-stream',disposition='attachment',scanStatus='unscanned'}={}) {
  const id=randomUUID(),objectId=randomUUID(),key=`${mailboxId}/attachment/fixture/${id}.bin`;
  await runtime.bucket.put(key,bytes);
  const hash=createHash('sha256').update(bytes).digest('hex'),now=Date.now();
  await runtime.db.batch([
    runtime.db.prepare(`INSERT INTO objects(id,mailbox_id,object_key,purpose,state,size_bytes,sha256,content_type,created_at,ready_at)
      VALUES(?,?,?,'attachment','ready',?,?,?,?,?)`).bind(objectId,mailboxId,key,bytes.byteLength,hash,contentType,now,now),
    runtime.db.prepare(`INSERT INTO attachments(id,mailbox_id,message_id,object_id,part_id,filename,disposition,scan_status)
      VALUES(?,?,?,?,?,?,?,?)`).bind(id,mailboxId,messageId,objectId,`fixture-${id}`,filename,disposition,scanStatus),
    runtime.db.prepare("UPDATE messages SET attachments_state='ready' WHERE mailbox_id=? AND id=?").bind(mailboxId,messageId)
  ]);
  return {id,objectId,key,bytes,filename,hash};
}
