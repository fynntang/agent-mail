import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {createAsyncAlertNotificationExport} from '../../src/lib/server/core/async-alert-notification-exports';
import {projectAsyncExportNotifications} from '../../src/lib/server/core/async-export-notifications';
import {createWebhookEndpoint} from '../../src/lib/server/core/webhooks';
import {getAlertNotificationPolicy,updateAlertNotificationPolicy} from '../../src/lib/server/core/alert-notification-policy';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import {previewAsyncExportNotificationRetryBatch,commitAsyncExportNotificationRetryBatch,type BatchRetryRow,type BatchRetryItemRow} from '../../src/lib/server/core/async-export-notification-retry-batches';
import {runAsyncExportNotificationRetryBatchJobs} from '../../src/lib/server/core/async-export-notification-retry-batch-jobs';
import {retryAsyncExportNotificationDelivery} from '../../src/lib/server/core/async-export-notification-retry';
import {exportRetryBatchSyncStatement} from '../../src/lib/server/core/async-export-notification-retry-batch-shared';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,env:RuntimeEnv,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'retry-batch-jobs'},r2Buckets:{MAIL_BLOBS:'retry-batch-jobs'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',OWNER_EMAIL:'owner@example.com',WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;vi.spyOn(Date,'now').mockImplementation(()=>at);
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const raw=(id:string)=>env.DB.prepare('SELECT * FROM async_export_notification_retry_batches WHERE id=?').bind(id).first<BatchRetryRow>();
const items=(id:string)=>env.DB.prepare('SELECT * FROM async_export_notification_retry_items WHERE batch_id=? ORDER BY delivery_id').bind(id).all<BatchRetryItemRow>();
const audits=()=>env.DB.prepare("SELECT id FROM audit_events WHERE action='webhook.delivery_retried'").all<{id:string}>();
const run=(overrides:Partial<RuntimeEnv>={},maxItems?:number)=>runAsyncExportNotificationRetryBatchJobs({...env,...overrides},{now:()=>at,...(maxItems===undefined?{}:{maxItems})});
async function policy(box:string,changes:Record<string,unknown>){const {version,updatedAt,...fields}=(await getAlertNotificationPolicy(ctx,box)).policy;return updateAlertNotificationPolicy(ctx,box,{...fields,...changes,expectedVersion:version});}
async function notice(box:string){
  const job=(await createAsyncAlertNotificationExport(ctx,box,{format:'json',clientRequestId:crypto.randomUUID()})).job;
  await env.DB.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='fixture',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at+120000,job.id).run();
  await env.DB.prepare("UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at,job.id).run();return job;
}
async function fixture(count=1){
  const box=await createMailbox(ctx,{name:'Batch executor',localPart:`batch-jobs-${crypto.randomUUID()}`});await createWebhookEndpoint(ctx,box.id,{url:'https://hooks.example.net/notify',eventTypes:['alert_notification.export.succeeded']});at++;
  for(let index=0;index<count;index++){await notice(box.id);at++;}
  await projectAsyncExportNotifications(env,{now:()=>at});for(let index=0;index<Math.ceil(count/2);index++)await runWebhookJobs(env,{now:()=>at,fetcher:async()=>new Response(null,{status:400})});
  return box;
}
async function preview(box:string){return previewAsyncExportNotificationRetryBatch(ctx,box,{clientRequestId:crypto.randomUUID(),from:at-100000,to:at+1,reason:'all'});}
async function committed(box:string){const p=await preview(box);await commitAsyncExportNotificationRetryBatch(ctx,box,p.batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:p.batch.version});return p.batch;}
function database(replace:(target:D1Database,statements:D1PreparedStatement[])=>Promise<D1Result[]>){return new Proxy(env.DB,{get(target,key){if(key==='batch')return(statements:D1PreparedStatement[])=>replace(target,statements);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}

it('processes at most five frozen candidates per tick, preserves late failures and never performs HTTP transport',async()=>{
  const box=await fixture(8),batch=await committed(box.id);await notice(box.id);at++;await projectAsyncExportNotifications(env,{now:()=>at});await runWebhookJobs(env,{now:()=>at,fetcher:async()=>new Response(null,{status:400})});
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('unexpected HTTP');});
  expect(await run()).toMatchObject({batchRetryProcessed:5,batchRetryRequeued:5});expect(await raw(batch.id)).toMatchObject({state:'running',total_items:8,processed_items:5,requeued_items:5});
  expect(await run()).toMatchObject({batchRetryProcessed:3,batchRetryRequeued:3});expect(await raw(batch.id)).toMatchObject({state:'completed',processed_items:8,unknown_items:0});
  expect((await audits()).results).toHaveLength(8);expect((await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE state='dead'").all()).results).toHaveLength(1);expect(fetcher).not.toHaveBeenCalled();
  expect(await run()).toMatchObject({batchRetryProcessed:0});expect((await audits()).results).toHaveLength(8);
},30_000);

it('skips changed versions and current disabled policy, and never promotes preview-blocked candidates after enabling',async()=>{
  const box=await fixture(3),batch=await committed(box.id),frozen=(await items(batch.id)).results;
  await env.DB.prepare('UPDATE webhook_deliveries SET updated_at=updated_at+1 WHERE id=?').bind(frozen[0].delivery_id).run();await policy(box.id,{enabled:false});
  expect(await run()).toMatchObject({batchRetrySkipped:3,batchRetryRequeued:0});const outcomes=(await items(batch.id)).results;expect(outcomes.find(item=>item.delivery_id===frozen[0].delivery_id)?.reason).toBe('changed');expect(outcomes.filter(item=>item.reason==='notifications_disabled')).toHaveLength(2);expect((await audits()).results).toHaveLength(0);
  const blocked=await committed(box.id);expect(blocked.eligibleItems).toBe(0);await policy(box.id,{enabled:true});expect(await run()).toMatchObject({batchRetrySkipped:3,batchRetryRequeued:0});expect((await items(blocked.id)).results.every(item=>item.reason==='notifications_disabled')).toBe(true);expect((await audits()).results).toHaveLength(0);
});

it('concurrent executors publish one per-item receipt and aggregate progress once',async()=>{
  const box=await fixture(6),batch=await committed(box.id);await Promise.all([run(),run()]);await run();
  expect(await raw(batch.id)).toMatchObject({state:'completed',processed_items:6,requeued_items:6,skipped_items:0,unknown_items:0});expect((await audits()).results).toHaveLength(6);
  expect((await env.DB.prepare('SELECT attempt_budget FROM webhook_deliveries WHERE mailbox_id=?').bind(box.id).all<{attempt_budget:number}>()).results.every(row=>row.attempt_budget===16)).toBe(true);
});

it('recovers the committed single-delivery receipt after a crash before the item checkpoint without increasing its budget again',async()=>{
  const box=await fixture(),batch=await committed(box.id);let calls=0;const failed=database(async(target,statements)=>{if(++calls===3)throw Error('PRIVATE_CHECKPOINT_UNAVAILABLE');return target.batch(statements);});vi.spyOn(console,'error').mockImplementation(()=>{});
  await run({DB:failed},1);expect((await audits()).results).toHaveLength(1);expect((await items(batch.id)).results[0].state).toBe('running');at+=120001;
  expect(await run()).toMatchObject({batchRetryProcessed:1,batchRetryRequeued:1});expect(await raw(batch.id)).toMatchObject({state:'completed',requeued_items:1});expect((await audits()).results).toHaveLength(1);
  expect(await env.DB.prepare('SELECT attempt_budget FROM webhook_deliveries WHERE mailbox_id=?').bind(box.id).first('attempt_budget')).toBe(16);
});

it('replacing an interrupted lease fences the old executor before its audit transaction and leaves unknown results read-only',async()=>{
  const box=await fixture(),batch=await committed(box.id);let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let first=true;
  let calls=0;const paused=database(async(target,statements)=>{if(++calls===2&&first){first=false;entered();await waiting;}return target.batch(statements);});
  const old=run({DB:paused},1);await started;at+=120001;expect(await run({},1)).toMatchObject({batchRetryUnknown:1});release();await old;
  expect(await raw(batch.id)).toMatchObject({state:'running',processed_items:1,unknown_items:1,requeued_items:0});expect((await audits()).results).toHaveLength(0);expect(await env.DB.prepare('SELECT attempt_budget FROM webhook_deliveries WHERE mailbox_id=?').bind(box.id).first('attempt_budget')).toBe(8);
  at+=60001;await run();expect((await audits()).results).toHaveLength(0);expect((await items(batch.id)).results[0].state).toBe('unknown');
});

it('expires pending operations without sending and can still reconcile a receipt committed before batch expiry',async()=>{
  const box=await fixture(2),batch=await committed(box.id);at=batch.expiresAt+1;expect(await run()).toMatchObject({batchRetrySkipped:2,batchRetryRequeued:0});expect(await raw(batch.id)).toMatchObject({state:'expired',processed_items:2,skipped_items:2});expect((await audits()).results).toHaveLength(0);
  at=Date.now()+1000;const other=await fixture(),recover=await committed(other.id);let calls=0;const failed=database(async(target,statements)=>{if(++calls===3)throw Error('checkpoint lost');return target.batch(statements);});vi.spyOn(console,'error').mockImplementation(()=>{});await run({DB:failed},1);at=recover.expiresAt+1;
  expect(await run()).toMatchObject({batchRetryRequeued:1});expect(await raw(recover.id)).toMatchObject({state:'expired',requeued_items:1});expect((await audits()).results).toHaveLength(1);
});

it('quiet or paused execution skips permanently, malformed options fail safely, and an empty confirmed batch completes without mutation',async()=>{
  const box=await fixture(),batch=await committed(box.id),minute=new Date(at).getUTCHours()*60+new Date(at).getUTCMinutes();
  await policy(box.id,{quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440,timeZone:'UTC'});expect(await run()).toMatchObject({batchRetrySkipped:1});expect((await items(batch.id)).results[0].reason).toBe('quiet_hours');
  await policy(box.id,{quietEnabled:false});const paused=await committed(box.id);await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(box.id).run();expect(await run()).toMatchObject({batchRetrySkipped:1});expect((await items(paused.id)).results[0].reason).toBe('mailbox_inactive');
  await expect(run({},6)).rejects.toMatchObject({code:'invalid_query'});expect((await audits()).results).toHaveLength(0);
  const empty=await createMailbox(ctx,{name:'No failures',localPart:`empty-${crypto.randomUUID()}`}),zero=await committed(empty.id);await run();expect(await raw(zero.id)).toMatchObject({state:'completed',processed_items:0,total_items:0});
});

it('does not claim cancelled pending entries or expire a cancelled preview, and preserves its original state during aggregation',async()=>{
  const box=await fixture(),batch=await committed(box.id),p=await preview(box.id);
  for(const id of[batch.id,p.batch.id])await env.DB.batch([
    env.DB.prepare('UPDATE async_export_notification_retry_batches SET cancelled_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(at,id),
    env.DB.prepare("UPDATE async_export_notification_retry_items SET state='skipped',reason='batch_cancelled',completed_at=?,version=version+1,updated_at=updated_at+1 WHERE batch_id=?").bind(at,id),
    exportRetryBatchSyncStatement(env,id,at)
  ]);
  const confirmed=await raw(batch.id),cancelledPreview=await raw(p.batch.id);at=batch.expiresAt+1;
  expect(await run()).toMatchObject({batchRetryProcessed:0,batchRetryReconciled:0});
  expect(await raw(batch.id)).toEqual(confirmed);expect(await raw(p.batch.id)).toEqual(cancelledPreview);
  expect(cancelledPreview).toMatchObject({state:'preview',processed_items:1,skipped_items:1});expect((await audits()).results).toHaveLength(0);
});

it('atomically advances the parent version when claiming, and cancellation fences an executor paused before its audit transaction',async()=>{
  const box=await fixture(),batch=await committed(box.id),before=(await raw(batch.id))!;
  let release!:()=>void,entered!:()=>void,calls=0;const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const paused=database(async(target,statements)=>{if(++calls===2){entered();await waiting;}return target.batch(statements);});
  const pending=run({DB:paused},1);await started;const claimed=(await items(batch.id)).results[0];
  expect(claimed.state).toBe('running');expect((await raw(batch.id))!.version).toBe(before.version+1);
  await env.DB.batch([
    env.DB.prepare('UPDATE async_export_notification_retry_batches SET cancelled_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(at,batch.id),
    env.DB.prepare("UPDATE async_export_notification_retry_items SET state='unknown',reason='result_unknown',completed_at=?,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=updated_at+1 WHERE batch_id=?").bind(at,batch.id),
    exportRetryBatchSyncStatement(env,batch.id,at)
  ]);
  release();await pending;
  expect((await items(batch.id)).results[0]).toMatchObject({state:'unknown',reason:'result_unknown',lease_token:null});
  expect(await raw(batch.id)).toMatchObject({state:'running',cancelled_at:at,unknown_items:1,requeued_items:0});expect((await audits()).results).toHaveLength(0);
  at+=60010;expect(await run()).toMatchObject({batchRetryRequeued:0});expect((await items(batch.id)).results[0].state).toBe('unknown');
  expect(await env.DB.prepare('SELECT attempt_budget FROM webhook_deliveries WHERE mailbox_id=?').bind(box.id).first('attempt_budget')).toBe(8);
});

it('reconciles a committed receipt after cancellation while preserving its outcome, without giving another retry budget',async()=>{
  const box=await fixture(),batch=await committed(box.id);let calls=0;vi.spyOn(console,'error').mockImplementation(()=>{});
  await run({DB:database(async(target,statements)=>{if(++calls===3)throw Error('checkpoint lost');return target.batch(statements);})},1);
  const item=(await items(batch.id)).results[0];expect(item.state).toBe('running');expect((await audits()).results).toHaveLength(1);
  await env.DB.batch([
    env.DB.prepare('UPDATE async_export_notification_retry_batches SET cancelled_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(at,batch.id),
    env.DB.prepare("UPDATE async_export_notification_retry_items SET state='unknown',reason='result_unknown',completed_at=?,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=updated_at+1 WHERE batch_id=?").bind(at,batch.id),
    exportRetryBatchSyncStatement(env,batch.id,at)
  ]);
  const cancelledAt=at;at+=60010;expect(await run()).toMatchObject({batchRetryReconciled:1,batchRetryRequeued:1});
  expect(await raw(batch.id)).toMatchObject({state:'running',cancelled_at:cancelledAt,requeued_items:1,unknown_items:0});
  const replay=await retryAsyncExportNotificationDelivery(ctx,box.id,item.job_id,item.delivery_id,{clientRequestId:item.client_request_id,expectedUpdatedAt:item.expected_updated_at},
    {batchGuard:{batchId:batch.id,leaseToken:'revoked',itemVersion:item.version}});
  expect(replay.replayed).toBe(true);expect(replay.delivery.attemptBudget).toBe(16);expect((await audits()).results).toHaveLength(1);
  expect(await run()).toMatchObject({batchRetryProcessed:0,batchRetryReconciled:0});
});

it('blocks a cancelled batch at the single-delivery transaction even if a stale running lease was not yet revoked',async()=>{
  const box=await fixture(),batch=await committed(box.id),item=(await items(batch.id)).results[0],token=crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("UPDATE async_export_notification_retry_items SET state='running',lease_token=?,lease_until=?,version=version+1,updated_at=updated_at+1 WHERE batch_id=?").bind(token,at+120000,batch.id),
    env.DB.prepare('UPDATE async_export_notification_retry_batches SET cancelled_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(at,batch.id)
  ]);
  await expect(retryAsyncExportNotificationDelivery(ctx,box.id,item.job_id,item.delivery_id,{clientRequestId:item.client_request_id,expectedUpdatedAt:item.expected_updated_at},
    {batchGuard:{batchId:batch.id,leaseToken:token,itemVersion:item.version+1}})).rejects.toMatchObject({code:'export_notification_retry_changed'});
  expect((await audits()).results).toHaveLength(0);expect(await env.DB.prepare('SELECT attempt_budget FROM webhook_deliveries WHERE id=?').bind(item.delivery_id).first('attempt_budget')).toBe(8);
  expect(await run()).toMatchObject({batchRetryProcessed:0});
});

it('keeps the append-only receipt and delivery update atomic when the real lease deadline crosses between their SQL statements',async()=>{
  const box=await fixture(),batch=await committed(box.id),item=(await items(batch.id)).results[0],token=crypto.randomUUID(),until=at+1000;
  await env.DB.prepare("UPDATE async_export_notification_retry_items SET state='running',lease_token=?,lease_until=?,version=version+1,updated_at=updated_at+1 WHERE batch_id=? AND delivery_id=?").bind(token,until,batch.id,item.delivery_id).run();
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE deadline_observation(at INTEGER) STRICT'),
    env.DB.prepare(`CREATE TRIGGER delayed_retry_audit AFTER INSERT ON audit_events WHEN NEW.action='webhook.delivery_retried'
      BEGIN SELECT COUNT(*) FROM(WITH RECURSIVE clock_delay(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM clock_delay WHERE i<20000000) SELECT i FROM clock_delay); END`),
    env.DB.prepare(`CREATE TRIGGER observe_retry_queue AFTER UPDATE OF state ON webhook_deliveries WHEN OLD.state='dead' AND NEW.state='pending'
      BEGIN INSERT INTO deadline_observation(at) VALUES(CAST(unixepoch('subsec')*1000 AS INTEGER)); END`)
  ]);
  const result=await retryAsyncExportNotificationDelivery(ctx,box.id,item.job_id,item.delivery_id,{clientRequestId:item.client_request_id,expectedUpdatedAt:item.expected_updated_at},
    {batchGuard:{batchId:batch.id,leaseToken:token,itemVersion:item.version+1}});
  expect(Number(await env.DB.prepare('SELECT at FROM deadline_observation').first('at'))).toBeGreaterThanOrEqual(until);
  expect(result.delivery.state).toBe('pending');expect(result.delivery.attemptBudget).toBe(16);expect((await audits()).results).toHaveLength(1);
},30_000);
