import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac,randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const accountId='a'.repeat(32),domain='agent.example.com',providerToken='POLICY_CF_PRIVATE_TEST_ONLY_12345678901234567890';
const createdType='cloudflare.suppression.alert.created',resolvedType='cloudflare.suppression.alert.resolved';
const bindings={EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain,
  WEBHOOK_KEYRING:JSON.stringify({activeKid:'policy-key',keys:{'policy-key':'A'.repeat(43)}})};
const cfPath=`/client/v4/accounts/${accountId}/email/sending/suppressions`;
const base=box=>`/owner/api/mailboxes/${box.id}`;
const policyPath=box=>`${base(box)}/alert-notification-policy`;
const syncPath=box=>`${base(box)}/cloudflare-suppressions/sync`;
const alertsPath=box=>`${base(box)}/cloudflare-suppression-alerts?status=all`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime,name='Policy Agent'){return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name,localPart:`policy-${randomUUID()}`}}),201)).mailbox;}
async function tick(runtime){assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
function stateFor(){return {failSync:true,webhookStatus:204,cloudflare:[],webhooks:[]};}
function upstream(state){return async request=>{
  const url=new URL(request.url);
  if(url.hostname==='hooks.example.net'){state.webhooks.push({headers:Object.fromEntries(request.headers),body:await request.text()});return new Response(null,{status:state.webhookStatus});}
  assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(url.pathname,cfPath);assert.equal(request.method,'GET');
  assert.equal(request.headers.get('Authorization'),`Bearer ${providerToken}`);state.cloudflare.push(request.url);
  if(state.invalidSync)return Response.json({success:true,result:'PRIVATE_POLICY_PROVIDER_RESPONSE'});
  return state.failSync?Response.json({success:false,errors:[{message:'PRIVATE_POLICY_PROVIDER_RESPONSE'}]},{status:500}):Response.json({success:true,result:[],result_info:{next_cursor:null}});
};}
async function subscription(runtime,box,eventTypes=[createdType,resolvedType]){return json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net/${randomUUID()}`,eventTypes}}),201);}
async function policy(runtime,box){return (await json(await runtime.request(policyPath(box)))).policy;}
async function save(runtime,box,changes={}){const current=await policy(runtime,box),{version,updatedAt,...settings}=current;
  return (await json(await runtime.request(policyPath(box),{method:'PATCH',body:{...settings,...changes,expectedVersion:version}}))).policy;}
async function fail(runtime,box,id=randomUUID()){await json(await runtime.request(syncPath(box),{method:'POST',body:{clientRequestId:id}}),502);return id;}
async function retry(runtime,box,parent){return runtime.request(`${base(box)}/cloudflare-suppressions/history/${parent}/retry`,{method:'POST',body:{kind:'sync',clientRequestId:randomUUID()}});}
function signed(record,secret){const header=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(record.headers['x-agent-mail-signature']);assert.ok(header);
  assert.equal(header[2],createHmac('sha256',secret).update(`${header[1]}.${record.headers['x-agent-mail-delivery']}.${record.body}`).digest('hex'));
  for(const name of ['authorization','cookie','cf-access-jwt-assertion','origin','referer'])assert.equal(record.headers[name],undefined);
  for(const secretValue of [providerToken,'PRIVATE_POLICY_PROVIDER_RESPONSE'])assert.equal(record.body.includes(secretValue),false);
  return JSON.parse(record.body);
}

test('notification policy uses Owner-only strict settings and optimistic versions without calling Cloudflare; paused mailboxes remain configurable',{timeout:120_000},async t=>{
  const state=stateFor(),runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>runtime.mf.dispose());
  const a=await mailbox(runtime),b=await mailbox(runtime),initial=await policy(runtime,a);
  assert.deepEqual(initial,{enabled:true,recoveryEnabled:true,repeatIntervalSeconds:0,quietEnabled:false,quietStartMinute:1320,quietEndMinute:480,timeZone:'UTC',version:0,updatedAt:0});
  const credential=await json(await runtime.request(`${base(a)}/tokens`,{method:'POST',body:{name:'Policy forbidden',scopes:['mail:read']}}),201);
  const {version,updatedAt,...settings}=initial,body={...settings,repeatIntervalSeconds:1800,quietEnabled:true,quietStartMinute:1380,quietEndMinute:420,timeZone:'Asia/Shanghai',expectedVersion:version};
  for(const path of [policyPath(a),`${policyPath(a)}?unknown=1`])assert.equal((await runtime.request(path,{authenticated:false})).status,401);
  assert.equal((await runtime.request(policyPath(a),{authenticated:false,headers:{Authorization:`Bearer ${credential.secret}`}})).status,401);
  assert.equal((await runtime.request(policyPath(a),{method:'PATCH',body,headers:{Origin:'https://other.example'}})).status,403);
  assert.equal((await runtime.request(policyPath(a),{method:'PATCH',body,authenticated:false,headers:{Authorization:`Bearer ${credential.secret}`}})).status,401);
  assert.equal((await runtime.mf.dispatchFetch('https://api.example.com/v1/alert-notification-policy',{headers:{Authorization:`Bearer ${credential.secret}`}})).status,404);
  for(const invalid of [{...body,expectedVersion:-1},{...body,repeatIntervalSeconds:604801},{...body,enabled:1},{...body,timeZone:'not/a-zone'},
    {...body,quietStartMinute:1440},{...body,quietEndMinute:1380},{...body,accountId}])
    assert.equal((await runtime.request(policyPath(a),{method:'PATCH',body:invalid})).status,400,JSON.stringify(invalid));
  const saved=(await json(await runtime.request(policyPath(a),{method:'PATCH',body}))).policy;assert.equal(saved.version,1);assert.equal(saved.timeZone,'Asia/Shanghai');assert.equal(saved.repeatIntervalSeconds,1800);assert.ok(saved.updatedAt>0);
  assert.equal((await runtime.request(policyPath(a),{method:'PATCH',body})).status,409);assert.deepEqual(await policy(runtime,a),saved);assert.deepEqual(await policy(runtime,b),initial);
  await json(await runtime.request(base(a),{method:'PATCH',body:{status:'paused',expectedUpdatedAt:a.updatedAt}}));
  const paused=await save(runtime,a,{enabled:false});assert.equal(paused.enabled,false);assert.equal(paused.version,2);assert.equal(state.cloudflare.length,0);assert.equal(state.webhooks.length,0);
  const serialized=JSON.stringify(await json(await runtime.request(policyPath(a))));for(const forbidden of ['secret_sha256','lease_token',providerToken,accountId])assert.equal(serialized.includes(forbidden),false);
});

test('mailbox notification switches suppress every alert endpoint without hiding Owner evidence or changing ordinary mail webhooks',{timeout:120_000},async t=>{
  const state=stateFor(),runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>runtime.mf.dispose());
  const a=await mailbox(runtime,'Quiet Agent'),b=await mailbox(runtime,'Other Agent');
  const first=await subscription(runtime,a,[createdType,resolvedType,'message.received']),second=await subscription(runtime,a,[createdType,resolvedType,'message.received']),other=await subscription(runtime,b);
  await save(runtime,a,{enabled:false});await fail(runtime,a);await fail(runtime,b);
  const messageId=randomUUID(),now=Date.now();await runtime.db.prepare("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES(?,?,'app',?,'message.received',?,?,?)")
    .bind(randomUUID(),a.id,randomUUID(),JSON.stringify({messageId}),now,now).run();
  await tick(runtime);await tick(runtime);
  assert.equal(state.webhooks.length,3);const notifications=state.webhooks.map(record=>JSON.parse(record.body));
  assert.equal(notifications.filter(item=>item.mailboxId===a.id&&item.type===createdType).length,0);assert.equal(notifications.filter(item=>item.mailboxId===a.id&&item.type==='message.received').length,2);
  assert.equal(notifications.filter(item=>item.mailboxId===b.id&&item.type===createdType).length,1);
  for(const record of state.webhooks){const endpoint=await runtime.db.prepare('SELECT endpoint_id FROM webhook_deliveries WHERE id=?').bind(record.headers['x-agent-mail-delivery']).first('endpoint_id');
    signed(record,endpoint===other.endpoint.id?other.secret:endpoint===first.endpoint.id?first.secret:second.secret);}
  const aAlerts=await json(await runtime.request(alertsPath(a)));assert.equal(aAlerts.summary.open,1);
  const ownerEvents=await json(await runtime.request(base(a)+'/events'));assert.ok(ownerEvents.events.some(item=>item.type===createdType));assert.ok(ownerEvents.events.some(item=>item.type==='message.received'));
  const decision=await runtime.db.prepare('SELECT decision FROM alert_notification_decisions WHERE mailbox_id=?').bind(a.id).first('decision');assert.equal(decision,'disabled');
  await save(runtime,a,{enabled:true});await tick(runtime);assert.equal(state.webhooks.length,3,'Re-enabling must not replay skipped alert events');
  await fail(runtime,a);await tick(runtime);assert.equal(state.webhooks.length,5);assert.equal((await json(await runtime.request(alertsPath(a)))).summary.open,2);
});

test('daily quiet windows skip new alert webhooks without catch-up; recovery toggles retain resolution evidence and reset repeat history',{timeout:120_000},async t=>{
  const state=stateFor(),runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),endpoint=await subscription(runtime,box),minute=new Date().getUTCHours()*60+new Date().getUTCMinutes();
  await save(runtime,box,{quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440,timeZone:'UTC',repeatIntervalSeconds:604800});
  const source=await fail(runtime,box);await tick(runtime);assert.equal(state.webhooks.length,0);assert.equal((await json(await runtime.request(alertsPath(box)))).summary.open,1);
  assert.equal(await runtime.db.prepare('SELECT decision FROM alert_notification_decisions WHERE mailbox_id=?').bind(box.id).first('decision'),'quiet_hours');
  await save(runtime,box,{quietEnabled:false,recoveryEnabled:false});await tick(runtime);assert.equal(state.webhooks.length,0);
  await json(await retry(runtime,box,source),502);await tick(runtime);assert.equal(state.webhooks.length,1);assert.equal(signed(state.webhooks[0],endpoint.secret).type,createdType);
  state.failSync=false;await json(await retry(runtime,box,source));await tick(runtime);assert.equal(state.webhooks.length,1,'Disabled recovery notifications must not send');
  const resolved=await json(await runtime.request(alertsPath(box)));assert.equal(resolved.summary.resolved,1);assert.equal(resolved.alerts[0].outcome,'resolved');
  assert.equal(await runtime.db.prepare("SELECT count(*) n FROM alert_notification_decisions WHERE mailbox_id=? AND decision='recovery_disabled'").bind(box.id).first('n'),1);
  await save(runtime,box,{recoveryEnabled:true});await tick(runtime);assert.equal(state.webhooks.length,1,'Enabling recovery must not replay its old skipped event');
  state.failSync=true;await json(await retry(runtime,box,source),502);await tick(runtime);assert.equal(state.webhooks.length,2,'A recovered incident starts a new cycle immediately even within the repeat interval');
  const fresh=signed(state.webhooks[1],endpoint.secret);assert.equal(fresh.type,createdType);assert.equal(fresh.data.alertId,resolved.alerts[0].id);
});

test('repeat admission is shared across endpoints and independent of HTTP success; changed diagnostics bypass it while quiet and disable safely hold or cancel pending attempts',{timeout:120_000},async t=>{
  const state=stateFor();state.webhookStatus=500;const runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime);await subscription(runtime,box);await subscription(runtime,box);await save(runtime,box,{repeatIntervalSeconds:3600});
  const source=await fail(runtime,box);await tick(runtime);assert.equal(state.webhooks.length,2);
  let decisionCounts=(await runtime.db.prepare('SELECT decision,count(*) n FROM alert_notification_decisions WHERE mailbox_id=? GROUP BY decision').bind(box.id).all()).results;
  assert.deepEqual(decisionCounts,[{decision:'allowed',n:1}]);assert.equal(await runtime.db.prepare('SELECT count(*) n FROM alert_notification_state WHERE mailbox_id=? AND last_notified_at IS NOT NULL').bind(box.id).first('n'),1);
  await json(await retry(runtime,box,source),502);await tick(runtime);assert.equal(state.webhooks.length,2,'A repeated event must not create two new endpoint deliveries even when the first HTTP requests failed');
  assert.equal(await runtime.db.prepare("SELECT count(*) n FROM alert_notification_decisions WHERE mailbox_id=? AND decision='repeat_limited'").bind(box.id).first('n'),1);
  const retained=await json(await runtime.request(alertsPath(box)));assert.equal(retained.alerts.length,1);assert.equal(retained.alerts[0].occurrences,2);
  await runtime.db.prepare('UPDATE alert_notification_state SET last_notified_at=0 WHERE mailbox_id=?').bind(box.id).run();
  await json(await retry(runtime,box,source),502);await tick(runtime);assert.equal(state.webhooks.length,4,'A new occurrence after the persisted interval may notify every endpoint once');
  state.invalidSync=true;await json(await retry(runtime,box,source),502);await tick(runtime);assert.equal(state.webhooks.length,6,'A changed safe diagnostic is a new signal even inside the repeat interval');
  assert.equal(JSON.parse(state.webhooks.at(-1).body).data.errorCode,'cloudflare_api_invalid_response');
  const before=(await runtime.db.prepare('SELECT id,attempts FROM webhook_deliveries WHERE mailbox_id=? ORDER BY id').bind(box.id).all()).results;
  assert.equal(before.length,6);assert.ok(before.every(item=>item.attempts===1));
  const minute=new Date().getUTCHours()*60+new Date().getUTCMinutes();await save(runtime,box,{quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440});
  await runtime.db.prepare("UPDATE webhook_deliveries SET available_at=0 WHERE mailbox_id=? AND state='pending'").bind(box.id).run();await tick(runtime);
  assert.equal(state.webhooks.length,6);const held=(await runtime.db.prepare('SELECT id,attempts FROM webhook_deliveries WHERE mailbox_id=? ORDER BY id').bind(box.id).all()).results;assert.deepEqual(held,before,'Quiet deferrals must not consume attempt budgets');
  assert.ok(await runtime.db.prepare("SELECT count(*) n FROM webhook_deliveries WHERE mailbox_id=? AND state='pending' AND last_error_code='alert_quiet_hours' AND available_at>?").bind(box.id,Date.now()).first('n'));
  await save(runtime,box,{enabled:false});assert.equal(await runtime.db.prepare("SELECT count(*) n FROM webhook_deliveries WHERE mailbox_id=? AND state='cancelled'").bind(box.id).first('n'),6);
  await tick(runtime);assert.equal(state.webhooks.length,6);assert.equal((await json(await runtime.request(alertsPath(box)))).summary.open,1);
});
