import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {cloudflareSuppressionConfig,listCloudflareSuppressions,releaseCloudflareSuppression,runCloudflareSuppressionSync,syncCloudflareSuppressions,type CloudflareSuppressionOptions} from '../../src/lib/server/core/cloudflare-suppressions';
import type {CloudflareSuppression} from '../../src/lib/types/cloudflare-suppressions';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,migrations:string[],at:number;
const account='a'.repeat(32),domain='agent.example.com';
beforeAll(async()=>{migrations=[];for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())migrations.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'cloudflare-suppression-core'},r2Buckets:{MAIL_BLOBS:'cloudflare-suppression-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(migrations.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:domain,EMAIL_SUPPRESSIONS_ACCOUNT_ID:account,EMAIL_SUPPRESSIONS_DOMAIN:domain,EMAIL_SUPPRESSIONS_API_TOKEN:'fake_cf_suppressions_token_1234567890'} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now();
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);
const mailbox=()=>createMailbox(ctx,{name:'Provider suppression',localPart:`provider-${crypto.randomUUID()}`});
function provider(email='recipient@example.net',type:'account'|'sending_domain'='account') {
  return {id:crypto.randomUUID(),email,reason:'manual',read_only:false,scope:type==='account'?{type}:{type,value:domain},created_at:new Date(at-1000).toISOString(),expires_at:null};
}
type Provider=ReturnType<typeof provider>;
const response=(result:unknown,info?:unknown)=>new Response(JSON.stringify({success:true,errors:[],result,...(info?{result_info:info}:{})}),{headers:{'Content-Type':'application/json'}});
const page=(rows:Provider[],next:string|null=null)=>response(rows,{count:rows.length,next_cursor:next});
function options(fetcher:(url:URL,init:RequestInit)=>Response|Promise<Response>):CloudflareSuppressionOptions {
  return {now:()=>at,fetcher:((url:RequestInfo|URL,init?:RequestInit)=>fetcher(new URL(String(url)),init??{})) as typeof fetch};
}
function snapshot(rows:Provider[]):CloudflareSuppressionOptions {
  return options(url=>page(rows.filter(row=>row.scope.type===url.searchParams.get('scope_type'))));
}
async function seedLocal(box:string,address='recipient@example.net') {
  const id=crypto.randomUUID();await env.DB.prepare(`INSERT INTO recipient_suppressions(id,mailbox_id,address,status,reason,version,last_event_at,last_event_id,created_at,updated_at)
    VALUES(?,?,?,'active','hard_bounce',1,?,?,?,?)`).bind(id,box,address,at-1000,'safe-event',at-1000,at-1000).run();return id;
}
async function cached(box:string,id:string) {return (await listCloudflareSuppressions(ctx,box)).suppressions.find(row=>row.id===id)!;}
function intent(row:CloudflareSuppression,localVersion?:number) {
  return {clientRequestId:crypto.randomUUID(),expectedVersion:row.version,confirmationAddress:row.address,confirmationScope:row.scope.type==='account'?'account':row.scope.value,
    ...(localVersion?{releaseLocal:true,expectedLocalVersion:localVersion}:{})};
}

