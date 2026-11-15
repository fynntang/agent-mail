import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const eventType='alert_notification.export.succeeded';
const bindings={WEBHOOK_KEYRING:JSON.stringify({activeKid:'batch-test',keys:{'batch-test':'A'.repeat(43)}})};
const base=box=>`/owner/api/mailboxes/${box.id}`;
const batches=box=>`${base(box)}/export-notification-retry-batches`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function tick(runtime){assert.equal((await(await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
async function box(runtime){return(await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Batch retries',localPart:`batch-${randomUUID()}`}}),201)).mailbox;}
async function runtimeFor(state){return createOwnerRuntime({bindings,outboundService:async request=>{assert.equal(new URL(request.url).hostname,'hooks.example.net');state.calls.push(await request.text());return new Response(null,{status:state.status});}});}
async function subscriptions(runtime,mailbox,count){for(let i=0;i<count;i++)await json(await runtime.request(`${base(mailbox)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net/${randomUUID()}`,eventTypes:[eventType]}}),201);await new Promise(resolve=>setTimeout(resolve,2));}
async function failedExport(runtime,mailbox,endpoints){const job=(await json(await runtime.request(`${base(mailbox)}/alert-notification-exports`,{method:'POST',body:{clientRequestId:randomUUID(),format:'csv'}}),202)).job;
  for(let i=0;i<1+Math.ceil(endpoints/2);i++)await tick(runtime);
  const results=await json(await runtime.request(`${base(mailbox)}/export-notifications/${job.id}/delivery-results`));assert.equal(results.deliverySummary.dead,endpoints);return {job,deliveries:results.deliveries};
}
async function preview(runtime,mailbox,changes={}){const body={clientRequestId:randomUUID(),reason:'http_rejected',...changes};return {body,...await json(await runtime.request(`${batches(mailbox)}/preview`,{method:'POST',body}),201)};}
async function commit(runtime,mailbox,batch,requestId=randomUUID()){const body={clientRequestId:requestId,expectedVersion:batch.version};return {body,...await json(await runtime.request(`${batches(mailbox)}/${batch.id}/commit`,{method:'POST',body}),202)};}
async function detail(runtime,mailbox,batch,query=''){return json(await runtime.request(`${batches(mailbox)}/${batch.id}${query}`));}
async function policy(runtime,mailbox,changes){const {version,updatedAt,...settings}=(await json(await runtime.request(`${base(mailbox)}/alert-notification-policy`))).policy;
  return json(await runtime.request(`${base(mailbox)}/alert-notification-policy`,{method:'PATCH',body:{...settings,...changes,expectedVersion:version}}));}
function safe(value){const text=JSON.stringify(value);for(const marker of ['https://','PRIVATE_BATCH','payload_json','url_snapshot','signing_secret','lease_token','request_hash','client_request_id'])assert.equal(text.includes(marker),false,marker);}

test('Owner confirms an immutable preview and a single Worker processes5+1 retries with idempotent progress and linked per-delivery receipts',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime);await subscriptions(runtime,mailbox,6);const original=await failedExport(runtime,mailbox,6),now=Date.now();
  const selected=await preview(runtime,mailbox,{from:now-60000,to:now+30000});assert.equal(selected.batch.totalItems,6);assert.equal(selected.batch.eligibleItems,6);assert.equal(selected.batch.state,'preview');safe(selected);
  const beforeCalls=state.calls.length;await tick(runtime);assert.equal(state.calls.length,beforeCalls);assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n'),0,'Preview is not authorization to retry');
  const replayPreview=await json(await runtime.request(`${batches(mailbox)}/preview`,{method:'POST',body:selected.body}),201);assert.equal(replayPreview.replayed,true);assert.equal(replayPreview.batch.id,selected.batch.id);
  const late=await failedExport(runtime,mailbox,6);assert.equal((await detail(runtime,mailbox,selected.batch)).batch.totalItems,6);
  const committed=await commit(runtime,mailbox,selected.batch),replayed=await json(await runtime.request(`${batches(mailbox)}/${selected.batch.id}/commit`,{method:'POST',body:committed.body}),202);assert.equal(replayed.replayed,true);assert.equal(committed.batch.state,'queued');
  await tick(runtime);const partial=await detail(runtime,mailbox,selected.batch);assert.equal(partial.batch.processedItems,5);assert.equal(partial.batch.requeuedItems,5);assert.equal(partial.batch.totalItems,6);
  await tick(runtime);const complete=await detail(runtime,mailbox,selected.batch);assert.equal(complete.batch.state,'completed');assert.equal(complete.batch.processedItems,6);assert.equal(complete.batch.requeuedItems,6);assert.equal(complete.batch.unknownItems,0);assert.ok(complete.items.every(item=>item.state==='requeued'&&item.manualRetryId));
  assert.deepEqual(new Set(complete.items.map(item=>item.deliveryId)),new Set(original.deliveries.map(item=>item.id)));assert.ok(complete.items.every(item=>!late.deliveries.some(value=>value.id===item.deliveryId)));
  const deliveryRows=(await runtime.db.prepare('SELECT id,attempt_budget FROM webhook_deliveries WHERE mailbox_id=?').bind(mailbox.id).all()).results;
  assert.ok(deliveryRows.filter(row=>original.deliveries.some(item=>item.id===row.id)).every(row=>row.attempt_budget===16));assert.ok(deliveryRows.filter(row=>late.deliveries.some(item=>item.id===row.id)).every(row=>row.attempt_budget===8));
  assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n'),6);
  const finalReplay=await json(await runtime.request(`${batches(mailbox)}/${selected.batch.id}/commit`,{method:'POST',body:committed.body}),202);assert.equal(finalReplay.replayed,true);assert.equal(finalReplay.batch.processedItems,6);
  const page=await detail(runtime,mailbox,selected.batch,'?limit=5');assert.equal(page.items.length,5);assert.ok(page.nextCursor);assert.equal((await detail(runtime,mailbox,selected.batch,`?limit=5&cursor=${page.nextCursor}`)).items.length,1);safe(complete);
});

test('changed versions and current policy become individual skip results rather than new attempts or rerun notification admission',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime);await subscriptions(runtime,mailbox,6);const original=await failedExport(runtime,mailbox,6),selected=await preview(runtime,mailbox);
  await runtime.db.prepare('UPDATE webhook_deliveries SET updated_at=updated_at+1 WHERE id=?').bind(original.deliveries[0].id).run();await policy(runtime,mailbox,{enabled:false});const calls=state.calls.length;
  await commit(runtime,mailbox,selected.batch);await tick(runtime);await tick(runtime);const result=await detail(runtime,mailbox,selected.batch);assert.equal(result.batch.state,'completed');assert.equal(result.batch.skippedItems,6);assert.equal(result.batch.requeuedItems,0);
  assert.ok(result.items.some(item=>item.reason==='changed'));assert.ok(result.items.some(item=>item.reason==='notifications_disabled'));assert.equal(state.calls.length,calls);assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n'),0);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM alert_notification_decisions').first('n'),0);safe(result);
});

