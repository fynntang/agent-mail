import {readFile,readdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,issueToken,type OwnerContext} from '../../src/lib/server/core/owner';
import {projectRetryBatchNotifications,type RetryBatchNotificationRow} from '../../src/lib/server/core/retry-batch-notifications';
import {getAlertNotificationPolicy,updateAlertNotificationPolicy} from '../../src/lib/server/core/alert-notification-policy';
import {createWebhookEndpoint,retryWebhookDelivery,rotateWebhookSecret} from '../../src/lib/server/core/webhooks';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import {retryRetryBatchNotificationDelivery,findRetryBatchNotificationRetryReceipt} from '../../src/lib/server/core/retry-batch-notification-retry';
import {RETRY_BATCH_NOTIFICATION_TYPES} from '../../src/lib/server/core/retry-batch-notification-admission';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'batch-notice-retry'},r2Buckets:{MAIL_BLOBS:'batch-notice-retry'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;vi.spyOn(Date,'now').mockImplementation(()=>at);
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Batch retry',localPart:`batch-retry-${crypto.randomUUID()}`});
async function policy(id:string,changes:Record<string,unknown>){const {version,updatedAt,...fields}=(await getAlertNotificationPolicy(ctx,id)).policy;return updateAlertNotificationPolicy(ctx,id,{...fields,...changes,expectedVersion:version});}
async function fixture(corruptKey=false){
  const mailbox=await box(),hook=await createWebhookEndpoint(ctx,mailbox.id,{url:'https://hooks.example.net/notice',eventTypes:[...RETRY_BATCH_NOTIFICATION_TYPES]});at++;
  if(corruptKey){const envelope=JSON.parse(await env.DB.prepare('SELECT signing_secret_ciphertext FROM webhook_endpoints WHERE id=?').bind(hook.endpoint.id).first<string>('signing_secret_ciphertext') as string);
    envelope.data=(envelope.data[0]==='A'?'B':'A')+envelope.data.slice(1);await env.DB.prepare('UPDATE webhook_endpoints SET signing_secret_ciphertext=? WHERE id=?').bind(JSON.stringify(envelope),hook.endpoint.id).run();}
  const batch=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO async_export_notification_retry_batches(id,mailbox_id,preview_request_id,request_hash,from_ms,to_ms,filter_reason,created_at,updated_at,expires_at,preview_expires_at,total_items,eligible_items)
    VALUES(?,?,?, ?,0,1,'all',?,?,?,?,1,1)`).bind(batch,mailbox.id,crypto.randomUUID(),'a'.repeat(64),at,at,at+86400000,at+600000).run();
  await env.DB.prepare("UPDATE async_export_notification_retry_batches SET state='queued',commit_request_id=?,commit_expected_version=1,committed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(crypto.randomUUID(),at,batch).run();at+=2;
  await env.DB.prepare("UPDATE async_export_notification_retry_batches SET state='completed',processed_items=1,requeued_items=1,completed_at=?,version=version+1,updated_at=? WHERE id=?").bind(at,at,batch).run();
  await projectRetryBatchNotifications(env,{now:()=>at});await runWebhookJobs(env,{now:()=>at,fetcher:async()=>new Response(null,{status:400})});
  if(corruptKey)await env.DB.prepare("UPDATE webhook_deliveries SET state='dead',completed_at=?,lease_token=NULL,lease_until=NULL WHERE mailbox_id=?").bind(at,mailbox.id).run();
  const notice=(await env.DB.prepare('SELECT * FROM async_export_retry_batch_notifications WHERE batch_id=?').bind(batch).first<RetryBatchNotificationRow>())!;
  const delivery=(await env.DB.prepare('SELECT * FROM webhook_deliveries WHERE event_id=?').bind(notice.event_id).first<Record<string,unknown>>())!;expect(delivery.state).toBe('dead');
  return {box:mailbox,hook,batch,notice,delivery};
}
const input=(version:number)=>({clientRequestId:crypto.randomUUID(),expectedUpdatedAt:version});
const raw=(id:string)=>env.DB.prepare('SELECT * FROM webhook_deliveries WHERE id=?').bind(id).first<Record<string,unknown>>();
const audits=()=>env.DB.prepare("SELECT * FROM audit_events WHERE action='webhook.delivery_retried'").all<Record<string,unknown>>();
const invoke=(f:Awaited<ReturnType<typeof fixture>>,request=input(Number(f.delivery.updated_at)),target=ctx)=>retryRetryBatchNotificationDelivery(target,f.box.id,f.notice.id,String(f.delivery.id),request);
async function cloneNotice(f:Awaited<ReturnType<typeof fixture>>){
  at+=10;const source=(await env.DB.prepare('SELECT * FROM async_export_retry_batch_notifications WHERE id=?').bind(f.notice.id).first<Record<string,unknown>>())!;
  const copy={...source,id:crypto.randomUUID(),source_version:Number(source.source_version)+1,occurred_at:at,created_at:at,acknowledged_at:null,version:1,event_id:null,projected_at:null,notification_decision:null,policy_version:null,decided_at:null,claim_token:null},columns=Object.keys(copy);
  await env.DB.prepare(`INSERT INTO async_export_retry_batch_notifications(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(column=>copy[column as keyof typeof copy])).run();
  await projectRetryBatchNotifications(env,{now:()=>at});return(await env.DB.prepare('SELECT * FROM async_export_retry_batch_notifications WHERE id=?').bind(copy.id).first<RetryBatchNotificationRow>())!;
}

it('requeues one original admitted delivery and retains old payload, URL and HMAC key after current endpoint rotation',async()=>{
  const f=await fixture();await rotateWebhookSecret(ctx,f.box.id,f.hook.endpoint.id,{expectedUpdatedAt:f.hook.endpoint.updatedAt});await policy(f.box.id,{recoveryEnabled:false});
  const request=input(Number(f.delivery.updated_at)),result=await invoke(f,request);expect(result).toMatchObject({replayed:false,delivery:{id:f.delivery.id,state:'pending',attempts:1,attemptBudget:16,secretVersion:1},manualRetry:{clientRequestId:request.clientRequestId,previousAttemptBudget:8,attemptBudget:16}});
  const after=(await raw(String(f.delivery.id)))!;for(const field of ['payload_json','url_snapshot','signing_secret_ciphertext','signed_secret_version','attempts'])expect(after[field]).toBe(f.delivery[field]);
  const sent:Request[]=[];at=Number(after.available_at);await runWebhookJobs(env,{now:()=>at,fetcher:async(input,init)=>{sent.push(new Request(input,init));return new Response(null,{status:204});}});
  expect(sent).toHaveLength(1);const body=await sent[0].text(),signature=sent[0].headers.get('X-Agent-Mail-Signature')!,timestamp=signature.match(/^t=(\d+),/)![1];
  expect(signature).toBe(`t=${timestamp},v1=${createHmac('sha256',f.hook.secret).update(`${timestamp}.${f.delivery.id}.${body}`).digest('hex')}`);expect(body).toBe(f.delivery.payload_json);expect(sent[0].headers.get('X-Agent-Mail-Attempt')).toBe('2');
  expect((await raw(String(f.delivery.id)))?.state).toBe('succeeded');expect((await audits()).results).toHaveLength(1);expect(await env.DB.prepare('SELECT count(*) n FROM async_export_notification_state').first('n')).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/https:|payload_json|signing_secret|lease_token|claim_token|endpoint_snapshot_json/);
});

