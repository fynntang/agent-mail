import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {seedMessages} from '../helpers/mail-fixtures.mjs';

const binary=Buffer.from([0,1,2,127,128,254,255,13,10,0,42]);
const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const mime=()=>[
  'From: Attachment Agent <sender@example.net>','To: research@agent.example.com','Subject: Attachment integration',
  'MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="attachment-integration"','',
  '--attachment-integration','Content-Type: text/plain; charset=utf-8','','Hello, attachments follow.',
  '--attachment-integration','Content-Type: application/octet-stream',
  "Content-Disposition: attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.bin",'Content-Transfer-Encoding: base64','',binary.toString('base64'),
  '--attachment-integration','Content-Type: image/svg+xml','Content-Disposition: inline; filename="../../danger.svg"',
  'Content-ID: <inline-danger>','Content-Transfer-Encoding: base64','',svg.toString('base64'),
  '--attachment-integration','Content-Type: text/plain','Content-Disposition: attachment; filename="empty.txt"',
  'Content-Transfer-Encoding: base64','','','--attachment-integration--',''
].join('\r\n');

async function mailbox(runtime,localPart='research') {
  const response=await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:localPart,localPart}});
  assert.equal(response.status,201,await response.clone().text());return (await response.json()).mailbox;
}
async function issue(runtime,box,scopes=['mail:read','attachments:read']) {
  const response=await runtime.request(`/owner/api/mailboxes/${box.id}/tokens`,{method:'POST',body:{name:'Attachment Agent',scopes}});
  assert.equal(response.status,201,await response.clone().text());return response.json();
}
async function inbound(runtime,box,body=mime()) {
  body=`Message-ID: <${randomUUID()}@agentmail.test>\r\n${body}`;
  const response=await runtime.mf.dispatchFetch(`http://localhost/cdn-cgi/local/email?from=sender%40example.net&to=${encodeURIComponent(box.address)}&format=json`,{
    method:'POST',headers:{'Content-Type':'message/rfc822'},body
  });
  assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).outcome,'ok');
  assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');
  return runtime.db.prepare('SELECT * FROM messages WHERE mailbox_id=? ORDER BY received_at DESC LIMIT 1').bind(box.id).first();
}
const apiUrl=(message,id)=>`https://api.example.com/v1/messages/${message.id}/attachments${id?`/${id}/download`:''}`;
const ownerUrl=(box,message,id)=>`/owner/api/mailboxes/${box.id}/messages/${message.id}/attachments${id?`/${id}/download`:''}`;
const bearer=secret=>({Authorization:`Bearer ${secret}`});

test('native MIME attachments persist once and download as verified private binary without executing active types',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),message=await inbound(runtime,box),token=await issue(runtime,box);
  const list=await runtime.mf.dispatchFetch(apiUrl(message),{headers:bearer(token.secret)});
  assert.equal(list.status,200);assert.match(list.headers.get('cache-control'),/no-store/);
  const data=await list.json();assert.equal(data.status,'ready');assert.equal(data.canDownload,true);assert.equal(data.attachments.length,3);
  const file=data.attachments.find(part=>part.filename==='报告.bin');assert.ok(file);assert.equal(file.sizeBytes,binary.length);
  assert.equal(file.scanStatus,'unscanned');assert.equal(file.downloadable,true);
  const inline=data.attachments.find(part=>part.disposition==='inline');assert.equal(inline.filename,'danger.svg');assert.equal(inline.contentType,'image/svg+xml');
  const empty=data.attachments.find(part=>part.filename==='empty.txt');assert.equal(empty.sizeBytes,0);
  const serialized=JSON.stringify(data);for(const hidden of ['object_key','object_id','sha256','/attachment/v1/'])assert.equal(serialized.includes(hidden),false);
  const audits=await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n');
  for(const [part,bytes] of [[file,binary],[inline,svg],[empty,Buffer.alloc(0)]]) {
    const response=await runtime.mf.dispatchFetch(apiUrl(message,part.id),{headers:bearer(token.secret)});
    assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('content-type'),'application/octet-stream');
    assert.match(response.headers.get('content-disposition'),/^attachment; filename="/);
    assert.match(response.headers.get('content-disposition'),/filename\*=UTF-8''/);
    assert.equal(response.headers.get('content-length'),String(bytes.length));assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.match(response.headers.get('content-security-policy'),/sandbox/);assert.match(response.headers.get('cache-control'),/no-store/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  }
  const ownerDownload=await runtime.request(ownerUrl(box,message,file.id));assert.equal(ownerDownload.status,200);
  assert.deepEqual(Buffer.from(await ownerDownload.arrayBuffer()),binary);
  const head=await runtime.mf.dispatchFetch(apiUrl(message,file.id),{method:'HEAD',headers:bearer(token.secret)});
  assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('content-length'),String(binary.length));
  assert.equal(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read'),0);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n'),audits);
  await runtime.db.prepare("UPDATE jobs SET state='pending',available_at=0 WHERE id=?").bind(message.ingest_receipt_id).run();
  await (await runtime.mf.getWorker()).scheduled();
  const again=await (await runtime.request(ownerUrl(box,message))).json();
  assert.deepEqual(again.attachments.map(part=>part.id),data.attachments.map(part=>part.id));
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM attachments WHERE message_id=?').bind(message.id).first('n'),3);
});

