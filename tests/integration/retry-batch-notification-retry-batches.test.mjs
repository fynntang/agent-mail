import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHmac} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const topic='alert_notification.retry_batch.completed';
const bindings={WEBHOOK_KEYRING:JSON.stringify({activeKid:'notice-bulk',keys:{'notice-bulk':'A'.repeat(43)}})};
const base=box=>`/owner/api/mailboxes/${box.id}`;
const batches=box=>`${base(box)}/retry-batch-notification-retry-batches`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function tick(runtime){assert.equal((await(await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
async function runtimeFor(state){return createOwnerRuntime({bindings,outboundService:async request=>{assert.equal(new URL(request.url).hostname,'hooks.example.net');state.calls.push({body:await request.text(),headers:Object.fromEntries(request.headers)});return new Response(null,{status:state.status});}});}
async function box(runtime){const {mailbox}=await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Notice bulk retries',localPart:`notice-bulk-${randomUUID()}`}}),201);await policy(runtime,mailbox,{repeatIntervalSeconds:0});return mailbox;}
async function policy(runtime,mailbox,changes){const {version,updatedAt,...settings}=(await json(await runtime.request(`${base(mailbox)}/alert-notification-policy`))).policy;return json(await runtime.request(`${base(mailbox)}/alert-notification-policy`,{method:'PATCH',body:{...settings,...changes,expectedVersion:version}}));}
async function subscribe(runtime,mailbox,count){const result=[];for(let i=0;i<count;i++)result.push(await json(await runtime.request(`${base(mailbox)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net/${randomUUID()}`,eventTypes:[topic]}}),201));await new Promise(resolve=>setTimeout(resolve,2));return result;}
async function source(runtime,mailbox,endpoints){
  const root=`${base(mailbox)}/export-notification-retry-batches`,selected=await json(await runtime.request(`${root}/preview`,{method:'POST',body:{clientRequestId:randomUUID(),reason:'all'}}),201);assert.equal(selected.batch.totalItems,0);
  const {batch}=await json(await runtime.request(`${root}/${selected.batch.id}/commit`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:selected.batch.version}}),202);await tick(runtime);
  const page=await json(await runtime.request(`${base(mailbox)}/retry-batch-notifications?status=all`)),notice=page.notifications.find(value=>value.batchId===batch.id);assert.ok(notice);
  for(let i=0;i<Math.ceil(endpoints/2);i++)await tick(runtime);
  const results=await json(await runtime.request(`${base(mailbox)}/retry-batch-notifications/${notice.id}/delivery-results`));assert.equal(results.deliverySummary.dead,endpoints);return {batch,notice,deliveries:results.deliveries};
}
async function preview(runtime,mailbox,changes={}){const body={clientRequestId:randomUUID(),reason:'http_rejected',...changes};return{body,...await json(await runtime.request(`${batches(mailbox)}/preview`,{method:'POST',body}),201)};}
async function commit(runtime,mailbox,batch){const body={clientRequestId:randomUUID(),expectedVersion:batch.version};return{body,...await json(await runtime.request(`${batches(mailbox)}/${batch.id}/commit`,{method:'POST',body}),202)};}
const detail=async(runtime,mailbox,batch,query='')=>json(await runtime.request(`${batches(mailbox)}/${batch.id}${query}`));
async function counts(runtime){return runtime.db.prepare('SELECT (SELECT COUNT(*) FROM events) events,(SELECT COUNT(*) FROM async_export_retry_batch_notifications) notices,(SELECT COUNT(*) FROM async_export_notification_retry_batches) sourceBatches').first();}
function safe(value){const text=JSON.stringify(value);for(const marker of ['https://','PRIVATE_NOTICE_BULK','payload_json','endpoint_snapshot_json','signing_secret','lease_token','claim_token','request_hash','client_request_id'])assert.equal(text.includes(marker),false,marker);}

test('Owner freezes six failed notice deliveries and processes5+1 with stable receipts and HMAC identity without recursive notices',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime),subscriptions=await subscribe(runtime,mailbox,6),original=await source(runtime,mailbox,6),selected=await preview(runtime,mailbox);
  assert.equal(selected.batch.totalItems,6);assert.equal(selected.batch.eligibleItems,6);safe(selected);const calls=state.calls.length;await tick(runtime);assert.equal(state.calls.length,calls);assert.equal(await runtime.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n'),0);
  const replayedPreview=await json(await runtime.request(`${batches(mailbox)}/preview`,{method:'POST',body:selected.body}),201);assert.equal(replayedPreview.replayed,true);assert.equal(replayedPreview.batch.id,selected.batch.id);
  const late=await source(runtime,mailbox,6),before=await counts(runtime),confirmed=await commit(runtime,mailbox,selected.batch);
  const replay=await json(await runtime.request(`${batches(mailbox)}/${selected.batch.id}/commit`,{method:'POST',body:confirmed.body}),202);assert.equal(replay.replayed,true);
  await tick(runtime);const partial=await detail(runtime,mailbox,selected.batch);assert.equal(partial.batch.processedItems,5);assert.equal(partial.batch.requeuedItems,5);
  state.status=204;await tick(runtime);const complete=await detail(runtime,mailbox,selected.batch);assert.equal(complete.batch.state,'completed');assert.equal(complete.batch.requeuedItems,6);assert.equal(complete.batch.unknownItems,0);assert.ok(complete.items.every(item=>item.notificationId===original.notice.id&&item.sourceBatchId===original.batch.id&&item.manualRetryId));assert.ok(complete.items.every(item=>!late.deliveries.some(value=>value.id===item.deliveryId)));
  for(let i=0;i<3;i++)await tick(runtime);assert.deepEqual(await counts(runtime),before,'Executing the retry task must not create source batches, events or notifications');
  const current=await json(await runtime.request(`${base(mailbox)}/retry-batch-notifications/${original.notice.id}/delivery-results`));assert.equal(current.deliverySummary.succeeded,6);
  const untouched=await json(await runtime.request(`${base(mailbox)}/retry-batch-notifications/${late.notice.id}/delivery-results`));assert.equal(untouched.deliverySummary.dead,6);assert.ok(untouched.deliveries.every(value=>value.attemptBudget===8));
  assert.equal(await runtime.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n'),6);
  for(const delivery of original.deliveries){const sent=state.calls.filter(call=>call.headers['x-agent-mail-delivery']===delivery.id);assert.equal(sent.length,2);assert.equal(sent[0].body,sent[1].body);assert.equal(sent[0].headers['x-agent-mail-secret-version'],sent[1].headers['x-agent-mail-secret-version']);const secret=subscriptions.find(value=>value.endpoint.id===delivery.endpointId).secret;for(const call of sent){const match=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(call.headers['x-agent-mail-signature']);assert.ok(match);assert.equal(match[2],createHmac('sha256',secret).update(`${match[1]}.${delivery.id}.${call.body}`).digest('hex'));}}
  const page=await detail(runtime,mailbox,selected.batch,'?limit=5');assert.equal(page.items.length,5);assert.ok(page.nextCursor);assert.equal((await detail(runtime,mailbox,selected.batch,`?limit=5&cursor=${page.nextCursor}`)).items.length,1);safe(complete);
});

test('changed versions and disabled policy become skip results without new attempts or notification admission',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime);await subscribe(runtime,mailbox,6);const original=await source(runtime,mailbox,6),selected=await preview(runtime,mailbox);
  await runtime.db.prepare('UPDATE webhook_deliveries SET updated_at=updated_at+1 WHERE id=?').bind(original.deliveries[0].id).run();await policy(runtime,mailbox,{enabled:false});const before=await counts(runtime),calls=state.calls.length;
  await commit(runtime,mailbox,selected.batch);await tick(runtime);await tick(runtime);const result=await detail(runtime,mailbox,selected.batch);assert.equal(result.batch.state,'completed');assert.equal(result.batch.skippedItems,6);assert.equal(result.batch.requeuedItems,0);assert.ok(result.items.some(item=>item.reason==='changed'));assert.ok(result.items.some(item=>item.reason==='notifications_disabled'));
  assert.equal(state.calls.length,calls);assert.deepEqual(await counts(runtime),before);assert.equal(await runtime.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n'),0);assert.equal(await runtime.db.prepare('SELECT COUNT(*) n FROM alert_notification_decisions').first('n'),0);safe(result);
});

