import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {createAsyncAlertNotificationExport} from '../../src/lib/server/core/async-alert-notification-exports';
import {acknowledgeAsyncExportNotification,exportNotice,getAsyncExportNotification,listAsyncExportNotifications,projectAsyncExportNotifications,
  type AsyncExportNotificationRow} from '../../src/lib/server/core/async-export-notifications';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,schema:string[],beforeNoticeSchema:string[],noticeMigration:string[],at:number;
beforeAll(async()=>{schema=[];beforeNoticeSchema=[];noticeMigration=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()){
  const statements=unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8'));schema.push(...statements);
  if(name<'0015_async_export_notifications.sql')beforeNoticeSchema.push(...statements);else if(name==='0015_async_export_notifications.sql')noticeMigration=statements;
}});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:{DB:'async-export-notices'},r2Buckets:{MAIL_BLOBS:'async-export-notices'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now();
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Export notifications',localPart:`notice-${crypto.randomUUID()}`});
const count=(table:string)=>ctx.env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>('n');
const raw=(id:string)=>ctx.env.DB.prepare('SELECT * FROM async_export_notifications WHERE job_id=?').bind(id).first<AsyncExportNotificationRow>();
async function queued(mailbox:string){return(await createAsyncAlertNotificationExport(ctx,mailbox,{clientRequestId:crypto.randomUUID(),format:'json'})).job;}
async function running(mailbox:string){const job=await queued(mailbox);await ctx.env.DB.prepare(`UPDATE async_alert_notification_exports SET state='running',lease_token=?,lease_until=?,started_at=?,
  version=version+1,updated_at=updated_at+1 WHERE id=?`).bind(crypto.randomUUID(),at+120000,at,job.id).run();return job;}
async function terminal(mailbox:string,outcome:'succeeded'|'failed'='succeeded',error:string|null=null){
  const job=await running(mailbox);await ctx.env.DB.prepare(`UPDATE async_alert_notification_exports SET state=?,lease_token=NULL,lease_until=NULL,error_code=?,completed_at=?,
    version=version+1,updated_at=updated_at+1 WHERE id=?`).bind(outcome,error,at,job.id).run();return job;
}

it('atomically captures one safe terminal fact and never notifies retries, cancellation or subsequent expiry',async()=>{
  const mailbox=await box(),success=await terminal(mailbox.id),failed=await terminal(mailbox.id,'failed','PRIVATE_UPSTREAM_DIAGNOSTIC');
  expect(await count('async_export_notifications')).toBe(2);expect((await raw(failed.id))?.error_code).toBe('async_export_failed');
  expect((await raw(success.id))).toMatchObject({outcome:'succeeded',error_code:null,version:1,acknowledged_at:null,projected_at:null,notification_decision:null});
  await ctx.env.DB.prepare(`UPDATE async_alert_notification_exports SET state='expired',version=version+1,updated_at=updated_at+1 WHERE id=?`).bind(success.id).run();
  expect((await raw(success.id))?.outcome).toBe('succeeded');
  const retry=await running(mailbox.id);await ctx.env.DB.prepare(`UPDATE async_alert_notification_exports SET state='queued',lease_token=NULL,lease_until=NULL,
    version=version+1,updated_at=updated_at+1 WHERE id=?`).bind(retry.id).run();
  await ctx.env.DB.prepare(`UPDATE async_alert_notification_exports SET state='cancelled',version=version+1,updated_at=updated_at+1 WHERE id=?`).bind(retry.id).run();
  expect(await count('async_export_notifications')).toBe(2);expect(await raw(retry.id)).toBeNull();
});

it('rolls back the terminal transition if its durable notification cannot be stored',async()=>{
  const mailbox=await box(),job=await running(mailbox.id);
  await ctx.env.DB.prepare("CREATE TRIGGER injected_notice_failure BEFORE INSERT ON async_export_notifications BEGIN SELECT RAISE(ABORT,'injected_notice_failure'); END").run();
  await expect(ctx.env.DB.prepare(`UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,completed_at=?,
    version=version+1,updated_at=updated_at+1 WHERE id=?`).bind(at,job.id).run()).rejects.toThrow('injected_notice_failure');
  expect(await ctx.env.DB.prepare('SELECT state FROM async_alert_notification_exports WHERE id=?').bind(job.id).first('state')).toBe('running');expect(await raw(job.id)).toBeNull();
});

it('projects once with stable event identity and original terminal creation time, including paused mailboxes',async()=>{
  const mailbox=await box(),job=await terminal(mailbox.id,'failed','async_export_storage_unavailable');
  await ctx.env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(mailbox.id).run();
  const atProjection=at+60000,results=await Promise.all([projectAsyncExportNotifications(ctx.env,{now:()=>atProjection}),projectAsyncExportNotifications(ctx.env,{now:()=>atProjection})]);
  expect(results.reduce((sum,result)=>sum+result.exportNotificationsProjected,0)).toBe(1);expect(await count('events')).toBe(1);
  const notice=(await raw(job.id))!,event=await ctx.env.DB.prepare('SELECT * FROM events WHERE id=?').bind(notice.event_id).first<Record<string,unknown>>();
  expect(notice).toMatchObject({projected_at:atProjection,version:1});expect(event).toMatchObject({source:'app',type:'alert_notification.export.failed',created_at:at,occurred_at:at});
  expect(JSON.parse(String(event!.payload_json))).toEqual({jobId:job.id,format:'json',state:'failed',totalDecisions:0,processedDecisions:0,processedDeliveries:0,bodyBytes:0,
    completedAt:at,expiresAt:job.expiresAt,errorCode:'async_export_storage_unavailable'});
  expect((await projectAsyncExportNotifications(ctx.env)).exportNotificationsProjected).toBe(0);
});

it('recovers a lost projection ACK without duplicating the event or replacing its immutable receipt',async()=>{
  const mailbox=await box(),job=await terminal(mailbox.id);let lost=true;
  const database=new Proxy(ctx.env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(lost){lost=false;throw Error('lost projection ACK');}return result;};return Reflect.get(target,key,target);}});
  await expect(projectAsyncExportNotifications({...ctx.env,DB:database})).rejects.toThrow('lost projection ACK');
  expect((await projectAsyncExportNotifications(ctx.env)).exportNotificationsProjected).toBe(0);expect(await count('events')).toBe(1);expect((await raw(job.id))?.event_id).not.toBeNull();
  await expect(ctx.env.DB.prepare('UPDATE async_export_notifications SET projected_at=projected_at+1 WHERE job_id=?').bind(job.id).run()).rejects.toThrow('immutable');
});

