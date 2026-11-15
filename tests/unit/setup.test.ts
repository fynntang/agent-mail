import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,beforeEach,afterEach,it,expect} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {getSetup,probeSetup,updateSetup} from '../../src/lib/server/core/setup';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,statements:string[],configFingerprint:string;
const allChecks={mailDomain:true,access:true,emailRouting:true,emailSending:true};
const input=(expectedUpdatedAt:number|null,attestations=allChecks,complete=false,expectedConfigFingerprint=configFingerprint)=>({expectedUpdatedAt,expectedConfigFingerprint,displayName:'Personal Agent Mail',attestations,complete});
beforeAll(async()=>{
  statements=[];
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()) {
    statements.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));
  }
});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'setup-core'},r2Buckets:{MAIL_BLOBS:'setup-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(statements.map(sql=>db.prepare(sql)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',
    OWNER_EMAIL:'owner@example.com',ACCESS_TEAM_DOMAIN:'https://agent-mail-tests.cloudflareaccess.com',ACCESS_AUD:'owner-tests',
    API_ORIGIN:'https://api.example.com',CONSOLE_ORIGIN:'https://console.example.com',EMAIL:{send:async()=>{throw new Error('must not send');}}} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
  configFingerprint=(await getSetup(ctx)).configFingerprint;
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);
const count=(table:string)=>ctx.env.DB.prepare(`SELECT count(*) n FROM ${table}`).first<number>('n');
async function box(){return createMailbox(ctx,{name:'Setup mailbox',localPart:`setup-${crypto.randomUUID()}`});}
function bucket(overrides:Record<string,unknown>) {
  return new Proxy(ctx.env.MAIL_BLOBS,{get(target,property){if(Object.hasOwn(overrides,property))return overrides[property as string];const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}}) as R2Bucket;
}

it('reads all migration health without initializing an instance, writing blobs, or sending mail',async()=>{
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migrated',r2:'connected',schemaVersion:'0019_retry_batch_notifications.sql',missingTables:[],missingIndexes:[]});
  expect(value.configValid).toBe(true);expect(value.instance).toMatchObject({id:null,state:'pending',updatedAt:null});
  expect(value.canComplete).toBe(false);expect(value.evidence.activeMailboxCount).toBe(0);
  await getSetup(ctx);expect(await count('instance_settings')).toBe(0);expect(await count('audit_events')).toBe(0);
  expect((await ctx.env.MAIL_BLOBS.list()).objects).toHaveLength(0);
});

it('denies token or anonymous callers before any probe or setup read/write',async()=>{
  let touched=false;
  const env={...ctx.env,MAIL_BLOBS:bucket({head:()=>{touched=true;throw new Error('private');},put:()=>{touched=true;throw new Error('private');}})};
  for(const actor of [null,{kind:'token' as const,mailboxId:crypto.randomUUID(),tokenId:crypto.randomUUID(),canRead:true}]) {
    const unauthorized={...ctx,env,actor};
    for(const call of [()=>getSetup(unauthorized),()=>probeSetup(unauthorized),()=>updateSetup(unauthorized,input(null))]) await expect(call()).rejects.toMatchObject({status:actor?403:401});
  }
  expect(touched).toBe(false);expect(await count('instance_settings')).toBe(0);
});

it('reports the policy schema and refuses initialization when a decision-history index is missing',async()=>{
  await ctx.env.DB.prepare('DROP INDEX alert_notification_decision_reason').run();
  const value=await getSetup(ctx);
  expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0012_alert_notification_policies.sql',missingTables:[],missingIndexes:['alert_notification_decision_reason']});
  expect(value.canComplete).toBe(false);
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
  expect(await count('instance_settings')).toBe(0);
});

