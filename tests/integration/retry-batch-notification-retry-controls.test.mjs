import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const topic='alert_notification.retry_batch.completed';
const bindings={WEBHOOK_KEYRING:JSON.stringify({activeKid:'notice-controls',keys:{'notice-controls':'A'.repeat(43)}})};
const base=box=>`/owner/api/mailboxes/${box.id}`;
const batches=box=>`${base(box)}/retry-batch-notification-retry-batches`;
const path=(box,batch)=>`${batches(box)}/${batch.id}`;
const input=batch=>({clientRequestId:randomUUID(),expectedVersion:batch.version});
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function tick(runtime){assert.equal((await(await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
async function runtimeFor(state){return createOwnerRuntime({bindings,outboundService:async request=>{assert.equal(new URL(request.url).hostname,'hooks.example.net');state.calls.push({body:await request.text(),headers:Object.fromEntries(request.headers)});return new Response(null,{status:state.status});}});}
async function mailbox(runtime){
  const box=(await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Notice retry controls',localPart:`notice-controls-${randomUUID()}`}}),201)).mailbox;
  const {version,updatedAt,...settings}=(await json(await runtime.request(`${base(box)}/alert-notification-policy`))).policy;
  await json(await runtime.request(`${base(box)}/alert-notification-policy`,{method:'PATCH',body:{...settings,repeatIntervalSeconds:0,expectedVersion:version}}));return box;
}
async function selection(runtime,box,count,{commit=true}={}){
  const subscriptions=[];
  for(let i=0;i<count;i++)subscriptions.push(await json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net/${randomUUID()}`,eventTypes:[topic]}}),201));
  await new Promise(resolve=>setTimeout(resolve,2));
  const source=`${base(box)}/export-notification-retry-batches`,preview=await json(await runtime.request(`${source}/preview`,{method:'POST',body:{clientRequestId:randomUUID(),reason:'all'}}),201);
  assert.equal(preview.batch.totalItems,0);
  await json(await runtime.request(`${source}/${preview.batch.id}/commit`,{method:'POST',body:input(preview.batch)}),202);
  await tick(runtime);for(let i=0;i<Math.ceil(count/2);i++)await tick(runtime);
  const selected=await json(await runtime.request(`${batches(box)}/preview`,{method:'POST',body:{clientRequestId:randomUUID(),reason:'http_rejected'}}),201);
  assert.equal(selected.batch.totalItems,count);assert.equal(selected.batch.eligibleItems,count);
  if(!commit)return{...selected,subscriptions};
  return{...await json(await runtime.request(`${path(box,selected.batch)}/commit`,{method:'POST',body:input(selected.batch)}),202),subscriptions};
}
async function read(runtime,box,batch){return json(await runtime.request(path(box,batch)));}
const retryCount=runtime=>runtime.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n');
async function counts(runtime){return runtime.db.prepare('SELECT (SELECT COUNT(*) FROM events) events,(SELECT COUNT(*) FROM async_export_retry_batch_notifications) notices,(SELECT COUNT(*) FROM async_export_notification_retry_batches) sourceBatches').first();}
function safe(value){const text=JSON.stringify(value);for(const marker of ['https://','PRIVATE_NOTICE_CONTROLS','payload_json','url_snapshot','signing_secret','lease_token','request_hash','client_request_id'])assert.equal(text.includes(marker),false,marker);}
function receiptId(box,uuid){const h=createHash('sha256').update(`retry-batch-notification-retry:v1:${box.id}:${uuid}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;}

test('notice retry cancellation preserves executed results, stops pending work and keeps original HMAC deliveries without recursive events',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),selected=await selection(runtime,box,6);
  await tick(runtime);const before=await read(runtime,box,selected.batch),sources=await counts(runtime);assert.equal(before.batch.requeuedItems,5);assert.equal(before.batch.processedItems,5);assert.equal(before.batch.canCancel,true);
  const executed=before.items.filter(item=>item.state==='requeued'),body=input(before.batch),calls=state.calls.length;
  const cancellations=await Promise.all([0,1].map(async()=>json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body}))));
  const [cancelled,concurrentCancel]=cancellations;assert.equal(concurrentCancel.operation.id,cancelled.operation.id);assert.ok(cancellations.some(value=>value.replayed));
  assert.equal(cancelled.batch.state,'cancelled');assert.equal(cancelled.batch.canCancel,false);assert.equal(cancelled.batch.canCommit,false);assert.ok(cancelled.batch.cancelledAt);
  assert.equal(cancelled.operation.action,'cancel');assert.deepEqual(cancelled.operation.summary,{stopped:1,unknown:0,retained:5});assert.equal(state.calls.length,calls);
  const after=await read(runtime,box,selected.batch);assert.equal(after.batch.processedItems,6);assert.equal(after.batch.requeuedItems,5);assert.equal(after.batch.skippedItems,1);
  for(const item of executed)assert.deepEqual(after.items.find(value=>value.deliveryId===item.deliveryId),item);
  assert.equal(after.items.find(item=>item.state==='skipped').reason,'batch_cancelled');assert.equal(await retryCount(runtime),5);
  const replay=await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body}));assert.equal(replay.replayed,true);assert.deepEqual(replay.operation,cancelled.operation);
  await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body:{...body,expectedVersion:body.expectedVersion+1}}),409);
  state.status=204;for(let i=0;i<4;i++)await tick(runtime);
  assert.equal(await retryCount(runtime),5);assert.equal(state.calls.length,calls+5);assert.deepEqual(await counts(runtime),sources);
  for(const item of executed){const sent=state.calls.filter(call=>call.headers['x-agent-mail-delivery']===item.deliveryId);assert.equal(sent.length,2);assert.equal(sent[0].body,sent[1].body);const endpoint=await runtime.db.prepare('SELECT endpoint_id FROM webhook_deliveries WHERE id=?').bind(item.deliveryId).first('endpoint_id'),secret=selected.subscriptions.find(value=>value.endpoint.id===endpoint).secret;
    for(const call of sent){const match=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(call.headers['x-agent-mail-signature']);assert.ok(match);assert.equal(match[2],createHmac('sha256',secret).update(`${match[1]}.${item.deliveryId}.${call.body}`).digest('hex'));}}
  const auditCount=await runtime.db.prepare('SELECT COUNT(*) n FROM audit_events').first('n'),callCount=state.calls.length,operations=[];let cursor='';
  do{const page=await json(await runtime.request(`${path(box,selected.batch)}/operations?limit=1${cursor?`&cursor=${cursor}`:''}`));operations.push(...page.operations);cursor=page.nextCursor??'';safe(page);}while(cursor);
  assert.deepEqual(new Set(operations.map(value=>value.action)),new Set(['preview','commit','cancel']));assert.equal(operations.length,3);
  assert.equal(await runtime.db.prepare('SELECT COUNT(*) n FROM audit_events').first('n'),auditCount);assert.equal(state.calls.length,callCount);safe(after);safe(cancelled);
});

