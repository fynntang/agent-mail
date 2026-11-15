import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {createAsyncAlertNotificationExport} from '../../src/lib/server/core/async-alert-notification-exports';
import {projectAsyncExportNotifications} from '../../src/lib/server/core/async-export-notifications';
import {createWebhookEndpoint} from '../../src/lib/server/core/webhooks';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import {previewAsyncExportNotificationRetryBatch,commitAsyncExportNotificationRetryBatch,getAsyncExportNotificationRetryBatch,type BatchRetryRow,type BatchRetryItemRow} from '../../src/lib/server/core/async-export-notification-retry-batches';
import {cancelAsyncExportNotificationRetryBatch,reconcileAsyncExportNotificationRetryBatch,listAsyncExportNotificationRetryBatchOperations} from '../../src/lib/server/core/async-export-notification-retry-controls';
import {exportRetryBatchSyncStatement} from '../../src/lib/server/core/async-export-notification-retry-batch-shared';
import {retryAsyncExportNotificationDelivery} from '../../src/lib/server/core/async-export-notification-retry';
import {stableId} from '../../src/lib/server/core/crypto';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,env:RuntimeEnv,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:{DB:'retry-controls'},r2Buckets:{MAIL_BLOBS:'retry-controls'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',OWNER_EMAIL:'owner@example.com',WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;vi.spyOn(Date,'now').mockImplementation(()=>at);
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const newBox=()=>createMailbox(ctx,{name:'Retry controls',localPart:`controls-${crypto.randomUUID()}`});
const raw=(id:string)=>env.DB.prepare('SELECT * FROM async_export_notification_retry_batches WHERE id=?').bind(id).first<BatchRetryRow>();
const items=async(id:string)=>(await env.DB.prepare('SELECT * FROM async_export_notification_retry_items WHERE batch_id=? ORDER BY delivery_id').bind(id).all<BatchRetryItemRow>()).results;
const preview=(box:string)=>previewAsyncExportNotificationRetryBatch(ctx,box,{clientRequestId:crypto.randomUUID()});
const cancel=(box:string,b:{id:string;version:number},clientRequestId=crypto.randomUUID())=>cancelAsyncExportNotificationRetryBatch(ctx,box,b.id,{clientRequestId,expectedVersion:b.version});
const reconcile=(box:string,b:{id:string;version:number},deliveryId?:string,clientRequestId=crypto.randomUUID())=>reconcileAsyncExportNotificationRetryBatch(ctx,box,b.id,{clientRequestId,expectedVersion:b.version,...(deliveryId?{deliveryId}:{})});
const controlAudits=async()=>Number(await env.DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action IN('export_notification_retry_batch.cancelled','export_notification_retry_batch.reconciled')").first('n'));
const safe=(value:unknown)=>expect(JSON.stringify(value)).not.toMatch(/PRIVATE_CONTROL|metadata_json|lease_token|claim_token|request_hash|signing_secret|https:\/\//);
function database(replace:(target:D1Database,statements:D1PreparedStatement[])=>Promise<D1Result[]>){return new Proxy(env.DB,{get(target,key){if(key==='batch')return(statements:D1PreparedStatement[])=>replace(target,statements);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}
async function fixture(total=3){
  const mailbox=await newBox();await createWebhookEndpoint(ctx,mailbox.id,{url:'https://hooks.example.net/PRIVATE_CONTROL_TARGET',eventTypes:['alert_notification.export.succeeded']});at++;
  for(let i=0;i<total;i++){const job=(await createAsyncAlertNotificationExport(ctx,mailbox.id,{clientRequestId:crypto.randomUUID(),format:'json'})).job;
    await env.DB.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='fixture',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at+120000,job.id).run();
    await env.DB.prepare("UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at,job.id).run();at++;
  }
  for(let i=0;i<Math.ceil(total/20);i++)await projectAsyncExportNotifications(env,{now:()=>at});for(let i=0;i<Math.ceil(total/2);i++)await runWebhookJobs(env,{now:()=>at,fetcher:async()=>new Response(null,{status:400})});
  const p=await preview(mailbox.id),committed=await commitAsyncExportNotificationRetryBatch(ctx,mailbox.id,p.batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:p.batch.version});
  return {mailbox,batch:committed.batch,items:await items(p.batch.id)};
}
async function setState(item:BatchRetryItemRow,state:'running'|'unknown'|'skipped'|'failed'|'requeued',manualRetryId:string|null=null){
  await env.DB.batch([env.DB.prepare(`UPDATE async_export_notification_retry_items SET state=?,reason=?,manual_retry_id=?,lease_token=?,lease_until=?,completed_at=?,updated_at=updated_at+1,version=version+1 WHERE batch_id=? AND delivery_id=?`)
    .bind(state,state==='unknown'?'result_unknown':null,manualRetryId,state==='running'?'PRIVATE_CONTROL_LEASE':null,state==='running'?at+120000:null,state==='running'?null:at,item.batch_id,item.delivery_id),exportRetryBatchSyncStatement(env,item.batch_id,at)]);
}

it('cancels an uncommitted preview atomically, preserves its selection and derives cancelled even after expiry',async()=>{
  const mailbox=await newBox(),p=await preview(mailbox.id),before=await raw(p.batch.id),request=crypto.randomUUID();
  const result=await cancel(mailbox.id,p.batch,request);expect(result).toMatchObject({replayed:false,batch:{state:'cancelled',cancelledAt:at,canCancel:false,canCommit:false,version:3},operation:{action:'cancel',clientRequestId:request,summary:{stopped:0,unknown:0,retained:0}}});
  expect(await raw(p.batch.id)).toMatchObject({state:'preview',expires_at:before!.expires_at,preview_expires_at:before!.preview_expires_at,committed_at:null});
  await expect(env.DB.prepare('UPDATE async_export_notification_retry_batches SET cancelled_at=NULL,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(p.batch.id).run()).rejects.toThrow('export_retry_batch_cancel_immutable');
  await expect(env.DB.prepare('UPDATE async_export_notification_retry_batches SET cancelled_at=cancelled_at+1,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(p.batch.id).run()).rejects.toThrow();
  at=before!.expires_at+100;expect((await getAsyncExportNotificationRetryBatch(ctx,mailbox.id,p.batch.id)).batch.state).toBe('cancelled');
  expect((await cancel(mailbox.id,p.batch,request)).replayed).toBe(true);expect(await controlAudits()).toBe(1);safe(result);
});

it('stops pending entries, revokes in-flight leases and retains every previously executed result without touching queued Webhooks',async()=>{
  const f=await fixture(6),[done,skipped,failed,unknown,running,pending]=f.items;
  const retried=await retryAsyncExportNotificationDelivery(ctx,f.mailbox.id,done.job_id,done.delivery_id,{clientRequestId:done.client_request_id,expectedUpdatedAt:done.expected_updated_at});
  await setState(done,'requeued',retried.manualRetry.id);await setState(skipped,'skipped');await setState(failed,'failed');await setState(unknown,'unknown');await setState(running,'running');
  const prior=await items(f.batch.id),deliveryBefore=await env.DB.prepare('SELECT state,attempt_budget,updated_at FROM webhook_deliveries WHERE id=?').bind(done.delivery_id).first();
  const result=await cancel(f.mailbox.id,(await raw(f.batch.id))!);expect(result.batch).toMatchObject({state:'cancelled',processedItems:6,requeuedItems:1,skippedItems:2,failedItems:1,unknownItems:2});
  expect(result.operation.summary).toEqual({stopped:1,unknown:2,retained:4});const after=await items(f.batch.id);
  for(const item of prior.filter(value=>['requeued','skipped','failed','unknown'].includes(value.state)))expect(after.find(value=>value.delivery_id===item.delivery_id)).toEqual(item);
  expect(after.find(value=>value.delivery_id===running.delivery_id)).toMatchObject({state:'unknown',reason:'result_unknown',lease_token:null,lease_until:null});
  expect(after.find(value=>value.delivery_id===pending.delivery_id)).toMatchObject({state:'skipped',reason:'batch_cancelled'});
  expect(await env.DB.prepare('SELECT state,attempt_budget,updated_at FROM webhook_deliveries WHERE id=?').bind(done.delivery_id).first()).toEqual(deliveryBefore);
});

it('enforces compare-and-swap, Owner scope, exact replay intent and cancellation eligibility without writing rejected operations',async()=>{
  const f=await fixture(1),other=await newBox(),request=crypto.randomUUID();
  await expect(cancel(f.mailbox.id,{...f.batch,version:999})).rejects.toMatchObject({code:'batch_control_changed'});
  await expect(cancelAsyncExportNotificationRetryBatch({...ctx,actor:{kind:'token',mailboxId:f.mailbox.id,tokenId:crypto.randomUUID(),canRead:true}},f.mailbox.id,f.batch.id,{clientRequestId:request,expectedVersion:f.batch.version})).rejects.toMatchObject({status:403});
  await expect(cancel(other.id,f.batch)).rejects.toMatchObject({status:404});expect(await controlAudits()).toBe(0);
  await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(f.mailbox.id).run();expect((await cancel(f.mailbox.id,f.batch,request)).batch.state).toBe('cancelled');
  await expect(cancel(f.mailbox.id,{...f.batch,version:f.batch.version+1},request)).rejects.toMatchObject({code:'batch_control_conflict'});
  await expect(reconcile(f.mailbox.id,f.batch,undefined,request)).rejects.toMatchObject({code:'batch_control_conflict'});
  const empty=await preview(other.id);at=empty.batch.previewExpiresAt;await expect(cancel(other.id,empty.batch)).rejects.toMatchObject({code:'batch_control_unavailable'});expect(await controlAudits()).toBe(1);
  for(const input of [null,[],{clientRequestId:'bad',expectedVersion:1},{clientRequestId:crypto.randomUUID(),expectedVersion:0},{clientRequestId:crypto.randomUUID(),expectedVersion:1,extra:true}])
    await expect(cancelAsyncExportNotificationRetryBatch(ctx,other.id,empty.batch.id,input)).rejects.toMatchObject({code:'batch_control_invalid',status:400});
});

it('releases cancelled preview and active-job quotas and keeps the original commit receipt replayable',async()=>{
  const mailbox=await newBox(),previews=[];for(let i=0;i<10;i++)previews.push(await preview(mailbox.id));await expect(preview(mailbox.id)).rejects.toMatchObject({code:'batch_retry_quota'});
  await cancel(mailbox.id,previews[0].batch);const extra=await preview(mailbox.id);const input={clientRequestId:crypto.randomUUID(),expectedVersion:extra.batch.version};
  const committed=await commitAsyncExportNotificationRetryBatch(ctx,mailbox.id,extra.batch.id,input);await cancel(mailbox.id,committed.batch);
  expect((await commitAsyncExportNotificationRetryBatch(ctx,mailbox.id,extra.batch.id,input)).batch.state).toBe('cancelled');
  await expect(commitAsyncExportNotificationRetryBatch(ctx,mailbox.id,previews[0].batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:previews[0].batch.version})).rejects.toMatchObject({code:'batch_retry_changed'});
  await commitAsyncExportNotificationRetryBatch(ctx,mailbox.id,previews[1].batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:1});
  await commitAsyncExportNotificationRetryBatch(ctx,mailbox.id,previews[2].batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:1});
});

it('reconciles receipt, proven absence and conflict in one atomic operation without AES, R2, retry calls or HTTP',async()=>{
  const f=await fixture(3),[found,missing,conflict]=f.items;
  const receipt=await retryAsyncExportNotificationDelivery(ctx,f.mailbox.id,found.job_id,found.delivery_id,{clientRequestId:found.client_request_id,expectedUpdatedAt:found.expected_updated_at});
  const conflictId=await stableId(`async-export-notification-retry:v1:${f.mailbox.id}:${conflict.client_request_id}`);
  await env.DB.prepare("INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at) VALUES(?,?,'owner','webhook.delivery_retried',?,'success',?,'{\"PRIVATE_CONTROL_BAD\":true}',?)").bind(conflictId,f.mailbox.id,conflict.delivery_id,ctx.requestId,at).run();
  for(const item of f.items)await setState(item,'unknown');await cancel(f.mailbox.id,(await raw(f.batch.id))!);at=f.batch.expiresAt+1;
  const before=await raw(f.batch.id),budgets=(await env.DB.prepare('SELECT id,attempt_budget FROM webhook_deliveries ORDER BY id').all()).results;
  const decrypt=vi.spyOn(crypto.subtle,'decrypt').mockRejectedValue(Error('forbidden AES')),fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('forbidden HTTP'));
  const readOnly={...ctx,env:{...env,WEBHOOK_KEYRING:undefined,MAIL_BLOBS:new Proxy(env.MAIL_BLOBS,{get(){throw Error('forbidden R2');}})}};
  const input={clientRequestId:crypto.randomUUID(),expectedVersion:before!.version},result=await reconcileAsyncExportNotificationRetryBatch(readOnly,f.mailbox.id,f.batch.id,input);
  expect(result).toMatchObject({replayed:false,batch:{state:'cancelled',processedItems:3,requeuedItems:1,skippedItems:1,unknownItems:1},operation:{action:'reconcile',summary:{requeued:1,notSubmitted:1,unresolved:1}}});
  const after=await items(f.batch.id);expect(after.find(item=>item.delivery_id===found.delivery_id)).toMatchObject({state:'requeued',manual_retry_id:receipt.manualRetry.id,reason:null});
  expect(after.find(item=>item.delivery_id===missing.delivery_id)).toMatchObject({state:'skipped',reason:'not_submitted'});expect(after.find(item=>item.delivery_id===conflict.delivery_id)).toMatchObject({state:'unknown',reason:'receipt_conflict'});
  expect(decrypt).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();expect((await env.DB.prepare('SELECT id,attempt_budget FROM webhook_deliveries ORDER BY id').all()).results).toEqual(budgets);safe(result);
  expect((await reconcileAsyncExportNotificationRetryBatch(readOnly,f.mailbox.id,f.batch.id,input)).replayed).toBe(true);expect((await raw(f.batch.id))!.version).toBe(before!.version+1);
});

it('only reconciles explicit unknown results, can scope one delivery and never steals an active lease',async()=>{
  const f=await fixture(3);await setState(f.items[0],'unknown');await setState(f.items[1],'running');
  let current=(await raw(f.batch.id))!;await expect(reconcile(f.mailbox.id,current,f.items[1].delivery_id)).rejects.toMatchObject({code:'batch_control_unavailable'});
  const result=await reconcile(f.mailbox.id,current,f.items[0].delivery_id);expect(result.operation.items).toEqual([{deliveryId:f.items[0].delivery_id,outcome:'not_submitted',beforeState:'unknown',afterState:'skipped'}]);
  expect((await items(f.batch.id)).find(item=>item.delivery_id===f.items[1].delivery_id)).toMatchObject({state:'running',lease_token:'PRIVATE_CONTROL_LEASE'});
  current=(await raw(f.batch.id))!;await expect(reconcile(f.mailbox.id,current)).rejects.toMatchObject({code:'batch_control_unavailable'});expect(await controlAudits()).toBe(1);
});

it('bounds a manual reconciliation to twenty unknown entries and preserves monotonic processed counts',async()=>{
  const f=await fixture(21);for(const item of f.items)await setState(item,'unknown');const before=(await raw(f.batch.id))!;
  const first=await reconcile(f.mailbox.id,before);expect(first.operation.items).toHaveLength(20);expect(first.batch).toMatchObject({processedItems:21,skippedItems:20,unknownItems:1});
  const second=await reconcile(f.mailbox.id,first.batch);expect(second.operation.items).toHaveLength(1);expect(second.batch).toMatchObject({state:'completed',processedItems:21,skippedItems:21,unknownItems:0});
},30_000);

it('makes simultaneous identical and cross-batch UUID submissions idempotent without changing the losing batch',async()=>{
  const f=await fixture(1),second=await preview(f.mailbox.id),request=crypto.randomUUID();
  const results=await Promise.all([cancel(f.mailbox.id,f.batch,request),cancel(f.mailbox.id,f.batch,request)]);expect(results.map(item=>item.replayed).sort()).toEqual([false,true]);expect(await controlAudits()).toBe(1);
  const otherRequest=crypto.randomUUID(),third=await preview(f.mailbox.id),beforeSecond=await raw(second.batch.id),beforeThird=await raw(third.batch.id);
  const raced=await Promise.allSettled([cancel(f.mailbox.id,second.batch,otherRequest),cancel(f.mailbox.id,third.batch,otherRequest)]);expect(raced.filter(item=>item.status==='fulfilled')).toHaveLength(1);
  const loser=raced[0].status==='rejected'?second:third;expect(await raw(loser.batch.id)).toEqual(loser===second?beforeSecond:beforeThird);expect(await controlAudits()).toBe(2);
});

it('rolls back audit, cancellation marker and items together after a D1 error and reconciles lost acknowledgements safely',async()=>{
  const f=await fixture(2),before=await raw(f.batch.id),beforeItems=await items(f.batch.id);await env.DB.prepare("CREATE TRIGGER test_control_failure BEFORE UPDATE ON async_export_notification_retry_items BEGIN SELECT RAISE(ABORT,'PRIVATE_CONTROL_TX'); END").run();
  await expect(cancel(f.mailbox.id,f.batch)).rejects.toMatchObject({code:'batch_control_unavailable'});expect(await raw(f.batch.id)).toEqual(before);expect(await items(f.batch.id)).toEqual(beforeItems);expect(await controlAudits()).toBe(0);
  await env.DB.prepare('DROP TRIGGER test_control_failure').run();let calls=0;const lost=database(async(target,statements)=>{const applied=await target.batch(statements);if(++calls===2)throw Error('PRIVATE_CONTROL_ACK');return applied;});
  const result=await cancelAsyncExportNotificationRetryBatch({...ctx,env:{...env,DB:lost}},f.mailbox.id,f.batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:f.batch.version});expect(result.replayed).toBe(true);expect(await controlAudits()).toBe(1);expect(result.batch.processedItems).toBe(2);
});

it('fences receipt absence that changes before the final transaction with no false not-submitted result',async()=>{
  const f=await fixture(1),item=f.items[0];await setState(item,'unknown');const before=(await raw(f.batch.id))!;let calls=0;
  const raced=database(async(target,statements)=>{if(++calls===2){const receiptId=await stableId(`async-export-notification-retry:v1:${f.mailbox.id}:${item.client_request_id}`);
      await target.prepare("INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at) VALUES(?,?,'owner','webhook.delivery_retried',?,'success',?,?,?)")
        .bind(receiptId,f.mailbox.id,item.delivery_id,ctx.requestId,JSON.stringify({jobId:item.job_id,clientRequestId:item.client_request_id,expectedUpdatedAt:item.expected_updated_at,previousAttemptBudget:8,attemptBudget:16}),at).run();}
    return target.batch(statements);});
  await expect(reconcileAsyncExportNotificationRetryBatch({...ctx,env:{...env,DB:raced}},f.mailbox.id,f.batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:before.version})).rejects.toMatchObject({code:'batch_control_changed'});
  expect((await items(f.batch.id))[0]).toMatchObject({state:'unknown',reason:'result_unknown'});expect(await raw(f.batch.id)).toEqual(before);expect(await controlAudits()).toBe(0);
});

it('rejects a stale reconciliation snapshot and atomically rolls back its receipt and all result changes on failure',async()=>{
  const f=await fixture(2);for(const item of f.items)await setState(item,'unknown');const before=(await raw(f.batch.id))!,beforeItems=await items(f.batch.id);let calls=0;
  const raced=database(async(target,statements)=>{if(++calls===2)await target.prepare('UPDATE async_export_notification_retry_batches SET version=version+1,updated_at=updated_at+1 WHERE id=?').bind(f.batch.id).run();return target.batch(statements);});
  await expect(reconcileAsyncExportNotificationRetryBatch({...ctx,env:{...env,DB:raced}},f.mailbox.id,f.batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:before.version})).rejects.toMatchObject({code:'batch_control_changed'});
  expect(await items(f.batch.id)).toEqual(beforeItems);expect(await controlAudits()).toBe(0);
  const current=(await raw(f.batch.id))!;await env.DB.prepare("CREATE TRIGGER test_reconcile_failure BEFORE UPDATE ON async_export_notification_retry_items BEGIN SELECT RAISE(ABORT,'PRIVATE_CONTROL_TX'); END").run();
  await expect(reconcile(f.mailbox.id,current)).rejects.toMatchObject({code:'batch_control_unavailable'});expect(await raw(f.batch.id)).toEqual(current);expect(await items(f.batch.id)).toEqual(beforeItems);expect(await controlAudits()).toBe(0);
});

it('replays a lost reconciliation acknowledgement without applying another result or version change',async()=>{
  const f=await fixture(1);await setState(f.items[0],'unknown');const before=(await raw(f.batch.id))!;let calls=0;
  const lost=database(async(target,statements)=>{const applied=await target.batch(statements);if(++calls===2)throw Error('PRIVATE_CONTROL_ACK');return applied;});
  const input={clientRequestId:crypto.randomUUID(),expectedVersion:before.version},result=await reconcileAsyncExportNotificationRetryBatch({...ctx,env:{...env,DB:lost}},f.mailbox.id,f.batch.id,input);
  expect(result).toMatchObject({replayed:true,batch:{version:before.version+1,processedItems:1,skippedItems:1},operation:{summary:{notSubmitted:1,requeued:0,unresolved:0}}});
  const replay=await reconcileAsyncExportNotificationRetryBatch(ctx,f.mailbox.id,f.batch.id,input);expect(replay.operation).toEqual(result.operation);expect(replay.batch).toEqual(result.batch);expect(await controlAudits()).toBe(1);
});

it('pages safe immutable preview, commit and controls history with mailbox, batch and page-size cursor binding',async()=>{
  const f=await fixture(1),item=f.items[0],other=await newBox();await setState(item,'unknown');at++;const c=await cancel(f.mailbox.id,(await raw(f.batch.id))!);at++;await reconcile(f.mailbox.id,c.batch);
  const first=await listAsyncExportNotificationRetryBatchOperations(ctx,f.mailbox.id,f.batch.id,{limit:2}),second=await listAsyncExportNotificationRetryBatchOperations(ctx,f.mailbox.id,f.batch.id,{limit:2,cursor:first.nextCursor});
  expect(first.operations.map(operation=>operation.action)).toEqual(['reconcile','cancel']);expect(second.operations.map(operation=>operation.action).sort()).toEqual(['commit','preview']);expect(second.nextCursor).toBeNull();safe(first);safe(second);
  expect(second.operations.find(item=>item.action==='preview')!.clientRequestId).not.toBeNull();expect(second.operations.find(item=>item.action==='commit')!.expectedVersion).toBe(1);
  await expect(listAsyncExportNotificationRetryBatchOperations(ctx,f.mailbox.id,f.batch.id,{limit:1,cursor:first.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  const another=await preview(f.mailbox.id);await expect(listAsyncExportNotificationRetryBatchOperations(ctx,f.mailbox.id,another.batch.id,{limit:2,cursor:first.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(listAsyncExportNotificationRetryBatchOperations(ctx,other.id,f.batch.id,{limit:2,cursor:first.nextCursor})).rejects.toMatchObject({status:404});
  await expect(listAsyncExportNotificationRetryBatchOperations({...ctx,actor:null},f.mailbox.id,f.batch.id)).rejects.toMatchObject({status:401});expect(await controlAudits()).toBe(2);
});

it('upgrades the previous schema without rebuilding retained batches or changing their immutable identity',async()=>{
  const old=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("old")}}',d1Databases:{DB:'retry-controls-upgrade'},log:new Log(LogLevel.ERROR)}));
  try{const db=await old.getD1Database('DB');for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)&&name<'0018_').sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(query=>db.prepare(query)));
    const oldCtx={...ctx,env:{...env,DB:db}},box=await createMailbox(oldCtx,{name:'Old',localPart:`old-${crypto.randomUUID()}`}),id=crypto.randomUUID(),previewId=crypto.randomUUID();
    await db.prepare("INSERT INTO async_export_notification_retry_batches(id,mailbox_id,preview_request_id,request_hash,from_ms,to_ms,filter_reason,created_at,updated_at,expires_at,preview_expires_at,total_items,eligible_items) VALUES(?,?,?,? ,0,1,'all',?,?,?,?,0,0)").bind(id,box.id,previewId,'a'.repeat(64),at,at,at+86400000,at+600000).run();
    const before=await db.prepare('SELECT * FROM async_export_notification_retry_batches WHERE id=?').bind(id).first();
    await db.batch(unstable_splitSqlQuery(await readFile('migrations/0018_export_notification_retry_controls.sql','utf8')).map(query=>db.prepare(query)));
    expect(await db.prepare('SELECT * FROM async_export_notification_retry_batches WHERE id=?').bind(id).first()).toEqual({...before,cancelled_at:null});
    expect((await cancelAsyncExportNotificationRetryBatch(oldCtx,box.id,id,{clientRequestId:crypto.randomUUID(),expectedVersion:1})).batch).toMatchObject({id,state:'cancelled',version:3});
  }finally{await old.dispose();}
},60_000);