it('does not accept a correctly named delivery index with the wrong column order',async()=>{
  await ctx.env.DB.batch([ctx.env.DB.prepare('DROP INDEX webhook_event_deliveries'),ctx.env.DB.prepare('CREATE INDEX webhook_event_deliveries ON webhook_deliveries(event_id,mailbox_id)')]);
  const value=await getSetup(ctx);
  expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0012_alert_notification_policies.sql',missingTables:[],missingIndexes:['webhook_event_deliveries']});
});

it('detects an incomplete schema beyond mailboxes and refuses initialization writes',async()=>{
  await ctx.env.DB.prepare('DROP TABLE oauth_registration_windows').run();
  const value=await getSetup(ctx);expect(value.resources.d1).toBe('migration_required');expect(value.resources.missingTables).toContain('oauth_registration_windows');
  expect(value.resources.schemaVersion).toBe('0001_initial.sql');
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
  expect(await count('instance_settings')).toBe(0);
});

it('reports the decision-history schema when the async export job table is missing',async()=>{
  await ctx.env.DB.prepare('DROP TABLE async_alert_notification_exports').run();
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0013_alert_notification_decision_indexes.sql',missingTables:['async_alert_notification_exports']});
  expect(value.canComplete).toBe(false);await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
});

it('refuses async readiness when a chunk checksum column is absent',async()=>{
  await ctx.env.DB.prepare('ALTER TABLE async_alert_notification_export_chunks RENAME COLUMN sha256 TO removed_checksum').run();
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0013_alert_notification_decision_indexes.sql',missingTables:['async_alert_notification_export_chunks']});
  expect(value.canComplete).toBe(false);
});

it('reports async export readiness when terminal notification storage is missing',async()=>{
  await ctx.env.DB.prepare('DROP TABLE async_export_notification_state').run();
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0014_async_alert_notification_exports.sql',missingTables:['async_export_notification_state']});
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
});

it('requires the terminal notice index to have the correct mailbox and acknowledgment columns',async()=>{
  await ctx.env.DB.batch([ctx.env.DB.prepare('DROP INDEX async_export_notifications_unread'),ctx.env.DB.prepare('CREATE INDEX async_export_notifications_unread ON async_export_notifications(acknowledged_at,mailbox_id,created_at DESC,job_id DESC)')]);
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0014_async_alert_notification_exports.sql',missingIndexes:['async_export_notifications_unread']});
});

it('requires scoped delivery retry history indexing before claiming the latest schema',async()=>{
  await ctx.env.DB.prepare('DROP INDEX audit_resource_history').run();
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0015_async_export_notifications.sql',missingIndexes:['audit_resource_history']});
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
});

it('rejects a resource history index with incorrect mailbox ordering',async()=>{
  await ctx.env.DB.batch([ctx.env.DB.prepare('DROP INDEX audit_resource_history'),ctx.env.DB.prepare('CREATE INDEX audit_resource_history ON audit_events(resource_id,mailbox_id,action,occurred_at DESC,id DESC)')]);
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0015_async_export_notifications.sql',missingIndexes:['audit_resource_history']});
});

it('reports the existing delivery-history schema when batch retry storage is absent',async()=>{
  await ctx.env.DB.prepare('DROP TABLE async_export_notification_retry_items').run();
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0016_export_notification_delivery_history.sql',missingTables:['async_export_notification_retry_items']});
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
});

it('requires correctly ordered batch item claim indexes for initialization',async()=>{
  await ctx.env.DB.batch([ctx.env.DB.prepare('DROP INDEX export_retry_item_claim'),ctx.env.DB.prepare('CREATE INDEX export_retry_item_claim ON async_export_notification_retry_items(updated_at,state,batch_id,delivery_id)')]);
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0016_export_notification_delivery_history.sql',missingIndexes:['export_retry_item_claim']});
});

it('requires the cancellation fence before claiming controls are migrated',async()=>{
  await ctx.env.DB.prepare('ALTER TABLE async_export_notification_retry_batches RENAME COLUMN cancelled_at TO removed_cancelled_at').run();
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0017_export_notification_retry_batches.sql',missingTables:['async_export_notification_retry_batches']});
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
  expect(await count('instance_settings')).toBe(0);
});