test('notice retry manual reconciliation verifies found, absent and conflicting original receipts without retries or budget changes',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),selected=await selection(runtime,box,3),sources=await counts(runtime);
  const items=(await runtime.db.prepare('SELECT * FROM retry_batch_notification_retry_items WHERE batch_id=? ORDER BY delivery_id').bind(selected.batch.id).all()).results,at=Date.now();
  await runtime.db.prepare("UPDATE retry_batch_notification_retry_items SET state='running',lease_token=?,lease_until=?,version=version+1,updated_at=MAX(updated_at+1,?) WHERE batch_id=?").bind(randomUUID(),at+120000,at,selected.batch.id).run();
  const queued=await json(await runtime.request(`${base(box)}/retry-batch-notifications/${items[0].notification_id}/deliveries/${items[0].delivery_id}/retry`,{method:'POST',body:{clientRequestId:items[0].client_request_id,expectedUpdatedAt:items[0].expected_updated_at}}));
  await runtime.db.prepare("INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at) VALUES(?,?,'owner','webhook.delivery_retried',?,'success',?,'{}',?)").bind(receiptId(box,items[2].client_request_id),box.id,items[2].delivery_id,randomUUID(),at).run();
  const cancelled=await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body:input((await read(runtime,box,selected.batch)).batch)}));assert.equal(cancelled.batch.unknownItems,3);
  const calls=state.calls.length,audits=await retryCount(runtime),budgets=(await runtime.db.prepare('SELECT id,attempt_budget FROM webhook_deliveries WHERE mailbox_id=? ORDER BY id').bind(box.id).all()).results;
  const body=input(cancelled.batch),reconciliations=await Promise.all([0,1].map(async()=>json(await runtime.request(`${path(box,selected.batch)}/reconcile`,{method:'POST',body}))));
  const [result,concurrentReconcile]=reconciliations;assert.equal(concurrentReconcile.operation.id,result.operation.id);assert.ok(reconciliations.some(value=>value.replayed));
  assert.equal(result.batch.state,'cancelled');assert.equal(result.batch.requeuedItems,1);assert.equal(result.batch.skippedItems,1);assert.equal(result.batch.unknownItems,1);assert.deepEqual(result.operation.summary,{requeued:1,notSubmitted:1,unresolved:1});assert.equal(result.operation.items.length,3);
  const outcomes=await read(runtime,box,selected.batch);assert.equal(outcomes.items.find(item=>item.deliveryId===items[0].delivery_id).manualRetryId,queued.manualRetry.id);assert.equal(outcomes.items.find(item=>item.deliveryId===items[1].delivery_id).reason,'not_submitted');assert.equal(outcomes.items.find(item=>item.deliveryId===items[2].delivery_id).reason,'receipt_conflict');
  const replay=await json(await runtime.request(`${path(box,selected.batch)}/reconcile`,{method:'POST',body}));assert.equal(replay.replayed,true);assert.deepEqual(replay.operation,result.operation);
  const single=await json(await runtime.request(`${path(box,selected.batch)}/reconcile`,{method:'POST',body:{...input(replay.batch),deliveryId:items[2].delivery_id}}));assert.equal(single.operation.summary.unresolved,1);
  await json(await runtime.request(`${path(box,selected.batch)}/reconcile`,{method:'POST',body:{...body,deliveryId:items[2].delivery_id}}),409);
  assert.equal(await retryCount(runtime),audits);assert.equal(state.calls.length,calls);assert.deepEqual((await runtime.db.prepare('SELECT id,attempt_budget FROM webhook_deliveries WHERE mailbox_id=? ORDER BY id').bind(box.id).all()).results,budgets);assert.deepEqual(await counts(runtime),sources);safe(result);safe(outcomes);safe(single);
});

