import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac,randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const topics=['alert_notification.retry_batch.completed','alert_notification.retry_batch.failed','alert_notification.retry_batch.needs_reconciliation'];
const bindings={WEBHOOK_KEYRING:JSON.stringify({activeKid:'batch-notices',keys:{'batch-notices':'A'.repeat(43)}})};
const base=box=>`/owner/api/mailboxes/${box.id}`;
const notices=box=>`${base(box)}/retry-batch-notifications`;
const batches=box=>`${base(box)}/export-notification-retry-batches`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function tick(runtime){assert.equal((await(await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
async function mailbox(runtime){return(await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Batch notifications',localPart:`notices-${randomUUID()}`}}),201)).mailbox;}
async function runtimeFor(state){return createOwnerRuntime({bindings,outboundService:async request=>{
  const url=new URL(request.url);assert.equal(url.hostname,'hooks.example.net');const body=await request.text(),headers=Object.fromEntries(request.headers);state.calls.push({path:url.pathname,body,headers});
  return new Response(null,{status:url.pathname.startsWith('/notices-')?state.noticeStatus:400});
}});}
async function endpoint(runtime,box,path,eventTypes){return json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net/${path}`,eventTypes}}),201);}
async function selection(runtime,box){
  await endpoint(runtime,box,`source-${randomUUID()}`,['alert_notification.export.succeeded']);await new Promise(resolve=>setTimeout(resolve,2));
  const job=(await json(await runtime.request(`${base(box)}/alert-notification-exports`,{method:'POST',body:{clientRequestId:randomUUID(),format:'json'}}),202)).job;
  await tick(runtime);await tick(runtime);
  const selected=await json(await runtime.request(`${batches(box)}/preview`,{method:'POST',body:{clientRequestId:randomUUID(),reason:'http_rejected'}}),201);
  return {...await json(await runtime.request(`${batches(box)}/${selected.batch.id}/commit`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:selected.batch.version}}),202),job};
}
async function policy(runtime,box,changes){const {version,updatedAt,...settings}=(await json(await runtime.request(`${base(box)}/alert-notification-policy`))).policy;return json(await runtime.request(`${base(box)}/alert-notification-policy`,{method:'PATCH',body:{...settings,...changes,expectedVersion:version}}));}
function safe(value){const serialized=JSON.stringify(value);for(const field of ['https://','payload_json','signing_secret','lease_token','claim_token','object_key','client_request_id'])assert.equal(serialized.includes(field),false,field);}
function signed(call,secret){const match=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(call.headers['x-agent-mail-signature']);assert.ok(match);assert.equal(match[2],createHmac('sha256',secret).update(`${match[1]}.${call.headers['x-agent-mail-delivery']}.${call.body}`).digest('hex'));for(const field of ['authorization','cookie','origin','cf-access-jwt-assertion'])assert.equal(call.headers[field],undefined);}

test('completed batches create one durable Owner notice and reuse frozen signed automatic Webhook retries without implying HTTP success',{timeout:120_000},async t=>{
  const state={calls:[],noticeStatus:503},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),subscription=await endpoint(runtime,box,`notices-${randomUUID()}`,topics),selected=await selection(runtime,box);
  await tick(runtime);const page=await json(await runtime.request(`${notices(box)}?status=all`));assert.equal(page.notifications.length,1);const notice=page.notifications[0];
  assert.equal(notice.kind,'completed');assert.equal(notice.batchId,selected.batch.id);assert.equal(notice.requeuedItems,1);assert.equal(notice.unknownItems,0);assert.equal(notice.currentAttention,false);assert.equal(page.summary.unread,1);safe(page);
  const original=await runtime.db.prepare('SELECT state FROM webhook_deliveries WHERE event_id=(SELECT event_id FROM async_export_notifications WHERE job_id=?)').bind(selected.job.id).first();assert.equal(original.state,'pending','Completion is a queue-operation result, not HTTP delivery');
  await tick(runtime);const delivery=await runtime.db.prepare('SELECT d.* FROM webhook_deliveries d JOIN events e ON e.id=d.event_id WHERE e.type=? AND d.mailbox_id=?').bind(topics[0],box.id).first();assert.equal(delivery.state,'pending');assert.equal(delivery.attempts,1);
  state.noticeStatus=204;await runtime.db.prepare('UPDATE webhook_deliveries SET available_at=? WHERE id=?').bind(Date.now(),delivery.id).run();await tick(runtime);
  const sent=state.calls.filter(call=>call.path.startsWith('/notices-'));assert.equal(sent.length,2);assert.equal(sent[0].body,sent[1].body);assert.equal(sent[0].headers['x-agent-mail-delivery'],sent[1].headers['x-agent-mail-delivery']);for(const call of sent)signed(call,subscription.secret);
  assert.equal((await runtime.db.prepare('SELECT state FROM webhook_deliveries WHERE id=?').bind(delivery.id).first()).state,'succeeded');
  const before=await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n'),calls=state.calls.length;await json(await runtime.request(`${notices(box)}/${notice.id}`));await json(await runtime.request(`${notices(box)}?status=all`));assert.equal(await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n'),before);assert.equal(state.calls.length,calls);
  const layout=await runtime.request('/owner/mailboxes/__data.json');assert.match(await layout.text(),/retryBatchNotificationNotice/);
  await json(await runtime.request(`${notices(box)}/${notice.id}/acknowledge`,{method:'POST',body:{expectedVersion:notice.version}}));await json(await runtime.request(`${notices(box)}/${notice.id}/acknowledge`,{method:'POST',body:{expectedVersion:notice.version}}),409);
  await tick(runtime);assert.equal((await json(await runtime.request(`${notices(box)}?status=all`))).notifications.length,1);assert.equal((await json(await runtime.request(notices(box)))).summary.unread,0);
});

test('cancelled in-flight entries produce a reconciliation alert whose immutable snapshot survives acknowledgement and later proof of non-submission',{timeout:120_000},async t=>{
  const state={calls:[],noticeStatus:204},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),selected=await selection(runtime,box),at=Date.now();
  await runtime.db.prepare("UPDATE async_export_notification_retry_items SET state='running',lease_token=?,lease_until=?,version=version+1,updated_at=MAX(updated_at+1,?) WHERE batch_id=?").bind(randomUUID(),at+120000,at,selected.batch.id).run();
  const cancelled=await json(await runtime.request(`${batches(box)}/${selected.batch.id}/cancel`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:selected.batch.version}}));assert.equal(cancelled.batch.unknownItems,1);
  let page=await json(await runtime.request(`${notices(box)}?status=all`));assert.equal(page.notifications.length,1);const notice=page.notifications[0];assert.equal(notice.kind,'needs_reconciliation');assert.equal(notice.batchState,'cancelled');assert.equal(notice.currentAttention,true);assert.equal(page.summary.attention,1);
  const calls=state.calls.length;await json(await runtime.request(`${batches(box)}/${selected.batch.id}/reconcile`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:cancelled.batch.version}}));
  const after=(await json(await runtime.request(`${notices(box)}/${notice.id}`))).notification;assert.equal(after.currentAttention,false);assert.equal(after.unknownItems,1,'Historical fact cannot be rewritten by a later reconciliation');assert.equal(after.acknowledgedAt,null);assert.equal(state.calls.length,calls);
  await runtime.updateBindings({WEBHOOK_KEYRING:''});await tick(runtime);page=await json(await runtime.request(`${notices(box)}?status=all`));assert.equal(page.summary.unread,1);assert.equal(page.summary.attention,0);assert.equal(page.notifications.length,1,'Cancellation is not a completion');safe(page);
  await runtime.db.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(box.id).run();await json(await runtime.request(`${notices(box)}/${notice.id}/acknowledge`,{method:'POST',body:{expectedVersion:notice.version}}));
});

test('execution failures alert independently of Webhook policy and enforce Owner scope, origin, cursor filters and Agent event isolation',{timeout:120_000},async t=>{
  const state={calls:[],noticeStatus:204},runtime=await runtimeFor(state);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),other=await mailbox(runtime);await endpoint(runtime,box,`notices-${randomUUID()}`,topics);const selected=await selection(runtime,box);
  // Preserve the immutable delivery snapshot; remove its wrapping key to exercise a real validation failure.
  await runtime.updateBindings({WEBHOOK_KEYRING:JSON.stringify({activeKid:'rotated',keys:{rotated:'A'.repeat(43)}})});
  await tick(runtime);await policy(runtime,box,{enabled:false});await tick(runtime);
  const page=await json(await runtime.request(`${notices(box)}?status=all&limit=1`));assert.equal(page.notifications.length,1);assert.ok(page.nextCursor);assert.equal(page.summary.unread,2);assert.equal(page.summary.failed,1);assert.equal(page.summary.completed,1);
  const second=await json(await runtime.request(`${notices(box)}?status=all&limit=1&cursor=${page.nextCursor}`));assert.equal(second.notifications.length,1);assert.notEqual(page.notifications[0].id,second.notifications[0].id);
  const both=[...page.notifications,...second.notifications];assert.ok(both.every(notice=>notice.notificationDecision==='disabled'));assert.equal(state.calls.filter(call=>call.path.startsWith('/notices-')).length,0);assert.equal((await json(await runtime.request(`${notices(box)}?status=all&kind=failed`))).notifications.length,1);
  const notice=both[0],token=(await json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'Read mail',scopes:['mail:read']}}),201)).secret;
  for(const route of [notices(box),`${notices(box)}/${notice.id}`])await json(await runtime.request(route,{authenticated:false,headers:{Authorization:`Bearer ${token}`}}),401);
  await json(await runtime.request(`${notices(other)}/${notice.id}`),404);await json(await runtime.request(`${notices(box)}/${notice.id}/acknowledge`,{method:'POST',body:{expectedVersion:notice.version},headers:{Origin:'https://evil.example'}}),403);
  await json(await runtime.request(`${notices(box)}?status=all&kind=failed&limit=1&cursor=${page.nextCursor}`),400);for(const query of ['?kind=other','?limit=0','?status=all&status=all','?extra=1'])await json(await runtime.request(notices(box)+query),400);
  const eventPage=await json(await runtime.request('/v1/events',{authenticated:false,headers:{Authorization:`Bearer ${token}`}}));assert.ok(eventPage.events.every(event=>!topics.includes(event.type)));
  safe(page);safe(second);
});