it('requires retry batch notification storage before claiming the latest schema',async()=>{
  await ctx.env.DB.prepare('DROP TABLE async_export_retry_batch_notifications').run();
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0018_export_notification_retry_controls.sql',missingTables:['async_export_retry_batch_notifications']});
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
});

it('requires the notification projection index column order',async()=>{
  await ctx.env.DB.batch([ctx.env.DB.prepare('DROP INDEX retry_batch_notifications_project'),ctx.env.DB.prepare('CREATE INDEX retry_batch_notifications_project ON async_export_retry_batch_notifications(created_at,projected_at,id)')]);
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0018_export_notification_retry_controls.sql',missingIndexes:['retry_batch_notifications_project']});
});

it('requires the frozen subscription fence for retry batch notifications',async()=>{
  await ctx.env.DB.prepare('ALTER TABLE async_export_retry_batch_notifications RENAME COLUMN endpoint_snapshot_json TO removed_snapshot').run();
  const value=await getSetup(ctx);expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0018_export_notification_retry_controls.sql',missingTables:['async_export_retry_batch_notifications']});
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
});

it('reports the prior delivery migration when the suppression table has not been applied',async()=>{
  await ctx.env.DB.prepare('DROP TABLE recipient_suppressions').run();
  const value=await getSetup(ctx);
  expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0007_email_delivery_events.sql',missingTables:['recipient_suppressions']});
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
});

it('reports the local suppression schema when provider snapshot tables are missing',async()=>{
  await ctx.env.DB.prepare('DROP TABLE cloudflare_suppression_cache').run();
  const value=await getSetup(ctx);
  expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0008_recipient_suppressions.sql',missingTables:['cloudflare_suppression_cache']});
  expect(value.canComplete).toBe(false);
});

it('reports the provider schema when the new operation journal table is missing',async()=>{
  await ctx.env.DB.prepare('DROP TABLE cloudflare_suppression_history_events').run();
  const value=await getSetup(ctx);
  expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0009_cloudflare_suppressions.sql',missingTables:['cloudflare_suppression_history_events']});
  expect(value.canComplete).toBe(false);
});

it('reports the history schema when the alert deployment cursor table is missing',async()=>{
  await ctx.env.DB.prepare('DROP TABLE cloudflare_suppression_alert_cursors').run();
  const value=await getSetup(ctx);
  expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0010_cloudflare_suppression_history.sql',missingTables:['cloudflare_suppression_alert_cursors']});
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
});

it('does not claim alert migration readiness when an alert column is missing',async()=>{
  await ctx.env.DB.prepare('ALTER TABLE cloudflare_suppression_alerts RENAME COLUMN last_fingerprint TO removed_fingerprint').run();
  const value=await getSetup(ctx);
  expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0010_cloudflare_suppression_history.sql',missingTables:['cloudflare_suppression_alerts']});
  expect(value.canComplete).toBe(false);
});

it('reports the alert schema when notification policy admission tables are missing',async()=>{
  await ctx.env.DB.prepare('DROP TABLE alert_notification_decisions').run();
  const value=await getSetup(ctx);
  expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0011_cloudflare_suppression_alerts.sql',missingTables:['alert_notification_decisions']});
  await expect(updateSetup(ctx,input(null))).rejects.toMatchObject({code:'setup_migration_required'});
});

it('does not claim notification policy readiness when its CAS version column is missing',async()=>{
  await ctx.env.DB.prepare('ALTER TABLE alert_notification_policies RENAME COLUMN version TO removed_policy_version').run();
  const value=await getSetup(ctx);
  expect(value.resources).toMatchObject({d1:'migration_required',schemaVersion:'0011_cloudflare_suppression_alerts.sql',missingTables:['alert_notification_policies']});
  expect(value.canComplete).toBe(false);
});

