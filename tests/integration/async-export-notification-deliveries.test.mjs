import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac,randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const type='alert_notification.export.succeeded';
const bindings={WEBHOOK_KEYRING:JSON.stringify({activeKid:'delivery-history',keys:{'delivery-history':'A'.repeat(43)}})};
const base=box=>`/owner/api/mailboxes/${box.id}`;
const notices=(box,job)=>`${base(box)}/export-notifications/${job.id}`;
const resultPath=(box,job)=>`${notices(box,job)}/delivery-results`;
const deliveryPath=(box,job,delivery)=>`${notices(box,job)}/deliveries/${delivery.id}`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function box(runtime){return(await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Tracked export',localPart:`tracking-${randomUUID()}`}}),201)).mailbox;}
async function tick(runtime){assert.equal((await(await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
async function endpoint(runtime,mailbox){const value=await json(await runtime.request(`${base(mailbox)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net/${randomUUID()}`,eventTypes:[type]}}),201);await new Promise(resolve=>setTimeout(resolve,2));return value;}
async function create(runtime,mailbox){return(await json(await runtime.request(`${base(mailbox)}/alert-notification-exports`,{method:'POST',body:{clientRequestId:randomUUID(),format:'json'}}),202)).job;}
async function policy(runtime,mailbox,changes){const {version,updatedAt,...settings}=(await json(await runtime.request(`${base(mailbox)}/alert-notification-policy`))).policy;
  return json(await runtime.request(`${base(mailbox)}/alert-notification-policy`,{method:'PATCH',body:{...settings,...changes,expectedVersion:version}}));}
async function runtimeFor(state){return createOwnerRuntime({bindings,outboundService:async request=>{
  assert.equal(new URL(request.url).hostname,'hooks.example.net');state.calls.push({headers:Object.fromEntries(request.headers),body:await request.text()});return new Response(null,{status:state.status});
}});}
function safe(value){const text=JSON.stringify(value);for(const marker of ['https://','url_snapshot','payload_json','signing_secret','claim_token','lease_token','object_key','PRIVATE_TRACKING'])assert.equal(text.includes(marker),false,marker);}
function signed(call,secret){const signature=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(call.headers['x-agent-mail-signature']);assert.ok(signature);
  assert.equal(signature[2],createHmac('sha256',secret).update(`${signature[1]}.${call.headers['x-agent-mail-delivery']}.${call.body}`).digest('hex'));
  for(const header of ['authorization','cookie','cf-access-jwt-assertion','origin','referer'])assert.equal(call.headers[header],undefined);
}

test('Owner tracks scoped decisions and attempts and safely retries one dead delivery with stable HMAC identity and an idempotent audit receipt',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime),subscriptions=[await endpoint(runtime,mailbox),await endpoint(runtime,mailbox)],job=await create(runtime,mailbox);
  // Capture the real terminal trigger before the scheduled projector is allowed to run.
  const terminalAt=Date.now();await runtime.db.batch([
    runtime.db.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token=?,lease_until=?,started_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(randomUUID(),terminalAt+120000,terminalAt,job.id),
    runtime.db.prepare("UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(terminalAt,job.id)
  ]);
  const pending=await json(await runtime.request(resultPath(mailbox,job)));assert.equal(pending.publication,'pending_projection');assert.equal(pending.notification.notificationDecision,null);assert.equal(pending.deliverySummary.total,0);
  await tick(runtime);const projected=await json(await runtime.request(resultPath(mailbox,job)));assert.equal(projected.publication,'pending_publication');await tick(runtime);
  const results=await json(await runtime.request(resultPath(mailbox,job)));safe(results);assert.equal(results.publication,'published');assert.equal(results.notification.notificationDecision,'allowed');assert.equal(results.deliverySummary.total,2);assert.equal(results.deliverySummary.dead,2);assert.equal(results.deliverySummary.attempts,2);
  const target=results.deliveries[0],path=deliveryPath(mailbox,job,target),detail=await json(await runtime.request(path));safe(detail);assert.equal(detail.delivery.retry.available,true);assert.equal(detail.attempts.length,1);assert.equal(detail.attempts[0].httpStatus,400);assert.equal(detail.manualRetries.length,0);
  const input={clientRequestId:randomUUID(),expectedUpdatedAt:target.updatedAt},before=state.calls.length;
  const queued=await json(await runtime.request(`${path}/retry`,{method:'POST',body:input}));safe(queued);assert.equal(queued.delivery.id,target.id);assert.equal(queued.delivery.state,'pending');assert.equal(queued.replayed,false);assert.equal(queued.delivery.attemptBudget,target.attemptBudget+8);assert.equal(state.calls.length,before,'Retry API must not perform transport');
  const replay=await json(await runtime.request(`${path}/retry`,{method:'POST',body:input}));assert.equal(replay.replayed,true);assert.equal(replay.manualRetry.id,queued.manualRetry.id);assert.equal(replay.delivery.attemptBudget,queued.delivery.attemptBudget);
  await json(await runtime.request(`${path}/retry`,{method:'POST',body:{...input,expectedUpdatedAt:input.expectedUpdatedAt+1}}),409);
  state.status=204;await tick(runtime);assert.equal(state.calls.length,before+1);const current=await json(await runtime.request(path));assert.equal(current.delivery.state,'succeeded');assert.equal(current.attempts.length,2);assert.equal(current.manualRetries.length,1);assert.equal(current.manualRetries[0].clientRequestId,input.clientRequestId);assert.equal(current.delivery.retry.available,false);
  const sent=state.calls.filter(call=>call.headers['x-agent-mail-delivery']===target.id);assert.equal(sent.length,2);assert.equal(sent[0].body,sent[1].body);assert.equal(sent[0].headers['x-agent-mail-secret-version'],sent[1].headers['x-agent-mail-secret-version']);assert.equal(sent[1].headers['x-agent-mail-attempt'],'2');
  const subscription=subscriptions.find(item=>item.endpoint.id===target.endpointId);for(const call of sent)signed(call,subscription.secret);
  assert.equal((await json(await runtime.request(`${path}/retry`,{method:'POST',body:input}))).replayed,true);
  await json(await runtime.request(`${path}/retry`,{method:'POST',body:{clientRequestId:randomUUID(),expectedUpdatedAt:current.delivery.updatedAt}}),409);
  assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE resource_id=? AND action='webhook.delivery_retried'").bind(target.id).first('n'),1);
});

test('tracking uses real delivery pagination, keeps reads side-effect free and rejects foreign jobs, mailbox cursors, Agents and cross-origin retries',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime),other=await box(runtime);
  for(let i=0;i<6;i++)await endpoint(runtime,mailbox);const job=await create(runtime,mailbox);await tick(runtime);await tick(runtime);
  const before=await runtime.db.prepare('SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM webhook_delivery_attempts) attempts,(SELECT count(*) FROM events) events').first(),calls=state.calls.length;
  const page=await json(await runtime.request(`${resultPath(mailbox,job)}?limit=5`));assert.equal(page.deliveries.length,5);assert.ok(page.nextCursor);assert.equal(page.deliverySummary.total,6);
  const next=await json(await runtime.request(`${resultPath(mailbox,job)}?limit=5&cursor=${page.nextCursor}`));assert.equal(next.deliveries.length,1);assert.equal(page.deliveries.some(item=>item.id===next.deliveries[0].id),false);
  const target=page.deliveries.find(item=>item.state==='dead')??next.deliveries[0],path=deliveryPath(mailbox,job,target);await json(await runtime.request(path));
  await json(await runtime.request(`${resultPath(other,job)}?limit=5&cursor=${page.nextCursor}`),400);await json(await runtime.request(`${resultPath(mailbox,job)}?limit=4&cursor=${page.nextCursor}`),400);
  for(const query of ['?limit=5&limit=5','?limit=0','?status=all','?cursor=bad'])await json(await runtime.request(resultPath(mailbox,job)+query),400);
  const foreignJob={id:randomUUID()};await json(await runtime.request(deliveryPath(mailbox,foreignJob,target)),404);await json(await runtime.request(deliveryPath(other,job,target)),404);
  assert.deepEqual(await runtime.db.prepare('SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM webhook_delivery_attempts) attempts,(SELECT count(*) FROM events) events').first(),before);assert.equal(state.calls.length,calls);
  const token=(await json(await runtime.request(`${base(mailbox)}/tokens`,{method:'POST',body:{name:'No Owner tracking',scopes:['mail:read']}}),201)).secret;
  for(const route of [resultPath(mailbox,job),path]){await json(await runtime.request(route,{authenticated:false}),401);await json(await runtime.request(route,{authenticated:false,headers:{Authorization:`Bearer ${token}`}}),401);}
  await json(await runtime.request(`${path}/retry`,{method:'POST',body:{clientRequestId:randomUUID(),expectedUpdatedAt:target.updatedAt},headers:{Origin:'https://evil.example'}}),403);
  await json(await runtime.request(`${path}/retry?extra=1`,{method:'POST',body:{clientRequestId:randomUUID(),expectedUpdatedAt:target.updatedAt}}),400);
  safe(page);safe(next);
});

test('live policy blocks retries through both dedicated and generic routes while skipped notices retain their original decision without a replay action',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime);await endpoint(runtime,mailbox);const job=await create(runtime,mailbox);await tick(runtime);await tick(runtime);
  const results=await json(await runtime.request(resultPath(mailbox,job))),target=results.deliveries[0],path=deliveryPath(mailbox,job,target),input={clientRequestId:randomUUID(),expectedUpdatedAt:target.updatedAt};
  await policy(runtime,mailbox,{enabled:false});assert.equal((await json(await runtime.request(path))).delivery.retry.reason,'notifications_disabled');await json(await runtime.request(`${path}/retry`,{method:'POST',body:input}),409);
  await json(await runtime.request(`${base(mailbox)}/webhook-deliveries/${target.id}/retry`,{method:'POST',body:input}),409);
  const skipped=await create(runtime,mailbox);await tick(runtime);await tick(runtime);const blocked=await json(await runtime.request(resultPath(mailbox,skipped)));assert.equal(blocked.notification.notificationDecision,'disabled');assert.equal(blocked.deliverySummary.total,0);assert.deepEqual(blocked.deliveries,[]);
  await json(await runtime.request(deliveryPath(mailbox,skipped,target)+'/retry',{method:'POST',body:input}),404);
  const now=new Date(),minute=now.getUTCHours()*60+now.getUTCMinutes();await policy(runtime,mailbox,{enabled:true,quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440,timeZone:'UTC'});
  assert.equal((await json(await runtime.request(path))).delivery.retry.reason,'quiet_hours');await json(await runtime.request(`${path}/retry`,{method:'POST',body:input}),409);
  await policy(runtime,mailbox,{quietEnabled:false});await runtime.db.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(mailbox.id).run();assert.equal((await json(await runtime.request(path))).delivery.retry.reason,'mailbox_inactive');await json(await runtime.request(`${path}/retry`,{method:'POST',body:input}),409);
  assert.equal(state.calls.length,1);assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE action='webhook.delivery_retried'").first('n'),0);
});

