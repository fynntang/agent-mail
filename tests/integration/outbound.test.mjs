import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {seedMessages} from '../helpers/mail-fixtures.mjs';

test('Access Owner + mailbox Token → draft/reply/approval → native scheduled EMAIL → Sent',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const {request,db,mf}=runtime;
  const json=async(path,options={},status=200)=>{const r=await request(path,options);assert.equal(r.status,status,await r.clone().text());return r.json();};
  const box=(await json('/owner/api/mailboxes',{method:'POST',body:{name:'Send agent',localPart:'sending'}},201)).mailbox;
  const base=`/owner/api/mailboxes/${box.id}`;
  const read=(await json(`${base}/tokens`,{method:'POST',body:{name:'read only',scopes:['mail:read']}},201));
  const token=(await json(`${base}/tokens`,{method:'POST',body:{name:'approve sender',scopes:['mail:read','mail:draft','mail:send']}},201));
  const agent=async(path,secret,options={})=>mf.dispatchFetch(`https://api.example.com${path}`,{method:options.method??'GET',
    headers:{Authorization:`Bearer ${secret}`,...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},
    body:options.body?JSON.stringify(options.body):undefined});
  assert.equal((await agent('/v1/drafts',read.secret)).status,403);
  assert.equal(token.token.requiresApproval,true);
  const [source]=await seedMessages(runtime,box.id,{text:'Original mail'});
  const reply=await agent('/v1/drafts',token.secret,{method:'POST',body:{replyMessageId:source.id,text:'Agent response'}});
  assert.equal(reply.status,201,await reply.clone().text());
  let draft=(await reply.json()).draft;
  assert.equal(draft.content.replyMessageId,source.id);assert.match(draft.content.subject,/^Re:/);
  assert.equal(draft.content.to.length,1);
  const sendBody={expectedVersion:draft.version},sendHeaders={'Idempotency-Key':'first-intent'};
  const pending=await agent(`/v1/drafts/${draft.id}/send`,token.secret,{method:'POST',body:sendBody,headers:sendHeaders});
  assert.equal(pending.status,202,await pending.clone().text());assert.equal((await pending.json()).status,'approval_required');
  assert.equal(await db.prepare('SELECT count(*) FROM outbound_messages').first('count(*)'),0);
  assert.equal((await agent(`/v1/drafts/${draft.id}/approve`,token.secret,{method:'POST',body:{}})).status,404);
  draft=(await json(`${base}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:draft.version,contentSha256:draft.contentSha256}})).draft;
  const queued=await json(`${base}/drafts/${draft.id}/send`,{method:'POST',body:{expectedVersion:draft.version},headers:{'Idempotency-Key':'owner-approved-intent'}},202);
  assert.equal(queued.status,'queued');
  const repeat=await json(`${base}/drafts/${draft.id}/send`,{method:'POST',body:{expectedVersion:draft.version},headers:{'Idempotency-Key':'owner-approved-intent'}},202);
  assert.equal(repeat.outboundId,queued.outboundId);
  assert.equal(await db.prepare('SELECT count(*) FROM send_reservations').first('count(*)'),1);
  const worker=await mf.getWorker();assert.equal((await worker.scheduled()).outcome,'ok');
  const record=await db.prepare('SELECT * FROM outbound_messages WHERE id=?').bind(queued.outboundId).first();
  assert.equal(record.status,'accepted',JSON.stringify(record));assert.ok(record.provider_message_id);
  assert.equal(await db.prepare('SELECT state FROM send_reservations').first('state'),'committed');
  const sent=await json(`${base}/messages?folder=sent`);
  assert.equal(sent.messages.length,1);assert.equal(sent.messages[0].id,queued.outboundId);
  const detail=await json(`${base}/messages/${queued.outboundId}`);
  assert.equal(detail.body.text,'Agent response');
  await worker.scheduled();assert.equal(await db.prepare('SELECT count(*) FROM send_attempts').first('count(*)'),1);
  // Old read-only credentials still have no draft/send permission, and request origins remain checked.
  assert.equal((await agent(`/v1/drafts/${draft.id}/send`,read.secret,{method:'POST',body:sendBody,headers:sendHeaders})).status,403);
  assert.equal((await agent('/v1/drafts',token.secret,{method:'POST',body:{},headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await request(`${base}/drafts`,{authenticated:false})).status,401);
});
