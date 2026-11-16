import {readFile,readdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,issueToken,type OwnerContext} from '../../src/lib/server/core/owner';
import {createAsyncAlertNotificationExport} from '../../src/lib/server/core/async-alert-notification-exports';
import {projectAsyncExportNotifications} from '../../src/lib/server/core/async-export-notifications';
import {getAlertNotificationPolicy,updateAlertNotificationPolicy} from '../../src/lib/server/core/alert-notification-policy';
import {createWebhookEndpoint,getWebhookDelivery,listMailEvents,listWebhookDeliveries,listWebhookEndpoints,updateWebhookEndpoint,webhookPayload,type WebhookEventRow} from '../../src/lib/server/core/webhooks';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,schema:string[],at:number;
const succeeded='alert_notification.export.succeeded',failed='alert_notification.export.failed';
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'export-notice-hooks'},r2Buckets:{MAIL_BLOBS:'export-notice-hooks'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Export notices',localPart:`export-notice-${crypto.randomUUID()}`});
const endpoint=(id:string)=>createWebhookEndpoint(ctx,id,{url:'https://hooks.example.net/notify',eventTypes:[succeeded,failed]});
async function policy(id:string,changes:Record<string,unknown>={}){const {version,updatedAt,...fields}=(await getAlertNotificationPolicy(ctx,id)).policy;return updateAlertNotificationPolicy(ctx,id,{...fields,...changes,expectedVersion:version});}
async function terminal(id:string,outcome:'succeeded'|'failed'='succeeded',error='async_export_storage_unavailable',project=true){
  const job=(await createAsyncAlertNotificationExport(ctx,id,{clientRequestId:crypto.randomUUID(),format:'json'})).job;
  await env.DB.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='fixture',lease_until=?,started_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at+120000,at,job.id).run();
  await env.DB.prepare('UPDATE async_alert_notification_exports SET state=?,error_code=?,lease_token=NULL,lease_until=NULL,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(outcome,outcome==='failed'?error:null,at,job.id).run();
  if(project)await projectAsyncExportNotifications(env,{now:()=>at});return job.id;
}
const run=(fetcher:typeof fetch,target=env)=>runWebhookJobs(target,{fetcher,now:()=>at});
const rows=(table:string)=>env.DB.prepare(`SELECT * FROM ${table}`).all<Record<string,unknown>>();
const decision=(job:string)=>env.DB.prepare('SELECT notification_decision FROM async_export_notifications WHERE job_id=?').bind(job).first('notification_decision');

it('atomically admits one terminal outcome across endpoints and concurrent publication, with independent HMAC and no suppression decision pollution',async()=>{
  const mailbox=await box(),firstEndpoint=await endpoint(mailbox.id),secondEndpoint=await endpoint(mailbox.id);await policy(mailbox.id,{repeatIntervalSeconds:60,recoveryEnabled:false});
  const first=await terminal(mailbox.id),repeat=await terminal(mailbox.id),requests:Request[]=[];
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{requests.push(new Request(input,init));return new Response(null,{status:204});});
  const result=await Promise.all([run(fetcher),run(fetcher)]);expect(result.reduce((total,value)=>total+value.webhookPublished,0)).toBe(2);
  expect(await decision(first)).toBe('allowed');expect(await decision(repeat)).toBe('repeat_limited');expect(requests).toHaveLength(2);
  for(const request of requests){const body=await request.text(),signature=request.headers.get('X-Agent-Mail-Signature')!,delivery=request.headers.get('X-Agent-Mail-Delivery')!,timestamp=signature.match(/^t=(\d+),v1=/)![1];
    const target=await env.DB.prepare('SELECT endpoint_id FROM webhook_deliveries WHERE id=?').bind(delivery).first<string>('endpoint_id'),secret=target===firstEndpoint.endpoint.id?firstEndpoint.secret:secondEndpoint.secret;
    expect(signature).toBe(`t=${timestamp},v1=${createHmac('sha256',secret).update(`${timestamp}.${delivery}.${body}`).digest('hex')}`);
    expect(JSON.parse(body).data).toMatchObject({jobId:first,state:'succeeded',format:'json'});expect(body).not.toMatch(/object_key|lease_token|filters|https:|claim_token/);
  }
  expect((await rows('alert_notification_decisions')).results).toHaveLength(0);expect((await rows('async_export_notification_state')).results).toHaveLength(1);
  await run(fetcher);expect(requests).toHaveLength(2);
});

