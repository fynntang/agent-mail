import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {getCloudflareSuppressionHistory,listCloudflareSuppressionHistory,listCloudflareSuppressions,reconcileCloudflareSuppression,releaseCloudflareSuppression,retryCloudflareSuppression,runCloudflareSuppressionSync,syncCloudflareSuppressions,type CloudflareSuppressionOptions} from '../../src/lib/server/core/cloudflare-suppressions';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,migrations:string[],at:number;
const account='a'.repeat(32),domain='agent.example.com';
beforeAll(async()=>{migrations=[];for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())migrations.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'suppression-history'},r2Buckets:{MAIL_BLOBS:'suppression-history'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(migrations.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:domain,EMAIL_SUPPRESSIONS_ACCOUNT_ID:account,EMAIL_SUPPRESSIONS_DOMAIN:domain,EMAIL_SUPPRESSIONS_API_TOKEN:'fake_cf_history_token_1234567890'} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now();
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);
const mailbox=()=>createMailbox(ctx,{name:'History',localPart:`history-${crypto.randomUUID()}`});
function provider(){return {id:crypto.randomUUID(),email:'recipient@example.net',reason:'manual',read_only:false,scope:{type:'account'},created_at:new Date(at-1000).toISOString(),expires_at:null};}
type Provider=ReturnType<typeof provider>;
const response=(result:unknown,info?:unknown)=>new Response(JSON.stringify({success:true,errors:[],result,...(info?{result_info:info}:{})}),{headers:{'Content-Type':'application/json'}});
function options(fetcher:(url:URL,init:RequestInit)=>Response|Promise<Response>):CloudflareSuppressionOptions{return {now:()=>at,fetcher:((url:RequestInfo|URL,init?:RequestInit)=>fetcher(new URL(String(url)),init??{})) as typeof fetch};}
const snapshot=(rows:Provider[])=>options(url=>{const values=url.searchParams.get('scope_type')==='account'?rows:[];return response(values,{count:values.length,next_cursor:null});});
async function seed(box:string,row:Provider){await syncCloudflareSuppressions(ctx,box,snapshot([row]));return (await listCloudflareSuppressions(ctx,box)).suppressions[0];}
async function unknown(box:string,row:Provider){const cached=await seed(box,row),input={clientRequestId:crypto.randomUUID(),expectedVersion:cached.version,confirmationAddress:row.email,confirmationScope:'account'};
  const result=await releaseCloudflareSuppression(ctx,box,row.id,input,options((_url,init)=>init.method==='DELETE'?new Response('never store provider error or secret',{status:503}):response(row)));
  expect(result.remoteStatus).toBe('unknown');return {id:result.operationId,cached,input};
}

it('journals failed Owner syncs, replays one command without network, and links an explicit new retry',async()=>{
  const box=await mailbox(),clientRequestId=crypto.randomUUID();let requests=0;
  await expect(syncCloudflareSuppressions(ctx,box.id,options(()=>{requests++;return new Response('confidential SMTP or token',{status:500});}),{clientRequestId})).rejects.toMatchObject({status:502});
  const history=await listCloudflareSuppressionHistory(ctx,box.id,{kind:'sync'});expect(history.history[0]).toMatchObject({id:clientRequestId,state:'failed',errorCode:'cloudflare_api_unavailable',canRetry:true,source:'owner'});
  const replay=await syncCloudflareSuppressions(ctx,box.id,options(()=>{throw Error('must not call');}),{clientRequestId});expect(replay).toMatchObject({runId:clientRequestId,state:'failed',synced:false});expect(requests).toBe(1);
  const retryId=crypto.randomUUID(),retried=await retryCloudflareSuppression(ctx,box.id,clientRequestId,{kind:'sync',clientRequestId:retryId},snapshot([]));expect(retried).toMatchObject({runId:retryId,state:'succeeded'});
  expect((await getCloudflareSuppressionHistory(ctx,box.id,retryId,{kind:'sync'})).item).toMatchObject({retryOf:clientRequestId,canRetry:false});
  const detail=await getCloudflareSuppressionHistory(ctx,box.id,clientRequestId,{kind:'sync'});expect(detail.timeline.map(event=>event.action)).toEqual(['sync.started','sync.completed']);expect(detail.timeline[1].errorCode).toBe('cloudflare_api_unavailable');expect(JSON.stringify(detail)).not.toContain('confidential');
  await expect(retryCloudflareSuppression(ctx,box.id,retryId,{kind:'sync',clientRequestId:crypto.randomUUID()},snapshot([]))).rejects.toMatchObject({code:'cloudflare_operation_not_retryable'});
});

