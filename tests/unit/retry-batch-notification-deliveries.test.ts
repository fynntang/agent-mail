import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {previewAsyncExportNotificationRetryBatch,commitAsyncExportNotificationRetryBatch} from '../../src/lib/server/core/async-export-notification-retry-batches';
import {projectRetryBatchNotifications,type RetryBatchNotificationRow} from '../../src/lib/server/core/retry-batch-notifications';
import {listRetryBatchNotificationDeliveryResults,getRetryBatchNotificationDelivery} from '../../src/lib/server/core/retry-batch-notification-deliveries';
import {retryBatchNotificationFrozenPayloadValid,retryBatchNotificationDeliveryWasCaptured} from '../../src/lib/server/core/retry-batch-notification-delivery-shared';
import {createWebhookEndpoint,type WebhookEventRow} from '../../src/lib/server/core/webhooks';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:{DB:'retry-batch-tracking'},r2Buckets:{MAIL_BLOBS:'retry-batch-tracking'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',
    WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
  at=Date.now()+1000;vi.spyOn(Date,'now').mockImplementation(()=>at);
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Batch tracking',localPart:`batch-tracking-${crypto.randomUUID()}`});
async function terminal(mailbox:string){
  const preview=await previewAsyncExportNotificationRetryBatch(ctx,mailbox,{clientRequestId:crypto.randomUUID()}),committed=await commitAsyncExportNotificationRetryBatch(ctx,mailbox,preview.batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:preview.batch.version});
  await ctx.env.DB.prepare("UPDATE async_export_notification_retry_batches SET state='completed',completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at,committed.batch.id).run();
  return(await ctx.env.DB.prepare('SELECT * FROM async_export_retry_batch_notifications WHERE batch_id=?').bind(committed.batch.id).first<RetryBatchNotificationRow>())!;
}
async function fixture(endpoints=3){
  const mailbox=await box();for(let i=0;i<endpoints;i++)await createWebhookEndpoint(ctx,mailbox.id,{url:`https://hooks.example.net/PRIVATE_BATCH_TARGET_${i}`,eventTypes:['alert_notification.retry_batch.completed']});
  const notice=await terminal(mailbox.id);await projectRetryBatchNotifications(ctx.env,{now:()=>at+100});
  for(let i=0;i<Math.ceil(endpoints/2);i++)await runWebhookJobs(ctx.env,{now:()=>at+200,fetcher:async()=>new Response(null,{status:400})});
  return {mailbox,notice};
}
function safe(value:unknown){expect(JSON.stringify(value)).not.toMatch(/PRIVATE_BATCH|claim_token|lease_token|signing_secret|url_snapshot|payload_json|endpoint_snapshot_json|WEBHOOK_KEYRING|object_key/);}
const counts=()=>ctx.env.DB.prepare('SELECT(SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM events) events,(SELECT sum(attempts) FROM webhook_deliveries) attempts').first();

it('shows durable decisions and empty totals through projection/publication without implying delivery success',async()=>{
  const mailbox=await box(),notice=await terminal(mailbox.id);
  const initial=await listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id);expect(initial).toMatchObject({publication:'pending_projection',notification:{notificationDecision:null,currentAttention:false},deliverySummary:{total:0,attempts:0}});expect(initial.deliveries).toEqual([]);
  await projectRetryBatchNotifications(ctx.env,{now:()=>at+100});expect((await listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id)).publication).toBe('pending_publication');
  await runWebhookJobs(ctx.env,{now:()=>at+200,fetcher:async()=>{throw Error('No subscriber should be called');}});
  const final=await listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id);expect(final).toMatchObject({publication:'published',notification:{notificationDecision:'no_subscribers'},deliverySummary:{total:0}});safe(final);
});