test('mailbox, time and failure filters are exact; preview and commit enforce Owner/Origin and paginated reads do not mutate data',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime),other=await box(runtime);await subscriptions(runtime,mailbox,2);const original=await failedExport(runtime,mailbox,2),target=original.deliveries[0];
  await runtime.db.prepare("UPDATE webhook_deliveries SET last_error_code='PRIVATE_BATCH_FAILURE',updated_at=updated_at+1 WHERE id=?").bind(target.id).run();
  const unknown=await preview(runtime,mailbox,{reason:'other'});assert.equal(unknown.batch.totalItems,1);assert.equal(unknown.items[0].failureReason,'other');safe(unknown);
  const known=await preview(runtime,mailbox);assert.equal(known.batch.totalItems,1);const empty=await preview(runtime,mailbox,{from:0,to:1});assert.equal(empty.batch.totalItems,0);assert.equal((await preview(runtime,other)).batch.totalItems,0);
  for(const body of [{from:1,to:1},{from:0,to:32*86400000},{reason:'PRIVATE_BATCH_FAILURE'},{from:true},{extra:1}])await json(await runtime.request(`${batches(mailbox)}/preview`,{method:'POST',body:{clientRequestId:randomUUID(),...body}}),400);
  await json(await runtime.request(`${batches(mailbox)}/preview`,{method:'POST',body:{...known.body,reason:'other'}}),409);
  const counts=()=>runtime.db.prepare('SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM webhook_delivery_attempts) attempts,(SELECT count(*) FROM events) events').first();const before=await counts(),calls=state.calls.length;
  const page=await json(await runtime.request(`${batches(mailbox)}?limit=1`));assert.equal(page.batches.length,1);assert.ok(page.nextCursor);await json(await runtime.request(`${batches(mailbox)}?limit=1&cursor=${page.nextCursor}`));
  await json(await runtime.request(`${batches(other)}?limit=1&cursor=${page.nextCursor}`),400);await json(await runtime.request(`${batches(mailbox)}?limit=1&limit=1`),400);await json(await runtime.request(`${batches(other)}/${known.batch.id}`),404);
  await detail(runtime,mailbox,known.batch);assert.deepEqual(await counts(),before);assert.equal(state.calls.length,calls);
  const token=(await json(await runtime.request(`${base(mailbox)}/tokens`,{method:'POST',body:{name:'No batch ownership',scopes:['mail:read']}}),201)).secret;
  await json(await runtime.request(batches(mailbox),{authenticated:false}),401);await json(await runtime.request(batches(mailbox),{authenticated:false,headers:{Authorization:`Bearer ${token}`}}),401);
  await json(await runtime.request(`${batches(mailbox)}/preview`,{method:'POST',body:{clientRequestId:randomUUID()},headers:{Origin:'https://evil.example'}}),403);
  await json(await runtime.request(`${batches(mailbox)}/${known.batch.id}/commit`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:known.batch.version},headers:{Origin:'https://evil.example'}}),403);
  await runtime.db.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(mailbox.id).run();assert.equal((await detail(runtime,mailbox,known.batch)).batch.canCommit,false);await json(await runtime.request(`${batches(mailbox)}/${known.batch.id}/commit`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:known.batch.version}}),409);
});

test('a preview past its confirmation deadline is read-only and cannot be submitted even before cleanup',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime),selected=await preview(runtime,mailbox,{reason:'all'});
  const row=await runtime.db.prepare('SELECT * FROM async_export_notification_retry_batches WHERE id=?').bind(selected.batch.id).first(),old=Date.now()-700000,id=randomUUID();
  const clone={...row,id,preview_request_id:randomUUID(),created_at:old,updated_at:old,preview_expires_at:old+600000,expires_at:old+86400000};const columns=Object.keys(clone);
  await runtime.db.prepare(`INSERT INTO async_export_notification_retry_batches(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(name=>clone[name])).run();
  const expired=await detail(runtime,mailbox,{id});assert.equal(expired.batch.state,'expired');assert.equal(expired.batch.canCommit,false);
  const rejected=await runtime.request(`${batches(mailbox)}/${id}/commit`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:1}});assert.equal(rejected.status,410);assert.equal((await rejected.json()).error.code,'batch_retry_expired');assert.equal(state.calls.length,0);
});