it('uses terminal state and safe error identity for repeat budgets and permits the exact repeat boundary',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);await policy(mailbox.id,{repeatIntervalSeconds:60});const fetcher=vi.fn(async()=>new Response(null,{status:204}));
  const first=await terminal(mailbox.id,'failed');await run(fetcher);expect(await decision(first)).toBe('allowed');
  at+=59999;const repeat=await terminal(mailbox.id,'failed');await run(fetcher);expect(await decision(repeat)).toBe('repeat_limited');
  at++;const boundary=await terminal(mailbox.id,'failed');await run(fetcher);expect(await decision(boundary)).toBe('allowed');
  const changed=await terminal(mailbox.id,'failed','async_export_limit_exceeded');await run(fetcher);expect(await decision(changed)).toBe('allowed');
  const success=await terminal(mailbox.id);await run(fetcher);expect(await decision(success)).toBe('allowed');expect(fetcher).toHaveBeenCalledTimes(4);
});

it('retains disabled and quiet receipts without replay and records absent, late and same-millisecond subscriptions safely',async()=>{
  at=Date.UTC(2026,10,15,12);const clock=vi.spyOn(Date,'now').mockImplementation(()=>at-1);
  const mailbox=await box();await endpoint(mailbox.id);await policy(mailbox.id,{enabled:false});const fetcher=vi.fn(async()=>new Response(null,{status:204}));
  const disabled=await terminal(mailbox.id);await run(fetcher);expect(await decision(disabled)).toBe('disabled');
  await policy(mailbox.id,{enabled:true,quietEnabled:true,quietStartMinute:0,quietEndMinute:1439,timeZone:'UTC'});
  const quiet=await terminal(mailbox.id);await run(fetcher);expect(await decision(quiet)).toBe('quiet_hours');
  await policy(mailbox.id,{quietEnabled:false});await run(fetcher);expect(fetcher).not.toHaveBeenCalled();
  for(const delta of [0,1]){const absent=await box(),job=await terminal(absent.id);clock.mockReturnValue(at+delta);await endpoint(absent.id);clock.mockImplementation(()=>at-1);await run(fetcher);expect(await decision(job)).toBe('no_subscribers');}
  expect(fetcher).not.toHaveBeenCalled();expect((await rows('async_export_notification_state')).results).toHaveLength(0);
});

it('defers retry transport during quiet time, wakes only quiet deferrals and preserves signed frozen delivery identity',async()=>{
  // Subscription and terminal clocks share one fixed timeline, independent of the host date.
  at=Date.UTC(2026,10,15,21,59);vi.spyOn(Date,'now').mockImplementation(()=>at-1);
  const mailbox=await box(),hook=await endpoint(mailbox.id);expect(hook.endpoint.createdAt).toBeLessThan(at);expect(hook.endpoint.updatedAt).toBeLessThan(at);
  const job=await terminal(mailbox.id),bodies:string[]=[],deliveryIds:string[]=[];
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const request=new Request(input,init);bodies.push(await request.text());deliveryIds.push(request.headers.get('X-Agent-Mail-Delivery')!);return new Response(null,{status:bodies.length===1?500:204});});
  await run(fetcher);expect(await decision(job)).toBe('allowed');await policy(mailbox.id,{quietEnabled:true,quietStartMinute:1320,quietEndMinute:480,timeZone:'UTC'});at+=60000;
  await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(1);expect((await rows('webhook_deliveries')).results[0]).toMatchObject({state:'pending',attempts:1,last_error_code:'alert_quiet_hours'});
  await policy(mailbox.id,{quietEnabled:false});await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(2);expect(bodies[0]).toBe(bodies[1]);expect(deliveryIds[0]).toBe(deliveryIds[1]);
  expect((await rows('webhook_delivery_attempts')).results.map(row=>row.outcome)).toEqual(['retry','succeeded']);
});

