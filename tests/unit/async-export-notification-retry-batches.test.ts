import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {createAsyncAlertNotificationExport} from '../../src/lib/server/core/async-alert-notification-exports';
import {projectAsyncExportNotifications} from '../../src/lib/server/core/async-export-notifications';
import {createWebhookEndpoint} from '../../src/lib/server/core/webhooks';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import {previewAsyncExportNotificationRetryBatch,commitAsyncExportNotificationRetryBatch,getAsyncExportNotificationRetryBatch,listAsyncExportNotificationRetryBatches,
  type BatchRetryRow} from '../../src/lib/server/core/async-export-notification-retry-batches';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:{DB:'retry-batches-core'},r2Buckets:{MAIL_BLOBS:'retry-batches-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;vi.spyOn(Date,'now').mockImplementation(()=>at);
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Batch retries',localPart:`batch-${crypto.randomUUID()}`});
const count=async(table:string)=>Number(await ctx.env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>('n'));
const preview=(mailbox:string,changes:Record<string,unknown>={})=>previewAsyncExportNotificationRetryBatch(ctx,mailbox,{clientRequestId:crypto.randomUUID(),...changes});
const commit=(mailbox:string,batch:{id:string;version:number},clientRequestId=crypto.randomUUID())=>commitAsyncExportNotificationRetryBatch(ctx,mailbox,batch.id,{clientRequestId,expectedVersion:batch.version});
async function fixture(total=3){
  const mailbox=await box();await createWebhookEndpoint(ctx,mailbox.id,{url:'https://hooks.example.net/PRIVATE_BATCH_TARGET',eventTypes:['alert_notification.export.succeeded']});at++;
  const jobs=[];
  for(let i=0;i<total;i++){const job=(await createAsyncAlertNotificationExport(ctx,mailbox.id,{clientRequestId:crypto.randomUUID(),format:'json'})).job;
    await ctx.env.DB.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='fixture',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at+120000,job.id).run();
    await ctx.env.DB.prepare("UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at,job.id).run();jobs.push(job);at++;
  }
  await projectAsyncExportNotifications(ctx.env,{now:()=>at});for(let i=0;i<Math.ceil(total/2);i++)await runWebhookJobs(ctx.env,{now:()=>at,fetcher:async()=>new Response(null,{status:400})});
  const deliveries=(await ctx.env.DB.prepare('SELECT id,event_id,updated_at,completed_at FROM webhook_deliveries WHERE mailbox_id=? ORDER BY id').bind(mailbox.id).all<{id:string;event_id:string;updated_at:number;completed_at:number}>()).results;
  return {mailbox,jobs,deliveries};
}
function safe(value:unknown){expect(JSON.stringify(value)).not.toMatch(/PRIVATE_BATCH|payload_json|lease_token|claim_token|request_hash|signing_secret|https:\/\//);}

it('freezes only exact mailbox export failures in the half-open failure-time window and preserves safe eligibility hints',async()=>{
  const f=await fixture(3),[first,second,third]=f.deliveries;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE webhook_deliveries SET last_error_code='network_error',completed_at=? WHERE id=?").bind(at-10,first.id),
    ctx.env.DB.prepare("UPDATE webhook_deliveries SET last_error_code='PRIVATE_BATCH_UNKNOWN',completed_at=? WHERE id=?").bind(at-5,second.id),
    ctx.env.DB.prepare("UPDATE webhook_deliveries SET attempt_budget=80,completed_at=? WHERE id=?").bind(at,third.id)
  ]);
  const selected=await preview(f.mailbox.id,{from:at-10,to:at,reason:'all'});expect(selected.batch).toMatchObject({totalItems:2,eligibleItems:2,state:'preview',canCommit:true});expect(selected.items.map(item=>item.failureReason).sort()).toEqual(['network_error','other']);safe(selected);
  const reason=await preview(f.mailbox.id,{from:at-10,to:at+1,reason:'other'});expect(reason.items.map(item=>item.deliveryId)).toEqual([second.id]);
  const blocked=await preview(f.mailbox.id,{from:at,to:at+1,reason:'http_rejected'});expect(blocked.items).toHaveLength(1);expect(blocked.items[0]).toMatchObject({deliveryId:third.id,previewEligible:false,previewReason:'budget_exhausted'});
  await expect(ctx.env.DB.prepare('UPDATE async_export_notification_retry_items SET expected_updated_at=expected_updated_at+1,version=version+1,updated_at=updated_at+1 WHERE batch_id=?').bind(selected.batch.id).run()).rejects.toThrow();
});

it('deduplicates the original default-window intent and leaves the captured candidates unchanged after later failures',async()=>{
  const f=await fixture(2),request={clientRequestId:crypto.randomUUID()},first=await previewAsyncExportNotificationRetryBatch(ctx,f.mailbox.id,request);at+=10000;
  const same=await previewAsyncExportNotificationRetryBatch(ctx,f.mailbox.id,request);expect(same.replayed).toBe(true);expect(same.batch.window).toEqual(first.batch.window);expect(same.batch.id).toBe(first.batch.id);
  await ctx.env.DB.prepare("UPDATE webhook_deliveries SET state='succeeded' WHERE id=?").bind(f.deliveries[0].id).run();
  expect((await getAsyncExportNotificationRetryBatch(ctx,f.mailbox.id,first.batch.id)).items.map(item=>item.deliveryId)).toEqual(first.items.map(item=>item.deliveryId));
  await expect(previewAsyncExportNotificationRetryBatch(ctx,f.mailbox.id,{...request,reason:'network_error'})).rejects.toMatchObject({code:'batch_retry_conflict'});
  const events=await count('events'),attempts=await count('webhook_delivery_attempts');await commit(f.mailbox.id,first.batch);expect(await count('events')).toBe(events);expect(await count('webhook_delivery_attempts')).toBe(attempts);
});

it('commits once under concurrent identical intents and fences changed UUIDs, versions and active-job quotas',async()=>{
  const f=await fixture(1),a=await preview(f.mailbox.id),b=await preview(f.mailbox.id),c=await preview(f.mailbox.id),request=crypto.randomUUID();
  const duplicates=await Promise.all([commit(f.mailbox.id,a.batch,request),commit(f.mailbox.id,a.batch,request)]);expect(duplicates.map(result=>result.replayed).sort()).toEqual([false,true]);
  await expect(commit(f.mailbox.id,a.batch)).rejects.toMatchObject({code:'batch_retry_conflict'});await expect(commit(f.mailbox.id,b.batch,request)).rejects.toMatchObject({code:'batch_retry_conflict'});
  await expect(commitAsyncExportNotificationRetryBatch(ctx,f.mailbox.id,b.batch.id,{clientRequestId:crypto.randomUUID(),expectedVersion:999})).rejects.toMatchObject({code:'batch_retry_changed'});
  await commit(f.mailbox.id,b.batch);await expect(commit(f.mailbox.id,c.batch)).rejects.toMatchObject({code:'batch_retry_quota'});
  expect(await ctx.env.DB.prepare("SELECT count(*) n FROM audit_events WHERE action='export_notification_retry_batch.committed'").first('n')).toBe(2);
});

it('caps instance concurrency atomically across mailboxes',async()=>{
  const mailboxes=await Promise.all(Array.from({length:5},()=>box())),batches=await Promise.all(mailboxes.map(mailbox=>preview(mailbox.id)));
  const result=await Promise.allSettled(batches.map((batch,index)=>commit(mailboxes[index].id,batch.batch)));expect(result.filter(item=>item.status==='fulfilled')).toHaveLength(4);
  expect(await ctx.env.DB.prepare("SELECT count(*) n FROM async_export_notification_retry_batches WHERE state='queued'").first('n')).toBe(4);
});

it('expires preview capability without read side effects and frees expired preview quota',async()=>{
  const mailbox=await box(),created=[];for(let i=0;i<10;i++)created.push(await preview(mailbox.id));await expect(preview(mailbox.id)).rejects.toMatchObject({code:'batch_retry_quota'});
  const before=await count('audit_events');at=created[0].batch.previewExpiresAt;
  const expired=await getAsyncExportNotificationRetryBatch(ctx,mailbox.id,created[0].batch.id);expect(expired.batch).toMatchObject({state:'expired',canCommit:false});expect(await count('audit_events')).toBe(before);
  expect(await ctx.env.DB.prepare('SELECT state FROM async_export_notification_retry_batches WHERE id=?').bind(created[0].batch.id).first('state')).toBe('preview');
  await expect(commit(mailbox.id,created[0].batch)).rejects.toMatchObject({code:'batch_retry_expired',status:410});expect((await preview(mailbox.id)).batch.state).toBe('preview');
});

it('supports safe paginated Owner reads without credentials, AES, R2 or HTTP and denies cross-mailbox cursors and Agents',async()=>{
  const f=await fixture(3),other=await box(),batch=await preview(f.mailbox.id),before=await count('audit_events');
  const decrypt=vi.spyOn(crypto.subtle,'decrypt').mockRejectedValue(Error('No decryption during preview/read'));
  const readOnly={...ctx,env:{...ctx.env,WEBHOOK_KEYRING:undefined,MAIL_BLOBS:new Proxy(ctx.env.MAIL_BLOBS,{get(){throw Error('No R2');}})}};
  const first=await getAsyncExportNotificationRetryBatch(readOnly,f.mailbox.id,batch.batch.id,{limit:2}),next=await getAsyncExportNotificationRetryBatch(readOnly,f.mailbox.id,batch.batch.id,{limit:2,cursor:first.nextCursor});expect(first.items).toHaveLength(2);expect(next.items).toHaveLength(1);expect(decrypt).not.toHaveBeenCalled();
  await expect(getAsyncExportNotificationRetryBatch(ctx,other.id,batch.batch.id)).rejects.toMatchObject({status:404});await expect(getAsyncExportNotificationRetryBatch(ctx,f.mailbox.id,batch.batch.id,{limit:1,cursor:first.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await preview(f.mailbox.id);const page=await listAsyncExportNotificationRetryBatches(ctx,f.mailbox.id,{limit:1});expect(page.nextCursor).not.toBeNull();await expect(listAsyncExportNotificationRetryBatches(ctx,other.id,{limit:1,cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(previewAsyncExportNotificationRetryBatch({...ctx,actor:null},f.mailbox.id,{clientRequestId:crypto.randomUUID()})).rejects.toMatchObject({status:401});
  const actor={kind:'token' as const,mailboxId:f.mailbox.id,tokenId:crypto.randomUUID(),canRead:true};await expect(getAsyncExportNotificationRetryBatch({...ctx,actor},f.mailbox.id,batch.batch.id)).rejects.toMatchObject({status:403});
  expect(await count('audit_events')).toBe(before+1);safe(first);safe(next);
});

it('keeps paused previews ineligible, checks strict inputs and reconciles a lost commit ACK with the same receipt',async()=>{
  const f=await fixture(1);await ctx.env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(f.mailbox.id).run();const paused=await preview(f.mailbox.id);expect(paused.batch).toMatchObject({eligibleItems:0,canCommit:false});expect(paused.items[0].previewReason).toBe('mailbox_inactive');await expect(commit(f.mailbox.id,paused.batch)).rejects.toMatchObject({code:'batch_retry_quota'});
  await ctx.env.DB.prepare("UPDATE mailboxes SET status='active' WHERE id=?").bind(f.mailbox.id).run();const batch=await preview(f.mailbox.id),request=crypto.randomUUID();let lost=false;
  const database=new Proxy(ctx.env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(!lost){lost=true;throw Error('PRIVATE_LOST_ACK');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const committed=await commitAsyncExportNotificationRetryBatch({...ctx,env:{...ctx.env,DB:database}},f.mailbox.id,batch.batch.id,{clientRequestId:request,expectedVersion:batch.batch.version});expect(committed.replayed).toBe(true);
  expect((await commit(f.mailbox.id,batch.batch,request)).batch.id).toBe(batch.batch.id);
  for(const input of [{clientRequestId:'invalid'},{clientRequestId:crypto.randomUUID(),from:true},{clientRequestId:crypto.randomUUID(),reason:'PRIVATE'},
    {clientRequestId:crypto.randomUUID(),from:0,to:32*86400000},{clientRequestId:crypto.randomUUID(),extra:'x'}])await expect(previewAsyncExportNotificationRetryBatch(ctx,f.mailbox.id,input)).rejects.toMatchObject({status:400});
});

it('rejects oversized previews before persisting any selection and accepts exactly1000 candidates',async()=>{
  const f=await fixture(1),source=f.deliveries[0];
  async function clone(count:number){const data=JSON.stringify(Array.from({length:count},()=>({job:crypto.randomUUID(),event:crypto.randomUUID(),delivery:crypto.randomUUID()})));
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`INSERT INTO async_alert_notification_exports(id,mailbox_id,client_request_id,request_hash,format,filter_decision,filter_event_type,from_ms,to_ms,decision_watermark,total_decisions,summary_json,state,created_at,updated_at,expires_at,available_at,cleanup_due_at)
        SELECT json_extract(value,'$.job'),b.mailbox_id,json_extract(value,'$.job'),b.request_hash,b.format,b.filter_decision,b.filter_event_type,b.from_ms,b.to_ms,b.decision_watermark,0,b.summary_json,'succeeded',b.created_at,b.updated_at,b.expires_at,b.available_at,b.cleanup_due_at FROM json_each(?) CROSS JOIN async_alert_notification_exports b WHERE b.id=?`).bind(data,f.jobs[0].id),
      ctx.env.DB.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at,webhook_published_at)
        SELECT json_extract(value,'$.event'),e.mailbox_id,'app',json_extract(value,'$.event'),e.type,json_set(e.payload_json,'$.jobId',json_extract(value,'$.job')),e.occurred_at,e.created_at,e.webhook_published_at FROM json_each(?) CROSS JOIN events e WHERE e.id=?`).bind(data,source.event_id),
      ctx.env.DB.prepare(`INSERT INTO async_export_notifications(job_id,mailbox_id,outcome,format,total_decisions,processed_decisions,processed_deliveries,body_bytes,error_code,completed_at,expires_at,created_at,event_id,projected_at,notification_decision,policy_version,decided_at,claim_token)
        SELECT json_extract(value,'$.job'),n.mailbox_id,n.outcome,n.format,0,0,0,0,n.error_code,n.completed_at,n.expires_at,n.created_at,json_extract(value,'$.event'),n.projected_at,n.notification_decision,n.policy_version,n.decided_at,n.claim_token FROM json_each(?) CROSS JOIN async_export_notifications n WHERE n.job_id=?`).bind(data,f.jobs[0].id),
      ctx.env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,last_http_status,last_error_code,completed_at,created_at,updated_at)
        SELECT json_extract(value,'$.delivery'),d.mailbox_id,d.endpoint_id,json_extract(value,'$.event'),'dead',d.attempts,d.available_at,d.signed_secret_version,d.signing_secret_ciphertext,d.url_snapshot,
          json_set(d.payload_json,'$.id',json_extract(value,'$.event'),'$.data.jobId',json_extract(value,'$.job')),400,'http_rejected',d.completed_at,d.created_at,d.updated_at FROM json_each(?) CROSS JOIN webhook_deliveries d WHERE d.id=?`).bind(data,source.id)
    ]);
  }
  await clone(999);const accepted=await preview(f.mailbox.id);expect(accepted.batch).toMatchObject({totalItems:1000,eligibleItems:1000});expect(await count('async_export_notification_retry_items')).toBe(1000);
  await clone(1);const before=await count('audit_events');await expect(preview(f.mailbox.id)).rejects.toMatchObject({code:'batch_retry_too_large',status:413});expect(await count('async_export_notification_retry_items')).toBe(1000);expect(await count('audit_events')).toBe(before);
},60_000);
