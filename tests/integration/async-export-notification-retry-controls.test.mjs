import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const eventType='alert_notification.export.succeeded';
const bindings={WEBHOOK_KEYRING:JSON.stringify({activeKid:'controls-test',keys:{'controls-test':'A'.repeat(43)}})};
const base=box=>`/owner/api/mailboxes/${box.id}`;
const batches=box=>`${base(box)}/export-notification-retry-batches`;
const path=(box,batch)=>`${batches(box)}/${batch.id}`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function tick(runtime){assert.equal((await(await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
async function mailbox(runtime){return(await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Retry controls',localPart:`controls-${randomUUID()}`}}),201)).mailbox;}
async function runtimeFor(state){return createOwnerRuntime({bindings,outboundService:async request=>{assert.equal(new URL(request.url).hostname,'hooks.example.net');state.calls++;return new Response(null,{status:400});}});}
async function selection(runtime,box,count,{commit=true}={}){
  for(let i=0;i<count;i++)await json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net/${randomUUID()}`,eventTypes:[eventType]}}),201);
  await new Promise(resolve=>setTimeout(resolve,2));
  const job=(await json(await runtime.request(`${base(box)}/alert-notification-exports`,{method:'POST',body:{clientRequestId:randomUUID(),format:'json'}}),202)).job;
  for(let i=0;i<1+Math.ceil(count/2);i++)await tick(runtime);
  const selected=await json(await runtime.request(`${batches(box)}/preview`,{method:'POST',body:{clientRequestId:randomUUID(),reason:'http_rejected'}}),201);
  assert.equal(selected.batch.totalItems,count);
  if(!commit)return{...selected,job};
  return {...await json(await runtime.request(`${path(box,selected.batch)}/commit`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:selected.batch.version}}),202),job};
}
async function detail(runtime,box,batch){return json(await runtime.request(path(box,batch)));}
const input=batch=>({clientRequestId:randomUUID(),expectedVersion:batch.version});
const retryCount=runtime=>runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n');
function safe(value){const text=JSON.stringify(value);for(const marker of ['https://','PRIVATE_CONTROLS','payload_json','url_snapshot','signing_secret','lease_token','request_hash','client_request_id'])assert.equal(text.includes(marker),false,marker);}
function receiptId(box,uuid){const h=createHash('sha256').update(`async-export-notification-retry:v1:${box.id}:${uuid}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;}

test('cancel preserves five executed receipts and stops the remaining candidate with durable replay and scoped read-only operation history',{timeout:120_000},async t=>{
  const state={calls:0},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),selected=await selection(runtime,box,6);
  await tick(runtime);const before=await detail(runtime,box,selected.batch);assert.equal(before.batch.requeuedItems,5);assert.equal(before.batch.processedItems,5);assert.equal(before.batch.canCancel,true);
  const executed=before.items.filter(item=>item.state==='requeued'),body=input(before.batch),calls=state.calls;
  const cancelled=await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body}));
  assert.equal(cancelled.batch.state,'cancelled');assert.equal(cancelled.batch.canCancel,false);assert.equal(cancelled.batch.canCommit,false);assert.ok(cancelled.batch.cancelledAt);assert.equal(cancelled.operation.action,'cancel');
  assert.deepEqual(cancelled.operation.summary,{stopped:1,unknown:0,retained:5});assert.equal(state.calls,calls);
  const after=await detail(runtime,box,selected.batch);assert.equal(after.batch.processedItems,6);assert.equal(after.batch.requeuedItems,5);assert.equal(after.batch.skippedItems,1);assert.equal(after.batch.unknownItems,0);
  for(const item of executed)assert.deepEqual(after.items.find(value=>value.deliveryId===item.deliveryId),item);
  assert.equal(after.items.find(item=>item.state==='skipped').reason,'batch_cancelled');assert.equal(await retryCount(runtime),5);
  await tick(runtime);await tick(runtime);assert.equal(await retryCount(runtime),5,'Cancellation cannot grant an attempt to a pending batch item');
  const replay=await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body}));assert.equal(replay.replayed,true);assert.equal(replay.operation.id,cancelled.operation.id);
  await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body:{...body,expectedVersion:body.expectedVersion+1}}),409);
  const count=await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n'),callCount=state.calls;
  const history=await json(await runtime.request(`${path(box,selected.batch)}/operations?limit=1`));assert.equal(history.operations.length,1);assert.ok(history.nextCursor);
  const next=await json(await runtime.request(`${path(box,selected.batch)}/operations?limit=1&cursor=${history.nextCursor}`));assert.equal(next.operations.length,1);assert.notEqual(next.operations[0].id,history.operations[0].id);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n'),count);assert.equal(state.calls,callCount);safe(after);safe(history);safe(next);
});