it('publishes complete cursor pages from both explicit scopes and paginates a mailbox-scoped, locally enriched cache',async()=>{
  const box=await mailbox(),rows=[provider('a@example.net'),provider('b@example.net'),provider('c@example.net','sending_domain')];await seedLocal(box.id,'a@example.net');const requests:string[]=[];
  const result=await syncCloudflareSuppressions(ctx,box.id,options((url,init)=>{
    requests.push(url.toString());expect(url.origin).toBe('https://api.cloudflare.com');expect(url.pathname).toBe(`/client/v4/accounts/${account}/email/sending/suppressions`);
    expect(init.redirect).toBe('manual');expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${env.EMAIL_SUPPRESSIONS_API_TOKEN}`);expect(new Headers(init.headers).get('Cookie')).toBeNull();
    expect(url.searchParams.get('per_page')).toBe('100');
    if(url.searchParams.get('scope_type')==='sending_domain'){expect(url.searchParams.get('scope_value')).toBe(domain);return page([rows[2]]);}
    return url.searchParams.has('cursor')?page([rows[1]]):page([rows[0]],'opaque-next');
  }));
  expect(result).toMatchObject({synced:true,count:3,syncedAt:at});expect(requests).toHaveLength(3);expect(cloudflareSuppressionConfig(env)).toEqual({accountId:account,domain});
  const first=await listCloudflareSuppressions(ctx,box.id,{limit:1}),second=await listCloudflareSuppressions(ctx,box.id,{limit:1,cursor:first.nextCursor!});
  expect(first.suppressions[0].id).not.toBe(second.suppressions[0].id);expect((await cached(box.id,rows[0].id)).localSuppression).toMatchObject({version:1,status:'active'});
  const other=await mailbox();await expect(listCloudflareSuppressions(ctx,other.id,{limit:1,cursor:first.nextCursor!})).rejects.toMatchObject({code:'invalid_cursor'});
  expect((await cached(other.id,rows[0].id)).localSuppression).toBeNull();expect(JSON.stringify(first)).not.toContain(env.EMAIL_SUPPRESSIONS_API_TOKEN);
});

it('keeps the last complete snapshot on a failed later page, foreign scope, invalid schema, or looping cursor',async()=>{
  const box=await mailbox(),old=provider();await syncCloudflareSuppressions(ctx,box.id,snapshot([old]));
  const before=await env.DB.prepare('SELECT * FROM cloudflare_suppression_cache').first();
  for(const mode of ['failure','foreign','invalid','loop']) {
    const fetcher=options(url=>{
      if(mode==='foreign')return page([{...provider(),scope:{type:'sending_domain',value:'foreign.example.com'}}] as Provider[]);
      if(mode==='invalid')return response([{...provider(),read_only:'false'}],{count:1});
      if(mode==='loop')return page([], 'repeated');
      return url.searchParams.has('cursor')?new Response('upstream confidential body',{status:500}):page([provider()], 'following');
    });
    await expect(syncCloudflareSuppressions(ctx,box.id,fetcher)).rejects.toMatchObject({status:502});
    expect(await env.DB.prepare('SELECT * FROM cloudflare_suppression_cache').first()).toEqual(before);
  }
  expect((await listCloudflareSuppressions(ctx,box.id)).sync?.lastErrorCode).toBe('cloudflare_api_invalid_response');
});

it('leaves optional synchronization disabled without credentials and denies non-Owner access and unrelated sender domains',async()=>{
  const box=await mailbox();let calls=0;const off={...env,EMAIL_SUPPRESSIONS_API_TOKEN:undefined};
  expect(await runCloudflareSuppressionSync(off,options(()=>{calls++;return page([]);}))).toEqual({cloudflareSuppressionsSynced:0});expect(calls).toBe(0);
  expect(await listCloudflareSuppressions({...ctx,env:off},box.id)).toEqual({configured:false,suppressions:[],nextCursor:null,sync:null});
  const token={...ctx,actor:{kind:'token' as const,mailboxId:box.id,tokenId:crypto.randomUUID(),canRead:true,canSend:true}};
  await expect(syncCloudflareSuppressions(token,box.id,snapshot([]))).rejects.toMatchObject({code:'owner_required'});
  await expect(listCloudflareSuppressions(token,box.id)).rejects.toMatchObject({code:'owner_required'});
  await expect(syncCloudflareSuppressions({...ctx,env:{...env,EMAIL_SUPPRESSIONS_DOMAIN:'other.example.com'}},box.id,snapshot([]))).rejects.toMatchObject({code:'cloudflare_suppression_domain_mismatch'});
});

it('freshly verifies readonly and identity before deleting, then makes an acknowledged release idempotent',async()=>{
  const box=await mailbox(),row=provider();await syncCloudflareSuppressions(ctx,box.id,snapshot([row]));const cachedRow=await cached(box.id,row.id);let deletes=0;
  await expect(releaseCloudflareSuppression(ctx,box.id,row.id,intent(cachedRow),options(()=>response({...row,read_only:true})))).rejects.toMatchObject({code:'cloudflare_suppression_read_only'});
  await expect(releaseCloudflareSuppression(ctx,box.id,row.id,intent(cachedRow),options(()=>response({...row,email:'changed@example.net'})))).rejects.toMatchObject({code:'cloudflare_suppression_changed'});
  const input=intent(cachedRow),fetcher=options((_url,init)=>{if(init.method==='DELETE'){deletes++;return response({id:row.id,scope:row.scope});}return response(row);});
  const released=await releaseCloudflareSuppression(ctx,box.id,row.id,input,fetcher);
  expect(released).toEqual({operationId:input.clientRequestId,remoteStatus:'deleted',localStatus:'not_requested'});expect(deletes).toBe(1);
  expect(await releaseCloudflareSuppression(ctx,box.id,row.id,input,options(()=>{throw Error('must not fetch');}))).toEqual(released);
  await expect(releaseCloudflareSuppression(ctx,box.id,row.id,{...input,confirmationAddress:'other@example.net'},fetcher)).rejects.toMatchObject({code:'cloudflare_operation_conflict'});
  expect((await listCloudflareSuppressions(ctx,box.id)).suppressions).toHaveLength(0);expect(deletes).toBe(1);
});

it('releases only the explicitly selected mailbox local version and reports newer local evidence separately from remote success',async()=>{
  const box=await mailbox(),other=await mailbox(),one=provider(),two=provider('second@example.net');
  const local=await seedLocal(box.id),foreign=await seedLocal(other.id),second=await seedLocal(box.id,two.email);await syncCloudflareSuppressions(ctx,box.id,snapshot([one,two]));
  const result=await releaseCloudflareSuppression(ctx,box.id,one.id,intent(await cached(box.id,one.id),1),options((_url,init)=>response(init.method==='DELETE'?{id:one.id}:one)));
  expect(result).toMatchObject({remoteStatus:'deleted',localStatus:'released'});expect(await env.DB.prepare('SELECT status,version FROM recipient_suppressions WHERE id=?').bind(local).first()).toEqual({status:'released',version:2});
  expect(await env.DB.prepare('SELECT status,version FROM recipient_suppressions WHERE id=?').bind(foreign).first()).toEqual({status:'active',version:1});
  const raced=await releaseCloudflareSuppression(ctx,box.id,two.id,intent(await cached(box.id,two.id),1),options(async(_url,init)=>{
    if(init.method==='DELETE'){await env.DB.prepare("UPDATE recipient_suppressions SET reason='complaint',version=version+1,last_event_at=?,last_event_id='new-evidence',updated_at=? WHERE id=?").bind(at+1,at+1,second).run();return response({id:two.id});}return response(two);
  }));
  expect(raced).toMatchObject({remoteStatus:'deleted',localStatus:'changed'});expect(await env.DB.prepare('SELECT status,reason,version FROM recipient_suppressions WHERE id=?').bind(second).first()).toEqual({status:'active',reason:'complaint',version:2});
});

it('records an ambiguous DELETE without retries, preserves local evidence, and confirms absence only from a complete snapshot',async()=>{
  const box=await mailbox(),row=provider(),local=await seedLocal(box.id);await syncCloudflareSuppressions(ctx,box.id,snapshot([row]));const input=intent(await cached(box.id,row.id),1);let deletes=0;
  const fetcher=options((_url,init)=>{if(init.method==='DELETE'){deletes++;return new Response('private provider failure',{status:503});}return response(row);});
  expect(await releaseCloudflareSuppression(ctx,box.id,row.id,input,fetcher)).toMatchObject({remoteStatus:'unknown',localStatus:'pending',errorCode:'cloudflare_delete_unknown'});
  expect(await releaseCloudflareSuppression(ctx,box.id,row.id,input,fetcher)).toMatchObject({remoteStatus:'unknown'});expect(deletes).toBe(1);
  await expect(releaseCloudflareSuppression(ctx,box.id,row.id,{...input,clientRequestId:crypto.randomUUID(),releaseLocal:undefined,expectedLocalVersion:undefined},fetcher)).rejects.toMatchObject({code:'cloudflare_operation_pending'});
  await syncCloudflareSuppressions(ctx,box.id,snapshot([row]));expect(await env.DB.prepare('SELECT state FROM cloudflare_suppression_operations WHERE id=?').bind(input.clientRequestId).first('state')).toBe('unknown');
  await syncCloudflareSuppressions(ctx,box.id,snapshot([]));
  expect(await releaseCloudflareSuppression(ctx,box.id,row.id,input,fetcher)).toMatchObject({remoteStatus:'already_absent',localStatus:'changed'});
  expect(await env.DB.prepare('SELECT status,version FROM recipient_suppressions WHERE id=?').bind(local).first()).toEqual({status:'active',version:1});expect(deletes).toBe(1);
});

it('bounds an uncooperative DELETE timeout and requires a later explicit intent after a grace-period present reconciliation',async()=>{
  const box=await mailbox(),row=provider();await syncCloudflareSuppressions(ctx,box.id,snapshot([row]));const cachedRow=await cached(box.id,row.id),input=intent(cachedRow);let deletes=0;
  const fetcher={...options((_url,init)=>{if(init.method==='DELETE'){deletes++;return new Promise<Response>(()=>{});}return response(row);}),timeoutMs:10};
  expect(await releaseCloudflareSuppression(ctx,box.id,row.id,input,fetcher)).toMatchObject({remoteStatus:'unknown'});expect(deletes).toBe(1);
  at+=120_001;await syncCloudflareSuppressions(ctx,box.id,snapshot([row]));expect(await env.DB.prepare('SELECT state FROM cloudflare_suppression_operations WHERE id=?').bind(input.clientRequestId).first('state')).toBe('failed');
  expect(await releaseCloudflareSuppression(ctx,box.id,row.id,input,fetcher)).toMatchObject({remoteStatus:'failed'});expect(deletes).toBe(1);
  expect(await releaseCloudflareSuppression(ctx,box.id,row.id,intent(cachedRow),options((_url,init)=>response(init.method==='DELETE'?{id:row.id}:row)))).toMatchObject({remoteStatus:'deleted'});
});

it('serializes sync and delete with a bounded shared lease and never allows an expired snapshot to replace current cache',async()=>{
  const box=await mailbox(),row=provider();await syncCloudflareSuppressions(ctx,box.id,snapshot([row]));const cachedRow=await cached(box.id,row.id);
  let unblock!:()=>void,reached!:()=>void;const blocked=new Promise<void>(resolve=>{unblock=resolve;}),ready=new Promise<void>(resolve=>{reached=resolve;});
  const syncing=syncCloudflareSuppressions(ctx,box.id,options(async url=>{reached();await blocked;return page(url.searchParams.get('scope_type')==='account'?[row]:[]);}));
  await ready;await expect(releaseCloudflareSuppression(ctx,box.id,row.id,intent(cachedRow),snapshot([]))).rejects.toMatchObject({code:'cloudflare_suppression_busy'});
  at+=120_001;unblock();await expect(syncing).rejects.toMatchObject({code:'cloudflare_api_timeout'});expect((await cached(box.id,row.id)).version).toBe(cachedRow.version);
  const result=await releaseCloudflareSuppression(ctx,box.id,row.id,intent(cachedRow),options((_url,init)=>response(init.method==='DELETE'?{id:row.id}:row)));expect(result.remoteStatus).toBe('deleted');
});
