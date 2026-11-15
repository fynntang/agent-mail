import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {getAlertNotificationPolicy,updateAlertNotificationPolicy} from '../../src/lib/server/core/alert-notification-policy';
import {createWebhookEndpoint} from '../../src/lib/server/core/webhooks';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,schema:string[],at:number;
const createdType='cloudflare.suppression.alert.created',resolvedType='cloudflare.suppression.alert.resolved';
beforeAll(async()=>{schema=[];for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'alert-admission'},r2Buckets:{MAIL_BLOBS:'alert-admission'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);
const mailbox=()=>createMailbox(ctx,{name:'Admission',localPart:`admission-${crypto.randomUUID()}`});
const endpoint=(box:string)=>createWebhookEndpoint(ctx,box,{url:'https://hooks.example.net/notify',eventTypes:[createdType,resolvedType]});
async function policy(box:string,overrides:Record<string,unknown>={}){
  const {version,updatedAt,...fields}=(await getAlertNotificationPolicy(ctx,box)).policy;
  return updateAlertNotificationPolicy(ctx,box,{...fields,...overrides,expectedVersion:version});
}
async function event(box:string,alertId:string,outcome:'failed'|'unknown'|'resolved'='failed',errorCode?:string){
  const id=crypto.randomUUID(),type=outcome==='resolved'?resolvedType:createdType;
  await env.DB.prepare("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES(?,?,'app',?,?,?,?,?)")
    .bind(id,box,id,type,JSON.stringify({alertId,kind:'sync',status:outcome==='resolved'?'resolved':'open',outcome,...(outcome==='resolved'?{}:{errorCode:errorCode??(outcome==='unknown'?'cloudflare_delete_unknown':'cloudflare_api_unavailable')})}),at,at).run();return id;
}
const run=(fetcher:typeof fetch,target=env)=>runWebhookJobs(target,{fetcher,now:()=>at});
const rows=(table:string)=>env.DB.prepare(`SELECT * FROM ${table}`).all<Record<string,unknown>>();
async function decision(id:string){return env.DB.prepare('SELECT decision FROM alert_notification_decisions WHERE event_id=?').bind(id).first('decision');}

it('admits one repeated incident atomically across one publication batch and concurrent cron calls while fanning out to every endpoint',async()=>{
  const box=await mailbox();await endpoint(box.id);await endpoint(box.id);await policy(box.id,{repeatIntervalSeconds:60});
  const alert=crypto.randomUUID(),first=await event(box.id,alert),repeat=await event(box.id,alert),fetcher=vi.fn(async()=>new Response(null,{status:204}));
  const results=await Promise.all([run(fetcher),run(fetcher)]);
  expect(results.reduce((total,result)=>total+result.webhookPublished,0)).toBe(2);expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await decision(first)).toBe('allowed');expect(await decision(repeat)).toBe('repeat_limited');
  expect((await rows('webhook_deliveries')).results.map(row=>row.event_id)).toEqual([first,first]);
  expect((await rows('webhook_delivery_attempts')).results.map(row=>row.outcome)).toEqual(['succeeded','succeeded']);
  expect((await rows('alert_notification_state')).results).toHaveLength(1);
  await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(2);expect((await rows('alert_notification_decisions')).results).toHaveLength(2);
});

it('allows exact interval expiry and changed diagnostics immediately, and a suppressed recovery starts the next failure episode afresh',async()=>{
  const box=await mailbox();await endpoint(box.id);await policy(box.id,{repeatIntervalSeconds:60,recoveryEnabled:false});
  const alert=crypto.randomUUID(),fetcher=vi.fn(async()=>new Response(null,{status:204}));
  const first=await event(box.id,alert);await run(fetcher);expect(await decision(first)).toBe('allowed');
  at+=59999;const before=await event(box.id,alert);await run(fetcher);expect(await decision(before)).toBe('repeat_limited');
  at++;const boundary=await event(box.id,alert);await run(fetcher);expect(await decision(boundary)).toBe('allowed');
  const changed=await event(box.id,alert,'failed','cloudflare_api_timeout');await run(fetcher);expect(await decision(changed)).toBe('allowed');
  const unknown=await event(box.id,alert,'unknown');await run(fetcher);expect(await decision(unknown)).toBe('allowed');
  const recovered=await event(box.id,alert,'resolved');await run(fetcher);expect(await decision(recovered)).toBe('recovery_disabled');
  expect(await env.DB.prepare('SELECT last_notified_at FROM alert_notification_state WHERE mailbox_id=? AND alert_id=?').bind(box.id,alert).first('last_notified_at')).toBeNull();
  const next=await event(box.id,alert,'unknown');await run(fetcher);expect(await decision(next)).toBe('allowed');expect(fetcher).toHaveBeenCalledTimes(5);
});

