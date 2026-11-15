import {readFile,readdir} from 'node:fs/promises';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {DEFAULT_ALERT_NOTIFICATION_POLICY,getAlertNotificationPolicy,updateAlertNotificationPolicy,normalizedAlertNotificationPolicy,isAlertNotificationQuiet} from '../../src/lib/server/core/alert-notification-policy';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext;
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'alert-notification-policy'},r2Buckets:{MAIL_BLOBS:'alert-notification-policy'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(query=>db.prepare(query)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterAll(async()=>{await mf?.dispose();},60_000);
const mailbox=()=>createMailbox(ctx,{name:'Policy',localPart:`policy-${crypto.randomUUID()}`});
const input=(expectedVersion=0,overrides:Record<string,unknown>={})=>({enabled:true,recoveryEnabled:true,repeatIntervalSeconds:0,quietEnabled:false,quietStartMinute:1320,quietEndMinute:480,timeZone:'UTC',expectedVersion,...overrides});

it('reads a backward-compatible virtual default without writing policy or audit rows',async()=>{
  const box=await mailbox(),first=await getAlertNotificationPolicy(ctx,box.id);
  expect(first.policy).toEqual(DEFAULT_ALERT_NOTIFICATION_POLICY);first.policy.enabled=false;
  expect((await getAlertNotificationPolicy(ctx,box.id)).policy.enabled).toBe(true);
  expect(await ctx.env.DB.prepare('SELECT count(*) count FROM alert_notification_policies WHERE mailbox_id=?').bind(box.id).first('count')).toBe(0);
  expect(await ctx.env.DB.prepare("SELECT count(*) count FROM audit_events WHERE mailbox_id=? AND action='alert_notification_policy.updated'").bind(box.id).first('count')).toBe(0);
});

it('atomically creates, versions and audits mailbox-isolated policies, including paused mailboxes',async()=>{
  const box=await mailbox(),other=await mailbox();
  const first=await updateAlertNotificationPolicy(ctx,box.id,input(0,{enabled:false,recoveryEnabled:false,repeatIntervalSeconds:604800,quietEnabled:true,timeZone:'US/Eastern'}));
  expect(first.policy).toMatchObject({enabled:false,recoveryEnabled:false,repeatIntervalSeconds:604800,quietEnabled:true,timeZone:'America/New_York',version:1});
  expect(first.policy.updatedAt).toBeGreaterThan(0);expect((await getAlertNotificationPolicy(ctx,other.id)).policy.version).toBe(0);
  await ctx.env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(box.id).run();
  const second=await updateAlertNotificationPolicy(ctx,box.id,input(1));expect(second.policy.version).toBe(2);expect(second.policy.updatedAt).toBeGreaterThan(first.policy.updatedAt);
  expect(await ctx.env.DB.prepare("SELECT count(*) count FROM audit_events WHERE mailbox_id=? AND action='alert_notification_policy.updated'").bind(box.id).first('count')).toBe(2);
});

it('claims default creation and later updates with Owner CAS under concurrent requests',async()=>{
  const box=await mailbox();
  const creations=await Promise.allSettled([updateAlertNotificationPolicy(ctx,box.id,input()),updateAlertNotificationPolicy(ctx,box.id,input(0,{repeatIntervalSeconds:60}))]);
  expect(creations.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(creations.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'alert_notification_policy_changed',status:409}});
  const updates=await Promise.allSettled([updateAlertNotificationPolicy(ctx,box.id,input(1,{repeatIntervalSeconds:120})),updateAlertNotificationPolicy(ctx,box.id,input(1,{repeatIntervalSeconds:180}))]);
  expect(updates.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect((await getAlertNotificationPolicy(ctx,box.id)).policy.version).toBe(2);
  await expect(updateAlertNotificationPolicy(ctx,box.id,input(0))).rejects.toMatchObject({code:'alert_notification_policy_changed'});
  expect(await ctx.env.DB.prepare("SELECT count(*) count FROM audit_events WHERE mailbox_id=? AND action='alert_notification_policy.updated'").bind(box.id).first('count')).toBe(2);
});

it('rejects malformed or incomplete policy settings before writes, and disallows Agent or retired mailbox management',async()=>{
  const box=await mailbox();
  for(const overrides of [{enabled:1},{recoveryEnabled:'true'},{quietEnabled:null},{repeatIntervalSeconds:-1},{repeatIntervalSeconds:604801},{repeatIntervalSeconds:1.5},{repeatIntervalSeconds:'60'},
    {quietStartMinute:-1},{quietEndMinute:1440},{quietEndMinute:0.5},{quietEnabled:true,quietStartMinute:60,quietEndMinute:60},
    {timeZone:'Not/AZone'},{timeZone:'+08:00'},{timeZone:' UTC '},{timeZone:'UTC\n'},{expectedVersion:-1}])
    await expect(updateAlertNotificationPolicy(ctx,box.id,input(0,overrides))).rejects.toMatchObject({code:'invalid_alert_notification_policy',status:400});
  expect(()=>normalizedAlertNotificationPolicy({...input(),secret:'no'})).toThrowError('invalid_input');
  expect(()=>normalizedAlertNotificationPolicy({expectedVersion:0})).toThrowError('invalid_alert_notification_policy');
  expect(normalizedAlertNotificationPolicy(input(0,{quietStartMinute:0,quietEndMinute:0})).quietEnabled).toBe(false);
  await expect(getAlertNotificationPolicy({...ctx,actor:null},box.id)).rejects.toMatchObject({status:401});
  const token={...ctx,actor:{kind:'token' as const,mailboxId:box.id,tokenId:crypto.randomUUID(),canRead:true,canSend:true}};
  await expect(getAlertNotificationPolicy(token,box.id)).rejects.toMatchObject({code:'owner_required',status:403});
  await expect(updateAlertNotificationPolicy(token,box.id,input())).rejects.toMatchObject({code:'owner_required',status:403});
  await ctx.env.DB.prepare("UPDATE mailboxes SET status='deleting' WHERE id=?").bind(box.id).run();
  await expect(getAlertNotificationPolicy(ctx,box.id)).rejects.toMatchObject({status:404});
  expect(await ctx.env.DB.prepare('SELECT count(*) count FROM alert_notification_policies WHERE mailbox_id=?').bind(box.id).first('count')).toBe(0);
});

it('applies half-open wall-clock quiet periods across midnight and daylight-saving transitions',()=>{
  const quiet={quietEnabled:true,quietStartMinute:1320,quietEndMinute:480,timeZone:'Asia/Shanghai'};
  const at=(iso:string)=>Date.parse(iso);
  expect(isAlertNotificationQuiet(quiet,at('2026-11-15T13:59:59Z'))).toBe(false);
  expect(isAlertNotificationQuiet(quiet,at('2026-11-15T14:00:00Z'))).toBe(true);
  expect(isAlertNotificationQuiet(quiet,at('2026-11-15T23:59:59Z'))).toBe(true);
  expect(isAlertNotificationQuiet(quiet,at('2026-11-16T00:00:00Z'))).toBe(false);
  expect(isAlertNotificationQuiet({...quiet,quietEnabled:false},at('2026-11-15T14:00:00Z'))).toBe(false);
  const fall={quietEnabled:true,quietStartMinute:75,quietEndMinute:105,timeZone:'America/New_York'};
  for(const iso of ['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'])expect(isAlertNotificationQuiet(fall,at(iso))).toBe(true);
  expect(isAlertNotificationQuiet(fall,at('2026-11-01T06:45:00Z'))).toBe(false);
  const spring={...fall,quietStartMinute:90,quietEndMinute:210};
  expect(isAlertNotificationQuiet(spring,at('2026-03-08T06:30:00Z'))).toBe(true);
  expect(isAlertNotificationQuiet(spring,at('2026-03-08T07:00:00Z'))).toBe(true);
  expect(isAlertNotificationQuiet(spring,at('2026-03-08T07:30:00Z'))).toBe(false);
});

async function queued(box:string,type:string,state:'pending'|'running'='pending'){
  const id=crypto.randomUUID(),event=crypto.randomUUID(),endpoint=crypto.randomUUID(),lease=crypto.randomUUID(),at=Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES(?,?,'app',?,?,?, ?,?)").bind(event,box,event,type,JSON.stringify({alertId:crypto.randomUUID()}),at,at),
    ctx.env.DB.prepare("INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,created_at,updated_at) VALUES(?,?,'https://hooks.example.net/','[]','{}',?,?)").bind(endpoint,box,at,at),
    ctx.env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,lease_token,lease_until,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?, ?,?,1,'{}','https://hooks.example.net/',?,?,?)`).bind(id,box,endpoint,event,state,state==='running'?1:0,at,state==='running'?lease:null,state==='running'?at+120000:null,JSON.stringify({type}),at,at),
    ...(state==='running'?[ctx.env.DB.prepare("INSERT INTO webhook_delivery_attempts(id,mailbox_id,delivery_id,attempt_no,lease_token,started_at) VALUES(?,?,?,1,?,?)").bind(crypto.randomUUID(),box,id,lease,at)]:[])
  ]);return id;
}

it('disabling notifications cancels queued/running alert deliveries and their active attempts without changing mail notifications',async()=>{
  const box=await mailbox(),created=await queued(box.id,'cloudflare.suppression.alert.created'),resolved=await queued(box.id,'cloudflare.suppression.alert.resolved','running'),mail=await queued(box.id,'message.received');
  await updateAlertNotificationPolicy(ctx,box.id,input(0,{enabled:false}));
  for(const id of [created,resolved])expect(await ctx.env.DB.prepare('SELECT state,last_error_code,lease_token,lease_until FROM webhook_deliveries WHERE id=?').bind(id).first())
    .toMatchObject({state:'cancelled',last_error_code:'alert_notifications_disabled',lease_token:null,lease_until:null});
  expect(await ctx.env.DB.prepare('SELECT outcome,error_code FROM webhook_delivery_attempts WHERE delivery_id=?').bind(resolved).first()).toMatchObject({outcome:'cancelled',error_code:'alert_notifications_disabled'});
  expect(await ctx.env.DB.prepare('SELECT state FROM webhook_deliveries WHERE id=?').bind(mail).first('state')).toBe('pending');
});

it('recovery switches cancel only recoveries and policy edits wake only quiet deferrals, preserving failure backoff',async()=>{
  const box=await mailbox(),created=await queued(box.id,'cloudflare.suppression.alert.created'),resolved=await queued(box.id,'cloudflare.suppression.alert.resolved','running'),backoff=await queued(box.id,'cloudflare.suppression.alert.created'),future=Date.now()+600000;
  await ctx.env.DB.prepare("UPDATE webhook_deliveries SET available_at=?,last_error_code='alert_quiet_hours' WHERE id=?").bind(future,created).run();
  await ctx.env.DB.prepare("UPDATE webhook_deliveries SET available_at=?,last_error_code='http_retry' WHERE id=?").bind(future,backoff).run();
  await updateAlertNotificationPolicy(ctx,box.id,input(0,{recoveryEnabled:false}));
  expect(await ctx.env.DB.prepare('SELECT state,last_error_code FROM webhook_deliveries WHERE id=?').bind(resolved).first()).toMatchObject({state:'cancelled',last_error_code:'alert_recovery_disabled'});
  const awakened=await ctx.env.DB.prepare('SELECT state,last_error_code,available_at FROM webhook_deliveries WHERE id=?').bind(created).first<{state:string;last_error_code:string|null;available_at:number}>();
  expect(awakened).toMatchObject({state:'pending',last_error_code:null});expect(awakened!.available_at).toBeLessThan(future);
  expect(await ctx.env.DB.prepare('SELECT available_at,last_error_code FROM webhook_deliveries WHERE id=?').bind(backoff).first()).toMatchObject({available_at:future,last_error_code:'http_retry'});
});
