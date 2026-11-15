import {readFile,readdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,issueToken,type OwnerContext} from '../../src/lib/server/core/owner';
import {projectRetryBatchNotifications} from '../../src/lib/server/core/retry-batch-notifications';
import {getAlertNotificationPolicy,updateAlertNotificationPolicy} from '../../src/lib/server/core/alert-notification-policy';
import {createWebhookEndpoint,getWebhookDelivery,listMailEvents,listWebhookDeliveries,listWebhookEndpoints,retryWebhookDelivery,updateWebhookEndpoint,webhookPayload,type WebhookEventRow} from '../../src/lib/server/core/webhooks';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import {RETRY_BATCH_NOTIFICATION_TYPES} from '../../src/lib/server/core/retry-batch-notification-admission';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,schema:string[],at:number;
type Kind='completed'|'failed'|'needs_reconciliation';
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'batch-notice-hooks'},r2Buckets:{MAIL_BLOBS:'batch-notice-hooks'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.UTC(2026,10,15,12);vi.spyOn(Date,'now').mockImplementation(()=>at);
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Batch notices',localPart:`batch-notice-${crypto.randomUUID()}`});
const endpoint=(id:string)=>createWebhookEndpoint(ctx,id,{url:'https://hooks.example.net/notify',eventTypes:[...RETRY_BATCH_NOTIFICATION_TYPES]});
async function policy(id:string,changes:Record<string,unknown>={}){const {version,updatedAt,...fields}=(await getAlertNotificationPolicy(ctx,id)).policy;return updateAlertNotificationPolicy(ctx,id,{...fields,...changes,expectedVersion:version});}
async function notice(boxId:string,kind:Kind='completed',project=true){
  const id=crypto.randomUUID();at+=10;const total=kind==='failed'?2:1;
  await env.DB.prepare(`INSERT INTO async_export_notification_retry_batches(id,mailbox_id,preview_request_id,request_hash,from_ms,to_ms,filter_reason,
    created_at,updated_at,expires_at,preview_expires_at,total_items,eligible_items) VALUES(?,?,?, ?,0,1,'all',?,?,?,?,?,?)`)
    .bind(id,boxId,crypto.randomUUID(),'a'.repeat(64),at,at,at+86400000,at+600000,total,total).run();
  await env.DB.prepare("UPDATE async_export_notification_retry_batches SET state='queued',commit_request_id=?,commit_expected_version=1,committed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?")
    .bind(crypto.randomUUID(),at,id).run();at+=2;
  await env.DB.prepare(`UPDATE async_export_notification_retry_batches SET state=?,processed_items=1,requeued_items=?,failed_items=?,unknown_items=?,completed_at=?,version=version+1,updated_at=? WHERE id=?`)
    .bind(kind==='completed'?'completed':'running',kind==='completed'?1:0,kind==='failed'?1:0,kind==='needs_reconciliation'?1:0,kind==='completed'?at:null,at,id).run();
  if(project)await projectRetryBatchNotifications(env,{now:()=>at});
  return(await env.DB.prepare('SELECT * FROM async_export_retry_batch_notifications WHERE batch_id=? ORDER BY created_at,id LIMIT 1').bind(id).first()) as Record<string,unknown>;
}
const run=(fetcher:typeof fetch,target=env)=>runWebhookJobs(target,{fetcher,now:()=>at});
const rows=(table:string)=>env.DB.prepare(`SELECT * FROM ${table}`).all<Record<string,unknown>>();
const decision=(n:Record<string,unknown>)=>env.DB.prepare('SELECT notification_decision FROM async_export_retry_batch_notifications WHERE id=?').bind(n.id).first('notification_decision');

it('publishes three safe batch kinds with independent HMAC, stable identities and namespaced repeat admission across concurrent publishers',async()=>{
  const mailbox=await box(),one=await endpoint(mailbox.id),two=await endpoint(mailbox.id);await policy(mailbox.id,{repeatIntervalSeconds:60,recoveryEnabled:false});
  const complete=await notice(mailbox.id),repeat=await notice(mailbox.id),failed=await notice(mailbox.id,'failed'),unknown=await notice(mailbox.id,'needs_reconciliation'),requests:Request[]=[];
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{requests.push(new Request(input,init));return new Response(null,{status:204});});
  const result=await Promise.all([run(fetcher),run(fetcher)]);for(let index=0;index<3;index++)await run(fetcher);
  expect(result.reduce((sum,value)=>sum+value.webhookPublished,0)).toBe(4);expect(await decision(complete)).toBe('allowed');expect(await decision(repeat)).toBe('repeat_limited');
  expect(await decision(failed)).toBe('allowed');expect(await decision(unknown)).toBe('allowed');expect(requests).toHaveLength(6);
  for(const request of requests){const body=await request.text(),deliveryId=request.headers.get('X-Agent-Mail-Delivery')!,signature=request.headers.get('X-Agent-Mail-Signature')!,timestamp=signature.match(/^t=(\d+),v1=/)![1];
    const endpointId=await env.DB.prepare('SELECT endpoint_id FROM webhook_deliveries WHERE id=?').bind(deliveryId).first('endpoint_id'),secret=endpointId===one.endpoint.id?one.secret:two.secret;
    expect(signature).toBe(`t=${timestamp},v1=${createHmac('sha256',secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex')}`);
    expect(JSON.parse(body).data).toMatchObject({totalItems:expect.any(Number),sourceVersion:3});expect(body).not.toMatch(/object_key|payload_json|lease_token|filters|https:|claim_token/);
  }
  expect((await rows('async_export_notification_state')).results).toHaveLength(3);expect((await rows('alert_notification_decisions')).results).toHaveLength(0);
  await run(fetcher);expect(requests).toHaveLength(6);
});

