import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {createAsyncAlertNotificationExport,getAsyncAlertNotificationExport,listAsyncAlertNotificationExports,cancelAsyncAlertNotificationExport,
  ASYNC_ALERT_NOTIFICATION_EXPORT_TTL,parseAsyncAlertNotificationExportSummary} from '../../src/lib/server/core/async-alert-notification-exports';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:{DB:'async-export-manager'},r2Buckets:{MAIL_BLOBS:'async-export-manager'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(sql=>db.prepare(sql)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()-1000;
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Async export',localPart:`async-${crypto.randomUUID()}`});
const input=(extra:Record<string,unknown>={})=>({clientRequestId:crypto.randomUUID(),format:'json',...extra});
async function record(mailboxId:string,reason='allowed',time=at,resolved=false){
  const id=crypto.randomUUID(),alertId=crypto.randomUUID();await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES(?,?,'app',?,?,?,?,?)`)
      .bind(id,mailboxId,id,`cloudflare.suppression.alert.${resolved?'resolved':'created'}`,JSON.stringify({alertId,kind:'sync',status:resolved?'resolved':'open',outcome:resolved?'resolved':'failed'}),time,time),
    ctx.env.DB.prepare(`INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token) VALUES(?,?,?,?,1,?,'PRIVATE_CLAIM')`).bind(id,mailboxId,alertId,reason,time)
  ]);return id;
}

it('creates an empty bounded job without configuration dependency and exposes only safe Owner metadata',async()=>{
  const mailbox=await box(),created=await createAsyncAlertNotificationExport(ctx,mailbox.id,input());
  expect(created.job).toMatchObject({mailboxId:mailbox.id,format:'json',state:'queued',version:1,totalDecisions:0,processedDecisions:0,processedDeliveries:0,chunkCount:0,bodyBytes:0,canCancel:true,downloadAvailable:false});
  expect(created.job.expiresAt-created.job.createdAt).toBe(ASYNC_ALERT_NOTIFICATION_EXPORT_TTL);expect(created.job.window.to-created.job.window.from).toBe(7*86_400_000);
  expect(JSON.stringify(created)).not.toMatch(/object_key|request_hash|lease_|cleanup_|PRIVATE|client_request_id/);
  const before=await ctx.env.DB.prepare('SELECT COUNT(*) n FROM audit_events').first('n');
  expect((await getAsyncAlertNotificationExport(ctx,mailbox.id,created.job.id)).job).toEqual(created.job);
  expect((await listAsyncAlertNotificationExports(ctx,mailbox.id)).jobs).toEqual([created.job]);expect(await ctx.env.DB.prepare('SELECT COUNT(*) n FROM audit_events').first('n')).toBe(before);
});

it('freezes exact filters and decision membership and keeps omitted-date idempotent retries stable as the clock changes',async()=>{
  const mailbox=await box();await record(mailbox.id,'quiet_hours',at,true);await record(mailbox.id,'quiet_hours',at+1);await record(mailbox.id,'disabled',at+2,true);
  const request=input({decision:'quiet_hours',eventType:'resolved',from:at,to:at+2}),first=await createAsyncAlertNotificationExport(ctx,mailbox.id,request);
  expect(first.job.totalDecisions).toBe(1);await record(mailbox.id,'quiet_hours',at-1,true);expect((await getAsyncAlertNotificationExport(ctx,mailbox.id,first.job.id)).job.totalDecisions).toBe(1);
  const defaults=input({format:'csv'}),initial=await createAsyncAlertNotificationExport(ctx,mailbox.id,defaults),clock=Date.now();vi.spyOn(Date,'now').mockReturnValue(clock+10_000);
  expect((await createAsyncAlertNotificationExport(ctx,mailbox.id,defaults)).job.id).toBe(initial.job.id);expect((await createAsyncAlertNotificationExport(ctx,mailbox.id,defaults)).job.window).toEqual(initial.job.window);
  await expect(createAsyncAlertNotificationExport(ctx,mailbox.id,{...request,format:'csv'})).rejects.toMatchObject({code:'async_export_idempotency_conflict',status:409});
});

it('atomically deduplicates concurrent creation and enforces mailbox and instance active-job quotas',async()=>{
  const first=await box(),second=await box(),third=await box(),request=input();
  const duplicate=await Promise.all([createAsyncAlertNotificationExport(ctx,first.id,request),createAsyncAlertNotificationExport(ctx,first.id,request)]);expect(duplicate[0].job.id).toBe(duplicate[1].job.id);
  await createAsyncAlertNotificationExport(ctx,first.id,input());await expect(createAsyncAlertNotificationExport(ctx,first.id,input())).rejects.toMatchObject({code:'async_export_quota_exceeded'});
  const competing=await Promise.allSettled([createAsyncAlertNotificationExport(ctx,second.id,input()),createAsyncAlertNotificationExport(ctx,second.id,input()),createAsyncAlertNotificationExport(ctx,third.id,input())]);
  expect(competing.filter(value=>value.status==='fulfilled')).toHaveLength(2);expect(await ctx.env.DB.prepare("SELECT COUNT(*) n FROM async_alert_notification_exports WHERE state='queued'").first('n')).toBe(4);
  expect(await ctx.env.DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='async_alert_notification_export.created'").first('n')).toBe(4);
});

it('cancels a live lease using CAS and prevents a concurrent old cancellation or late progress publication',async()=>{
  const mailbox=await box(),created=(await createAsyncAlertNotificationExport(ctx,mailbox.id,input())).job;
  await ctx.env.DB.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='PRIVATE_LEASE',lease_until=?,started_at=?,attempts=1,version=version+1,updated_at=updated_at+1 WHERE id=?")
    .bind(Date.now()+120_000,Date.now(),created.id).run();
  const current=(await getAsyncAlertNotificationExport(ctx,mailbox.id,created.id)).job;
  const result=await Promise.allSettled([cancelAsyncAlertNotificationExport(ctx,mailbox.id,current.id,{expectedVersion:current.version}),cancelAsyncAlertNotificationExport(ctx,mailbox.id,current.id,{expectedVersion:current.version})]);
  expect(result.filter(value=>value.status==='fulfilled')).toHaveLength(1);expect((await getAsyncAlertNotificationExport(ctx,mailbox.id,current.id)).job).toMatchObject({state:'cancelled',canCancel:false,downloadAvailable:false});
  expect(await ctx.env.DB.prepare('SELECT lease_token FROM async_alert_notification_exports WHERE id=?').bind(current.id).first('lease_token')).toBeNull();
  expect((await ctx.env.DB.prepare("UPDATE async_alert_notification_exports SET processed_decisions=total_decisions,version=version+1,updated_at=updated_at+1 WHERE id=? AND state='running' AND lease_token='PRIVATE_LEASE'").bind(current.id).run()).meta.changes).toBe(0);
  await expect(cancelAsyncAlertNotificationExport(ctx,mailbox.id,current.id,{expectedVersion:current.version+1})).rejects.toMatchObject({code:'async_export_not_cancellable'});
});

it('protects Owner scope and paginated history while allowing paused mailbox reads and writes',async()=>{
  const first=await box(),second=await box();for(let i=0;i<5;i++){const job=(await createAsyncAlertNotificationExport(ctx,first.id,input())).job;await cancelAsyncAlertNotificationExport(ctx,first.id,job.id,{expectedVersion:job.version});}
  const page=await listAsyncAlertNotificationExports(ctx,first.id,{limit:2}),next=await listAsyncAlertNotificationExports(ctx,first.id,{limit:2,cursor:page.nextCursor});expect(page.jobs).toHaveLength(2);expect(next.jobs).toHaveLength(2);expect(new Set([...page.jobs,...next.jobs].map(job=>job.id)).size).toBe(4);
  await expect(listAsyncAlertNotificationExports(ctx,second.id,{limit:2,cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(getAsyncAlertNotificationExport(ctx,second.id,page.jobs[0].id)).rejects.toMatchObject({status:404});
  await expect(createAsyncAlertNotificationExport({...ctx,actor:null},first.id,input())).rejects.toMatchObject({status:401});
  await expect(listAsyncAlertNotificationExports({...ctx,actor:{kind:'token',mailboxId:first.id,tokenId:crypto.randomUUID(),canRead:true}},first.id)).rejects.toMatchObject({status:403});
  await ctx.env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(first.id).run();expect((await createAsyncAlertNotificationExport(ctx,first.id,input())).job.state).toBe('queued');
  for(const value of [input({format:'html'}),input({clientRequestId:'not-a-uuid'}),input({decision:'unexpected'}),input({from:true}),input({from:at,to:at}),input({from:0,to:32*86_400_000}),input({expiry:1})])await expect(createAsyncAlertNotificationExport(ctx,second.id,value)).rejects.toMatchObject({status:400});
});

it('expires immediately in safe read DTOs, frees expired quota, and rejects changed source identity or private summary fields',async()=>{
  const mailbox=await box(),a=(await createAsyncAlertNotificationExport(ctx,mailbox.id,input())).job;await createAsyncAlertNotificationExport(ctx,mailbox.id,input());
  vi.spyOn(Date,'now').mockReturnValue(a.expiresAt+1);const expired=(await getAsyncAlertNotificationExport(ctx,mailbox.id,a.id)).job;expect(expired).toMatchObject({state:'expired',canCancel:false,downloadAvailable:false});
  expect(await ctx.env.DB.prepare('SELECT state FROM async_alert_notification_exports WHERE id=?').bind(a.id).first('state')).toBe('queued');
  await expect(cancelAsyncAlertNotificationExport(ctx,mailbox.id,a.id,{expectedVersion:a.version})).rejects.toMatchObject({code:'async_export_not_cancellable'});expect((await createAsyncAlertNotificationExport(ctx,mailbox.id,input())).job.state).toBe('queued');
  await expect(ctx.env.DB.prepare('UPDATE async_alert_notification_exports SET from_ms=from_ms+1,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(a.id).run()).rejects.toThrow();
  const summary={...a.summary,PRIVATE:'SECRET',byDecision:{...a.summary.byDecision,PRIVATE:'SECRET'}};expect(JSON.stringify(parseAsyncAlertNotificationExportSummary(JSON.stringify(summary)))).not.toContain('PRIVATE');
  expect(()=>parseAsyncAlertNotificationExportSummary('{"PRIVATE":"SECRET"}')).toThrowError('async_export_source_changed');
});

it('enforces the large dataset bound and immutable mailbox-scoped chunk manifests in real SQLite',async()=>{
  const first=await box(),second=await box();
  await ctx.env.DB.prepare(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100001)
    INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at)
    SELECT printf('%08x-0000-4000-8000-%012x',i,i),?,'app',printf('%08x-0000-4000-8000-%012x',i,i),'cloudflare.suppression.alert.created','{}',?,? FROM n`).bind(first.id,at,at).run();
  await ctx.env.DB.prepare(`INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token)
    SELECT id,mailbox_id,'00000000-0000-4000-8000-000000000000','allowed',0,created_at,'fixture' FROM events WHERE mailbox_id=?`).bind(first.id).run();
  await expect(createAsyncAlertNotificationExport(ctx,first.id,input())).rejects.toMatchObject({code:'async_export_too_large',status:413});
  const job=(await createAsyncAlertNotificationExport(ctx,second.id,input())).job,key=`exports/alert-notification/${second.id}/${job.id}/lease/1.part`;
  const insert=(mailboxId:string,sequence=1)=>ctx.env.DB.prepare('INSERT INTO async_alert_notification_export_chunks(job_id,mailbox_id,sequence,object_key,size_bytes,sha256,created_at) VALUES(?,?,?,?,1,?,?)').bind(job.id,mailboxId,sequence,key,'a'.repeat(64),Date.now()).run();
  await expect(insert(first.id)).rejects.toThrow();await insert(second.id);await expect(insert(second.id)).rejects.toThrow();
  await expect(ctx.env.DB.prepare('UPDATE async_alert_notification_export_chunks SET size_bytes=2 WHERE job_id=?').bind(job.id).run()).rejects.toThrow();
  await expect(ctx.env.DB.prepare('DELETE FROM async_alert_notification_export_chunks WHERE job_id=?').bind(job.id).run()).rejects.toThrow();
  await expect(ctx.env.DB.prepare('DELETE FROM async_alert_notification_exports WHERE id=?').bind(job.id).run()).rejects.toThrow();
},60_000);
