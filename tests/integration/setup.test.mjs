import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const checks={mailDomain:true,access:true,emailRouting:true,emailSending:true};
const form=(setup,{attestations=checks,complete=false,displayName='My Agent Mail'}={})=>({
  expectedUpdatedAt:setup.instance.updatedAt,expectedConfigFingerprint:setup.configFingerprint,displayName,attestations,complete
});
async function setupOf(runtime) {
  const response=await runtime.request('/owner/api/setup');
  assert.equal(response.status,200,await response.clone().text());return (await response.json()).setup;
}
const count=(runtime,table)=>runtime.db.prepare(`SELECT count(*) n FROM ${table}`).first('n');
async function mailbox(runtime) {
  const response=await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Research',localPart:'research'}});
  assert.equal(response.status,201,await response.clone().text());return (await response.json()).mailbox;
}

test('setup APIs require verified Owner JWT and same Origin; diagnostics never initialize or expose private state',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  for(const path of ['/owner/setup','/owner/setup/__data.json','/owner/api/setup','/owner/api/setup/checks']) {
    assert.equal((await runtime.request(path,{authenticated:false})).status,401,path);
  }
  for(const path of ['/owner/api/setup','/owner/api/setup/probe']) {
    assert.equal((await runtime.request(path,{method:'POST',authenticated:false,body:{}})).status,401,path);
    for(const Origin of ['https://evil.example','null','']) {
      assert.equal((await runtime.request(path,{method:'POST',body:{},headers:{Origin}})).status,403,`${path} ${Origin}`);
    }
    const missing=await runtime.mf.dispatchFetch(`https://console.example.com${path}`,{method:'POST',
      headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,'Content-Type':'application/json'},body:'{}'});
    assert.equal(missing.status,403,path);
  }
  assert.equal((await runtime.request('/owner/api/setup',{authenticated:false,headers:{'Cf-Access-Authenticated-User-Email':runtime.ownerEmail,'X-Owner':'true'}})).status,401);
  assert.equal((await runtime.request('/owner/api/setup',{headers:{'Cf-Access-Jwt-Assertion':await runtime.sign({aud:'another-app'})}})).status,401);
  const initial=await setupOf(runtime);
  assert.equal(initial.instance.id,null);assert.equal(initial.instance.state,'pending');assert.equal(initial.instance.updatedAt,null);
  assert.match(initial.configFingerprint,/^[0-9a-f]{64}$/);assert.equal(initial.configValid,true);assert.equal(initial.canComplete,false);
  assert.deepEqual(initial.resources,{d1:'migrated',r2:'connected',schemaVersion:'0019_retry_batch_notifications.sql',missingTables:[],missingIndexes:[],
    expectedMigrations:['0001_initial.sql','0002_oauth.sql','0003_setup.sql','0004_attachments.sql','0005_draft_attachments.sql','0006_webhooks.sql','0007_email_delivery_events.sql','0008_recipient_suppressions.sql','0009_cloudflare_suppressions.sql','0010_cloudflare_suppression_history.sql','0011_cloudflare_suppression_alerts.sql','0012_alert_notification_policies.sql','0013_alert_notification_decision_indexes.sql','0014_async_alert_notification_exports.sql','0015_async_export_notifications.sql','0016_export_notification_delivery_history.sql','0017_export_notification_retry_batches.sql','0018_export_notification_retry_controls.sql','0019_retry_batch_notifications.sql']});
  assert.deepEqual(await (await runtime.request('/owner/api/setup/checks')).json(),{d1:'migrated',r2:'connected'});
  const response=await runtime.request('/owner/api/setup');assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal(await count(runtime,'instance_settings'),0);assert.equal(await count(runtime,'audit_events'),0);
  assert.equal((await runtime.bucket.list()).objects.length,0);
  assert.equal((await runtime.request('/owner/api/setup',{method:'POST',body:{...form(initial),adminToken:'never-accepted'}})).status,400);
  assert.equal((await runtime.request('/owner/api/setup',{method:'POST',body:{...form(initial),expectedConfigFingerprint:undefined}})).status,400);
  assert.equal((await runtime.request('/owner/api/setup/probe',{method:'POST',body:{sendEmail:true}})).status,400);
  const publicPage=await runtime.request('/',{authenticated:false});assert.equal(publicPage.status,200);
  const publicHtml=await publicPage.text();
  for(const value of [runtime.ownerEmail,runtime.issuer,runtime.audience,initial.configFingerprint,'setup_checks_json','setup_config_sha256']) assert.equal(publicHtml.includes(value),false,value);
  assert.deepEqual(await (await runtime.request('/healthz',{authenticated:false})).json(),{status:'ok',service:'agent-mail'});
});