it('allows the exact repeat interval boundary without sharing the original export notification fingerprint',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);await policy(mailbox.id,{repeatIntervalSeconds:60});const fetcher=vi.fn(async()=>new Response(null,{status:204}));
  const first=await notice(mailbox.id);await run(fetcher);const admittedAt=at;
  at=admittedAt+59987;const repeat=await notice(mailbox.id);await run(fetcher);expect(await decision(repeat)).toBe('repeat_limited');
  at=admittedAt+59988;const boundary=await notice(mailbox.id);await run(fetcher);expect(at).toBe(admittedAt+60000);expect(await decision(boundary)).toBe('allowed');
  expect(await decision(first)).toBe('allowed');expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await rows('async_export_notification_state')).results[0].fingerprint).toBe('["retry_batch","completed","completed"]');
});

it('keeps disabled and quiet decisions durable and does not backfill absent, late or same-millisecond subscriptions',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);await policy(mailbox.id,{enabled:false});const fetcher=vi.fn(async()=>new Response(null,{status:204}));
  const disabled=await notice(mailbox.id,'failed');await run(fetcher);expect(await decision(disabled)).toBe('disabled');
  await policy(mailbox.id,{enabled:true,quietEnabled:true,quietStartMinute:0,quietEndMinute:1439,timeZone:'UTC'});
  const quiet=await notice(mailbox.id,'needs_reconciliation');await run(fetcher);expect(await decision(quiet)).toBe('quiet_hours');
  await policy(mailbox.id,{quietEnabled:false});await run(fetcher);expect(fetcher).not.toHaveBeenCalled();
  for(const delta of [0,1]){const absent=await box(),n=await notice(absent.id);at+=delta;await endpoint(absent.id);await run(fetcher);expect(await decision(n)).toBe('no_subscribers');}
  expect(fetcher).not.toHaveBeenCalled();expect((await rows('async_export_notification_state')).results).toHaveLength(0);
});

it('fences configuration changes after the snapshot even if outbox projection is delayed',async()=>{
  const mailbox=await box(),prior=await createWebhookEndpoint(ctx,mailbox.id,{url:'https://hooks.example.net/late',eventTypes:['message.received']});
  const n=await notice(mailbox.id,'failed',false);at++;
  await updateWebhookEndpoint(ctx,mailbox.id,prior.endpoint.id,{expectedUpdatedAt:prior.endpoint.updatedAt,eventTypes:[...RETRY_BATCH_NOTIFICATION_TYPES]});
  await projectRetryBatchNotifications(env,{now:()=>at});const fetcher=vi.fn(async()=>new Response(null,{status:204}));await run(fetcher);
  expect(await decision(n)).toBe('no_subscribers');expect(fetcher).not.toHaveBeenCalled();
});