test('attachment metadata and content obey separate scopes, exact message/mailbox ownership and current credentials',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const a=await mailbox(runtime),b=await mailbox(runtime,'other'),own=await inbound(runtime,a),other=await inbound(runtime,b);
  const reader=await issue(runtime,a,['mail:read']),full=await issue(runtime,a),outsider=await issue(runtime,b);
  const metadata=await (await runtime.mf.dispatchFetch(apiUrl(own),{headers:bearer(reader.secret)})).json();
  assert.equal(metadata.canDownload,false);assert.ok(metadata.attachments.every(part=>!part.downloadable));
  const file=metadata.attachments[0],path=apiUrl(own,file.id);
  assert.equal((await runtime.mf.dispatchFetch(path,{headers:bearer(reader.secret)})).status,403);
  assert.equal((await runtime.mf.dispatchFetch(path)).status,401);
  assert.equal((await runtime.mf.dispatchFetch(path,{headers:bearer(outsider.secret)})).status,404);
  assert.equal((await runtime.mf.dispatchFetch(apiUrl(other,file.id),{headers:bearer(full.secret)})).status,404);
  const [sameBoxOther]=await seedMessages(runtime,a.id);
  await runtime.db.prepare("UPDATE messages SET attachments_state='ready' WHERE id=?").bind(sameBoxOther.id).run();
  assert.equal((await runtime.mf.dispatchFetch(apiUrl(sameBoxOther,file.id),{headers:bearer(full.secret)})).status,404);
  assert.equal((await runtime.mf.dispatchFetch(apiUrl(own,randomUUID()),{headers:bearer(full.secret)})).status,404);
  assert.equal((await runtime.request(ownerUrl(a,own,file.id),{authenticated:false})).status,401);
  assert.equal((await runtime.request(ownerUrl(b,own,file.id))).status,404);
  assert.equal((await runtime.request(ownerUrl(a,own,file.id),{headers:{Origin:'https://evil.example'}})).status,403);
  const invalid=await runtime.request(`/owner/api/mailboxes/${a.id}/tokens`,{method:'POST',body:{name:'No read',scopes:['attachments:read']}});
  assert.equal(invalid.status,400);
  await runtime.request(`/owner/api/mailboxes/${a.id}/tokens/${full.token.id}`,{method:'DELETE'});
  assert.equal((await runtime.mf.dispatchFetch(path,{headers:bearer(full.secret)})).status,401);
  const replacement=await issue(runtime,a);
  const paused=await runtime.request(`/owner/api/mailboxes/${a.id}`,{method:'PATCH',body:{status:'paused',expectedUpdatedAt:a.updatedAt}});
  assert.equal(paused.status,200);
  assert.equal((await runtime.mf.dispatchFetch(path,{headers:bearer(replacement.secret)})).status,401);
  assert.equal((await runtime.request(ownerUrl(a,own,file.id))).status,200,'Owner can inspect paused mailboxes');
});