it('paginates the exact notification event with full snapshot counters and scoped cursors',async()=>{
  const {mailbox,notice}=await fixture(),page=await listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id,{limit:2});
  expect(page).toMatchObject({publication:'published',notification:{notificationDecision:'allowed'},deliverySummary:{total:3,dead:3,attempts:3}});expect(page.deliveries).toHaveLength(2);expect(page.nextCursor).not.toBeNull();
  const next=await listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id,{limit:2,cursor:page.nextCursor});expect(next.deliveries).toHaveLength(1);expect(next.nextCursor).toBeNull();expect(new Set([...page.deliveries,...next.deliveries].map(row=>row.id)).size).toBe(3);expect(page.deliveries.every(row=>row.retry.available)).toBe(true);
  const other=await terminal(mailbox.id);await expect(listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,other.id,{limit:2,cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id,{limit:1,cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(getRetryBatchNotificationDelivery(ctx,mailbox.id,other.id,page.deliveries[0].id)).rejects.toMatchObject({status:404});safe(page);safe(next);
});

it('returns bounded, sanitized attempt and manual-retry histories including legacy receipts',async()=>{
  const {mailbox,notice}=await fixture(1),page=await listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id),delivery=page.deliveries[0],client=crypto.randomUUID();
  for(let i=0;i<11;i++)await ctx.env.DB.prepare("INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at) VALUES(?,?,'owner','webhook.delivery_retried',?,'success','PRIVATE_BATCH_REQUEST',?,?)")
    .bind(crypto.randomUUID(),mailbox.id,delivery.id,i===10?'{}':JSON.stringify({clientRequestId:client,expectedUpdatedAt:delivery.updatedAt,previousAttemptBudget:8,attemptBudget:16,PRIVATE_BATCH:'NEVER_RETURN'}),at+201+i).run();
  const detail=await getRetryBatchNotificationDelivery(ctx,mailbox.id,notice.id,delivery.id);expect(detail.attempts).toHaveLength(1);expect(detail.attempts[0]).toMatchObject({attemptNo:1,outcome:'dead',httpStatus:400,errorCode:'http_rejected'});
  expect(detail.manualRetries).toHaveLength(10);expect(detail.manualRetries[0]).toMatchObject({clientRequestId:null,expectedUpdatedAt:null,previousAttemptBudget:null,attemptBudget:null});expect(detail.manualRetries[1]).toMatchObject({clientRequestId:client,previousAttemptBudget:8,attemptBudget:16});safe(detail);
});

it('reads without decrypting, fetching, touching R2 or mutating data when key configuration is absent',async()=>{
  const {mailbox,notice}=await fixture(1),before=await counts();
  const decrypt=vi.spyOn(crypto.subtle,'decrypt').mockImplementation(async()=>{throw Error('Read must not decrypt');}),fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('Read must not fetch');});
  const restricted={...ctx,env:{...ctx.env,WEBHOOK_KEYRING:undefined,MAIL_BLOBS:new Proxy(ctx.env.MAIL_BLOBS,{get(){throw Error('Read must not use R2');}})}};
  const page=await listRetryBatchNotificationDeliveryResults(restricted,mailbox.id,notice.id);expect(page.deliveries[0].retry).toEqual({available:false,reason:'not_configured'});
  const detail=await getRetryBatchNotificationDelivery(restricted,mailbox.id,notice.id,page.deliveries[0].id);safe(detail);expect(decrypt).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();expect(await counts()).toEqual(before);
});

it('allows paused historical reads while rejecting other mailboxes and all non-Owner actors',async()=>{
  const {mailbox,notice}=await fixture(1),other=await box(),page=await listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id);
  await ctx.env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(mailbox.id).run();
  const result=await getRetryBatchNotificationDelivery(ctx,mailbox.id,notice.id,page.deliveries[0].id);expect(result.delivery.retry).toEqual({available:false,reason:'mailbox_inactive'});
  await expect(listRetryBatchNotificationDeliveryResults(ctx,other.id,notice.id)).rejects.toMatchObject({status:404});
  for(const actor of [null,{kind:'token' as const,mailboxId:mailbox.id,tokenId:crypto.randomUUID(),canRead:true}]){
    const unauthorized={...ctx,actor};await expect(listRetryBatchNotificationDeliveryResults(unauthorized,mailbox.id,notice.id)).rejects.toMatchObject({status:actor?403:401});
    await expect(getRetryBatchNotificationDelivery(unauthorized,mailbox.id,notice.id,page.deliveries[0].id)).rejects.toMatchObject({status:actor?403:401});
  }
});

