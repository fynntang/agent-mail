import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {acknowledgeCloudflareSuppressionAlert,getCloudflareSuppressionAlert,listCloudflareSuppressionAlerts,projectCloudflareSuppressionAlerts,safeAlertErrorCode} from '../../src/lib/server/core/cloudflare-suppression-alerts';
import {reconcileCloudflareSuppression,releaseCloudflareSuppression,syncCloudflareSuppressions,type CloudflareSuppressionOptions} from '../../src/lib/server/core/cloudflare-suppressions';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,migrations:Map<string,string[]>,at:number;
const account='a'.repeat(32),domain='agent.example.com';
beforeAll(async()=>{migrations=new Map();for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())migrations.set(name,unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'suppression-alerts'},r2Buckets:{MAIL_BLOBS:'suppression-alerts'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch([...migrations.values()].flat().map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:domain,EMAIL_SUPPRESSIONS_ACCOUNT_ID:account,EMAIL_SUPPRESSIONS_DOMAIN:domain,EMAIL_SUPPRESSIONS_API_TOKEN:'fake_cf_alert_token_1234567890'} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+10_000;
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);
const mailbox=()=>createMailbox(ctx,{name:'Alerts',localPart:`alert-${crypto.randomUUID()}`});
const project=()=>projectCloudflareSuppressionAlerts(env,{now:()=>at});
function options(fetcher:(url:URL,init:RequestInit)=>Response|Promise<Response>):CloudflareSuppressionOptions{return {now:()=>at,fetcher:((url:RequestInfo|URL,init?:RequestInit)=>fetcher(new URL(String(url)),init??{})) as typeof fetch};}
const response=(result:unknown,info?:unknown)=>new Response(JSON.stringify({success:true,errors:[],result,...(info?{result_info:info}:{})}),{headers:{'Content-Type':'application/json'}});
async function run(box:string|null,state:'failed'|'succeeded'='failed',parent?:string,error='cloudflare_api_unavailable',target=env){
  const id=crypto.randomUUID();await target.DB.prepare(`INSERT INTO cloudflare_suppression_sync_runs(id,request_hash,account_id,domain,mailbox_id,source,retry_of,state,started_at)
    VALUES(?,?,?,?,?,?,?,'running',?)`).bind(id,'a'.repeat(64),account,domain,box,box?'owner':'scheduled',parent??null,at).run();
  await target.DB.prepare('UPDATE cloudflare_suppression_sync_runs SET state=?,error_code=?,count=?,completed_at=? WHERE id=?').bind(state,state==='failed'?error:null,state==='succeeded'?0:null,at,id).run();return id;
}

it('projects real sync failure once under concurrency and emits only a safe app alert payload',async()=>{
  const box=await mailbox();await expect(syncCloudflareSuppressions(ctx,box.id,options(()=>new Response('recipient@example.net secret-token',{status:500})))).rejects.toMatchObject({status:502});
  await Promise.all([project(),project()]);await project();
  const result=await listCloudflareSuppressionAlerts(ctx,box.id);expect(result.alerts).toHaveLength(1);expect(result.summary).toEqual({open:1,acknowledged:0,resolved:0});expect(result.alerts[0]).toMatchObject({kind:'sync',status:'open',outcome:'failed',version:1,occurrences:1});
  const events=(await env.DB.prepare("SELECT * FROM events WHERE type='cloudflare.suppression.alert.created'").all<{payload_json:string}>()).results;expect(events).toHaveLength(1);
  expect(JSON.parse(events[0].payload_json)).toEqual({alertId:result.alerts[0].id,kind:'sync',status:'open',outcome:'failed',errorCode:'cloudflare_api_unavailable'});
  expect(events[0].payload_json).not.toContain(box.id);expect(events[0].payload_json).not.toContain(result.alerts[0].source.sourceId);expect(events[0].payload_json).not.toContain('secret');
});

it('acknowledges by Owner CAS and reopens only a meaningful retry failure before resolving a successful child',async()=>{
  const box=await mailbox(),root=await run(box.id);await project();let alert=(await listCloudflareSuppressionAlerts(ctx,box.id)).alerts[0];
  const results=await Promise.allSettled([acknowledgeCloudflareSuppressionAlert(ctx,box.id,alert.id,{expectedVersion:1}),acknowledgeCloudflareSuppressionAlert(ctx,box.id,alert.id,{expectedVersion:1})]);expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect((await getCloudflareSuppressionAlert(ctx,box.id,alert.id)).alert).toMatchObject({status:'acknowledged',version:2});await project();expect((await getCloudflareSuppressionAlert(ctx,box.id,alert.id)).alert.status).toBe('acknowledged');
  at++;const child=await run(box.id,'failed',root);await project();alert=(await getCloudflareSuppressionAlert(ctx,box.id,alert.id)).alert;expect(alert).toMatchObject({status:'open',version:3,occurrences:2,generation:1,source:{sourceId:child},acknowledgedAt:null});
  at++;const success=await run(box.id,'succeeded',child);await project();alert=(await getCloudflareSuppressionAlert(ctx,box.id,alert.id)).alert;expect(alert).toMatchObject({status:'resolved',outcome:'resolved',version:4,source:{sourceId:success}});
  await expect(acknowledgeCloudflareSuppressionAlert(ctx,box.id,alert.id,{expectedVersion:4})).rejects.toMatchObject({code:'alert_changed'});
  at++;await run(box.id,'failed',success);await project();expect((await getCloudflareSuppressionAlert(ctx,box.id,alert.id)).alert).toMatchObject({status:'open',generation:2,occurrences:3,version:5,resolvedAt:null});
  expect((await getCloudflareSuppressionAlert(ctx,box.id,alert.id)).timeline.map(item=>item.action)).toEqual(['failed','failed','resolved','failed']);
});

it('keeps unknown deletion open after verified presence and resolves only confirmed absence without another DELETE',async()=>{
  const box=await mailbox(),row={id:crypto.randomUUID(),email:'recipient@example.net',reason:'manual',read_only:false,scope:{type:'account'},created_at:new Date(at-1000).toISOString(),expires_at:null};
  await syncCloudflareSuppressions(ctx,box.id,options(url=>response(url.searchParams.get('scope_type')==='account'?[row]:[],{next_cursor:null})));
  const cache=await env.DB.prepare('SELECT version_hash FROM cloudflare_suppression_cache WHERE remote_id=?').bind(row.id).first('version_hash');
  const op=await releaseCloudflareSuppression(ctx,box.id,row.id,{clientRequestId:crypto.randomUUID(),expectedVersion:cache,confirmationAddress:row.email,confirmationScope:'account'},options((_url,init)=>init.method==='DELETE'?new Response(null,{status:500}):response(row)));
  await project();let alert=(await listCloudflareSuppressionAlerts(ctx,box.id)).alerts[0];expect(alert).toMatchObject({kind:'release',outcome:'unknown'});await acknowledgeCloudflareSuppressionAlert(ctx,box.id,alert.id,{expectedVersion:alert.version});
  at+=120001;await reconcileCloudflareSuppression(ctx,box.id,op.operationId,{clientRequestId:crypto.randomUUID()},options((_url,init)=>{expect(init.method).toBe('GET');return response(row);}));await project();
  expect((await getCloudflareSuppressionAlert(ctx,box.id,alert.id)).alert).toMatchObject({status:'acknowledged',outcome:'unknown',occurrences:1});
  await reconcileCloudflareSuppression(ctx,box.id,op.operationId,{clientRequestId:crypto.randomUUID()},options((_url,init)=>{expect(init.method).toBe('GET');return new Response(null,{status:404});}));await project();
  alert=(await getCloudflareSuppressionAlert(ctx,box.id,alert.id)).alert;expect(alert).toMatchObject({status:'resolved',outcome:'resolved',errorCode:null});expect((await env.DB.prepare("SELECT id FROM events WHERE type='cloudflare.suppression.alert.resolved'").all()).results).toHaveLength(1);
});

it('groups scheduled runs globally, keeps paused consoles visible, and never backfills mailboxes created after an occurrence',async()=>{
  const active=await mailbox(),paused=await mailbox();await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(paused.id).run();
  const scheduled=await run(null);await project();const alert=(await listCloudflareSuppressionAlerts(ctx,active.id)).alerts[0];expect(alert.global).toBe(true);expect(alert.source.mailboxId).toBeUndefined();expect((await listCloudflareSuppressionAlerts(ctx,paused.id)).alerts[0].id).toBe(alert.id);
  const events=await env.DB.prepare('SELECT mailbox_id FROM events').all<{mailbox_id:string}>();expect(events.results.map(row=>row.mailbox_id)).toEqual([active.id]);
  const later=await mailbox();await env.DB.prepare('UPDATE mailboxes SET created_at=?,updated_at=? WHERE id=?').bind(at+1,at+1,later.id).run();await project();expect((await env.DB.prepare('SELECT id FROM events WHERE mailbox_id=?').bind(later.id).all()).results).toHaveLength(0);
  at+=2;await run(null);await project();expect((await listCloudflareSuppressionAlerts(ctx,active.id)).alerts).toHaveLength(1);expect((await getCloudflareSuppressionAlert(ctx,active.id,alert.id)).alert.occurrences).toBe(2);
  at++;await run(null,'succeeded');await project();expect((await getCloudflareSuppressionAlert(ctx,paused.id,alert.id)).alert.status).toBe('resolved');
  at++;const child=await run(active.id,'failed',scheduled);await project();const detail=await getCloudflareSuppressionAlert(ctx,paused.id,alert.id);expect(detail.alert.source).toEqual({kind:'sync',sourceId:child,mailboxId:active.id});expect(detail.timeline.at(-1)!.source.mailboxId).toBe(active.id);
});

it('scopes lists, cursors, acknowledgements and public identity reads, and normalizes any unexpected error before notifications',async()=>{
  const box=await mailbox(),other=await mailbox();await run(box.id,'failed',undefined,'recipient@example.net raw secret');await run(box.id);await project();
  const first=await listCloudflareSuppressionAlerts(ctx,box.id,{limit:1}),second=await listCloudflareSuppressionAlerts(ctx,box.id,{limit:1,cursor:first.nextCursor!});expect(first.alerts[0].id).not.toBe(second.alerts[0].id);expect(safeAlertErrorCode('recipient@example.net raw secret')).toBeNull();
  expect((await listCloudflareSuppressionAlerts(ctx,other.id)).alerts).toHaveLength(0);await expect(listCloudflareSuppressionAlerts(ctx,other.id,{limit:1,cursor:first.nextCursor!})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(getCloudflareSuppressionAlert(ctx,other.id,first.alerts[0].id)).rejects.toMatchObject({status:404});await expect(acknowledgeCloudflareSuppressionAlert(ctx,other.id,first.alerts[0].id,{expectedVersion:1})).rejects.toMatchObject({code:'alert_changed'});
  const missing={...ctx,env:{...env,EMAIL_SUPPRESSIONS_API_TOKEN:undefined}};expect((await listCloudflareSuppressionAlerts(missing,box.id)).alerts).toHaveLength(2);
  const token={...ctx,actor:{kind:'token' as const,mailboxId:box.id,tokenId:crypto.randomUUID(),canRead:true,canSend:true}};await expect(listCloudflareSuppressionAlerts(token,box.id)).rejects.toMatchObject({code:'owner_required'});
  const json=JSON.stringify((await env.DB.prepare('SELECT payload_json FROM events').all()).results);expect(json).not.toContain('recipient@example.net');expect(json).not.toContain('raw secret');
  expect(await projectCloudflareSuppressionAlerts({...env,EMAIL_SUPPRESSIONS_ACCOUNT_ID:undefined})).toEqual({suppressionAlertsProjected:0});
});

it('bounds journal projection and preserves an atomic cursor when another projector wins the same rows',async()=>{
  const box=await mailbox();for(let i=0;i<30;i++)await run(box.id);
  const result=await project();expect(result.suppressionAlertsProjected).toBe(50);expect((await listCloudflareSuppressionAlerts(ctx,box.id)).summary.open).toBe(25);
  await Promise.all([project(),project()]);expect((await listCloudflareSuppressionAlerts(ctx,box.id)).summary.open).toBe(30);expect((await env.DB.prepare('SELECT id FROM events').all()).results).toHaveLength(30);
});

it('marks pre-upgrade history consumed without sending old failures, then projects only new journal rows',async()=>{
  const old=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("old");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'alert-upgrade'},r2Buckets:{MAIL_BLOBS:'alert-upgrade'},log:new Log(LogLevel.ERROR)}));
  try{
    const db=await old.getD1Database('DB');await db.batch([...migrations.entries()].filter(([name])=>name<'0011').flatMap(([,queries])=>queries).map(query=>db.prepare(query)));
    const target={...env,DB:db,MAIL_BLOBS:await old.getR2Bucket('MAIL_BLOBS')} as unknown as RuntimeEnv,owner={...ctx,env:target},box=await createMailbox(owner,{name:'Old',localPart:'old-alert'});
    await run(box.id,'failed',undefined,'cloudflare_api_unavailable',target);await db.batch(migrations.get('0011_cloudflare_suppression_alerts.sql')!.map(query=>db.prepare(query)));
    expect(await projectCloudflareSuppressionAlerts(target)).toEqual({suppressionAlertsProjected:0});expect((await listCloudflareSuppressionAlerts(owner,box.id)).alerts).toHaveLength(0);
    await run(box.id,'failed',undefined,'cloudflare_api_unavailable',target);await projectCloudflareSuppressionAlerts(target);expect((await listCloudflareSuppressionAlerts(owner,box.id)).alerts).toHaveLength(1);
  }finally{await old.dispose();}
});