it('recovers a lost D1 ACK and replays its immutable receipt after another dead outcome without another budget',async()=>{
  const f=await fixture(),request=input(Number(f.delivery.updated_at));let lost=false;
  const database=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(!lost){lost=true;throw Error('PRIVATE_LOST_ACK');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const first=await invoke(f,request,{...ctx,env:{...env,DB:database}});expect(first).toMatchObject({replayed:true,delivery:{attemptBudget:16}});
  at=first.delivery.availableAt;await runWebhookJobs(env,{now:()=>at,fetcher:async()=>new Response(null,{status:400})});const replay=await invoke(f,request);expect(replay).toMatchObject({replayed:true,delivery:{state:'dead',attemptBudget:16}});
  await expect(invoke(f,{...request,expectedUpdatedAt:replay.delivery.updatedAt})).rejects.toMatchObject({code:'retry_batch_notification_retry_conflict'});
  await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(f.box.id).run();const noKey={...ctx,env:{...env,WEBHOOK_KEYRING:undefined}};
  expect(await retryWebhookDelivery(noKey,f.box.id,String(f.delivery.id),request)).toMatchObject({replayed:true});await expect(invoke(f,input(replay.delivery.updatedAt),noKey)).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});
  expect((await audits()).results).toHaveLength(1);expect(await findRetryBatchNotificationRetryReceipt(env,f.box.id,f.notice.id,f.batch,String(f.delivery.id),request.clientRequestId,request.expectedUpdatedAt)).toEqual(first.manualRetry);
});

