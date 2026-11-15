import type {CloudflareSuppression,CloudflareSuppressionList,CloudflareSuppressionOperationResult,CloudflareSuppressionReason,CloudflareSuppressionHistoryItem,CloudflareSuppressionHistoryList,CloudflareSuppressionHistoryDetail,CloudflareSuppressionReleaseHistory} from '../../types/cloudflare-suppressions';
import {cloudflareSuppressionConfig,cloudflareSuppressionIdentity} from './cloudflare-suppression-config';
import {sha256} from './crypto';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {externalAddress,objectInput} from './outbound-content';
import {ServiceError,type RuntimeEnv} from './types';
export {cloudflareSuppressionConfig} from './cloudflare-suppression-config';

type Config=NonNullable<ReturnType<typeof cloudflareSuppressionConfig>>;
export interface CloudflareSuppressionOptions {fetcher?:typeof fetch;now?:()=>number;timeoutMs?:number}
interface Row {
  account_id:string;configured_domain:string;remote_id:string;address:string;scope_type:'account'|'sending_domain';scope_value:string;
  reason:CloudflareSuppressionReason;read_only:number;status:'active'|'absent';version_hash:string;expires_at:number|null;provider_created_at:number;seen_at:number;
}
interface Operation {
  id:string;request_hash:string;account_id:string;domain:string;mailbox_id:string;remote_id:string;address:string;scope_type:string;scope_value:string;version_hash:string;
  release_local:number;local_id:string|null;local_version:number|null;state:string;remote_status:CloudflareSuppressionOperationResult['remoteStatus'];
  local_status:CloudflareSuppressionOperationResult['localStatus'];lease_token:string|null;lease_until:number|null;created_at:number;updated_at:number;error_code:string|null;
  completed_at:number|null;retry_of:string|null;verified_at:number|null;verified_read_only:number|null;verified_version:string|null;
}
interface SyncRun {id:string;request_hash:string;account_id:string;domain:string;mailbox_id:string|null;source:'owner'|'scheduled';retry_of:string|null;state:'running'|'succeeded'|'failed';count:number|null;error_code:string|null;started_at:number;completed_at:number|null;lease_until:number|null}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasons=['manual','complaint','hard_bounce','soft_bounce','policy'];
const encoder=new TextEncoder(),LEASE=120_000,UNKNOWN_GRACE=120_000,INTERVAL=15*60_000;
const sql=(env:RuntimeEnv,query:string,...args:(string|number|null)[])=>env.DB.prepare(query).bind(...args);
const clock=(options:CloudflareSuppressionOptions)=>options.now??Date.now;
function configured(env:RuntimeEnv):Config {const value=cloudflareSuppressionConfig(env);if(!value)throw new ServiceError('cloudflare_suppressions_not_configured',503);return value;}
async function ownerBox(ctx:OwnerContext,box:string,config?:Config):Promise<void> {
  requireOwner(ctx.actor);const mailbox=await getMailbox(ctx,box);
  if(!['active','paused'].includes(mailbox.status))throw new ServiceError('not_found',404);
  if(config&&mailbox.address.split('@')[1]!==config.domain)throw new ServiceError('cloudflare_suppression_domain_mismatch',409);
}
function record(value:unknown):Record<string,unknown> {if(!value||typeof value!=='object'||Array.isArray(value))throw new ServiceError('cloudflare_api_invalid_response',502);return value as Record<string,unknown>;}
function timestamp(value:unknown,nullable=false):number|null {
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||value.length>64)throw new ServiceError('cloudflare_api_invalid_response',502);
  const result=Date.parse(value);if(!Number.isSafeInteger(result)||result<0)throw new ServiceError('cloudflare_api_invalid_response',502);return result;
}
function scope(value:unknown,config:Config):{scope_type:'account'|'sending_domain';scope_value:string} {
  const input=record(value);
  if(input.type==='account'&&input.value===undefined)return {scope_type:'account',scope_value:''};
  if(input.type==='sending_domain'&&input.value===config.domain)return {scope_type:'sending_domain',scope_value:config.domain};
  throw new ServiceError('cloudflare_api_scope_mismatch',502);
}
async function normalized(value:unknown,config:Config,expectedScope?:string):Promise<Row> {
  const input=record(value),scoped=scope(input.scope,config);
  if(typeof input.id!=='string'||!uuid.test(input.id)||typeof input.read_only!=='boolean'||typeof input.reason!=='string'||!reasons.includes(input.reason)
    ||expectedScope!==undefined&&scoped.scope_type!==expectedScope)throw new ServiceError('cloudflare_api_invalid_response',502);
  let address:string;try{address=externalAddress(input.email);}catch{throw new ServiceError('cloudflare_api_invalid_response',502);}
  const identity={remote_id:input.id.toLowerCase(),address,...scoped,reason:input.reason as CloudflareSuppressionReason,read_only:input.read_only?1:0,
    expires_at:timestamp(input.expires_at,true),provider_created_at:timestamp(input.created_at)!};
  return {account_id:config.accountId,configured_domain:config.domain,...identity,status:'active',version_hash:await sha256(JSON.stringify(identity)),seen_at:0};
}
function envelope(value:unknown):Record<string,unknown> {
  const input=record(value);if(input.success!==true||input.errors!==undefined&&(!Array.isArray(input.errors)||input.errors.length))throw new ServiceError('cloudflare_api_invalid_response',502);return input;
}
function cancel(response:Response):void {void response.body?.cancel().catch(()=>{});}
/** Fixed Cloudflare API origin; credentials never come from request headers or appear in diagnostics. */
async function api(env:RuntimeEnv,config:Config,path:string,method:'GET'|'DELETE',options:CloudflareSuppressionOptions,allow404=false):Promise<{status:number;body:unknown}> {
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>,response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const work=async()=>{
    response=await (options.fetcher??fetch)(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/suppressions${path}`,{
      method,redirect:'manual',cache:'no-store',signal:controller.signal,headers:{Authorization:`Bearer ${env.EMAIL_SUPPRESSIONS_API_TOKEN!}`,Accept:'application/json'}});
    if(controller.signal.aborted){cancel(response);throw new ServiceError('cloudflare_api_timeout',504);}
    if(allow404&&response.status===404){cancel(response);return {status:404,body:null};}
    if(response.status<200||response.status>299){cancel(response);return {status:response.status,body:null};}
    if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type')??'')||!response.body)throw new ServiceError('cloudflare_api_invalid_response',502);
    const declared=response.headers.get('Content-Length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>1024*1024))throw new ServiceError('cloudflare_api_invalid_response',502);
    reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
    while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>1024*1024)throw new ServiceError('cloudflare_api_invalid_response',502);chunks.push(item.value);}
    const data=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
    try{return {status:response.status,body:JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(data)) as unknown};}
    catch{throw new ServiceError('cloudflare_api_invalid_response',502);}
  };
  try{return await Promise.race([work(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ServiceError('cloudflare_api_timeout',504));},options.timeoutMs??10_000);})]);}
  catch(error){if(error instanceof ServiceError)throw error;throw new ServiceError('cloudflare_api_unavailable',502);}
  finally{clearTimeout(timer!);controller.abort();if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}else if(response)cancel(response);}
}
async function recover(env:RuntimeEnv,config:Config,now:number):Promise<void> {
  await env.DB.batch([
    sql(env,"UPDATE cloudflare_suppression_sync_runs SET state='failed',error_code='operation_lease_expired',completed_at=?,lease_token=NULL,lease_until=NULL WHERE account_id=? AND domain=? AND state='running' AND lease_until<=?",now,config.accountId,config.domain,now),
    sql(env,"UPDATE cloudflare_suppression_reconciliations SET state='failed',error_code='operation_lease_expired',completed_at=?,lease_token=NULL,lease_until=NULL WHERE account_id=? AND domain=? AND state='running' AND lease_until<=?",now,config.accountId,config.domain,now)
  ]);
  await sql(env,`UPDATE cloudflare_suppression_operations SET state=CASE WHEN state='deleting' THEN 'unknown' ELSE 'failed' END,
    remote_status=CASE WHEN state='deleting' THEN 'unknown' ELSE 'failed' END,local_status=CASE WHEN release_local=1 THEN 'pending' ELSE 'not_requested' END,
    lease_token=NULL,lease_until=NULL,updated_at=MAX(updated_at,?),completed_at=CASE WHEN state='deleting' THEN NULL ELSE ? END,error_code='operation_lease_expired'
    WHERE account_id=? AND domain=? AND state IN('preparing','deleting') AND lease_until<=?`,now,now,config.accountId,config.domain,now).run();
}
async function lock(env:RuntimeEnv,config:Config,now:number):Promise<string> {
  await recover(env,config,now);const token=crypto.randomUUID();
  const results=await env.DB.batch([
    sql(env,'INSERT INTO cloudflare_suppression_sync(account_id,domain) VALUES(?,?) ON CONFLICT(account_id,domain) DO NOTHING',config.accountId,config.domain),
    sql(env,'UPDATE cloudflare_suppression_sync SET lease_token=?,lease_until=? WHERE account_id=? AND domain=? AND(lease_until IS NULL OR lease_until<=?)',token,now+LEASE,config.accountId,config.domain,now)
  ]);
  if(results[1].meta.changes!==1)throw new ServiceError('cloudflare_suppression_busy',409);return token;
}
async function unlock(env:RuntimeEnv,config:Config,token:string):Promise<void> {
  await sql(env,'UPDATE cloudflare_suppression_sync SET lease_token=NULL,lease_until=NULL WHERE account_id=? AND domain=? AND lease_token=?',config.accountId,config.domain,token).run();
}
function live(config:Config,token:string,now:number):{query:string;args:(string|number)[]} {
  return {query:'EXISTS(SELECT 1 FROM cloudflare_suppression_sync WHERE account_id=? AND domain=? AND lease_token=? AND lease_until>?)',args:[config.accountId,config.domain,token,now]};
}
async function sync(env:RuntimeEnv,options:CloudflareSuppressionOptions,runId:string):Promise<{synced:true;count:number;syncedAt:number}> {
  const config=configured(env),now=clock(options),token=await lock(env,config,now()),deadline=now()+90_000;
  await sql(env,'UPDATE cloudflare_suppression_sync SET last_attempt_at=? WHERE account_id=? AND domain=? AND lease_token=?',now(),config.accountId,config.domain,token).run();
  try {
    const rows:Row[]=[],ids=new Set<string>();
    for(const type of ['account','sending_domain']) {
      let cursor:string|undefined;const seenCursors=new Set<string>();
      for(let page=0;page<10;page++) {
        if(now()>deadline)throw new ServiceError('cloudflare_api_timeout',504);
        const query=new URLSearchParams({scope_type:type,per_page:'100'});if(type==='sending_domain')query.set('scope_value',config.domain);if(cursor)query.set('cursor',cursor);
        const response=await api(env,config,`?${query}`,'GET',options);if(response.status!==200)throw new ServiceError('cloudflare_api_unavailable',502);
        const body=envelope(response.body),info=record(body.result_info);
        if(!Array.isArray(body.result)||body.result.length>1000||info.count!==undefined&&(!Number.isSafeInteger(info.count)||info.count!==body.result.length))throw new ServiceError('cloudflare_api_invalid_response',502);
        for(const value of body.result){const row=await normalized(value,config,type);if(ids.has(row.remote_id))throw new ServiceError('cloudflare_api_invalid_response',502);ids.add(row.remote_id);rows.push(row);if(rows.length>1000)throw new ServiceError('cloudflare_suppression_sync_limit',503);}
        const next=info.next_cursor;if(next===null||next===undefined||next===''){cursor=undefined;break;}
        if(typeof next!=='string'||next.length>2048||seenCursors.has(next))throw new ServiceError('cloudflare_api_invalid_response',502);
        seenCursors.add(next);cursor=next;if(page===9)throw new ServiceError('cloudflare_suppression_sync_limit',503);
      }
    }
    const at=now(),generation=crypto.randomUUID(),guard=live(config,token,at),batch:D1PreparedStatement[]=[];
    batch.push(sql(env,`INSERT INTO cloudflare_suppression_cache(account_id,configured_domain,remote_id,address,scope_type,scope_value,reason,read_only,status,version_hash,expires_at,provider_created_at,seen_at,updated_at,last_sync_id)
      SELECT ?,?,json_extract(value,'$.remote_id'),json_extract(value,'$.address'),json_extract(value,'$.scope_type'),json_extract(value,'$.scope_value'),json_extract(value,'$.reason'),json_extract(value,'$.read_only'),'active',
      json_extract(value,'$.version_hash'),json_extract(value,'$.expires_at'),json_extract(value,'$.provider_created_at'),?,?,? FROM json_each(?) WHERE ${guard.query}
      ON CONFLICT(account_id,configured_domain,remote_id) DO UPDATE SET address=excluded.address,scope_type=excluded.scope_type,
      scope_value=excluded.scope_value,reason=excluded.reason,read_only=excluded.read_only,status='active',version_hash=excluded.version_hash,expires_at=excluded.expires_at,
      provider_created_at=excluded.provider_created_at,seen_at=excluded.seen_at,updated_at=excluded.updated_at,last_sync_id=excluded.last_sync_id`,
      config.accountId,config.domain,at,at,generation,JSON.stringify(rows),...guard.args));
    batch.push(sql(env,`UPDATE cloudflare_suppression_cache SET status='absent',updated_at=? WHERE account_id=? AND configured_domain=? AND last_sync_id<>? AND ${guard.query}`,at,config.accountId,config.domain,generation,...guard.args),
      sql(env,`UPDATE cloudflare_suppression_operations SET state=CASE WHEN EXISTS(SELECT 1 FROM cloudflare_suppression_cache c WHERE c.account_id=cloudflare_suppression_operations.account_id AND c.configured_domain=cloudflare_suppression_operations.domain AND c.remote_id=cloudflare_suppression_operations.remote_id AND c.status='active') THEN 'failed' ELSE 'confirmed_absent' END,
        remote_status=CASE WHEN EXISTS(SELECT 1 FROM cloudflare_suppression_cache c WHERE c.account_id=cloudflare_suppression_operations.account_id AND c.configured_domain=cloudflare_suppression_operations.domain AND c.remote_id=cloudflare_suppression_operations.remote_id AND c.status='active') THEN 'failed' ELSE 'already_absent' END,
        local_status=CASE WHEN release_local=1 THEN 'changed' ELSE 'not_requested' END,completed_at=?,updated_at=?,error_code=NULL
        WHERE account_id=? AND domain=? AND state='unknown' AND (COALESCE((SELECT MIN(h.occurred_at) FROM cloudflare_suppression_history_events h WHERE h.kind='release' AND h.resource_id=cloudflare_suppression_operations.id AND h.remote_status='unknown'),updated_at)<=? OR NOT EXISTS(SELECT 1 FROM cloudflare_suppression_cache c WHERE c.account_id=cloudflare_suppression_operations.account_id AND c.configured_domain=cloudflare_suppression_operations.domain AND c.remote_id=cloudflare_suppression_operations.remote_id AND c.status='active')) AND ${guard.query}`,at,at,config.accountId,config.domain,at-UNKNOWN_GRACE,...guard.args),
      sql(env,`UPDATE cloudflare_suppression_sync_runs SET state='succeeded',count=?,completed_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND state='running' AND ${guard.query}`,rows.length,at,runId,...guard.args),
      sql(env,`UPDATE cloudflare_suppression_sync SET last_success_at=?,last_error_code=NULL WHERE account_id=? AND domain=? AND lease_token=? AND lease_until>?`,at,config.accountId,config.domain,token,at));
    const results=await env.DB.batch(batch);if(results.at(-1)!.meta.changes!==1)throw new ServiceError('cloudflare_suppression_sync_expired',409);
    return {synced:true,count:rows.length,syncedAt:at};
  }catch(error){
    const code=error instanceof ServiceError?error.code:'cloudflare_api_unavailable';await sql(env,'UPDATE cloudflare_suppression_sync SET last_error_code=? WHERE account_id=? AND domain=? AND lease_token=?',code,config.accountId,config.domain,token).run();
    if(error instanceof ServiceError)throw error;throw new ServiceError('cloudflare_api_unavailable',502);
  }finally{await unlock(env,config,token);}
}
export async function syncCloudflareSuppressions(ctx:OwnerContext,box:string,options:CloudflareSuppressionOptions={},input:unknown={}) {
  await ownerBox(ctx,box);const config=configured(ctx.env);await ownerBox(ctx,box,config);
  const data=objectInput(input,['clientRequestId']);return trackedSync(ctx.env,box,'owner',data.clientRequestId,undefined,options);
}
export async function runCloudflareSuppressionSync(env:RuntimeEnv,options:CloudflareSuppressionOptions={}):Promise<{cloudflareSuppressionsSynced:number}> {
  const config=cloudflareSuppressionConfig(env);if(!config)return {cloudflareSuppressionsSynced:0};
  const row=await sql(env,'SELECT last_attempt_at FROM cloudflare_suppression_sync WHERE account_id=? AND domain=?',config.accountId,config.domain).first<{last_attempt_at:number|null}>();
  if(row?.last_attempt_at!==null&&row?.last_attempt_at!==undefined&&clock(options)()-row.last_attempt_at<INTERVAL)return {cloudflareSuppressionsSynced:0};
  try{await trackedSync(env,null,'scheduled',undefined,undefined,options);return {cloudflareSuppressionsSynced:1};}catch{return {cloudflareSuppressionsSynced:0};}
}
export async function listCloudflareSuppressions(ctx:OwnerContext,box:string,query:{limit?:unknown;cursor?:unknown}={}):Promise<CloudflareSuppressionList> {
  await ownerBox(ctx,box);objectInput(query,['limit','cursor']);const config=cloudflareSuppressionConfig(ctx.env);
  if(!config)return {configured:false,suppressions:[],nextCursor:null,sync:null};await ownerBox(ctx,box,config);
  const limit=query.limit===undefined?20:Number(query.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_query',400);
  let after:string|null=null;
  if(query.cursor!==undefined){try{
    if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw new Error();const value=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));
    if(!value||Object.keys(value).length!==6||value.v!==1||value.account!==config.accountId||value.domain!==config.domain||value.box!==box||value.limit!==limit||typeof value.id!=='string'||!uuid.test(value.id))throw new Error();after=value.id;
  }catch{throw new ServiceError('invalid_cursor',400);}}
  const {results}=await sql(ctx.env,`SELECT * FROM cloudflare_suppression_cache WHERE account_id=? AND configured_domain=? AND status='active' ${after?'AND remote_id>?':''} ORDER BY remote_id LIMIT ?`,
    config.accountId,config.domain,...(after?[after]:[]),limit+1).all<Row>();
  const page=results.slice(0,limit),requested=[...new Set(page.map(row=>row.address))];
  const local=requested.length?(await sql(ctx.env,`SELECT id,address,version,status,reason FROM recipient_suppressions WHERE mailbox_id=? AND address IN(${requested.map(()=>'?').join(',')})`,box,...requested)
    .all<{id:string;address:string;version:number;status:'active'|'released';reason:'hard_bounce'|'complaint'}>()).results:[];
  const byAddress=new Map(local.map(row=>[row.address,row]));
  const suppressions:CloudflareSuppression[]=page.map(row=>{
    const item=byAddress.get(row.address);return {id:row.remote_id,address:row.address,reason:row.reason,scope:row.scope_type==='account'?{type:'account'}:{type:'sending_domain',value:row.scope_value},readOnly:row.read_only===1,status:row.status,
      version:row.version_hash,expiresAt:row.expires_at,providerCreatedAt:row.provider_created_at,seenAt:row.seen_at,localSuppression:item?{id:item.id,version:item.version,status:item.status,reason:item.reason}:null};
  });
  const state=await sql(ctx.env,'SELECT last_attempt_at,last_success_at,last_error_code FROM cloudflare_suppression_sync WHERE account_id=? AND domain=?',config.accountId,config.domain).first<{last_attempt_at:number|null;last_success_at:number|null;last_error_code:string|null}>();
  const nextCursor=results.length>limit?btoa(JSON.stringify({v:1,account:config.accountId,domain:config.domain,box,limit,id:page.at(-1)!.remote_id})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null;
  return {configured:true,suppressions,nextCursor,sync:state?{lastSuccessAt:state.last_success_at,lastAttemptAt:state.last_attempt_at,lastErrorCode:state.last_error_code}:null};
}
function operationDto(operation:Operation):CloudflareSuppressionOperationResult {
  return {operationId:operation.id,remoteStatus:operation.remote_status,localStatus:operation.local_status,...(operation.error_code?{errorCode:operation.error_code}:{})};
}
async function operation(env:RuntimeEnv,id:string):Promise<Operation> {return (await sql(env,'SELECT * FROM cloudflare_suppression_operations WHERE id=?',id).first<Operation>())!;}
async function failed(env:RuntimeEnv,op:Operation,token:string,at:number,unknown:boolean,code:string):Promise<CloudflareSuppressionOperationResult> {
  await sql(env,`UPDATE cloudflare_suppression_operations SET state=?,remote_status=?,local_status=?,lease_token=NULL,lease_until=NULL,updated_at=MAX(updated_at,?),completed_at=?,error_code=?
    WHERE id=? AND state IN('preparing','deleting') AND lease_token=? AND lease_until>?`,unknown?'unknown':'failed',unknown?'unknown':'failed',op.release_local?unknown?'pending':'changed':'not_requested',at,unknown?null:at,code,op.id,token,at).run();
  return operationDto(await operation(env,op.id));
}
async function finished(ctx:OwnerContext,config:Config,op:Operation,token:string,at:number,remote:'deleted'|'already_absent'):Promise<CloudflareSuppressionOperationResult> {
  const claim=crypto.randomUUID(),localClaim=crypto.randomUUID(),guard=live(config,token,at),owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  await ctx.env.DB.batch([
    sql(ctx.env,`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at) SELECT ?,?,'owner','cloudflare_suppression.released',?,'success',?,?
      WHERE EXISTS(SELECT 1 FROM cloudflare_suppression_operations WHERE id=? AND state IN('preparing','deleting') AND lease_token=? AND lease_until>?) AND ${guard.query}`,
      claim,op.mailbox_id,op.remote_id,ctx.requestId,at,op.id,token,at,...guard.args),
    sql(ctx.env,`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at) SELECT ?,?,'owner','recipient_suppression.released',?,'success',?,?
      WHERE ?=1 AND ${owned} AND EXISTS(SELECT 1 FROM recipient_suppressions s JOIN mailboxes m ON m.id=s.mailbox_id WHERE s.id=? AND s.mailbox_id=? AND s.address=? AND s.status='active' AND s.version=? AND m.status IN('active','paused'))`,
      localClaim,op.mailbox_id,op.local_id,ctx.requestId,at,op.release_local,claim,op.local_id,op.mailbox_id,op.address,op.local_version),
    sql(ctx.env,`UPDATE recipient_suppressions SET status='released',version=version+1,updated_at=MAX(updated_at+1,?),released_at=MAX(updated_at+1,?),release_watermark=MAX(release_watermark,last_event_at,updated_at+1,?) WHERE id=? AND mailbox_id=? AND ${owned}`,
      at,at,at,op.local_id,op.mailbox_id,localClaim),
    sql(ctx.env,`UPDATE cloudflare_suppression_cache SET status='absent',updated_at=? WHERE account_id=? AND configured_domain=? AND remote_id=? AND version_hash=? AND ${owned}`,
      at,config.accountId,config.domain,op.remote_id,op.version_hash,claim),
    sql(ctx.env,`UPDATE cloudflare_suppression_operations SET state='succeeded',remote_status=?,local_status=CASE WHEN release_local=0 THEN 'not_requested' WHEN ${owned} THEN 'released' ELSE 'changed' END,
      lease_token=NULL,lease_until=NULL,updated_at=MAX(updated_at,?),completed_at=?,error_code=NULL WHERE id=? AND ${owned}`,remote,localClaim,at,at,op.id,claim)
  ]);
  return operationDto(await operation(ctx.env,op.id));
}
export async function releaseCloudflareSuppression(ctx:OwnerContext,box:string,id:string,input:unknown,options:CloudflareSuppressionOptions={},retryOf?:string):Promise<CloudflareSuppressionOperationResult> {
  await ownerBox(ctx,box);const config=configured(ctx.env);await ownerBox(ctx,box,config);
  const data=objectInput(input,['clientRequestId','expectedVersion','confirmationAddress','confirmationScope','releaseLocal','expectedLocalVersion']);
  if(!uuid.test(id)||typeof data.clientRequestId!=='string'||!uuid.test(data.clientRequestId)||typeof data.expectedVersion!=='string'||!/^[0-9a-f]{64}$/.test(data.expectedVersion)
    ||typeof data.confirmationAddress!=='string'||typeof data.confirmationScope!=='string'||data.releaseLocal!==undefined&&typeof data.releaseLocal!=='boolean'
    ||data.releaseLocal===true&&(typeof data.expectedLocalVersion!=='number'||!Number.isSafeInteger(data.expectedLocalVersion)||data.expectedLocalVersion<1)
    ||data.releaseLocal!==true&&data.expectedLocalVersion!==undefined)throw new ServiceError('invalid_input',400);
  let address:string;try{address=externalAddress(data.confirmationAddress);}catch{throw new ServiceError('invalid_input',400);}
  id=id.toLowerCase();const requestId=data.clientRequestId.toLowerCase(),releaseLocal=data.releaseLocal===true;
  const hash=await sha256(JSON.stringify({account:config.accountId,domain:config.domain,box,id,version:data.expectedVersion,address,scope:data.confirmationScope,releaseLocal,localVersion:data.expectedLocalVersion??null,...(retryOf?{retryOf}:{})}));
  const existing=await sql(ctx.env,'SELECT * FROM cloudflare_suppression_operations WHERE id=?',requestId).first<Operation>();
  if(existing){if(existing.request_hash!==hash)throw new ServiceError('cloudflare_operation_conflict',409);return operationDto(existing);}
  const cached=await sql(ctx.env,'SELECT * FROM cloudflare_suppression_cache WHERE account_id=? AND configured_domain=? AND remote_id=?',config.accountId,config.domain,id).first<Row>();
  if(!cached)throw new ServiceError('not_found',404);
  if(cached.version_hash!==data.expectedVersion||cached.address!==address||data.confirmationScope!==(cached.scope_type==='account'?'account':cached.scope_value))throw new ServiceError('cloudflare_suppression_changed',409);
  if(cached.read_only===1)throw new ServiceError('cloudflare_suppression_read_only',409);
  let local:{id:string;version:number;status:string}|null=null;
  if(releaseLocal){local=await sql(ctx.env,'SELECT id,version,status FROM recipient_suppressions WHERE mailbox_id=? AND address=?',box,address).first();if(!local||local.status!=='active'||local.version!==data.expectedLocalVersion)throw new ServiceError('suppression_changed',409);}
  const now=clock(options),token=await lock(ctx.env,config,now());let op:Operation|undefined;
  try {
    const prior=await sql(ctx.env,"SELECT * FROM cloudflare_suppression_operations WHERE account_id=? AND domain=? AND remote_id=? AND state IN('preparing','deleting','unknown')",config.accountId,config.domain,id).first<Operation>();
    if(prior){if(prior.request_hash===hash)return operationDto(prior);throw new ServiceError('cloudflare_operation_pending',409);}
    const at=now();await sql(ctx.env,`INSERT INTO cloudflare_suppression_operations(id,request_hash,account_id,domain,mailbox_id,remote_id,address,scope_type,scope_value,version_hash,
      release_local,local_id,local_version,state,remote_status,local_status,lease_token,lease_until,created_at,updated_at,retry_of)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'preparing','in_progress',?,?,?,?,?,?)`,requestId,hash,config.accountId,config.domain,box,id,address,cached.scope_type,cached.scope_value,cached.version_hash,
      releaseLocal?1:0,local?.id??null,local?.version??null,releaseLocal?'pending':'not_requested',token,at+LEASE,at,at,retryOf??null).run();op=await operation(ctx.env,requestId);
    let fresh:Row;
    try {
      const response=await api(ctx.env,config,`/${id}`,'GET',options,true);
      if(response.status===404)return await finished(ctx,config,op,token,now(),'already_absent');
      if(response.status!==200)throw new ServiceError('cloudflare_api_unavailable',502);
      fresh=await normalized(envelope(response.body).result,config);
      if(fresh.remote_id!==id||fresh.address!==cached.address||fresh.scope_type!==cached.scope_type||fresh.scope_value!==cached.scope_value)throw new ServiceError('cloudflare_suppression_changed',409);
      if(fresh.read_only)throw new ServiceError('cloudflare_suppression_read_only',409);
      if(fresh.version_hash!==cached.version_hash)throw new ServiceError('cloudflare_suppression_changed',409);
    }catch(error){await failed(ctx.env,op,token,now(),false,error instanceof ServiceError?error.code:'cloudflare_api_unavailable');throw error;}
    const boundary=await sql(ctx.env,`UPDATE cloudflare_suppression_operations SET state='deleting',updated_at=MAX(updated_at,?) WHERE id=? AND state='preparing' AND lease_token=? AND lease_until>? AND ${live(config,token,now()).query}`,
      now(),op.id,token,now(),...live(config,token,now()).args).run();
    if(!boundary.meta.changes){await recover(ctx.env,config,now());return operationDto(await operation(ctx.env,op.id));}
    try {
      const response=await api(ctx.env,config,`/${id}`,'DELETE',options);
      if(response.status>=300&&response.status<500)return await failed(ctx.env,op,token,now(),false,'cloudflare_api_rejected');
      if(response.status!==200)return await failed(ctx.env,op,token,now(),true,'cloudflare_delete_unknown');
      const result=record(envelope(response.body).result);if(result.id!==id)throw new ServiceError('cloudflare_api_invalid_response',502);
      if(result.scope!==undefined){const check=scope(result.scope,config);if(check.scope_type!==cached.scope_type||check.scope_value!==cached.scope_value)throw new ServiceError('cloudflare_api_scope_mismatch',502);}
      return await finished(ctx,config,op,token,now(),'deleted');
    }catch{return await failed(ctx.env,op,token,now(),true,'cloudflare_delete_unknown');}
  }finally{await unlock(ctx.env,config,token);}
}

/** A command ID identifies one execution; retries always create a separately linked run. */
async function trackedSync(env:RuntimeEnv,box:string|null,source:'owner'|'scheduled',requestId:unknown,retryOf:string|undefined,options:CloudflareSuppressionOptions) {
  const config=configured(env),at=clock(options)();
  if(requestId!==undefined&&(typeof requestId!=='string'||!uuid.test(requestId)))throw new ServiceError('invalid_input',400);
  const id=typeof requestId==='string'?requestId.toLowerCase():crypto.randomUUID();
  const hash=await sha256(JSON.stringify({account:config.accountId,domain:config.domain,box,source,retryOf:retryOf??null}));
  await recover(env,config,at);
  const inserted=await sql(env,`INSERT INTO cloudflare_suppression_sync_runs(id,request_hash,account_id,domain,mailbox_id,source,retry_of,state,started_at,lease_token,lease_until)
    VALUES(?,?,?,?,?,?,?,'running',?,?,?) ON CONFLICT(id) DO NOTHING`,id,hash,config.accountId,config.domain,box,source,retryOf??null,at,crypto.randomUUID(),at+LEASE).run();
  const row=(await sql(env,'SELECT * FROM cloudflare_suppression_sync_runs WHERE id=?',id).first<SyncRun>())!;
  if(row.request_hash!==hash)throw new ServiceError('cloudflare_operation_conflict',409);
  if(!inserted.meta.changes)return {synced:row.state==='succeeded',count:row.count??0,syncedAt:row.completed_at,runId:id,state:row.state,...(row.error_code?{errorCode:row.error_code}:{})};
  try{const result=await sync(env,options,id);return {...result,runId:id,state:'succeeded' as const};}
  catch(error){
    await sql(env,"UPDATE cloudflare_suppression_sync_runs SET state='failed',error_code=?,completed_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND state='running'",error instanceof ServiceError?error.code:'cloudflare_api_unavailable',clock(options)(),id).run();
    throw error;
  }
}

async function historyConfig(ctx:OwnerContext,box:string):Promise<Config|null> {
  await ownerBox(ctx,box);const config=cloudflareSuppressionIdentity(ctx.env);if(config)await ownerBox(ctx,box,config);return config;
}
function historyKind(value:unknown):'sync'|'release' {if(value!=='sync'&&value!=='release')throw new ServiceError('invalid_query',400);return value;}
async function releaseHistory(ctx:OwnerContext,row:Operation,at:number):Promise<CloudflareSuppressionReleaseHistory> {
  const cached=await sql(ctx.env,"SELECT version_hash,read_only FROM cloudflare_suppression_cache WHERE account_id=? AND configured_domain=? AND remote_id=? AND status='active'",row.account_id,row.domain,row.remote_id).first<{version_hash:string;read_only:number}>();
  const local=await sql(ctx.env,'SELECT id,version,status,reason FROM recipient_suppressions WHERE mailbox_id=? AND address=?',row.mailbox_id,row.address).first<{id:string;version:number;status:'active'|'released';reason:'hard_bounce'|'complaint'}>();
  const enabled=Boolean(cloudflareSuppressionConfig(ctx.env));
  return {id:row.id,kind:'release',state:row.state,startedAt:row.created_at,completedAt:row.completed_at,errorCode:row.error_code,retryOf:row.retry_of,
    canRetry:enabled&&row.state==='failed'&&Boolean(cached&&!cached.read_only)&&!['cloudflare_suppression_read_only','cloudflare_suppression_changed'].includes(row.error_code??''),
    canReconcile:enabled&&(['unknown','failed'].includes(row.state)||['preparing','deleting'].includes(row.state)&&(row.lease_until??0)<=at),
    remoteId:row.remote_id,address:row.address,scope:row.scope_type==='account'?{type:'account'}:{type:'sending_domain',value:row.scope_value},version:row.version_hash,
    remoteStatus:row.remote_status,localStatus:row.local_status,current:cached?{version:cached.version_hash,readOnly:cached.read_only===1,localSuppression:local}:null};
}
function syncHistory(ctx:OwnerContext,row:SyncRun):CloudflareSuppressionHistoryItem {
  return {id:row.id,kind:'sync',state:row.state,startedAt:row.started_at,completedAt:row.completed_at,errorCode:row.error_code,retryOf:row.retry_of,source:row.source,count:row.count,
    canRetry:(row.state==='failed'||row.state==='running'&&(row.lease_until??0)<=Date.now())&&Boolean(cloudflareSuppressionConfig(ctx.env)),canReconcile:false};
}
export async function listCloudflareSuppressionHistory(ctx:OwnerContext,box:string,query:{kind?:unknown;limit?:unknown;cursor?:unknown}={}):Promise<CloudflareSuppressionHistoryList> {
  const config=await historyConfig(ctx,box);objectInput(query,['kind','limit','cursor']);const kind=historyKind(query.kind??'sync');
  const limit=query.limit===undefined?20:Number(query.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_query',400);
  if(!config)return {configured:false,history:[],nextCursor:null};
  const at=Date.now();let before:{time:number;id:string}|null=null;
  if(query.cursor!==undefined){try{
    if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw Error();
    const value=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));
    if(!value||Object.keys(value).length!==8||value.v!==1||value.account!==config.accountId||value.domain!==config.domain||value.box!==box||value.kind!==kind||value.limit!==limit||!Number.isSafeInteger(value.time)||typeof value.id!=='string'||!uuid.test(value.id))throw Error();before={time:value.time,id:value.id};
  }catch{throw new ServiceError('invalid_cursor',400);}}
  const time=kind==='sync'?'started_at':'created_at',table=kind==='sync'?'cloudflare_suppression_sync_runs':'cloudflare_suppression_operations';
  const rows=(await sql(ctx.env,`SELECT * FROM ${table} WHERE account_id=? AND domain=? AND ${kind==='sync'?'(mailbox_id=? OR mailbox_id IS NULL)':'mailbox_id=?'}
    ${before?`AND(${time}<? OR(${time}=? AND id<?))`:''} ORDER BY ${time} DESC,id DESC LIMIT ?`,config.accountId,config.domain,box,...(before?[before.time,before.time,before.id]:[]),limit+1).all<SyncRun|Operation>()).results;
  const page=rows.slice(0,limit),history=await Promise.all(page.map(row=>kind==='sync'?syncHistory(ctx,row as SyncRun):releaseHistory(ctx,row as Operation,at)));
  const last=page.at(-1),nextCursor=rows.length>limit&&last?btoa(JSON.stringify({v:1,account:config.accountId,domain:config.domain,box,kind,limit,time:kind==='sync'?(last as SyncRun).started_at:(last as Operation).created_at,id:last.id})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null;
  return {configured:true,history,nextCursor};
}
export async function getCloudflareSuppressionHistory(ctx:OwnerContext,box:string,id:string,query:{kind?:unknown}={}):Promise<CloudflareSuppressionHistoryDetail> {
  const config=await historyConfig(ctx,box);objectInput(query,['kind']);const kind=historyKind(query.kind??'sync');if(!uuid.test(id))throw new ServiceError('not_found',404);
  if(!config)throw new ServiceError('cloudflare_suppressions_not_configured',503);
  const row=await sql(ctx.env,`SELECT * FROM ${kind==='sync'?'cloudflare_suppression_sync_runs':'cloudflare_suppression_operations'} WHERE id=? AND account_id=? AND domain=? AND ${kind==='sync'?'(mailbox_id=? OR mailbox_id IS NULL)':'mailbox_id=?'}`,id.toLowerCase(),config.accountId,config.domain,box).first<SyncRun|Operation>();
  if(!row)throw new ServiceError('not_found',404);
  const events=(await sql(ctx.env,'SELECT * FROM cloudflare_suppression_history_events WHERE account_id=? AND domain=? AND kind=? AND resource_id=? ORDER BY rowid DESC LIMIT 101',config.accountId,config.domain,kind,row.id)
    .all<{id:string;action:string;state:string;remote_status:string|null;local_status:string|null;error_code:string|null;count:number|null;occurred_at:number}>()).results;
  return {item:kind==='sync'?syncHistory(ctx,row as SyncRun):await releaseHistory(ctx,row as Operation,Date.now()),timeline:events.slice(0,100).reverse().map(event=>({id:event.id,action:event.action,state:event.state,remoteStatus:event.remote_status,localStatus:event.local_status,errorCode:event.error_code,count:event.count,occurredAt:event.occurred_at})),timelineTruncated:events.length>100};
}

/** Explicit verification performs GET only. It cannot release local evidence or repeat a DELETE. */
export async function reconcileCloudflareSuppression(ctx:OwnerContext,box:string,id:string,input:unknown,options:CloudflareSuppressionOptions={}) {
  await ownerBox(ctx,box);const config=configured(ctx.env);await ownerBox(ctx,box,config);const data=objectInput(input,['clientRequestId']);
  if(!uuid.test(id)||typeof data.clientRequestId!=='string'||!uuid.test(data.clientRequestId))throw new ServiceError('invalid_input',400);
  id=id.toLowerCase();const requestId=data.clientRequestId.toLowerCase(),hash=await sha256(JSON.stringify({account:config.accountId,domain:config.domain,box,id})),now=clock(options);
  const load=async()=>{
    const row=await sql(ctx.env,'SELECT * FROM cloudflare_suppression_operations WHERE id=? AND account_id=? AND domain=? AND mailbox_id=?',id,config.accountId,config.domain,box).first<Operation>();if(!row)throw new ServiceError('not_found',404);return row;
  };
  let op=await load();
  const previous=await sql(ctx.env,'SELECT request_hash FROM cloudflare_suppression_reconciliations WHERE id=?',requestId).first<{request_hash:string}>();
  if(previous){if(previous.request_hash!==hash)throw new ServiceError('cloudflare_operation_conflict',409);return {operation:await releaseHistory(ctx,op,now()),reconciliationId:requestId};}
  const token=await lock(ctx.env,config,now());
  try {
    op=await load();if(!['unknown','failed'].includes(op.state))throw new ServiceError('cloudflare_operation_not_reconcilable',409);
    const at=now();await sql(ctx.env,`INSERT INTO cloudflare_suppression_reconciliations(id,request_hash,operation_id,account_id,domain,mailbox_id,state,started_at,lease_token,lease_until)
      VALUES(?,?,?,?,?,?,'running',?,?,?)`,requestId,hash,id,config.accountId,config.domain,box,at,token,at+LEASE).run();
    try {
      const result=await api(ctx.env,config,`/${op.remote_id}`,'GET',options,true);let fresh:Row|null=null;
      if(result.status===200){fresh=await normalized(envelope(result.body).result,config);if(fresh.remote_id!==op.remote_id||fresh.address!==op.address||fresh.scope_type!==op.scope_type||fresh.scope_value!==op.scope_value)throw new ServiceError('cloudflare_suppression_changed',409);}
      else if(result.status!==404)throw new ServiceError('cloudflare_api_unavailable',502);
      const finishedAt=now(),guard=live(config,token,finishedAt),since=await sql(ctx.env,"SELECT MIN(occurred_at) AS time FROM cloudflare_suppression_history_events WHERE kind='release' AND resource_id=? AND remote_status='unknown'",id).first<{time:number|null}>();
      const state=fresh?(op.state==='unknown'&&finishedAt-(since?.time??op.updated_at)<UNKNOWN_GRACE?'unknown':'failed'):'confirmed_absent';
      const batch:D1PreparedStatement[]=[];
      if(fresh)batch.push(sql(ctx.env,`INSERT INTO cloudflare_suppression_cache(account_id,configured_domain,remote_id,address,scope_type,scope_value,reason,read_only,status,version_hash,expires_at,provider_created_at,seen_at,updated_at,last_sync_id)
        SELECT ?,?,?,?,?,?,?,?,'active',?,?,?,?,?,? WHERE ${guard.query}
        ON CONFLICT(account_id,configured_domain,remote_id) DO UPDATE SET reason=excluded.reason,read_only=excluded.read_only,status='active',version_hash=excluded.version_hash,expires_at=excluded.expires_at,provider_created_at=excluded.provider_created_at,seen_at=excluded.seen_at,updated_at=excluded.updated_at,last_sync_id=excluded.last_sync_id`,
        config.accountId,config.domain,fresh.remote_id,fresh.address,fresh.scope_type,fresh.scope_value,fresh.reason,fresh.read_only,fresh.version_hash,fresh.expires_at,fresh.provider_created_at,finishedAt,finishedAt,`reconcile:${requestId}`,...guard.args));
      else batch.push(sql(ctx.env,`UPDATE cloudflare_suppression_cache SET status='absent',updated_at=? WHERE account_id=? AND configured_domain=? AND remote_id=? AND ${guard.query}`,finishedAt,config.accountId,config.domain,op.remote_id,...guard.args));
      batch.push(sql(ctx.env,`UPDATE cloudflare_suppression_operations SET state=?,remote_status=?,local_status=CASE WHEN release_local=1 THEN ? ELSE 'not_requested' END,verified_at=?,verified_read_only=?,verified_version=?,updated_at=MAX(updated_at,?),completed_at=?,error_code=?,lease_token=NULL,lease_until=NULL
        WHERE id=? AND state IN('unknown','failed') AND ${guard.query}`,state,fresh?state==='unknown'?'unknown':'failed':'already_absent',fresh&&state==='unknown'?'pending':'changed',finishedAt,fresh?.read_only??null,fresh?.version_hash??null,finishedAt,state==='unknown'?null:finishedAt,fresh?.read_only?'cloudflare_suppression_read_only':null,id,...guard.args),
        sql(ctx.env,`UPDATE cloudflare_suppression_reconciliations SET state='succeeded',completed_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND state='running' AND lease_token=? AND ${guard.query}`,finishedAt,requestId,token,...guard.args));
      const results=await ctx.env.DB.batch(batch);if(!results.at(-1)!.meta.changes)throw new ServiceError('cloudflare_suppression_sync_expired',409);
    }catch(error){
      await sql(ctx.env,"UPDATE cloudflare_suppression_reconciliations SET state='failed',error_code=?,completed_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND state='running' AND lease_token=?",error instanceof ServiceError?error.code:'cloudflare_api_unavailable',now(),requestId,token).run();throw error;
    }
    return {operation:await releaseHistory(ctx,await load(),now()),reconciliationId:requestId};
  }finally{await unlock(ctx.env,config,token);}
}

export async function retryCloudflareSuppression(ctx:OwnerContext,box:string,id:string,input:unknown,options:CloudflareSuppressionOptions={}) {
  await ownerBox(ctx,box);const config=configured(ctx.env);await ownerBox(ctx,box,config);
  const data=objectInput(input,['kind','clientRequestId','expectedVersion','confirmationAddress','confirmationScope','releaseLocal','expectedLocalVersion']);
  const kind=historyKind(data.kind);if(!uuid.test(id)||typeof data.clientRequestId!=='string'||!uuid.test(data.clientRequestId))throw new ServiceError('invalid_input',400);
  id=id.toLowerCase();await recover(ctx.env,config,clock(options)());
  if(kind==='sync'){
    objectInput(input,['kind','clientRequestId']);
    const parent=await sql(ctx.env,"SELECT * FROM cloudflare_suppression_sync_runs WHERE id=? AND account_id=? AND domain=? AND(mailbox_id=? OR mailbox_id IS NULL)",id,config.accountId,config.domain,box).first<SyncRun>();
    if(!parent)throw new ServiceError('not_found',404);if(parent.state!=='failed')throw new ServiceError('cloudflare_operation_not_retryable',409);
    return trackedSync(ctx.env,box,'owner',data.clientRequestId,id,options);
  }
  const parent=await sql(ctx.env,'SELECT * FROM cloudflare_suppression_operations WHERE id=? AND account_id=? AND domain=? AND mailbox_id=?',id,config.accountId,config.domain,box).first<Operation>();
  if(!parent)throw new ServiceError('not_found',404);
  const prior=await sql(ctx.env,'SELECT retry_of FROM cloudflare_suppression_operations WHERE id=?',data.clientRequestId.toLowerCase()).first<{retry_of:string|null}>();
  if(!prior||prior.retry_of!==id){if(!(await releaseHistory(ctx,parent,clock(options)())).canRetry)throw new ServiceError('cloudflare_operation_not_retryable',409);}
  const {kind:_kind,...intent}=data;return releaseCloudflareSuppression(ctx,box,parent.remote_id,intent,options,id);
}