it('uses an independent acknowledgment CAS while projection and notification admission preserve the version',async()=>{
  const mailbox=await box(),job=await terminal(mailbox.id);await projectAsyncExportNotifications(ctx.env);
  await expect(ctx.env.DB.prepare("UPDATE async_export_notifications SET notification_decision='allowed' WHERE job_id=?").bind(job.id).run()).rejects.toThrow();
  await expect(ctx.env.DB.prepare('UPDATE async_export_notifications SET version=version+1 WHERE job_id=?').bind(job.id).run()).rejects.toThrow('immutable');
  await ctx.env.DB.prepare("UPDATE async_export_notifications SET notification_decision='disabled',policy_version=2,decided_at=?,claim_token='PRIVATE_CLAIM' WHERE job_id=?").bind(at+1,job.id).run();
  expect((await getAsyncExportNotification(ctx,mailbox.id,job.id)).notification.version).toBe(1);
  const acknowledgments=await Promise.allSettled([acknowledgeAsyncExportNotification(ctx,mailbox.id,job.id,{expectedVersion:1}),acknowledgeAsyncExportNotification(ctx,mailbox.id,job.id,{expectedVersion:1})]);
  expect(acknowledgments.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await ctx.env.DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='async_export_notification.acknowledged'").first('n')).toBe(1);
  const notice=(await getAsyncExportNotification(ctx,mailbox.id,job.id)).notification;expect(notice).toMatchObject({version:2,notificationDecision:'disabled',policyVersion:2});
  expect(JSON.stringify(notice)).not.toMatch(/PRIVATE|claim_token|projected_at|event_id|object_key/);
  await expect(acknowledgeAsyncExportNotification(ctx,mailbox.id,job.id,{expectedVersion:2})).rejects.toMatchObject({code:'export_notification_changed',status:409});
  await expect(ctx.env.DB.prepare("UPDATE async_export_notifications SET notification_decision='allowed' WHERE job_id=?").bind(job.id).run()).rejects.toThrow('immutable');
  await expect(ctx.env.DB.prepare('UPDATE async_export_notifications SET body_bytes=body_bytes+1 WHERE job_id=?').bind(job.id).run()).rejects.toThrow('immutable');
  await expect(ctx.env.DB.prepare('DELETE FROM async_export_notifications WHERE job_id=?').bind(job.id).run()).rejects.toThrow('retained');
});

it('keeps Owner reads side-effect free, paginates mailbox history and separates unread totals from outcome totals',async()=>{
  const mailbox=await box(),other=await box();let first='';for(let index=0;index<7;index++){const job=await terminal(mailbox.id,index<5?'succeeded':'failed','async_export_failed');if(!index)first=job.id;}
  await terminal(other.id);await acknowledgeAsyncExportNotification(ctx,mailbox.id,first,{expectedVersion:1});
  const audits=await count('audit_events'),events=await count('events'),page=await listAsyncExportNotifications(ctx,mailbox.id,{status:'all',limit:3});
  expect(page.notifications).toHaveLength(3);expect(page.summary).toEqual({unread:6,succeeded:5,failed:2});
  const next=await listAsyncExportNotifications(ctx,mailbox.id,{status:'all',limit:3,cursor:page.nextCursor});expect(new Set([...page.notifications,...next.notifications].map(item=>item.id)).size).toBe(6);
  expect((await listAsyncExportNotifications(ctx,mailbox.id,{status:'acknowledged'})).notifications.map(item=>item.id)).toEqual([first]);
  expect(await exportNotice(ctx)).toMatchObject({count:7});expect(await count('audit_events')).toBe(audits);expect(await count('events')).toBe(events);
  await expect(listAsyncExportNotifications(ctx,other.id,{status:'all',limit:3,cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(listAsyncExportNotifications(ctx,mailbox.id,{status:'unread',limit:3,cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(getAsyncExportNotification(ctx,other.id,first)).rejects.toMatchObject({status:404});
  await expect(getAsyncExportNotification({...ctx,actor:null},mailbox.id,first)).rejects.toMatchObject({status:401});
  await expect(listAsyncExportNotifications({...ctx,actor:{kind:'token',mailboxId:mailbox.id,tokenId:crypto.randomUUID(),canRead:true}},mailbox.id)).rejects.toMatchObject({status:403});
  for(const query of [{status:'bad'},{limit:0},{limit:101},{cursor:'invalid'},{extra:1}])await expect(listAsyncExportNotifications(ctx,mailbox.id,query)).rejects.toMatchObject({status:400});
});

it('bounds each projection pass and excludes retired mailboxes without deleting retained notices',async()=>{
  const mailbox=await box(),retired=await box();for(let index=0;index<23;index++)await terminal(mailbox.id);const old=await terminal(retired.id);
  await ctx.env.DB.prepare("UPDATE mailboxes SET status='deleted',deleted_at=? WHERE id=?").bind(at,retired.id).run();
  expect((await projectAsyncExportNotifications(ctx.env)).exportNotificationsProjected).toBe(20);expect((await projectAsyncExportNotifications(ctx.env)).exportNotificationsProjected).toBe(3);
  expect((await projectAsyncExportNotifications(ctx.env)).exportNotificationsProjected).toBe(0);expect((await raw(old.id))?.projected_at).toBeNull();expect(await exportNotice(ctx)).toMatchObject({count:23,mailboxId:mailbox.id});
  await expect(getAsyncExportNotification(ctx,retired.id,old.id)).rejects.toMatchObject({status:404});
});

it('upgrades existing instances without backfilling historical terminal jobs and starts capturing new transitions',async()=>{
  const previous=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:{DB:'pre-export-notices'},r2Buckets:{MAIL_BLOBS:'pre-export-notices'},log:new Log(LogLevel.ERROR)}));
  try{
    const db=await previous.getD1Database('DB');await db.batch(beforeNoticeSchema.map(query=>db.prepare(query)));
    const oldContext:OwnerContext={...ctx,env:{...ctx.env,DB:db}},mailbox=await createMailbox(oldContext,{name:'Existing instance',localPart:'existing'});
    const old=(await createAsyncAlertNotificationExport(oldContext,mailbox.id,{clientRequestId:crypto.randomUUID(),format:'csv'})).job;
    await db.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='old',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at+120000,old.id).run();
    await db.prepare("UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at,old.id).run();
    await db.batch(noticeMigration.map(query=>db.prepare(query)));expect(await db.prepare('SELECT COUNT(*) n FROM async_export_notifications').first('n')).toBe(0);
    expect((await listAsyncExportNotifications(oldContext,mailbox.id)).summary).toEqual({unread:0,succeeded:0,failed:0});
    const next=(await createAsyncAlertNotificationExport(oldContext,mailbox.id,{clientRequestId:crypto.randomUUID(),format:'json'})).job;
    await db.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='next',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at+120000,next.id).run();
    await db.prepare("UPDATE async_alert_notification_exports SET state='failed',lease_token=NULL,lease_until=NULL,error_code='async_export_failed',completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at,next.id).run();
    expect((await listAsyncExportNotifications(oldContext,mailbox.id)).notifications.map(item=>item.id)).toEqual([next.id]);
  }finally{await previous.dispose();}
});
