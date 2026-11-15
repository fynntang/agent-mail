import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac,randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const succeeded='alert_notification.export.succeeded',failed='alert_notification.export.failed';
const bindings={WEBHOOK_KEYRING:JSON.stringify({activeKid:'export-notice-test',keys:{'export-notice-test':'A'.repeat(43)}})};
const base=box=>`/owner/api/mailboxes/${box.id}`;
const notices=box=>`${base(box)}/export-notifications`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime){return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Export notifications',localPart:`notice-${randomUUID()}`}}),201)).mailbox;}
async function tick(runtime){assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
function runtimeFor(records,status=()=>204){return createOwnerRuntime({bindings,outboundService:async request=>{
  assert.equal(new URL(request.url).hostname,'hooks.example.net');records.push({headers:Object.fromEntries(request.headers),body:await request.text()});return new Response(null,{status:status()});
}});}
async function endpoint(runtime,box,types=[succeeded,failed]){const result=await json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net/${randomUUID()}`,eventTypes:types}}),201);
  // Completion eligibility deliberately excludes endpoints created in its exact millisecond.
  await new Promise(resolve=>setTimeout(resolve,2));return result;
}
async function create(runtime,box,format='json',fail=false){
  const job=(await json(await runtime.request(`${base(box)}/alert-notification-exports`,{method:'POST',body:{format,clientRequestId:randomUUID()}}),202)).job;
  if(fail)await runtime.db.prepare("UPDATE async_alert_notification_exports SET summary_json='{}',version=version+1,updated_at=updated_at+1 WHERE id=?").bind(job.id).run();
  return job;
}
async function save(runtime,box,changes){const policy=(await json(await runtime.request(`${base(box)}/alert-notification-policy`))).policy;
  const {version,updatedAt,...settings}=policy;return json(await runtime.request(`${base(box)}/alert-notification-policy`,{method:'PATCH',body:{...settings,...changes,expectedVersion:version}}));}
async function getNotice(runtime,box,id){return (await json(await runtime.request(`${notices(box)}/${id}`))).notification;}
function signed(record,secret){const signature=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(record.headers['x-agent-mail-signature']);assert.ok(signature);
  assert.equal(signature[2],createHmac('sha256',secret).update(`${signature[1]}.${record.headers['x-agent-mail-delivery']}.${record.body}`).digest('hex'));
  for(const header of ['authorization','cookie','origin','referer','cf-access-jwt-assertion'])assert.equal(record.headers[header],undefined);
  const data=JSON.parse(record.body);safe(data);return data;
}
function safe(data){const text=JSON.stringify(data);for(const value of ['object_key','lease_token','claim_token','request_hash','signing_secret','PRIVATE_NOTIFY','https://','from_ms','filter_decision'])assert.equal(text.includes(value),false,value);}

test('terminal export receipts survive cleanup, project once, and reuse signed retryable mailbox Webhooks without changing suppression decision statistics',{timeout:120_000},async t=>{
  const records=[];let status=500;const runtime=await runtimeFor(records,()=>status);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),subscription=await endpoint(runtime,box);
  const sourceId=randomUUID(),alertId=randomUUID(),at=Date.now()-1000;
  await runtime.db.batch([
    runtime.db.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at,webhook_published_at)
      VALUES(?,?,'app',?,'cloudflare.suppression.alert.created',?,?,?,?)`)
      .bind(sourceId,box.id,sourceId,JSON.stringify({alertId,kind:'sync',status:'open',outcome:'failed',errorCode:'cloudflare_api_unavailable'}),at,at,at),
    runtime.db.prepare("INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token) VALUES(?,?,?,'allowed',0,?,'PRIVATE_NOTIFY_CLAIM')")
      .bind(sourceId,box.id,alertId,at)
  ]);
  const good=await create(runtime,box),bad=await create(runtime,box,'csv',true);await tick(runtime);
  const page=await json(await runtime.request(`${notices(box)}?status=all`));assert.equal(page.notifications.length,2);assert.equal(page.summary.unread,2);safe(page);
  assert.equal((await getNotice(runtime,box,good.id)).outcome,'succeeded');assert.equal((await getNotice(runtime,box,bad.id)).errorCode,'async_export_source_changed');
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM alert_notification_decisions WHERE mailbox_id=?').bind(box.id).first('n'),1);
  const download=await runtime.request(`${base(box)}/alert-notification-exports/${good.id}/download`);assert.equal(download.status,200);
  const exported=await download.json();assert.equal(exported.decisions.length,1);assert.equal(exported.decisions[0].eventId,sourceId);
  assert.equal((await runtime.bucket.list({prefix:`exports/alert-notification/${box.id}/${good.id}/`})).objects.length,1,'A terminal notification trigger must not cause deletion of a committed export fragment');
  await tick(runtime);assert.equal(records.length,2);const first=records.map(record=>signed(record,subscription.secret));assert.deepEqual(new Set(first.map(item=>item.type)),new Set([succeeded,failed]));
  for(const event of first){assert.equal(event.mailboxId,box.id);assert.ok([good.id,bad.id].includes(event.data.jobId));assert.equal(event.data.state,event.type===succeeded?'succeeded':'failed');}
  status=204;await runtime.db.prepare("UPDATE webhook_deliveries SET available_at=0 WHERE mailbox_id=? AND state='pending'").bind(box.id).run();await tick(runtime);assert.equal(records.length,4);
  for(const record of records.slice(2)){signed(record,subscription.secret);assert.equal(record.headers['x-agent-mail-attempt'],'2');assert.ok(records.slice(0,2).some(original=>original.headers['x-agent-mail-delivery']===record.headers['x-agent-mail-delivery']&&original.body===record.body));}
  await tick(runtime);assert.equal(records.length,4);assert.equal(await runtime.db.prepare("SELECT count(*) n FROM events WHERE mailbox_id=? AND type LIKE 'alert_notification.export.%'").bind(box.id).first('n'),2);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM async_export_notifications WHERE mailbox_id=?').bind(box.id).first('n'),2);
  const deliveries=await json(await runtime.request(`${base(box)}/webhook-deliveries`));assert.equal(deliveries.deliveries.length,2);assert.ok(deliveries.deliveries.every(item=>item.state==='succeeded'&&item.attempts===2));
});