it('paginates history within public identity and mailbox scope, remains readable without secrets, and performs no recovery writes on GET',async()=>{
  const box=await mailbox(),other=await mailbox();for(let i=0;i<3;i++)await syncCloudflareSuppressions(ctx,box.id,snapshot([]));
  const first=await listCloudflareSuppressionHistory(ctx,box.id,{kind:'sync',limit:1}),second=await listCloudflareSuppressionHistory(ctx,box.id,{kind:'sync',limit:1,cursor:first.nextCursor!});expect(first.history[0].id).not.toBe(second.history[0].id);
  await expect(listCloudflareSuppressionHistory(ctx,other.id,{kind:'sync',limit:1,cursor:first.nextCursor!})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(getCloudflareSuppressionHistory(ctx,other.id,first.history[0].id,{kind:'sync'})).rejects.toMatchObject({status:404});
  const runId=crypto.randomUUID();await env.DB.prepare("INSERT INTO cloudflare_suppression_sync_runs(id,request_hash,account_id,domain,mailbox_id,source,state,started_at,lease_token,lease_until) VALUES(?,?,?,?,?,'owner','running',?,?,0)").bind(runId,'a'.repeat(64),account,domain,box.id,at-180000,'old').run();
  const before=await env.DB.prepare('SELECT COUNT(*) FROM cloudflare_suppression_history_events').first('COUNT(*)'),without={...ctx,env:{...env,EMAIL_SUPPRESSIONS_API_TOKEN:undefined}};
  expect((await getCloudflareSuppressionHistory(ctx,box.id,runId,{kind:'sync'})).item).toMatchObject({state:'running',canRetry:true});
  expect((await getCloudflareSuppressionHistory(without,box.id,runId,{kind:'sync'})).item).toMatchObject({state:'running',canRetry:false});
  expect(await env.DB.prepare('SELECT COUNT(*) FROM cloudflare_suppression_history_events').first('COUNT(*)')).toBe(before);
  expect(await listCloudflareSuppressionHistory({...ctx,env:{...env,EMAIL_SUPPRESSIONS_ACCOUNT_ID:undefined}},box.id)).toEqual({configured:false,history:[],nextCursor:null});
  await expect(retryCloudflareSuppression(without,box.id,runId,{kind:'sync',clientRequestId:crypto.randomUUID()},snapshot([]))).rejects.toMatchObject({status:503});
  await retryCloudflareSuppression(ctx,box.id,runId,{kind:'sync',clientRequestId:crypto.randomUUID()},snapshot([]));expect((await getCloudflareSuppressionHistory(ctx,box.id,runId,{kind:'sync'})).item.state).toBe('failed');
});

it('reconciles unknown outcomes with GET only, preserves grace and errors, and requires a fresh Owner intent for a linked retry',async()=>{
  const box=await mailbox(),row=provider(),op=await unknown(box.id,row),command=crypto.randomUUID();let gets=0;
  const lookup=options((_url,init)=>{expect(init.method).toBe('GET');gets++;return response(row);});
  expect((await reconcileCloudflareSuppression(ctx,box.id,op.id,{clientRequestId:command},lookup)).operation).toMatchObject({state:'unknown',canRetry:false});
  await reconcileCloudflareSuppression(ctx,box.id,op.id,{clientRequestId:command},lookup);expect(gets).toBe(1);
  await expect(retryCloudflareSuppression(ctx,box.id,op.id,{kind:'release',...op.input,clientRequestId:crypto.randomUUID()},lookup)).rejects.toMatchObject({code:'cloudflare_operation_not_retryable'});
  at+=120001;const verified=await reconcileCloudflareSuppression(ctx,box.id,op.id,{clientRequestId:crypto.randomUUID()},lookup);expect(verified.operation).toMatchObject({state:'failed',canRetry:true,current:{version:op.cached.version}});
  const retryId=crypto.randomUUID(),retryInput={kind:'release',...op.input,clientRequestId:retryId};let deletes=0;
  const sending=options((_url,init)=>{if(init.method==='DELETE'){deletes++;return response({id:row.id});}return response(row);});
  expect(await retryCloudflareSuppression(ctx,box.id,op.id,retryInput,sending)).toMatchObject({operationId:retryId,remoteStatus:'deleted'});
  expect(await retryCloudflareSuppression(ctx,box.id,op.id,retryInput,sending)).toMatchObject({operationId:retryId,remoteStatus:'deleted'});expect(deletes).toBe(1);
  expect((await getCloudflareSuppressionHistory(ctx,box.id,retryId,{kind:'release'})).item).toMatchObject({retryOf:op.id,canRetry:false,canReconcile:false});
  const detail=await getCloudflareSuppressionHistory(ctx,box.id,op.id,{kind:'release'});expect(detail.timeline.some(event=>event.errorCode==='cloudflare_delete_unknown')).toBe(true);expect(detail.timeline.filter(event=>event.action==='reconcile.started')).toHaveLength(2);
});

it('confirms absent remote state without clearing any local evidence, even when the original intent requested local release',async()=>{
  const box=await mailbox(),row=provider(),cached=await seed(box.id,row),localId=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO recipient_suppressions(id,mailbox_id,address,status,reason,version,last_event_at,last_event_id,created_at,updated_at) VALUES(?,?,?,'active','complaint',1,?,'event',?,?)").bind(localId,box.id,row.email,at,at,at).run();
  const input={clientRequestId:crypto.randomUUID(),expectedVersion:cached.version,confirmationAddress:row.email,confirmationScope:'account',releaseLocal:true,expectedLocalVersion:1};
  const op=await releaseCloudflareSuppression(ctx,box.id,row.id,input,options((_url,init)=>init.method==='DELETE'?new Response(null,{status:500}):response(row)));
  const result=await reconcileCloudflareSuppression(ctx,box.id,op.operationId,{clientRequestId:crypto.randomUUID()},options((_url,init)=>{expect(init.method).toBe('GET');return new Response(null,{status:404});}));
  expect(result.operation).toMatchObject({state:'confirmed_absent',remoteStatus:'already_absent',localStatus:'changed',canRetry:false});expect(await env.DB.prepare('SELECT status,version FROM recipient_suppressions WHERE id=?').bind(localId).first()).toEqual({status:'active',version:1});
});

it('blocks readonly and identity changes after verification and journals failed reconciliation without losing the original unknown error',async()=>{
  const box=await mailbox(),row=provider(),op=await unknown(box.id,row);at+=120001;
  await expect(reconcileCloudflareSuppression(ctx,box.id,op.id,{clientRequestId:crypto.randomUUID()},options(()=>response({...row,email:'unrelated@example.net'})))).rejects.toMatchObject({code:'cloudflare_suppression_changed'});
  const verified=await reconcileCloudflareSuppression(ctx,box.id,op.id,{clientRequestId:crypto.randomUUID()},options(()=>response({...row,read_only:true})));
  expect(verified.operation).toMatchObject({state:'failed',canRetry:false,current:{readOnly:true}});
  await expect(retryCloudflareSuppression(ctx,box.id,op.id,{kind:'release',...op.input,clientRequestId:crypto.randomUUID()},options(()=>{throw Error('must not fetch');}))).rejects.toMatchObject({code:'cloudflare_operation_not_retryable'});
  const detail=await getCloudflareSuppressionHistory(ctx,box.id,op.id,{kind:'release'});expect(detail.timeline.some(event=>event.errorCode==='cloudflare_suppression_changed')).toBe(true);expect(detail.timeline.some(event=>event.errorCode==='cloudflare_delete_unknown')).toBe(true);
});

it('recovers a crashed DELETE before explicit reconciliation, rejects live leases, and scopes reconciliation identities in D1',async()=>{
  const box=await mailbox(),other=await mailbox(),row=provider(),cached=await seed(box.id,row),id=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO cloudflare_suppression_operations(id,request_hash,account_id,domain,mailbox_id,remote_id,address,scope_type,scope_value,version_hash,release_local,state,remote_status,local_status,lease_token,lease_until,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'account','',?,0,'deleting','in_progress','not_requested','crashed',0,?,?)`).bind(id,'a'.repeat(64),account,domain,box.id,row.id,row.email,cached.version,at-180000,at-180000).run();
  expect((await getCloudflareSuppressionHistory(ctx,box.id,id,{kind:'release'})).item).toMatchObject({state:'deleting',canReconcile:true});
  await expect(env.DB.prepare("INSERT INTO cloudflare_suppression_reconciliations(id,request_hash,operation_id,account_id,domain,mailbox_id,state,started_at) VALUES(?,?,?,?,?,?,'running',?)").bind(crypto.randomUUID(),'b'.repeat(64),id,account,domain,other.id,at).run()).rejects.toThrow();
  const result=await reconcileCloudflareSuppression(ctx,box.id,id,{clientRequestId:crypto.randomUUID()},options((_url,init)=>{expect(init.method).toBe('GET');return response(row);}));expect(result.operation.state).toBe('unknown');
  const detail=await getCloudflareSuppressionHistory(ctx,box.id,id,{kind:'release'});expect(detail.timeline.some(event=>event.errorCode==='operation_lease_expired')).toBe(true);
  await expect(env.DB.prepare('DELETE FROM cloudflare_suppression_history_events WHERE resource_id=?').bind(id).run()).rejects.toThrow('append only');
});

it('records scheduled sync attempts and exposes them to the Owner while denying all history to tokens',async()=>{
  const box=await mailbox();expect(await runCloudflareSuppressionSync(env,snapshot([]))).toEqual({cloudflareSuppressionsSynced:1});
  const result=await listCloudflareSuppressionHistory(ctx,box.id,{kind:'sync'});expect(result.history[0]).toMatchObject({source:'scheduled',state:'succeeded'});
  const token={...ctx,actor:{kind:'token' as const,mailboxId:box.id,tokenId:crypto.randomUUID(),canRead:true,canSend:true}};
  await expect(listCloudflareSuppressionHistory(token,box.id)).rejects.toMatchObject({code:'owner_required'});await expect(getCloudflareSuppressionHistory(token,box.id,result.history[0].id)).rejects.toMatchObject({code:'owner_required'});
  expect(await runCloudflareSuppressionSync(env,snapshot([]))).toEqual({cloudflareSuppressionsSynced:0});expect((await listCloudflareSuppressionHistory(ctx,box.id,{kind:'sync'})).history).toHaveLength(1);
});