it('rechecks current enabled/quiet policy without reevaluating the immutable allowed decision',async()=>{
  const {mailbox,notice}=await fixture(1),page=await listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id),id=page.deliveries[0].id;
  await ctx.env.DB.prepare('INSERT INTO alert_notification_policies(mailbox_id,enabled,updated_at) VALUES(?,0,?)').bind(mailbox.id,at).run();
  const disabled=await getRetryBatchNotificationDelivery(ctx,mailbox.id,notice.id,id);expect(disabled).toMatchObject({notification:{notificationDecision:'allowed'},delivery:{retry:{available:false,reason:'notifications_disabled'}},currentPolicy:{enabled:false,quiet:false,version:1}});
  const date=new Date(at),minute=date.getUTCHours()*60+date.getUTCMinutes();await ctx.env.DB.prepare("UPDATE alert_notification_policies SET enabled=1,quiet_enabled=1,quiet_start_minute=?,quiet_end_minute=?,time_zone='UTC',version=version+1,updated_at=updated_at+1 WHERE mailbox_id=?")
    .bind((minute+1435)%1440,(minute+5)%1440,mailbox.id).run();
  const quiet=await getRetryBatchNotificationDelivery(ctx,mailbox.id,notice.id,id);expect(quiet.delivery.retry).toEqual({available:false,reason:'quiet_hours'});expect(quiet.currentPolicy).toEqual({enabled:true,quiet:true,version:2});
});

it('binds every frozen payload field and the captured original endpoint key version',async()=>{
  const {mailbox,notice}=await fixture(1),page=await listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id),delivery=page.deliveries[0];
  const raw=(await ctx.env.DB.prepare('SELECT * FROM async_export_retry_batch_notifications WHERE id=?').bind(notice.id).first<RetryBatchNotificationRow>())!,payload=(await ctx.env.DB.prepare('SELECT payload_json FROM webhook_deliveries WHERE id=?').bind(delivery.id).first<string>('payload_json'))!;
  const event=(await ctx.env.DB.prepare('SELECT * FROM events WHERE id=?').bind(delivery.eventId).first<WebhookEventRow&{source_event_id:string}>())!;
  expect(retryBatchNotificationFrozenPayloadValid(raw,event,payload)).toBe(true);expect(retryBatchNotificationDeliveryWasCaptured(raw,delivery.endpointId,delivery.secretVersion)).toBe(true);
  for(const field of ['notificationId','batchId','kind','reason','batchState','sourceVersion','totalItems','eligibleItems','processedItems','requeuedItems','skippedItems','failedItems','unknownItems','occurredAt']){
    const data=JSON.parse(event.payload_json);data[field]=typeof data[field]==='number'?data[field]+1:'forged';expect(retryBatchNotificationFrozenPayloadValid(raw,{...event,payload_json:JSON.stringify(data)},payload),field).toBe(false);
  }
  expect(retryBatchNotificationFrozenPayloadValid(raw,{...event,source_event_id:'forged'},payload)).toBe(false);expect(retryBatchNotificationFrozenPayloadValid(raw,{...event,mailbox_id:crypto.randomUUID()},payload)).toBe(false);
  expect(retryBatchNotificationFrozenPayloadValid(raw,event,payload+' ')).toBe(false);expect(retryBatchNotificationFrozenPayloadValid(raw,event,' '.repeat(8193))).toBe(false);
  expect(retryBatchNotificationDeliveryWasCaptured(raw,crypto.randomUUID(),delivery.secretVersion)).toBe(false);expect(retryBatchNotificationDeliveryWasCaptured(raw,delivery.endpointId,delivery.secretVersion+1)).toBe(false);
  expect((await getRetryBatchNotificationDelivery(ctx,mailbox.id,notice.id,delivery.id)).currentPolicy).toEqual({enabled:true,quiet:false,version:0});
});

it('does not offer retries for a plausible delivery associated with an endpoint outside the captured subscription snapshot',async()=>{
  const {mailbox,notice}=await fixture(1),page=await listRetryBatchNotificationDeliveryResults(ctx,mailbox.id,notice.id),delivery=page.deliveries[0];at+=10000;
  const later=await createWebhookEndpoint(ctx,mailbox.id,{url:'https://hooks.example.net/PRIVATE_BATCH_LATE',eventTypes:['alert_notification.retry_batch.completed']});
  const old=(await ctx.env.DB.prepare('SELECT * FROM webhook_deliveries WHERE id=?').bind(delivery.id).first<Record<string,unknown>>())!,newId=crypto.randomUUID();
  const copy:Record<string,unknown>={...old,id:newId,endpoint_id:later.endpoint.id},columns=Object.keys(copy);
  await ctx.env.DB.prepare(`INSERT INTO webhook_deliveries(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(column=>copy[column] as string|number|null)).run();
  expect((await getRetryBatchNotificationDelivery(ctx,mailbox.id,notice.id,newId)).delivery.retry).toEqual({available:false,reason:'payload_unavailable'});
});