test('export notifications reuse disabled, quiet and repeat policies; completion ignores the recovery switch and skipped events never replay',{timeout:120_000},async t=>{
  const records=[],runtime=await runtimeFor(records);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),subscription=await endpoint(runtime,box);
  await save(runtime,box,{enabled:false});const disabled=await create(runtime,box);await tick(runtime);await tick(runtime);assert.equal((await getNotice(runtime,box,disabled.id)).notificationDecision,'disabled');assert.equal(records.length,0);
  const now=new Date(),minute=now.getUTCHours()*60+now.getUTCMinutes();await save(runtime,box,{enabled:true,quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440,timeZone:'UTC'});
  const quiet=await create(runtime,box);await tick(runtime);await tick(runtime);assert.equal((await getNotice(runtime,box,quiet.id)).notificationDecision,'quiet_hours');assert.equal(records.length,0);
  await save(runtime,box,{quietEnabled:false,recoveryEnabled:false,repeatIntervalSeconds:3600});const allowed=await create(runtime,box);await tick(runtime);await tick(runtime);assert.equal((await getNotice(runtime,box,allowed.id)).notificationDecision,'allowed');assert.equal(records.length,1);assert.equal(signed(records[0],subscription.secret).type,succeeded);
  const limited=await create(runtime,box);await tick(runtime);await tick(runtime);assert.equal((await getNotice(runtime,box,limited.id)).notificationDecision,'repeat_limited');assert.equal(records.length,1);
  const bad=await create(runtime,box,'json',true);await tick(runtime);await tick(runtime);assert.equal((await getNotice(runtime,box,bad.id)).notificationDecision,'allowed');assert.equal(records.length,2);
  await save(runtime,box,{repeatIntervalSeconds:0});await tick(runtime);assert.equal(records.length,2,'Previously skipped receipts must not replay');
  assert.equal((await json(await runtime.request(`${notices(box)}?status=all`))).summary.unread,5);assert.equal(await runtime.db.prepare('SELECT count(*) n FROM alert_notification_decisions WHERE mailbox_id=?').bind(box.id).first('n'),0);
});