it('drops new quiet events without replay and defers existing transport retries before claiming an attempt until quiet hours end',async()=>{
  at=Date.UTC(2030,0,1,21,59);const box=await mailbox();await endpoint(box.id);const alert=crypto.randomUUID();
  const fetcher=vi.fn(async()=>new Response(null,{status:500})),old=await event(box.id,alert);await run(fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);expect((await rows('webhook_delivery_attempts')).results).toHaveLength(1);
  await policy(box.id,{quietEnabled:true,quietStartMinute:1320,quietEndMinute:480,timeZone:'UTC'});
  at+=60000;const skipped=await event(box.id,crypto.randomUUID());const result=await run(fetcher);
  expect(result.webhookProcessed).toBe(0);expect(await decision(skipped)).toBe('quiet_hours');expect(fetcher).toHaveBeenCalledTimes(1);
  const held=(await rows('webhook_deliveries')).results;expect(held).toHaveLength(1);expect(held[0]).toMatchObject({event_id:old,state:'pending',attempts:1,last_error_code:'alert_quiet_hours',available_at:at+60000});
  expect((await rows('webhook_delivery_attempts')).results).toHaveLength(1);
  at=Date.UTC(2030,0,2,8,0);fetcher.mockImplementation(async()=>new Response(null,{status:204}));await run(fetcher);
  expect(fetcher).toHaveBeenCalledTimes(2);expect((await rows('webhook_deliveries')).results).toHaveLength(1);
  expect((await rows('webhook_delivery_attempts')).results.map(row=>row.attempt_no)).toEqual([1,2]);expect(await decision(skipped)).toBe('quiet_hours');
});

it('fences publication against a policy update between preselection and its D1 transaction, then records only the live decision',async()=>{
  const box=await mailbox();await endpoint(box.id);const sent=await event(box.id,crypto.randomUUID()),fetcher=vi.fn(async()=>new Response(null,{status:204}));
  let changed=false;
  const db=new Proxy(env.DB,{get(target,key){
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!changed){changed=true;await policy(box.id,{enabled:false});}return target.batch(statements);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  expect((await run(fetcher,{...env,DB:db})).webhookPublished).toBe(0);expect(fetcher).not.toHaveBeenCalled();expect(await decision(sent)).toBeNull();
  expect(await env.DB.prepare('SELECT webhook_published_at FROM events WHERE id=?').bind(sent).first('webhook_published_at')).toBeNull();
  expect((await run(fetcher)).webhookPublished).toBe(1);expect(await decision(sent)).toBe('disabled');expect(fetcher).not.toHaveBeenCalled();
  expect((await rows('webhook_deliveries')).results).toHaveLength(0);expect((await rows('alert_notification_state')).results).toHaveLength(0);
});

it('cancels an in-flight alert under a policy switch and rejects its late HTTP acknowledgement without reviving its lease',async()=>{
  const box=await mailbox();await endpoint(box.id);await event(box.id,crypto.randomUUID());
  const fetcher=vi.fn(async()=>{await policy(box.id,{enabled:false});return new Response(null,{status:204});});
  const result=await run(fetcher);expect(result.webhookProcessed).toBe(1);expect(result.webhookSucceeded).toBe(0);expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await rows('webhook_deliveries')).results[0]).toMatchObject({state:'cancelled',last_error_code:'alert_notifications_disabled',lease_token:null,lease_until:null});
  expect((await rows('webhook_delivery_attempts')).results[0]).toMatchObject({outcome:'cancelled',error_code:'alert_notifications_disabled'});
  await policy(box.id,{enabled:true});at+=120001;await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(1);
});