it('uses the transactional endpoint snapshot to reject late subscriptions and edits whose wall clock still predates the logical source timestamp',async()=>{
  const late=await box(),edited=await box(),control=await box(),existing=await endpoint(edited.id);await endpoint(control.id);
  const wall=at;at=wall+60000;
  const lateNotice=await notice(late.id,'completed',false),editedNotice=await notice(edited.id,'completed',false),allowed=await notice(control.id,'completed',false);
  at=wall+1000;
  const added=await endpoint(late.id),changed=await updateWebhookEndpoint(ctx,edited.id,existing.endpoint.id,{expectedUpdatedAt:existing.endpoint.updatedAt,status:'active'});
  expect(added.endpoint.createdAt).toBeLessThan(Number(lateNotice.created_at));expect(changed.endpoint.updatedAt).toBeLessThan(Number(editedNotice.created_at));
  await projectRetryBatchNotifications(env,{now:()=>at});const fetcher=vi.fn(async()=>new Response(null,{status:204}));await run(fetcher);
  expect(await decision(lateNotice)).toBe('no_subscribers');expect(await decision(editedNotice)).toBe('no_subscribers');expect(await decision(allowed)).toBe('allowed');expect(fetcher).toHaveBeenCalledTimes(1);
  const current=(await rows('webhook_deliveries')).results;expect(current).toHaveLength(1);expect(current[0].mailbox_id).toBe(control.id);
});

it('preserves frozen HMAC payload and delivery identity across HTTP retries and quiet-window deferrals',async()=>{
  const mailbox=await box(),hook=await endpoint(mailbox.id);at=Date.UTC(2026,10,15,21,58);const n=await notice(mailbox.id,'needs_reconciliation'),bodies:string[]=[],deliveryIds:string[]=[];
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const request=new Request(input,init),body=await request.text(),id=request.headers.get('X-Agent-Mail-Delivery')!,signature=request.headers.get('X-Agent-Mail-Signature')!,timestamp=signature.match(/^t=(\d+),v1=/)![1];
    expect(signature).toBe(`t=${timestamp},v1=${createHmac('sha256',hook.secret).update(`${timestamp}.${id}.${body}`).digest('hex')}`);bodies.push(body);deliveryIds.push(id);return new Response(null,{status:bodies.length===1?500:204});});
  await run(fetcher);expect(await decision(n)).toBe('allowed');await policy(mailbox.id,{quietEnabled:true,quietStartMinute:1320,quietEndMinute:480,timeZone:'UTC'});at=Date.UTC(2026,10,15,22,1);
  await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(1);expect((await rows('webhook_deliveries')).results[0]).toMatchObject({state:'pending',attempts:1,last_error_code:'alert_quiet_hours'});
  await policy(mailbox.id,{quietEnabled:false});await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(2);expect(bodies[0]).toBe(bodies[1]);expect(deliveryIds[0]).toBe(deliveryIds[1]);
  expect((await rows('webhook_delivery_attempts')).results.map(row=>row.outcome)).toEqual(['retry','succeeded']);
});

it('atomically cancels pending and in-flight batch notifications when disabled and never revives an old transport acknowledgement',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);await notice(mailbox.id,'failed');
  const fetcher=vi.fn(async()=>{await policy(mailbox.id,{enabled:false});return new Response(null,{status:204});});
  const result=await run(fetcher);expect(result.webhookProcessed).toBe(1);expect(result.webhookSucceeded).toBe(0);
  expect((await rows('webhook_deliveries')).results[0]).toMatchObject({state:'cancelled',last_error_code:'alert_notifications_disabled',lease_token:null});
  expect((await rows('webhook_delivery_attempts')).results[0]).toMatchObject({outcome:'cancelled',error_code:'alert_notifications_disabled'});
});