it('commits only one of competing versions and makes simultaneous identical intents idempotent',async()=>{
  const f=await fixture(),results=await Promise.allSettled([invoke(f),invoke(f)]);expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect((await audits()).results).toHaveLength(1);expect((await raw(String(f.delivery.id)))?.attempt_budget).toBe(16);
  const second=await fixture(),request=input(Number(second.delivery.updated_at)),duplicate=await Promise.all([invoke(second,request),invoke(second,request)]);expect(duplicate.map(value=>value.replayed).sort()).toEqual([false,true]);expect((await audits()).results).toHaveLength(2);
});

it('rejects UUID reuse for another notice or delivery and validates every receipt scope field',async()=>{
  const f=await fixture(),g=await fixture(),request=input(Number(f.delivery.updated_at));await invoke(f,request);
  const h=await createWebhookEndpoint(ctx,f.box.id,{url:'https://hooks.example.net/other',eventTypes:[...RETRY_BATCH_NOTIFICATION_TYPES]}),other=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at,attempt_budget)
    SELECT ?,mailbox_id,?,event_id,'dead',attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,?,8 FROM webhook_deliveries WHERE id=?`).bind(other,h.endpoint.id,request.expectedUpdatedAt,f.delivery.id).run();
  await expect(retryRetryBatchNotificationDelivery(ctx,f.box.id,f.notice.id,other,request)).rejects.toMatchObject({code:'retry_batch_notification_retry_conflict'});
  const originalAudit=(await audits()).results[0];const metadata=JSON.parse(String(originalAudit.metadata_json));expect(metadata).toMatchObject({notificationId:f.notice.id,batchId:f.batch});
  await expect(findRetryBatchNotificationRetryReceipt(env,f.box.id,crypto.randomUUID(),f.batch,String(f.delivery.id),request.clientRequestId,request.expectedUpdatedAt)).rejects.toMatchObject({code:'retry_batch_notification_retry_conflict'});
  await expect(findRetryBatchNotificationRetryReceipt(env,f.box.id,f.notice.id,crypto.randomUUID(),String(f.delivery.id),request.clientRequestId,request.expectedUpdatedAt)).rejects.toMatchObject({code:'retry_batch_notification_retry_conflict'});
  expect((await invoke(g,input(Number(g.delivery.updated_at)))).delivery.attemptBudget).toBe(16);
});

it('rejects reusing a committed UUID for another notification within the same mailbox',async()=>{
  const f=await fixture(),request=input(Number(f.delivery.updated_at));await policy(f.box.id,{repeatIntervalSeconds:0});await invoke(f,request);
  const other=await cloneNotice(f);await runWebhookJobs(env,{now:()=>at,fetcher:async()=>new Response(null,{status:400})});const target=(await env.DB.prepare('SELECT * FROM webhook_deliveries WHERE event_id=?').bind(other.event_id).first<Record<string,unknown>>())!;
  expect(target.state).toBe('dead');await expect(retryRetryBatchNotificationDelivery(ctx,f.box.id,other.id,String(target.id),request)).rejects.toMatchObject({code:'retry_batch_notification_retry_conflict'});
  expect((await audits()).results).toHaveLength(1);expect((await raw(String(target.id)))?.attempt_budget).toBe(8);
});

it('never upgrades an original disabled decision or re-admits a forged delivery after current policy is enabled',async()=>{
  const f=await fixture();await policy(f.box.id,{enabled:false});const skipped=await cloneNotice(f);await runWebhookJobs(env,{now:()=>at,fetcher:async()=>new Response(null,{status:204})});
  expect(await env.DB.prepare('SELECT notification_decision FROM async_export_retry_batch_notifications WHERE id=?').bind(skipped.id).first('notification_decision')).toBe('disabled');await policy(f.box.id,{enabled:true});
  const forged=crypto.randomUUID(),payload=await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(skipped.event_id).first<{id:string;mailbox_id:string;source:string;type:string;payload_json:string;occurred_at:number;created_at:number}>();
  const {webhookPayload}=await import('../../src/lib/server/core/webhooks');
  await env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at,attempt_budget)
    SELECT ?,mailbox_id,endpoint_id,?,'dead',attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,?,created_at,updated_at,8 FROM webhook_deliveries WHERE id=?`).bind(forged,skipped.event_id,webhookPayload(payload!),f.delivery.id).run();
  await expect(retryWebhookDelivery(ctx,f.box.id,forged,input(Number(f.delivery.updated_at)))).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});expect((await audits()).results).toHaveLength(0);
  expect(await env.DB.prepare('SELECT count(*) n FROM async_export_notification_state').first('n')).toBe(1);
});