test('notice retry controls enforce Owner, Origin, mailbox scope, immutable cancellation and bound operation cursors on paused mailboxes',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),other=await mailbox(runtime),selected=await selection(runtime,box,1,{commit:false}),body=input(selected.batch);
  const token=(await json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'Agent read',scopes:['mail:read']}}),201)).secret;
  for(const action of ['cancel','reconcile']){
    await json(await runtime.request(`${path(box,selected.batch)}/${action}`,{method:'POST',body,authenticated:false,headers:{Authorization:`Bearer ${token}`}}),401);
    await json(await runtime.request(`${path(box,selected.batch)}/${action}`,{method:'POST',body,headers:{Origin:'https://evil.example'}}),403);
    await json(await runtime.request(`${path(other,selected.batch)}/${action}`,{method:'POST',body}),404);
    await json(await runtime.request(`${path(box,selected.batch)}/${action}?extra=1`,{method:'POST',body}),400);
  }
  await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body:{...body,expectedVersion:body.expectedVersion+1}}),409);
  await runtime.db.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(box.id).run();assert.equal((await read(runtime,box,selected.batch)).batch.canCancel,true);
  const sources=await counts(runtime),cancelled=await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body}));assert.equal(cancelled.batch.state,'cancelled');assert.equal(cancelled.batch.skippedItems,1);
  await runtime.db.prepare("UPDATE mailboxes SET status='active' WHERE id=?").bind(box.id).run();await json(await runtime.request(`${path(box,selected.batch)}/commit`,{method:'POST',body:input(cancelled.batch)}),409);
  await tick(runtime);assert.equal(await retryCount(runtime),0);assert.equal((await read(runtime,box,selected.batch)).batch.state,'cancelled');assert.deepEqual(await counts(runtime),sources);
  const history=await json(await runtime.request(`${path(box,selected.batch)}/operations?limit=1`));assert.ok(history.nextCursor);
  for(const query of ['?limit=0','?limit=1&limit=1','?cursor=invalid','?limit=2&cursor='+history.nextCursor])await json(await runtime.request(`${path(box,selected.batch)}/operations${query}`),400);
  await json(await runtime.request(`${path(other,selected.batch)}/operations?limit=1&cursor=${history.nextCursor}`),404);
  await json(await runtime.request(`${path(box,selected.batch)}/operations`,{authenticated:false,headers:{Authorization:`Bearer ${token}`}}),401);
  await json(await runtime.request(`${path(box,selected.batch)}/reconcile`,{method:'POST',body}),409);
  const cancelAudits=await runtime.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE mailbox_id=? AND action LIKE '%cancelled'").bind(box.id).first('n');assert.equal(cancelAudits,1);safe(cancelled);safe(history);
});