test('setup save, real R2 probe, explicit completion and CAS preserve mailbox and approval state',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  let setup=await setupOf(runtime);
  let response=await runtime.request('/owner/api/setup',{method:'POST',body:form(setup,{complete:true})});
  assert.equal(response.status,409);assert.equal((await response.json()).error.code,'setup_incomplete');
  const box=await mailbox(runtime);
  const issued=await runtime.request(`/owner/api/mailboxes/${box.id}/tokens`,{method:'POST',body:{name:'Agent',scopes:['mail:read']}});
  const secret=(await issued.json()).secret;
  const tokenAttempt=await runtime.mf.dispatchFetch('https://console.example.com/owner/api/setup',{
    headers:{Authorization:`Bearer ${secret}`}});assert.equal(tokenAttempt.status,401);
  response=await runtime.request('/owner/api/setup/probe',{method:'POST',body:{}});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{probe:{success:true,code:'verified'}});
  assert.equal((await runtime.bucket.list()).objects.length,0);
  response=await runtime.request('/owner/api/setup',{method:'POST',body:form(setup)});
  assert.equal(response.status,200);setup=(await response.json()).setup;
  assert.equal(setup.instance.state,'pending');assert.equal(setup.canComplete,true);assert.equal(setup.evidence.activeMailboxCount,1);
  const responses=await Promise.all(['First','Second'].map(displayName=>runtime.request('/owner/api/setup',{method:'POST',body:form(setup,{displayName})})));
  assert.deepEqual(responses.map(result=>result.status).sort(),[200,409]);
  const stale=responses.find(result=>result.status===409);assert.equal((await stale.json()).error.code,'setup_changed');
  setup=await setupOf(runtime);
  response=await runtime.request('/owner/api/setup',{method:'POST',body:form(setup,{complete:true})});
  assert.equal(response.status,200,await response.clone().text());setup=(await response.json()).setup;
  assert.equal(setup.instance.state,'ready');assert.equal(setup.canComplete,true);
  assert.equal(await runtime.db.prepare('SELECT setup_state FROM instance_settings WHERE id=1').first('setup_state'),'ready');
  const auditCount=await count(runtime,'audit_events');await setupOf(runtime);await setupOf(runtime);
  assert.equal(await count(runtime,'audit_events'),auditCount);assert.equal((await runtime.bucket.list()).objects.length,0);
  for(const table of ['messages','drafts','outbound_messages','ingest_receipts']) assert.equal(await count(runtime,table),0,table);
  assert.equal(await count(runtime,'mailboxes'),1);assert.equal(await count(runtime,'mailbox_tokens'),1);
  response=await runtime.request('/owner/api/setup',{method:'POST',body:form(setup,{attestations:{...checks,access:false}})});
  assert.equal(response.status,200);assert.equal((await response.json()).setup.instance.state,'pending');
  const audits=await runtime.db.prepare("SELECT metadata_json FROM audit_events WHERE action LIKE 'setup.%'").all();
  assert.equal(JSON.stringify(audits).includes(secret),false);assert.equal(JSON.stringify(audits).includes(runtime.jwt),false);
});

test('a stale browser cannot attest or finish after deployment configuration changes',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  await mailbox(runtime);
  let response=await runtime.request('/owner/api/setup',{method:'POST',body:form(await setupOf(runtime))});
  assert.equal(response.status,200);const before=(await response.json()).setup;
  const priorAudits=await count(runtime,'audit_events');
  await runtime.updateBindings({MAIL_DOMAIN:'changed.example.com'});
  const changed=await setupOf(runtime);
  assert.equal(changed.instance.updatedAt,before.instance.updatedAt);assert.equal(changed.config.mailDomain,'changed.example.com');
  assert.notEqual(changed.configFingerprint,before.configFingerprint);assert.equal(changed.configChanged,true);
  assert.deepEqual(changed.attestations,{mailDomain:false,access:false,emailRouting:false,emailSending:false});
  for(const complete of [false,true]) {
    response=await runtime.request('/owner/api/setup',{method:'POST',body:form(before,{complete})});
    assert.equal(response.status,409);assert.equal((await response.json()).error.code,'setup_config_changed');
  }
  assert.equal(await count(runtime,'audit_events'),priorAudits);assert.equal((await runtime.bucket.list()).objects.length,0);
  assert.equal((await setupOf(runtime)).instance.updatedAt,before.instance.updatedAt);
  response=await runtime.request('/owner/api/setup',{method:'POST',body:form(changed)});
  assert.equal(response.status,200);assert.equal((await response.json()).setup.configChanged,false);
});

test('missing migrated tables or columns return actionable Owner diagnostics and refuse initialization',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  await runtime.db.prepare('DROP TABLE oauth_registration_windows').run();
  let setup=await setupOf(runtime);assert.equal(setup.resources.d1,'migration_required');assert.equal(setup.resources.schemaVersion,'0001_initial.sql');
  assert.deepEqual(setup.resources.missingTables,['oauth_registration_windows']);assert.equal(setup.canComplete,false);
  assert.deepEqual(await (await runtime.request('/owner/api/setup/checks')).json(),{d1:'migration_required',r2:'connected'});
  let response=await runtime.request('/owner/api/setup',{method:'POST',body:form(setup)});
  assert.equal(response.status,409);assert.equal((await response.json()).error.code,'setup_migration_required');
  const page=await runtime.request('/owner/setup',{headers:{Accept:'text/html'}});assert.equal(page.status,200,await page.clone().text());
  assert.equal(await count(runtime,'instance_settings'),0);assert.equal(await count(runtime,'audit_events'),0);
  await runtime.db.prepare('ALTER TABLE messages RENAME COLUMN subject TO removed_subject').run();
  setup=await setupOf(runtime);assert.deepEqual(setup.resources.missingTables,['messages','oauth_registration_windows']);
  assert.equal(setup.resources.schemaVersion,null);assert.equal(setup.canComplete,false);
  response=await runtime.request('/owner/api/setup',{method:'POST',body:form(setup,{complete:true})});
  assert.equal(response.status,409);assert.equal((await response.json()).error.code,'setup_migration_required');
  assert.equal((await runtime.bucket.list()).objects.length,0);
});
