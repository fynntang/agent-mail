import {randomUUID,createHash} from 'node:crypto';

/**
 * Indexed-mail fixtures with real D1 relations, private R2 bytes, and their actual checksums.
 * @param {{db:any,bucket:any}} runtime Node-side Miniflare binding proxies.
 * @param {string} mailboxId
 * @param {{count?:number,prefix?:string,sameTime?:boolean,receivedAt?:number,text?:string|null}} options
 */
export async function seedMessages(runtime,mailboxId,{count=1,prefix='构建报告',sameTime=false,receivedAt=Date.now(),text}={}) {
  const messages=[];
  for(let index=0;index<count;index++) {
    const id=randomUUID(),rawId=randomUUID(),bodyId=randomUUID();
    const subject=`${prefix} ${String(index+1).padStart(3,'0')}`;
    const bodyText=text===undefined?`你好，\n\n${subject}已经准备好。\n构建与检查均已完成，可以继续下一步。\n\nBuild Agent`:text;
    const raw=`From: Build Agent <build@example.net>\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText??''}`;
    const body=JSON.stringify({text:bodyText,htmlExtracted:false,attachmentsExtracted:false});
    const rawKey=`${mailboxId}/raw/${id}.eml`,bodyKey=`${mailboxId}/body/v1/${id}.json`;
    const hash=value=>createHash('sha256').update(value).digest('hex');
    const at=sameTime?receivedAt:receivedAt-index*60_000;
    await runtime.bucket.put(rawKey,raw);
    await runtime.bucket.put(bodyKey,body,{httpMetadata:{contentType:'application/json'}});
    await runtime.db.batch([
      runtime.db.prepare(`INSERT INTO objects(id,mailbox_id,object_key,purpose,state,size_bytes,sha256,content_type,created_at,ready_at)
        VALUES(?,?,?,'raw_email','ready',?,?,'message/rfc822',?,?)`).bind(rawId,mailboxId,rawKey,Buffer.byteLength(raw),hash(raw),at,at),
      runtime.db.prepare(`INSERT INTO objects(id,mailbox_id,object_key,purpose,state,size_bytes,sha256,content_type,created_at,ready_at)
        VALUES(?,?,?,'body','ready',?,?,'application/json',?,?)`).bind(bodyId,mailboxId,bodyKey,Buffer.byteLength(body),hash(body),at,at),
      runtime.db.prepare(`INSERT INTO messages(id,mailbox_id,raw_object_id,body_object_id,subject,preview,direction,parse_state,size_bytes,received_at)
        VALUES(?,?,?,?,?,?,'inbound','ready',?,?)`).bind(id,mailboxId,rawId,bodyId,subject,(bodyText??'').slice(0,200),Buffer.byteLength(raw),at),
      runtime.db.prepare(`INSERT INTO message_addresses(id,mailbox_id,message_id,kind,ordinal,address,display_name)
        VALUES(?,?,?,'from',0,'build@example.net','Build Agent')`).bind(randomUUID(),mailboxId,id),
      runtime.db.prepare(`INSERT INTO message_addresses(id,mailbox_id,message_id,kind,ordinal,address,display_name)
        SELECT ?,?,?,'to',0,address,NULL FROM mailbox_addresses WHERE mailbox_id=? AND is_primary=1`)
        .bind(randomUUID(),mailboxId,id,mailboxId)
    ]);
    messages.push({id,subject,text:bodyText,receivedAt:at,rawId,bodyId,rawKey,bodyKey});
  }
  return messages;
}