it('rejects forged snapshot events and malformed payloads without admitting a second delivery or poisoning event publication',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);const n=await notice(mailbox.id,'needs_reconciliation');
  const original=(await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(n.event_id).first<WebhookEventRow>())!,data=JSON.parse(original.payload_json),forged=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES(?,?,'app',?,?,?,?,?)")
    .bind(forged,mailbox.id,forged,original.type,original.payload_json,at,at).run();
  const fetcher=vi.fn(async()=>new Response(null,{status:204}));expect((await run(fetcher)).webhookPublished).toBe(2);expect(fetcher).toHaveBeenCalledTimes(1);expect((await rows('webhook_deliveries')).results).toHaveLength(1);
  const safe=webhookPayload({...original,payload_json:JSON.stringify({...data,recipient:'PRIVATE',secret:'PRIVATE',lease_token:'PRIVATE'})});expect(safe).not.toContain('PRIVATE');
  for(const change of [{notificationId:'bad'},{sourceVersion:0},{unknownItems:0},{processedItems:2},{reason:'PRIVATE'},{batchState:'invalid'},{occurredAt:at+1}])expect(webhookPayload({...original,payload_json:JSON.stringify({...data,...change})})).toBeNull();
  expect(webhookPayload({...original,source:'cloudflare'})).toBeNull();expect(webhookPayload({...original,created_at:at+1})).toBeNull();
});

it('isolates batch events, subscriptions, delivery attempts and generic retries from Agent access and payload-spoof bypasses',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);await notice(mailbox.id,'failed');await run(vi.fn(async()=>new Response(null,{status:400})));
  const token=await issueToken(ctx,mailbox.id,{name:'Reader',scopes:['mail:read']}),agent={...ctx,actor:{kind:'token' as const,mailboxId:mailbox.id,tokenId:token.token.id,canRead:true}};
  expect((await listMailEvents(agent,mailbox.id)).events).toEqual([]);expect((await listWebhookDeliveries(agent,mailbox.id)).deliveries).toEqual([]);
  const subscriptions=await listWebhookEndpoints(agent,mailbox.id);expect(subscriptions.endpoints[0].eventTypes).toEqual([]);for(const type of RETRY_BATCH_NOTIFICATION_TYPES)expect(subscriptions.eventTypes).not.toContain(type);
  const d=(await listWebhookDeliveries(ctx,mailbox.id)).deliveries[0];await expect(getWebhookDelivery(agent,mailbox.id,d.id)).rejects.toMatchObject({status:404});
  await expect(retryWebhookDelivery(agent,mailbox.id,d.id,{})).rejects.toMatchObject({status:403});await expect(retryWebhookDelivery(ctx,mailbox.id,d.id,{})).rejects.toMatchObject({code:'invalid_input'});
  await expect(env.DB.prepare("UPDATE webhook_deliveries SET payload_json=json_set(payload_json,'$.type','message.received') WHERE id=?").bind(d.id).run()).rejects.toThrow('immutable');
  // Simulate an inconsistent old snapshot on a distinct endpoint; the durable event/receipt still wins over its declared type.
  const second=await endpoint(mailbox.id),inconsistent=crypto.randomUUID();await env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,
    signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at,attempt_budget) SELECT ?,mailbox_id,?,event_id,'dead',attempts,available_at,signed_secret_version,
    signing_secret_ciphertext,url_snapshot,json_set(payload_json,'$.type','message.received'),created_at,updated_at,attempt_budget FROM webhook_deliveries WHERE id=?`)
    .bind(inconsistent,second.endpoint.id,d.id).run();
  expect((await listWebhookDeliveries(agent,mailbox.id)).deliveries).toEqual([]);await expect(getWebhookDelivery(agent,mailbox.id,inconsistent)).rejects.toMatchObject({status:404});
  await expect(retryWebhookDelivery(ctx,mailbox.id,inconsistent,{clientRequestId:crypto.randomUUID(),expectedUpdatedAt:d.updatedAt})).rejects.toMatchObject({code:'retry_batch_notification_retry_unavailable'});expect((await rows('webhook_deliveries')).results.every(row=>row.state==='dead'&&row.attempt_budget===8)).toBe(true);
});

it('fences an admission policy version race and records the new disabled decision on the next bounded pass',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);const n=await notice(mailbox.id),fetcher=vi.fn(async()=>new Response(null,{status:204}));let changed=false;
  const database=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!changed){changed=true;await policy(mailbox.id,{enabled:false});}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  expect((await run(fetcher,{...env,DB:database})).webhookPublished).toBe(0);expect(await decision(n)).toBeNull();await run(fetcher);expect(await decision(n)).toBe('disabled');expect(fetcher).not.toHaveBeenCalled();
});
