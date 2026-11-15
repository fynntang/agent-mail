import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {createWebhookEndpoint} from '../../src/lib/server/core/webhooks';
import {getAlertNotificationPolicy,updateAlertNotificationPolicy} from '../../src/lib/server/core/alert-notification-policy';
import {projectRetryBatchNotifications} from '../../src/lib/server/core/retry-batch-notifications';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import {previewRetryBatchNotificationRetryBatch,commitRetryBatchNotificationRetryBatch,type NotificationRetryBatchRow,type NotificationRetryItemRow} from '../../src/lib/server/core/retry-batch-notification-retry-batches';
import {runRetryBatchNotificationRetryJobs} from '../../src/lib/server/core/retry-batch-notification-retry-jobs';
import {retryRetryBatchNotificationDelivery} from '../../src/lib/server/core/retry-batch-notification-retry';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,env:RuntimeEnv,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'notice-bulk-jobs'},r2Buckets:{MAIL_BLOBS:'notice-bulk-jobs'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',OWNER_EMAIL:'owner@example.com',WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;vi.spyOn(Date,'now').mockImplementation(()=>at);
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const raw=(id:string)=>env.DB.prepare('SELECT * FROM retry_batch_notification_retry_batches WHERE id=?').bind(id).first<NotificationRetryBatchRow>();
const items=(id:string)=>env.DB.prepare('SELECT * FROM retry_batch_notification_retry_items WHERE batch_id=? ORDER BY delivery_id').bind(id).all<NotificationRetryItemRow>();
const audits=()=>env.DB.prepare("SELECT id FROM audit_events WHERE action='webhook.delivery_retried'").all<{id:string}>();
const run=(overrides:Partial<RuntimeEnv>={},maxItems?:number)=>runRetryBatchNotificationRetryJobs({...env,...overrides},{now:()=>at,...(maxItems===undefined?{}:{maxItems})});
async function policy(box:string,changes:Record<string,unknown>){const {version,updatedAt,...fields}=(await getAlertNotificationPolicy(ctx,box)).policy;return updateAlertNotificationPolicy(ctx,box,{...fields,...changes,expectedVersion:version});}
async function notice(box:string){
  const source=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO async_export_notification_retry_batches(id,mailbox_id,preview_request_id,request_hash,from_ms,to_ms,filter_reason,created_at,updated_at,expires_at,preview_expires_at,total_items,eligible_items)
    VALUES(?,?,?,?,0,1,'all',?,?,?,?,0,0)`).bind(source,box,crypto.randomUUID(),'a'.repeat(64),at,at,at+86400000,at+600000).run();
  await env.DB.prepare("UPDATE async_export_notification_retry_batches SET state='queued',commit_request_id=?,commit_expected_version=1,committed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(crypto.randomUUID(),at,source).run();at+=2;
  await env.DB.prepare("UPDATE async_export_notification_retry_batches SET state='completed',completed_at=?,version=version+1,updated_at=? WHERE id=?").bind(at,at,source).run();return source;
}
async function transport(count:number){await projectRetryBatchNotifications(env,{now:()=>at});for(let i=0;i<Math.ceil(count/2);i++)await runWebhookJobs(env,{now:()=>at,fetcher:async()=>new Response(null,{status:400})});}
async function fixture(count=1){
  const box=await createMailbox(ctx,{name:'Notice bulk executor',localPart:`notice-jobs-${crypto.randomUUID()}`});
  for(let i=0;i<count;i++){await createWebhookEndpoint(ctx,box.id,{url:`https://hooks.example.net/${i}`,eventTypes:['alert_notification.retry_batch.completed']});at++;}
  await policy(box.id,{repeatIntervalSeconds:0});at++;
  await notice(box.id);await transport(count);return box;
}
async function preview(box:string){return previewRetryBatchNotificationRetryBatch(ctx,box,{clientRequestId:crypto.randomUUID(),from:at-100000,to:at+1,reason:'all'});}
async function committed(box:string){const p=await preview(box);return(await commitRetryBatchNotificationRetryBatch(ctx,box,p.batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:p.batch.version})).batch;}
function database(replace:(target:D1Database,statements:D1PreparedStatement[])=>Promise<D1Result[]>){return new Proxy(env.DB,{get(target,key){if(key==='batch')return(statements:D1PreparedStatement[])=>replace(target,statements);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}
const sourceFacts=()=>env.DB.prepare(`SELECT(SELECT COUNT(*) FROM async_export_notification_retry_batches) sourceBatches,
 (SELECT COUNT(*) FROM async_export_retry_batch_notifications) notifications,(SELECT COUNT(*) FROM events) events,
 (SELECT COUNT(*) FROM async_export_notification_state) admissionClocks,(SELECT COUNT(*) FROM webhook_delivery_attempts) attempts`).first();

it('processes five then one frozen candidates without recursion, publication or HTTP and excludes later failed notices',async()=>{
  const box=await fixture(6),batch=await committed(box.id),original=(await items(batch.id)).results;
  await notice(box.id);await transport(6);const facts=await sourceFacts(),fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('unexpected HTTP');});
  expect(await run()).toMatchObject({noticeBatchRetryProcessed:5,noticeBatchRetryRequeued:5});expect(await raw(batch.id)).toMatchObject({state:'running',processed_items:5,requeued_items:5,total_items:6});
  expect(await run()).toMatchObject({noticeBatchRetryProcessed:1,noticeBatchRetryRequeued:1});expect(await raw(batch.id)).toMatchObject({state:'completed',processed_items:6,unknown_items:0});
  expect((await items(batch.id)).results.map(item=>item.delivery_id)).toEqual(original.map(item=>item.delivery_id));expect((await audits()).results).toHaveLength(6);
  expect(await sourceFacts()).toEqual(facts);expect(fetcher).not.toHaveBeenCalled();expect(await run()).toMatchObject({noticeBatchRetryProcessed:0});
  expect(Number(await env.DB.prepare("SELECT COUNT(*) n FROM webhook_deliveries WHERE state='dead'").first('n'))).toBe(6);
},30_000);

it('records changed and live-policy skips and never promotes candidates blocked by their original preview',async()=>{
  const box=await fixture(3),batch=await committed(box.id),frozen=(await items(batch.id)).results;
  await env.DB.prepare('UPDATE webhook_deliveries SET updated_at=updated_at+1 WHERE id=?').bind(frozen[0].delivery_id).run();await policy(box.id,{enabled:false});
  expect(await run()).toMatchObject({noticeBatchRetrySkipped:3,noticeBatchRetryRequeued:0});const outcomes=(await items(batch.id)).results;
  expect(outcomes.find(item=>item.delivery_id===frozen[0].delivery_id)?.reason).toBe('changed');expect(outcomes.filter(item=>item.reason==='notifications_disabled')).toHaveLength(2);
  const blocked=await committed(box.id);expect(blocked.eligibleItems).toBe(0);await policy(box.id,{enabled:true});expect(await run()).toMatchObject({noticeBatchRetrySkipped:3});
  expect((await items(blocked.id)).results.every(item=>item.reason==='notifications_disabled')).toBe(true);expect((await audits()).results).toHaveLength(0);
});

it('allows concurrent executors to create one receipt and budget increase per selected delivery',async()=>{
  const box=await fixture(6),batch=await committed(box.id);await Promise.all([run(),run()]);await run();
  expect(await raw(batch.id)).toMatchObject({state:'completed',requeued_items:6,processed_items:6,unknown_items:0});expect((await audits()).results).toHaveLength(6);
  expect((await env.DB.prepare('SELECT attempt_budget FROM webhook_deliveries WHERE mailbox_id=?').bind(box.id).all<{attempt_budget:number}>()).results.every(row=>row.attempt_budget===16)).toBe(true);
},30_000);

it('recovers a committed receipt after a lost checkpoint without granting another budget, including after expiry',async()=>{
  const box=await fixture(),batch=await committed(box.id);let calls=0;vi.spyOn(console,'error').mockImplementation(()=>{});
  await run({DB:database(async(target,statements)=>{if(++calls===3)throw Error('PRIVATE_CHECKPOINT_LOST');return target.batch(statements);})},1);
  expect((await items(batch.id)).results[0].state).toBe('running');expect((await audits()).results).toHaveLength(1);at=batch.expiresAt+1;
  expect(await run()).toMatchObject({noticeBatchRetryRequeued:1});expect(await raw(batch.id)).toMatchObject({state:'expired',requeued_items:1,unknown_items:0});
  expect((await audits()).results).toHaveLength(1);expect(await env.DB.prepare('SELECT attempt_budget FROM webhook_deliveries WHERE mailbox_id=?').bind(box.id).first('attempt_budget')).toBe(16);
});

it('fences an old executor after its lease is reclaimed and keeps missing receipts explicitly unknown without resubmission',async()=>{
  const box=await fixture(),batch=await committed(box.id);let release!:()=>void,entered!:()=>void,calls=0;const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const paused=database(async(target,statements)=>{if(++calls===2){entered();await waiting;}return target.batch(statements);});
  const pending=run({DB:paused},1);await started;const before=(await raw(batch.id))!;expect(before.version).toBe(batch.version+1);at+=120001;
  expect(await run({},1)).toMatchObject({noticeBatchRetryUnknown:1});release();await pending;
  expect(await raw(batch.id)).toMatchObject({state:'running',unknown_items:1,requeued_items:0,processed_items:1});expect((await audits()).results).toHaveLength(0);
  at+=60001;const facts=await sourceFacts();await run();expect((await items(batch.id)).results[0].state).toBe('unknown');expect((await audits()).results).toHaveLength(0);expect(await sourceFacts()).toEqual(facts);
  expect(await env.DB.prepare('SELECT attempt_budget FROM webhook_deliveries WHERE mailbox_id=?').bind(box.id).first('attempt_budget')).toBe(8);
});

it('recovers a lost claim acknowledgement conservatively without creating a receipt or replaying the selected operation',async()=>{
  const box=await fixture(),batch=await committed(box.id);let calls=0;
  const lost=database(async(target,statements)=>{const applied=await target.batch(statements);if(++calls===1)throw Error('PRIVATE_CLAIM_ACK');return applied;});
  await expect(run({DB:lost},1)).rejects.toThrow('PRIVATE_CLAIM_ACK');expect((await items(batch.id)).results[0].state).toBe('running');expect((await audits()).results).toHaveLength(0);
  const facts=await sourceFacts();at+=120001;expect(await run({},1)).toMatchObject({noticeBatchRetryUnknown:1});at+=60001;await run();
  expect((await items(batch.id)).results[0].state).toBe('unknown');expect((await audits()).results).toHaveLength(0);expect(await sourceFacts()).toEqual(facts);
});

it('records a frozen signing-key failure without producing a notification about the notification retry task',async()=>{
  const box=await fixture(),batch=await committed(box.id),facts=await sourceFacts();
  expect(await run({WEBHOOK_KEYRING:JSON.stringify({activeKid:'k2',keys:{k2:'A'.repeat(43)}})})).toMatchObject({noticeBatchRetryFailed:1,noticeBatchRetryRequeued:0});
  expect(await raw(batch.id)).toMatchObject({state:'completed',failed_items:1,requeued_items:0});expect((await items(batch.id)).results[0].reason).toBe('signing_key_unavailable');
  expect((await audits()).results).toHaveLength(0);expect(await sourceFacts()).toEqual(facts);
});

it('expires pending entries without invoking the helper, while quiet and paused execution remain individual skips',async()=>{
  const box=await fixture(2),batch=await committed(box.id);at=batch.expiresAt+1;const facts=await sourceFacts();expect(await run()).toMatchObject({noticeBatchRetrySkipped:2});
  expect(await raw(batch.id)).toMatchObject({state:'expired',skipped_items:2,requeued_items:0});expect(await sourceFacts()).toEqual(facts);
  const other=await fixture(),quiet=await committed(other.id),minute=new Date(at).getUTCHours()*60+new Date(at).getUTCMinutes();
  await policy(other.id,{quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440,timeZone:'UTC'});expect(await run()).toMatchObject({noticeBatchRetrySkipped:1});expect((await items(quiet.id)).results[0].reason).toBe('quiet_hours');
  await policy(other.id,{quietEnabled:false});const paused=await committed(other.id);await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(other.id).run();expect(await run()).toMatchObject({noticeBatchRetrySkipped:1});expect((await items(paused.id)).results[0].reason).toBe('mailbox_inactive');
  expect((await audits()).results).toHaveLength(0);
});

it('finishes an empty confirmed task without any notification and rejects invalid execution budgets',async()=>{
  const box=await createMailbox(ctx,{name:'Empty independent task',localPart:`empty-${crypto.randomUUID()}`}),batch=await committed(box.id),facts=await sourceFacts();
  expect(await run()).toMatchObject({noticeBatchRetryProcessed:0});expect(await raw(batch.id)).toMatchObject({state:'completed',total_items:0,processed_items:0});expect(await sourceFacts()).toEqual(facts);
  for(const maxItems of[0,6,1.5])await expect(run({},maxItems)).rejects.toMatchObject({code:'invalid_query'});
});

it('requires the exact source notice and internal lease/version fence before the single-delivery transaction',async()=>{
  const box=await fixture(),batch=await committed(box.id),item=(await items(batch.id)).results[0],token=crypto.randomUUID();
  await env.DB.prepare("UPDATE retry_batch_notification_retry_items SET state='running',lease_token=?,lease_until=?,version=version+1,updated_at=updated_at+1 WHERE batch_id=?").bind(token,at+120000,batch.id).run();
  const intent={clientRequestId:item.client_request_id,expectedUpdatedAt:item.expected_updated_at};
  for(const guard of[{batchId:crypto.randomUUID(),leaseToken:token,itemVersion:item.version+1},{batchId:batch.id,leaseToken:'old',itemVersion:item.version+1},{batchId:batch.id,leaseToken:token,itemVersion:item.version}])
    await expect(retryRetryBatchNotificationDelivery(ctx,box.id,item.notification_id,item.delivery_id,intent,{batchGuard:guard})).rejects.toMatchObject({code:'retry_batch_notification_retry_changed'});
  await expect(retryRetryBatchNotificationDelivery(ctx,box.id,item.notification_id,item.delivery_id,{...intent,batchGuard:{batchId:batch.id,leaseToken:token,itemVersion:item.version+1}})).rejects.toMatchObject({code:'invalid_input'});
  expect((await audits()).results).toHaveLength(0);expect(await env.DB.prepare('SELECT attempt_budget FROM webhook_deliveries WHERE id=?').bind(item.delivery_id).first('attempt_budget')).toBe(8);
});

it('keeps a valid audit and queue mutation atomic when a real SQL clock crosses the admitted lease deadline',async()=>{
  const box=await fixture(),batch=await committed(box.id),item=(await items(batch.id)).results[0],token=crypto.randomUUID(),until=at+1000;
  await env.DB.prepare("UPDATE retry_batch_notification_retry_items SET state='running',lease_token=?,lease_until=?,version=version+1,updated_at=updated_at+1 WHERE batch_id=? AND delivery_id=?").bind(token,until,batch.id,item.delivery_id).run();
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE notice_deadline_observation(at INTEGER) STRICT'),
    env.DB.prepare(`CREATE TRIGGER delayed_notice_retry_audit AFTER INSERT ON audit_events WHEN NEW.action='webhook.delivery_retried'
      BEGIN SELECT COUNT(*) FROM(WITH RECURSIVE clock_delay(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM clock_delay WHERE i<20000000) SELECT i FROM clock_delay); END`),
    env.DB.prepare(`CREATE TRIGGER observe_notice_retry_queue AFTER UPDATE OF state ON webhook_deliveries WHEN OLD.state='dead' AND NEW.state='pending'
      BEGIN INSERT INTO notice_deadline_observation(at) VALUES(CAST(unixepoch('subsec')*1000 AS INTEGER)); END`)
  ]);
  const result=await retryRetryBatchNotificationDelivery(ctx,box.id,item.notification_id,item.delivery_id,{clientRequestId:item.client_request_id,expectedUpdatedAt:item.expected_updated_at},
    {batchGuard:{batchId:batch.id,leaseToken:token,itemVersion:item.version+1}});
  expect(Number(await env.DB.prepare('SELECT at FROM notice_deadline_observation').first('at'))).toBeGreaterThanOrEqual(until);
  expect(result.delivery.state).toBe('pending');expect(result.delivery.attemptBudget).toBe(16);expect((await audits()).results).toHaveLength(1);
},30_000);