test('blocked, failed, missing, corrupt and wrongly attributed objects fail closed before releasing attachment bytes',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),message=await inbound(runtime,box),token=await issue(runtime,box);
  const data=await (await runtime.request(ownerUrl(box,message))).json(),file=data.attachments[0],url=apiUrl(message,file.id);
  for(const status of ['blocked','failed']) {
    await runtime.db.prepare('UPDATE attachments SET scan_status=? WHERE id=?').bind(status,file.id).run();
    const blocked=await runtime.mf.dispatchFetch(url,{headers:bearer(token.secret)});assert.equal(blocked.status,403);
    assert.equal((await blocked.json()).error.code,'attachment_blocked');
    assert.equal((await runtime.request(ownerUrl(box,message,file.id))).status,403);
    assert.equal((await (await runtime.request(ownerUrl(box,message))).json()).attachments.find(part=>part.id===file.id).downloadable,false);
  }
  await runtime.db.prepare("UPDATE attachments SET scan_status='unscanned' WHERE id=?").bind(file.id).run();
  const object=await runtime.db.prepare('SELECT o.* FROM objects o JOIN attachments a ON a.object_id=o.id AND a.mailbox_id=o.mailbox_id WHERE a.id=?').bind(file.id).first();
  const saved=Buffer.from(await (await runtime.bucket.get(object.object_key)).arrayBuffer());
  for(const failure of ['corrupt','missing']) {
    if(failure==='corrupt')await runtime.bucket.put(object.object_key,'CORRUPTED_PRIVATE_BYTES');else await runtime.bucket.delete(object.object_key);
    const response=await runtime.mf.dispatchFetch(url,{headers:bearer(token.secret)});assert.equal(response.status,503);
    const text=await response.text();assert.ok(text.includes('attachment_unavailable'));assert.equal(text.includes(object.object_key),false);assert.equal(text.includes('CORRUPTED_PRIVATE_BYTES'),false);
  }
  await runtime.bucket.put(object.object_key,saved);
  await runtime.db.prepare('UPDATE attachments SET object_id=? WHERE id=?').bind(message.raw_object_id,file.id).run();
  assert.equal((await runtime.mf.dispatchFetch(url,{headers:bearer(token.secret)})).status,503);
  await runtime.db.prepare('UPDATE attachments SET object_id=? WHERE id=?').bind(object.id,file.id).run();
  assert.equal((await runtime.mf.dispatchFetch(url,{headers:bearer(token.secret)})).status,200);
  await runtime.db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').bind(Date.now(),message.id).run();
  assert.equal((await runtime.mf.dispatchFetch(url,{headers:bearer(token.secret)})).status,404);
});

test('old unextracted messages are distinct from freshly parsed empty attachment lists and do not trigger GET backfills',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),[legacy]=await seedMessages(runtime,box.id);
  const before=await runtime.db.prepare('SELECT count(*) n FROM jobs').first('n'),objects=(await runtime.bucket.list()).objects.length;
  let result=await (await runtime.request(ownerUrl(box,legacy))).json();assert.equal(result.status,'not_extracted');assert.deepEqual(result.attachments,[]);
  for(const state of ['pending','failed']) {
    await runtime.db.prepare('UPDATE messages SET parse_state=? WHERE id=?').bind(state,legacy.id).run();
    result=await (await runtime.request(ownerUrl(box,legacy))).json();assert.equal(result.status,state);
  }
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM jobs').first('n'),before);assert.equal((await runtime.bucket.list()).objects.length,objects);
  const fresh=await inbound(runtime,box,'From: sender@example.net\r\nSubject: No attachments\r\n\r\nPlain text');
  result=await (await runtime.request(ownerUrl(box,fresh))).json();assert.equal(result.status,'ready');assert.deepEqual(result.attachments,[]);
  const orderedParts=Array.from({length:11},(_,index)=>['--ordered-parts','Content-Type: application/octet-stream',
    `Content-Disposition: attachment; filename="file-${index+1}.bin"`,'Content-Transfer-Encoding: base64','','AQ=='].join('\r\n'));
  const ordered=await inbound(runtime,box,['From: sender@example.net','Subject: Ordered parts','MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="ordered-parts"','',...orderedParts,'--ordered-parts--'].join('\r\n'));
  result=await (await runtime.request(ownerUrl(box,ordered))).json();
  assert.deepEqual(result.attachments.map(part=>part.filename),Array.from({length:11},(_,index)=>`file-${index+1}.bin`));
});