test('concurrent retry requests share one CAS winner and repeated intent cannot spend another budget after transport fails again',{timeout:120_000},async t=>{
  const state={status:400,calls:[]},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const mailbox=await box(runtime);await endpoint(runtime,mailbox);const job=await create(runtime,mailbox);await tick(runtime);await tick(runtime);
  const target=(await json(await runtime.request(resultPath(mailbox,job)))).deliveries[0],path=deliveryPath(mailbox,job,target),requests=[{clientRequestId:randomUUID(),expectedUpdatedAt:target.updatedAt},{clientRequestId:randomUUID(),expectedUpdatedAt:target.updatedAt}];
  const raced=await Promise.all(requests.map(body=>runtime.request(`${path}/retry`,{method:'POST',body})));assert.deepEqual(raced.map(item=>item.status).sort(),[200,409]);const winning=raced.findIndex(item=>item.status===200),receipt=await raced[winning].json();
  await tick(runtime);const dead=await json(await runtime.request(path));assert.equal(dead.delivery.state,'dead');assert.equal(dead.manualRetries.length,1);
  const replay=await json(await runtime.request(`${path}/retry`,{method:'POST',body:requests[winning]}));assert.equal(replay.replayed,true);assert.equal(replay.delivery.state,'dead');assert.equal(replay.delivery.attemptBudget,receipt.delivery.attemptBudget);
  await json(await runtime.request(`${base(mailbox)}/webhook-deliveries/${target.id}/retry`,{method:'POST',body:{}}),400);
  const generic={clientRequestId:randomUUID(),expectedUpdatedAt:dead.delivery.updatedAt},queued=await json(await runtime.request(`${base(mailbox)}/webhook-deliveries/${target.id}/retry`,{method:'POST',body:generic}));assert.equal(queued.delivery.state,'pending');
  const current=await json(await runtime.request(path));assert.equal(current.manualRetries.length,2);assert.equal(current.delivery.attemptBudget,target.attemptBudget+16);safe(current);
});