test('exact mailbox/time/reason filtering, Owner origin and pause/version rules protect independent preview and commit histories',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime),other=await box(runtime);await subscribe(runtime,mailbox,2);const original=await source(runtime,mailbox,2);
  await runtime.db.prepare("UPDATE webhook_deliveries SET last_error_code='PRIVATE_NOTICE_BULK',updated_at=updated_at+1 WHERE id=?").bind(original.deliveries[0].id).run();const selected=await preview(runtime,mailbox,{reason:'other'});assert.equal(selected.batch.totalItems,1);assert.equal(selected.items[0].failureReason,'other');safe(selected);
  assert.equal((await preview(runtime,mailbox,{from:0,to:1})).batch.totalItems,0);assert.equal((await preview(runtime,other)).batch.totalItems,0);await json(await runtime.request(`${batches(mailbox)}/preview`,{method:'POST',body:{...selected.body,reason:'all'}}),409);
  const page=await json(await runtime.request(`${batches(mailbox)}?limit=1`));assert.ok(page.nextCursor);await json(await runtime.request(`${batches(other)}?limit=1&cursor=${page.nextCursor}`),400);await json(await runtime.request(`${batches(other)}/${selected.batch.id}`),404);
  const token=(await json(await runtime.request(`${base(mailbox)}/tokens`,{method:'POST',body:{name:'Agent read',scopes:['mail:read']}}),201)).secret;await json(await runtime.request(batches(mailbox),{authenticated:false,headers:{Authorization:`Bearer ${token}`}}),401);
  await json(await runtime.request(`${batches(mailbox)}/preview`,{method:'POST',body:{clientRequestId:randomUUID()},headers:{Origin:'https://evil.example'}}),403);await json(await runtime.request(`${batches(mailbox)}/${selected.batch.id}/commit`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:selected.batch.version},headers:{Origin:'https://evil.example'}}),403);
  await runtime.db.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(mailbox.id).run();assert.equal((await detail(runtime,mailbox,selected.batch)).batch.canCommit,false);await json(await runtime.request(`${batches(mailbox)}/${selected.batch.id}/commit`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:selected.batch.version}}),409);
  for(const query of ['?limit=0','?limit=1&limit=1','?cursor=bad'])await json(await runtime.request(batches(mailbox)+query),400);
});