it('does not backfill terminal notices when an older endpoint adds a subscription before delayed projection',async()=>{
  const late=await box(),prior=await box(),old=await createWebhookEndpoint(ctx,late.id,{url:'https://hooks.example.net/late',eventTypes:['message.received']});await endpoint(prior.id);
  const skipped=await terminal(late.id,'succeeded','async_export_storage_unavailable',false),allowed=await terminal(prior.id,'succeeded','async_export_storage_unavailable',false);
  const clock=vi.spyOn(Date,'now').mockReturnValue(at+1);
  await updateWebhookEndpoint(ctx,late.id,old.endpoint.id,{expectedUpdatedAt:old.endpoint.updatedAt,eventTypes:['message.received',succeeded]});clock.mockRestore();at+=2;
  await projectAsyncExportNotifications(env,{now:()=>at});const fetcher=vi.fn(async()=>new Response(null,{status:204}));await run(fetcher);
  expect(await decision(skipped)).toBe('no_subscribers');expect(await decision(allowed)).toBe('allowed');expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await rows('webhook_deliveries')).results.map(row=>row.mailbox_id)).toEqual([prior.id]);
});

it('fences admission policy races and prevents a disabled in-flight request acknowledgement from reviving its delivery',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);const job=await terminal(mailbox.id),fetcher=vi.fn(async()=>new Response(null,{status:204}));let changed=false;
  const database=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!changed){changed=true;await policy(mailbox.id,{enabled:false});}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  expect((await run(fetcher,{...env,DB:database})).webhookPublished).toBe(0);expect(await decision(job)).toBeNull();await run(fetcher);expect(await decision(job)).toBe('disabled');expect(fetcher).not.toHaveBeenCalled();
  await policy(mailbox.id,{enabled:true});await terminal(mailbox.id,'failed');const inFlight=vi.fn(async()=>{await policy(mailbox.id,{enabled:false});return new Response(null,{status:204});});
  const result=await run(inFlight);expect(result.webhookProcessed).toBe(1);expect(result.webhookSucceeded).toBe(0);
  expect((await rows('webhook_deliveries')).results[0]).toMatchObject({state:'cancelled',last_error_code:'alert_notifications_disabled',lease_token:null});
  expect((await rows('webhook_delivery_attempts')).results[0]).toMatchObject({outcome:'cancelled',error_code:'alert_notifications_disabled'});
});

it('isolates operational event and delivery reads from mailbox Tokens and rejects forged or mismatched terminal payloads without blocking publication',async()=>{
  const mailbox=await box(),hook=await endpoint(mailbox.id);const job=await terminal(mailbox.id,'failed');const fetcher=vi.fn(async()=>new Response(null,{status:204}));await run(fetcher);
  const token=await issueToken(ctx,mailbox.id,{name:'Reader',scopes:['mail:read']}),actor={kind:'token' as const,mailboxId:mailbox.id,tokenId:token.token.id,canRead:true},agent={...ctx,actor};
  expect((await listMailEvents(agent,mailbox.id)).events).toEqual([]);expect((await listWebhookDeliveries(agent,mailbox.id)).deliveries).toEqual([]);
  const listed=await listWebhookEndpoints(agent,mailbox.id);expect(listed.eventTypes).not.toContain(succeeded);expect(listed.endpoints[0].eventTypes).toEqual([]);
  const actual=(await listWebhookDeliveries(ctx,mailbox.id)).deliveries[0];await expect(getWebhookDelivery(agent,mailbox.id,actual.id)).rejects.toMatchObject({status:404});
  const original=await env.DB.prepare('SELECT e.* FROM events e JOIN async_export_notifications n ON n.event_id=e.id WHERE n.job_id=?').bind(job).first<WebhookEventRow>();
  const data=JSON.parse(original!.payload_json),forged=crypto.randomUUID();await env.DB.prepare("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES(?,?,'app',?,?,?,?,?)").bind(forged,mailbox.id,forged,failed,JSON.stringify({...data,bodyBytes:1}),at,at).run();
  const result=await run(fetcher);expect(result.webhookPublished).toBe(1);expect(fetcher).toHaveBeenCalledTimes(1);expect((await rows('webhook_deliveries')).results).toHaveLength(1);
  const payload=webhookPayload({...original!,payload_json:JSON.stringify({...data,secret:'PRIVATE',errorCode:'PRIVATE_ERROR'})});expect(payload).not.toContain('PRIVATE');
  for(const changed of [{processedDecisions:-1},{bodyBytes:256*1024*1024+1},{expiresAt:at},{jobId:'bad'},{state:'succeeded'},{format:'html'}])expect(webhookPayload({...original!,payload_json:JSON.stringify({...data,...changed})})).toBeNull();
  expect(webhookPayload({...original!,source:'cloudflare'})).toBeNull();expect(hook.endpoint.eventTypes).toContain(failed);
});