it('treats a missing mail-reading column as an incomplete migration even when every table exists',async()=>{
  await ctx.env.DB.prepare('ALTER TABLE messages RENAME COLUMN subject TO subject_removed').run();
  const value=await getSetup(ctx);expect(value.resources.d1).toBe('migration_required');expect(value.resources.missingTables).toContain('messages');
  expect(value.canComplete).toBe(false);expect(await count('instance_settings')).toBe(0);
});

it('does not mistake a view with the expected columns for a migrated application table',async()=>{
  await ctx.env.DB.prepare('ALTER TABLE oauth_registration_windows RENAME TO registration_backup').run();
  await ctx.env.DB.prepare('CREATE VIEW oauth_registration_windows AS SELECT * FROM registration_backup').run();
  const value=await getSetup(ctx);expect(value.resources.d1).toBe('migration_required');expect(value.resources.missingTables).toContain('oauth_registration_windows');
  expect(value.canComplete).toBe(false);
});

it('saves explicit Owner attestations without declaring ready, and config changes invalidate them',async()=>{
  await box();
  const saved=await updateSetup(ctx,input(null));expect(saved.instance.state).toBe('pending');expect(saved.canComplete).toBe(true);
  expect(saved.attestations).toEqual(allChecks);expect(saved.instance.id).toMatch(/^[a-f0-9-]{36}$/);
  const altered=await getSetup({...ctx,env:{...ctx.env,MAIL_DOMAIN:'other.example.com'}});
  expect(altered.configChanged).toBe(true);expect(Object.values(altered.attestations)).toEqual([false,false,false,false]);expect(altered.canComplete).toBe(false);
  expect(await count('mailboxes')).toBe(1);expect(await count('outbound_messages')).toBe(0);
  for(const bad of [{...input(saved.instance.updatedAt),setup_state:'ready'}, {...input(saved.instance.updatedAt),attestations:{...allChecks,serverVerified:true}}]) {
    await expect(updateSetup(ctx,bad)).rejects.toMatchObject({code:'invalid_input'});
  }
});

it('claims the singleton and every update with a unique audit guard under concurrent saves',async()=>{
  const results=await Promise.allSettled([updateSetup(ctx,input(null)),updateSetup(ctx,input(null))]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'setup_changed'});
  expect(await count('instance_settings')).toBe(1);expect(await count('audit_events')).toBe(1);
  const saved=await getSetup(ctx),version=saved.instance.updatedAt;
  const changes=await Promise.allSettled([updateSetup(ctx,{...input(version),displayName:'A'}),updateSetup(ctx,{...input(version),displayName:'B'})]);
  expect(changes.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await count('audit_events')).toBe(2);
});

it('rejects an old browser form after deployment config changes before any probe or writes',async()=>{
  await box();
  const saved=await updateSetup(ctx,input(null));
  let probes=0;
  const changed={...ctx,env:{...ctx.env,MAIL_DOMAIN:'changed.example.com',MAIL_BLOBS:bucket({put:async()=>{probes++;throw new Error('must not probe');}})}};
  for(const complete of [false,true]) {
    await expect(updateSetup(changed,input(saved.instance.updatedAt,allChecks,complete,saved.configFingerprint))).rejects.toMatchObject({code:'setup_config_changed',status:409});
  }
  expect(probes).toBe(0);expect(await count('audit_events')).toBe(2);
  const unchanged=await getSetup(ctx);expect(unchanged.instance.updatedAt).toBe(saved.instance.updatedAt);expect(unchanged.attestations).toEqual(allChecks);
  const refreshed=await getSetup(changed);expect(refreshed.configFingerprint).not.toBe(saved.configFingerprint);expect(refreshed.configChanged).toBe(true);
  expect(Object.values(refreshed.attestations)).toEqual([false,false,false,false]);
  const resaved=await updateSetup(changed,input(saved.instance.updatedAt,allChecks,false,refreshed.configFingerprint));
  expect(resaved.attestations).toEqual(allChecks);expect(resaved.configChanged).toBe(false);expect(resaved.instance.state).toBe('pending');
});

