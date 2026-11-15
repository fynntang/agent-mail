import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac,randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const type='alert_notification.retry_batch.completed';
const bindings={WEBHOOK_KEYRING:JSON.stringify({activeKid:'batch-tracking',keys:{'batch-tracking':'A'.repeat(43)}})};
const base=box=>`/owner/api/mailboxes/${box.id}`;
const notices=box=>`${base(box)}/retry-batch-notifications`;
const deliveries=(box,notice)=>`${notices(box)}/${notice.id}/delivery-results`;
const detail=(box,notice,delivery)=>`${notices(box)}/${notice.id}/deliveries/${delivery.id}`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function tick(runtime){assert.equal((await(await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
async function mailbox(runtime){return(await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Batch delivery tracking',localPart:`tracking-${randomUUID()}`}}),201)).mailbox;}
async function runtimeFor(state){return createOwnerRuntime({bindings,outboundService:async request=>{assert.equal(new URL(request.url).hostname,'hooks.example.net');state.calls.push({url:request.url,body:await request.text(),headers:Object.fromEntries(request.headers)});return new Response(null,{status:state.status});}});}
async function endpoint(runtime,box){const result=await json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net/${randomUUID()}`,eventTypes:[type]}}),201);await new Promise(resolve=>setTimeout(resolve,2));return result;}
async function capture(runtime,box){
  const root=`${base(box)}/export-notification-retry-batches`,preview=await json(await runtime.request(`${root}/preview`,{method:'POST',body:{clientRequestId:randomUUID(),reason:'all'}}),201);
  assert.equal(preview.batch.totalItems,0);
  const {batch}=await json(await runtime.request(`${root}/${preview.batch.id}/commit`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:preview.batch.version}}),202);
  await runtime.db.prepare("UPDATE async_export_notification_retry_batches SET state='completed',completed_at=?,version=version+1,updated_at=MAX(updated_at+1,?) WHERE id=?").bind(Date.now(),Date.now(),batch.id).run();
  const page=await json(await runtime.request(`${notices(box)}?status=all`));return page.notifications.find(item=>item.batchId===batch.id);
}
async function policy(runtime,box,changes){const {version,updatedAt,...settings}=(await json(await runtime.request(`${base(box)}/alert-notification-policy`))).policy;return json(await runtime.request(`${base(box)}/alert-notification-policy`,{method:'PATCH',body:{...settings,...changes,expectedVersion:version}}));}
function safe(value){const text=JSON.stringify(value);for(const marker of ['https://','url_snapshot','payload_json','signing_secret','endpoint_snapshot_json','claim_token','lease_token','object_key','PRIVATE_BATCH_TRACKING'])assert.equal(text.includes(marker),false,marker);}
function signed(call,secret){const match=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(call.headers['x-agent-mail-signature']);assert.ok(match);assert.equal(match[2],createHmac('sha256',secret).update(`${match[1]}.${call.headers['x-agent-mail-delivery']}.${call.body}`).digest('hex'));for(const key of ['authorization','cookie','cf-access-jwt-assertion','origin','referer'])assert.equal(call.headers[key],undefined);}

test('Owner tracks notification admission and safely requeues one dead batch notice with a stable receipt and frozen signed identity',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),subscriptions=[await endpoint(runtime,box),await endpoint(runtime,box)],notice=await capture(runtime,box);
  const pending=await json(await runtime.request(deliveries(box,notice)));assert.equal(pending.publication,'pending_projection');assert.equal(pending.notification.notificationDecision,null);assert.equal(pending.deliverySummary.total,0);
  await tick(runtime);assert.equal((await json(await runtime.request(deliveries(box,notice)))).publication,'pending_publication');await tick(runtime);
  const page=await json(await runtime.request(deliveries(box,notice)));assert.equal(page.publication,'published');assert.equal(page.notification.notificationDecision,'allowed');assert.equal(page.deliverySummary.dead,2);assert.equal(page.deliverySummary.attempts,2);safe(page);
  const target=page.deliveries[0],path=detail(box,notice,target),before=await json(await runtime.request(path));assert.equal(before.delivery.retry.available,true);assert.equal(before.attempts.length,1);assert.equal(before.manualRetries.length,0);
  const input={clientRequestId:randomUUID(),expectedUpdatedAt:target.updatedAt},calls=state.calls.length,queued=await json(await runtime.request(`${path}/retry`,{method:'POST',body:input}));assert.equal(queued.replayed,false);assert.equal(queued.delivery.id,target.id);assert.equal(queued.delivery.state,'pending');assert.equal(queued.delivery.attemptBudget,16);assert.equal(state.calls.length,calls);
  const replay=await json(await runtime.request(`${path}/retry`,{method:'POST',body:input}));assert.equal(replay.replayed,true);assert.equal(replay.manualRetry.id,queued.manualRetry.id);assert.equal(replay.delivery.attemptBudget,16);
  const generic=await json(await runtime.request(`${base(box)}/webhook-deliveries/${target.id}/retry`,{method:'POST',body:input}));assert.equal(generic.replayed,true);assert.equal(generic.manualRetry.id,queued.manualRetry.id);
  await json(await runtime.request(`${path}/retry`,{method:'POST',body:{...input,expectedUpdatedAt:input.expectedUpdatedAt+1}}),409);
  state.status=204;await tick(runtime);const complete=await json(await runtime.request(path));assert.equal(complete.delivery.state,'succeeded');assert.equal(complete.delivery.attemptBudget,16);assert.equal(complete.attempts.length,2);assert.equal(complete.manualRetries.length,1);
  const sent=state.calls.filter(call=>call.headers['x-agent-mail-delivery']===target.id),subscription=subscriptions.find(item=>item.endpoint.id===target.endpointId);assert.equal(sent.length,2);assert.equal(sent[0].body,sent[1].body);assert.equal(sent[0].url,sent[1].url);assert.equal(sent[0].headers['x-agent-mail-secret-version'],sent[1].headers['x-agent-mail-secret-version']);for(const call of sent)signed(call,subscription.secret);
  assert.equal((await json(await runtime.request(`${path}/retry`,{method:'POST',body:input}))).replayed,true);assert.equal((await json(await runtime.request(`${notices(box)}?status=all`))).notifications.length,1);assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n'),1);safe(complete);safe(queued);
});

test('batch notice delivery pagination and traces are scoped, read-only without key configuration, and inaccessible to mailbox Agents',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),other=await mailbox(runtime);for(let i=0;i<6;i++)await endpoint(runtime,box);const notice=await capture(runtime,box);await tick(runtime);await tick(runtime);await tick(runtime);await tick(runtime);
  const counts=()=>runtime.db.prepare('SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM webhook_delivery_attempts) attempts,(SELECT count(*) FROM events) events').first(),before=await counts(),calls=state.calls.length;
  const page=await json(await runtime.request(`${deliveries(box,notice)}?limit=5`));assert.equal(page.deliveries.length,5);assert.equal(page.deliverySummary.total,6);assert.equal(page.deliverySummary.dead,6);assert.ok(page.nextCursor);
  const next=await json(await runtime.request(`${deliveries(box,notice)}?limit=5&cursor=${page.nextCursor}`));assert.equal(next.deliveries.length,1);assert.ok(!page.deliveries.some(item=>item.id===next.deliveries[0].id));
  const target=page.deliveries[0],path=detail(box,notice,target);await runtime.updateBindings({WEBHOOK_KEYRING:''});const info=await json(await runtime.request(path));assert.equal(info.attempts.length,1);assert.equal(info.delivery.retry.available,false);assert.deepEqual(await counts(),before);assert.equal(state.calls.length,calls);safe(info);
  const token=(await json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'No Owner tracing',scopes:['mail:read']}}),201)).secret;
  for(const route of [deliveries(box,notice),path])await json(await runtime.request(route,{authenticated:false,headers:{Authorization:`Bearer ${token}`}}),401);
  await json(await runtime.request(detail(other,notice,target)),404);await json(await runtime.request(detail(box,{id:randomUUID()},target)),404);
  await json(await runtime.request(`${deliveries(box,notice)}?limit=4&cursor=${page.nextCursor}`),400);await json(await runtime.request(`${deliveries(other,notice)}?limit=5&cursor=${page.nextCursor}`),400);
  for(const query of ['?limit=5&limit=5','?limit=0','?cursor=invalid','?extra=1'])await json(await runtime.request(deliveries(box,notice)+query),400);
  await json(await runtime.request(`${path}/retry`,{method:'POST',body:{clientRequestId:randomUUID(),expectedUpdatedAt:target.updatedAt},headers:{Origin:'https://evil.example'}}),403);await json(await runtime.request(`${path}/retry?extra=1`,{method:'POST',body:{}}),400);
});

test('current policy blocks dedicated and generic retries while original skipped decisions remain immutable with no synthetic deliveries',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime);await endpoint(runtime,box);const notice=await capture(runtime,box);await tick(runtime);await tick(runtime);const page=await json(await runtime.request(deliveries(box,notice))),target=page.deliveries[0],input={clientRequestId:randomUUID(),expectedUpdatedAt:target.updatedAt};
  await policy(runtime,box,{enabled:false});const blocked=await json(await runtime.request(detail(box,notice,target)));assert.equal(blocked.notification.notificationDecision,'allowed');assert.equal(blocked.delivery.retry.reason,'notifications_disabled');assert.equal(blocked.currentPolicy.enabled,false);
  const calls=state.calls.length;for(const route of [`${detail(box,notice,target)}/retry`,`${base(box)}/webhook-deliveries/${target.id}/retry`])await json(await runtime.request(route,{method:'POST',body:input}),409);
  const skipped=await capture(runtime,box);await tick(runtime);await tick(runtime);const result=await json(await runtime.request(deliveries(box,skipped)));assert.equal(result.notification.notificationDecision,'disabled');assert.equal(result.publication,'published');assert.equal(result.deliverySummary.total,0);assert.deepEqual(result.deliveries,[]);assert.equal(state.calls.length,calls);
  await json(await runtime.request(detail(box,skipped,target)+'/retry',{method:'POST',body:input}),404);assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n'),0);safe(result);safe(blocked);
});