it('blocks disabled, quiet, paused, retired, inactive endpoint and budget80 while preserving original admission and retries',async()=>{
  const f=await fixture(),request=input(Number(f.delivery.updated_at));await policy(f.box.id,{enabled:false});await expect(invoke(f,request)).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});
  const minute=new Date(at).getUTCHours()*60+new Date(at).getUTCMinutes();await policy(f.box.id,{enabled:true,quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440,timeZone:'UTC'});await expect(invoke(f,request)).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});
  await policy(f.box.id,{quietEnabled:false});await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(f.box.id).run();await expect(invoke(f,request)).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});
  await env.DB.prepare("UPDATE mailboxes SET status='active' WHERE id=?").bind(f.box.id).run();await env.DB.prepare("UPDATE webhook_endpoints SET status='paused' WHERE id=?").bind(f.hook.endpoint.id).run();await expect(invoke(f,request)).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});
  await env.DB.prepare("UPDATE webhook_endpoints SET status='active' WHERE id=?").bind(f.hook.endpoint.id).run();await env.DB.prepare('UPDATE webhook_deliveries SET attempt_budget=80 WHERE id=?').bind(f.delivery.id).run();await expect(invoke(f,request)).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});
  await env.DB.prepare("UPDATE mailboxes SET status='deleted' WHERE id=?").bind(f.box.id).run();await expect(invoke(f,request)).rejects.toMatchObject({status:404});expect((await audits()).results).toHaveLength(0);
});

it('fences policy changes immediately before the atomic transaction and rolls back receipts when a delivery update fails',async()=>{
  const f=await fixture();let touched=false;const database=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!touched){touched=true;await policy(f.box.id,{enabled:false});}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await expect(invoke(f,undefined,{...ctx,env:{...env,DB:database}})).rejects.toMatchObject({code:'retry_batch_notification_retry_changed'});expect((await audits()).results).toHaveLength(0);
  await policy(f.box.id,{enabled:true});await env.DB.prepare("CREATE TRIGGER test_retry_failure BEFORE UPDATE ON webhook_deliveries BEGIN SELECT RAISE(ABORT,'PRIVATE_RETRY_FAILURE'); END").run();
  await expect(invoke(f)).rejects.toThrow('PRIVATE_RETRY_FAILURE');expect((await audits()).results).toHaveLength(0);expect((await raw(String(f.delivery.id)))?.state).toBe('dead');
});