it('requires a mailbox, valid deployment config and manual checks before an explicit completion',async()=>{
  await expect(updateSetup(ctx,input(null,allChecks,true))).rejects.toMatchObject({code:'setup_incomplete'});
  await box();
  await expect(updateSetup(ctx,input(null,{...allChecks,emailRouting:false},true))).rejects.toMatchObject({code:'setup_incomplete'});
  const invalid={...ctx,env:{...ctx.env,MAIL_DOMAIN:'CHANGE_ME'}};
  expect((await getSetup(invalid)).configValid).toBe(false);
  await expect(updateSetup(invalid,input(null,allChecks,true,(await getSetup(invalid)).configFingerprint))).rejects.toMatchObject({code:'setup_incomplete'});
  expect(await count('instance_settings')).toBe(0);
  const completed=await updateSetup(ctx,input(null,allChecks,true));expect(completed.instance.state).toBe('ready');
  expect((await ctx.env.MAIL_BLOBS.list()).objects).toHaveLength(0);expect(await count('outbound_messages')).toBe(0);
  const read=await getSetup(ctx);expect(read.instance.state).toBe('ready');expect(await count('instance_settings')).toBe(1);
  const changed=await updateSetup(ctx,input(read.instance.updatedAt,{...allChecks,access:false}));expect(changed.instance.state).toBe('pending');expect(changed.canComplete).toBe(false);
});

it('supports receive-only setup when EMAIL is absent and reports real probe cleanup',async()=>{
  await box();
  const receiveOnly={...ctx,env:{...ctx.env,EMAIL:undefined}};
  const complete=await updateSetup(receiveOnly,input(null,{...allChecks,emailSending:false},true,(await getSetup(receiveOnly)).configFingerprint));
  expect(complete.instance.state).toBe('ready');expect(complete.config.sendingEnabled).toBe(false);
  expect(await probeSetup(ctx)).toEqual({success:true,code:'verified'});expect((await ctx.env.MAIL_BLOBS.list()).objects).toHaveLength(0);
  const restored=await getSetup(ctx);expect(restored.configChanged).toBe(true);expect(restored.instance.state).toBe('pending');
});

it('never marks ready after a failed R2 probe and distinguishes cleanup failure without leaking errors',async()=>{
  await box();
  const denied={...ctx,env:{...ctx.env,MAIL_BLOBS:bucket({put:async()=>{throw new Error('SECRET_PROVIDER_TOKEN sql://private');}})}};
  expect(await probeSetup(denied)).toEqual({success:false,code:'probe_failed'});
  await expect(updateSetup(denied,input(null,allChecks,true))).rejects.toMatchObject({code:'setup_probe_failed'});
  expect(await count('instance_settings')).toBe(0);expect(await count('audit_events')).toBe(1); // mailbox.created only
  const noDelete={...ctx,env:{...ctx.env,MAIL_BLOBS:bucket({delete:async()=>{throw new Error('private bucket key');}})}};
  const result=await probeSetup(noDelete);expect(result).toEqual({success:false,code:'cleanup_failed'});expect(JSON.stringify(result)).not.toContain('private');
});

it('reports unavailable storage and corrupt persisted attestations honestly',async()=>{
  await updateSetup(ctx,input(null));
  await ctx.env.DB.prepare("UPDATE instance_settings SET setup_checks_json='{}',setup_state='ready' WHERE id=1").run();
  expect((await getSetup(ctx)).instance.state).toBe('pending');expect((await getSetup(ctx)).canComplete).toBe(false);
  const unavailable={...ctx,env:{...ctx.env,MAIL_BLOBS:bucket({head:async()=>{throw new Error('private bucket address');}})}};
  const value=await getSetup(unavailable);expect(value.resources.r2).toBe('unavailable');expect(value.canComplete).toBe(false);
  expect(JSON.stringify(value)).not.toContain('private bucket address');
});