test('Owner receipts have read-only scoped pagination, CAS acknowledgment and global reminders; agents cannot enumerate notification events or deliveries',{timeout:120_000},async t=>{
  const records=[],runtime=await runtimeFor(records);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),other=await mailbox(runtime),subscription=await endpoint(runtime,box);
  const first=await create(runtime,box),second=await create(runtime,box,'csv');await tick(runtime);await tick(runtime);
  const before=await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n'),page=await json(await runtime.request(`${notices(box)}?status=all&limit=1`));assert.equal(page.notifications.length,1);assert.ok(page.nextCursor);
  const next=await json(await runtime.request(`${notices(box)}?status=all&limit=1&cursor=${page.nextCursor}`));assert.equal(next.notifications.length,1);assert.notEqual(page.notifications[0].id,next.notifications[0].id);
  await json(await runtime.request(`${notices(other)}?status=all&limit=1&cursor=${page.nextCursor}`),400);await json(await runtime.request(`${notices(box)}?status=all&status=unread`),400);
  await json(await runtime.request(`${notices(other)}/${first.id}`),404);await json(await runtime.request(`${notices(box)}/${first.id}?extra=1`),400);
  const receipt=await getNotice(runtime,box,first.id);safe(receipt);assert.equal(await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n'),before);
  const global=await runtime.request('/owner/mailboxes');assert.match(await global.text(),/导出通知/);
  await json(await runtime.request(`${notices(box)}/${first.id}/acknowledge`,{method:'POST',body:{expectedVersion:receipt.version},headers:{Origin:'https://evil.example'}}),403);
  const acknowledged=await json(await runtime.request(`${notices(box)}/${first.id}/acknowledge`,{method:'POST',body:{expectedVersion:receipt.version}}));assert.ok(acknowledged.notification.acknowledgedAt);
  await json(await runtime.request(`${notices(box)}/${first.id}/acknowledge`,{method:'POST',body:{expectedVersion:receipt.version}}),409);
  assert.equal((await json(await runtime.request(notices(box)))).summary.unread,1);assert.equal((await json(await runtime.request(`${notices(box)}?status=acknowledged`))).notifications[0].jobId,first.id);
  const token=(await json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'No export notices',scopes:['mail:read']}}),201)).secret;
  for(const path of [notices(box),`${notices(box)}/${second.id}`]){assert.equal((await runtime.request(path,{authenticated:false})).status,401);assert.equal((await runtime.request(path,{authenticated:false,headers:{Authorization:`Bearer ${token}`}})).status,401);}
  const agentRequest=path=>runtime.mf.dispatchFetch(`https://api.example.com${path}`,{headers:{Authorization:`Bearer ${token}`}});
  assert.deepEqual((await json(await agentRequest('/v1/events'))).events,[]);assert.deepEqual((await json(await agentRequest('/v1/webhook-deliveries'))).deliveries,[]);
  const agentEndpoints=await json(await agentRequest('/v1/webhooks'));assert.ok(!agentEndpoints.eventTypes.includes(succeeded));assert.deepEqual(agentEndpoints.endpoints[0].eventTypes,[]);
  const delivery=await runtime.db.prepare('SELECT id FROM webhook_deliveries WHERE mailbox_id=? LIMIT 1').bind(box.id).first('id');await json(await agentRequest(`/v1/webhook-deliveries/${delivery}`),404);
  assert.equal((await agentRequest('/v1/export-notifications')).status,404);
});

test('cancelled exports create no terminal notice and late subscriptions do not receive already completed exports',{timeout:120_000},async t=>{
  const records=[],runtime=await runtimeFor(records);t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),cancelled=await create(runtime,box);
  await json(await runtime.request(`${base(box)}/alert-notification-exports/${cancelled.id}/cancel`,{method:'POST',body:{expectedVersion:cancelled.version}}));await tick(runtime);
  assert.equal((await json(await runtime.request(notices(box)))).notifications.length,0);
  const completed=await create(runtime,box);await tick(runtime);const receipt=await getNotice(runtime,box,completed.id);assert.equal(receipt.outcome,'succeeded');
  await endpoint(runtime,box);await tick(runtime);assert.equal(records.length,0);assert.equal((await getNotice(runtime,box,completed.id)).notificationDecision,'no_subscribers');
  await runtime.db.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(box.id).run();assert.equal((await getNotice(runtime,box,completed.id)).outcome,'succeeded');
  const before=await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n');await json(await runtime.request(`${notices(box)}?status=all`));assert.equal(await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n'),before);
});