it('denies wrong mailbox/notice, non-Owner and malformed intents, and generic routes use the same guarded protocol',async()=>{
  const f=await fixture(),other=await box(),request=input(Number(f.delivery.updated_at)),id=String(f.delivery.id);
  await expect(retryRetryBatchNotificationDelivery(ctx,other.id,f.notice.id,id,request)).rejects.toMatchObject({status:404});await expect(retryRetryBatchNotificationDelivery(ctx,f.box.id,crypto.randomUUID(),id,request)).rejects.toMatchObject({status:404});
  const token=await issueToken(ctx,f.box.id,{name:'Agent',scopes:['mail:read']});for(const actor of [null,{kind:'token' as const,mailboxId:f.box.id,tokenId:token.token.id,canRead:true}])await expect(invoke(f,request,{...ctx,actor})).rejects.toMatchObject({status:actor?403:401});
  for(const value of [{},{...request,clientRequestId:'invalid'},{...request,expectedUpdatedAt:-1},{...request,extra:'PRIVATE'}])await expect(retryWebhookDelivery(ctx,f.box.id,id,value)).rejects.toMatchObject({code:'invalid_input'});
  await policy(f.box.id,{enabled:false});await expect(retryWebhookDelivery(ctx,f.box.id,id,request)).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});await policy(f.box.id,{enabled:true});expect((await retryWebhookDelivery(ctx,f.box.id,id,request)).delivery.state).toBe('pending');
});

it('authenticates original ciphertext on POST and caps a final79 budget at80 without any transport',async()=>{
  const broken=await fixture(true);await expect(invoke(broken)).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});expect((await audits()).results).toHaveLength(0);
  const f=await fixture();await env.DB.prepare('UPDATE webhook_deliveries SET attempt_budget=79 WHERE id=?').bind(f.delivery.id).run();const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('PRIVATE_HTTP'));
  expect(await invoke(f)).toMatchObject({delivery:{attemptBudget:80},manualRetry:{previousAttemptBudget:79,attemptBudget:80}});expect(fetcher).not.toHaveBeenCalled();expect((await env.MAIL_BLOBS.list()).objects).toHaveLength(0);
});

it('fails closed for a frozen payload that masquerades as mail, an un-captured endpoint and a batch event without a durable receipt',async()=>{
  const f=await fixture(),extra=await createWebhookEndpoint(ctx,f.box.id,{url:'https://hooks.example.net/extra',eventTypes:[...RETRY_BATCH_NOTIFICATION_TYPES]}),forged=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at,attempt_budget)
    SELECT ?,mailbox_id,?,event_id,'dead',attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,json_set(payload_json,'$.type','message.received'),created_at,updated_at,8 FROM webhook_deliveries WHERE id=?`).bind(forged,extra.endpoint.id,f.delivery.id).run();
  await expect(retryWebhookDelivery(ctx,f.box.id,forged,input(Number(f.delivery.updated_at)))).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});
  const event=crypto.randomUUID(),another=crypto.randomUUID();await env.DB.prepare("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) SELECT ?,mailbox_id,'app',?,'alert_notification.retry_batch.completed',payload_json,occurred_at,created_at FROM events WHERE id=?").bind(event,event,f.notice.event_id).run();
  await env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at,attempt_budget)
    SELECT ?,mailbox_id,endpoint_id,?,'dead',attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at,8 FROM webhook_deliveries WHERE id=?`).bind(another,event,f.delivery.id).run();
  await expect(retryWebhookDelivery(ctx,f.box.id,another,input(Number(f.delivery.updated_at)))).rejects.toMatchObject({status:404});expect((await audits()).results).toHaveLength(0);
});