test('manual reconciliation proves receipt-found, never-submitted and conflicting outcomes without new transport or budget and replays the same operation',{timeout:120_000},async t=>{
  const state={calls:0},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),selected=await selection(runtime,box,3);
  const items=(await runtime.db.prepare('SELECT * FROM async_export_notification_retry_items WHERE batch_id=? ORDER BY delivery_id').bind(selected.batch.id).all()).results;
  const lease=randomUUID(),at=Date.now();
  await runtime.db.prepare("UPDATE async_export_notification_retry_items SET state='running',lease_token=?,lease_until=?,version=version+1,updated_at=MAX(updated_at+1,?) WHERE batch_id=?").bind(lease,at+120000,at,selected.batch.id).run();
  const queued=await json(await runtime.request(`${base(box)}/export-notifications/${items[0].job_id}/deliveries/${items[0].delivery_id}/retry`,{method:'POST',body:{clientRequestId:items[0].client_request_id,expectedUpdatedAt:items[0].expected_updated_at}}));
  const conflict=receiptId(box,items[2].client_request_id);
  await runtime.db.prepare("INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at) VALUES(?,?,'owner','webhook.delivery_retried',?,'success',?,'{}',?)").bind(conflict,box.id,items[2].delivery_id,randomUUID(),at).run();
  const cancelled=await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body:input((await detail(runtime,box,selected.batch)).batch)}));assert.equal(cancelled.batch.unknownItems,3);
  const calls=state.calls,audits=await retryCount(runtime),budgets=(await runtime.db.prepare('SELECT id,attempt_budget FROM webhook_deliveries WHERE mailbox_id=? ORDER BY id').bind(box.id).all()).results;
  const body=input(cancelled.batch),result=await json(await runtime.request(`${path(box,selected.batch)}/reconcile`,{method:'POST',body}));
  assert.equal(result.batch.state,'cancelled');assert.equal(result.batch.requeuedItems,1);assert.equal(result.batch.skippedItems,1);assert.equal(result.batch.unknownItems,1);
  assert.deepEqual(result.operation.summary,{requeued:1,notSubmitted:1,unresolved:1});assert.equal(result.operation.items.length,3);
  const outcomes=await detail(runtime,box,selected.batch);assert.equal(outcomes.items.find(item=>item.deliveryId===items[0].delivery_id).manualRetryId,queued.manualRetry.id);
  assert.equal(outcomes.items.find(item=>item.deliveryId===items[1].delivery_id).reason,'not_submitted');assert.equal(outcomes.items.find(item=>item.deliveryId===items[2].delivery_id).reason,'receipt_conflict');
  const replay=await json(await runtime.request(`${path(box,selected.batch)}/reconcile`,{method:'POST',body}));assert.equal(replay.replayed,true);assert.deepEqual(replay.operation,result.operation);
  const single=await json(await runtime.request(`${path(box,selected.batch)}/reconcile`,{method:'POST',body:{...input(replay.batch),deliveryId:items[2].delivery_id}}));assert.equal(single.operation.summary.unresolved,1);
  assert.equal(await retryCount(runtime),audits);assert.equal(state.calls,calls);assert.deepEqual((await runtime.db.prepare('SELECT id,attempt_budget FROM webhook_deliveries WHERE mailbox_id=? ORDER BY id').bind(box.id).all()).results,budgets);
  safe(result);safe(outcomes);safe(single);
});

test('Owner controls enforce Origin, exact mailbox scope, version fences and durable cancellation of a paused preview',{timeout:120_000},async t=>{
  const state={calls:0},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),other=await mailbox(runtime),selected=await selection(runtime,box,1,{commit:false}),body=input(selected.batch);
  const token=(await json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'Mailbox agent',scopes:['mail:read']}}),201)).secret;
  for(const action of ['cancel','reconcile']){
    await json(await runtime.request(`${path(box,selected.batch)}/${action}`,{method:'POST',body,authenticated:false,headers:{Authorization:`Bearer ${token}`}}),401);
    await json(await runtime.request(`${path(box,selected.batch)}/${action}`,{method:'POST',body,headers:{Origin:'https://evil.example'}}),403);
    await json(await runtime.request(`${path(other,selected.batch)}/${action}`,{method:'POST',body}),404);
    await json(await runtime.request(`${path(box,selected.batch)}/${action}?extra=1`,{method:'POST',body}),400);
  }
  await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body:{...body,expectedVersion:body.expectedVersion+1}}),409);
  await runtime.db.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(box.id).run();
  const cancelled=await json(await runtime.request(`${path(box,selected.batch)}/cancel`,{method:'POST',body}));assert.equal(cancelled.batch.state,'cancelled');assert.equal(cancelled.batch.skippedItems,1);
  await runtime.db.prepare("UPDATE mailboxes SET status='active' WHERE id=?").bind(box.id).run();
  await json(await runtime.request(`${path(box,selected.batch)}/commit`,{method:'POST',body:input(cancelled.batch)}),409);
  await tick(runtime);assert.equal(await retryCount(runtime),0);assert.equal((await detail(runtime,box,selected.batch)).batch.state,'cancelled');
  const history=await json(await runtime.request(`${path(box,selected.batch)}/operations?limit=1`));assert.ok(history.nextCursor);
  for(const query of ['?limit=0','?limit=1&limit=1','?cursor=invalid'])await json(await runtime.request(`${path(box,selected.batch)}/operations${query}`),400);
  await json(await runtime.request(`${path(other,selected.batch)}/operations?limit=1&cursor=${history.nextCursor}`),404);
  await json(await runtime.request(`${path(box,selected.batch)}/operations`,{authenticated:false,headers:{Authorization:`Bearer ${token}`}}),401);
  assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE action='export_notification_retry_batch.cancelled'").first('n'),1);safe(cancelled);safe(history);
});
