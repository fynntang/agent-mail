import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';

const api='https://api.example.com',accountId='a'.repeat(32),domain='agent.example.com';
const providerToken='HISTORY_CF_PRIVATE_API_TOKEN_TEST_ONLY_1234567890';
const bindings={EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain};
const providerBase=`/client/v4/accounts/${accountId}/email/sending/suppressions`;
const base=box=>`/owner/api/mailboxes/${box.id}/cloudflare-suppressions`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime){return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Suppression history',localPart:`cf-history-${randomUUID()}`}}),201)).mailbox;}
async function token(runtime,box){return json(await runtime.request(`/owner/api/mailboxes/${box.id}/tokens`,{method:'POST',body:{name:'History denied',scopes:['mail:read','mail:draft','mail:send']}}),201);}
const row=email=>({id:randomUUID(),email,reason:'manual',scope:{type:'account'},read_only:false,created_at:'2026-11-01T10:00:00Z',expires_at:null});
function provider(state){return async request=>{
  const url=new URL(request.url);assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(request.headers.get('authorization'),`Bearer ${providerToken}`);
  for(const header of ['cookie','cf-access-jwt-assertion','origin','referer'])assert.equal(request.headers.get(header),null,header);
  state.calls.push({method:request.method,path:url.pathname,search:url.search});
  if(url.pathname===providerBase){assert.equal(request.method,'GET');assert.equal(url.searchParams.get('per_page'),'100');
    if(state.listFailure)return Response.json({success:false,errors:[{message:'PRIVATE_HISTORY_NETWORK_DIAGNOSTIC'}]},{status:500});
    return Response.json({success:true,result:url.searchParams.get('scope_type')==='account'?state.rows:[],result_info:{next_cursor:null}});}
  const id=url.pathname.slice(providerBase.length+1),entry=state.rows.find(item=>item.id===id);
  if(request.method==='GET')return entry?Response.json({success:true,result:{...entry,...(state.freshReadOnly?{read_only:true}:{})}}):Response.json({success:false,result:null},{status:404});
  assert.equal(request.method,'DELETE');state.deletes++;if(!state.keepOnDelete)state.rows=state.rows.filter(item=>item.id!==id);
  if(state.unknownDelete)throw new Error('PRIVATE_HISTORY_NETWORK_DIAGNOSTIC');return Response.json({success:true,result:{id}});
};}
function safe(value){const serialized=JSON.stringify(value);for(const text of [providerToken,'PRIVATE_HISTORY_NETWORK_DIAGNOSTIC','Authorization','request_hash','lease_token'])assert.equal(serialized.includes(text),false,text);}
async function clientFor(t,runtime,secret){
  const client=new Client({name:'suppression-history-negative',version:'1'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});registerMcpClient(runtime,client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},fetch:async(input,init)=>{
    const request=new Request(input,init),body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();assert.equal(new URL(request.url).origin,api);
    return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body,signal:request.signal});
  }}),{timeout:10_000});return client;
}

async function oauthToken(runtime,box){
  const apiResource=`${api}/mcp`,redirect='https://history-client.example/callback',verifier=randomBytes(32).toString('base64url');
  const registered=await json(await runtime.mf.dispatchFetch(`${api}/oauth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    client_name:'History denied OAuth',redirect_uris:[redirect],scope:'mail:read',token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']
  })}),201);
  const url=new URL('/owner/oauth/authorize','https://console.example.com');url.search=new URLSearchParams({client_id:registered.client_id,redirect_uri:redirect,response_type:'code',resource:apiResource,scope:'mail:read',
    state:randomUUID(),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const response=await runtime.mf.dispatchFetch(url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'}});assert.equal(response.status,200);const html=await response.text();
  const requestId=/name="requestId"[^>]*value="([^"]+)"/.exec(html)?.[1],csrfToken=/name="csrfToken"[^>]*value="([^"]+)"/.exec(html)?.[1];assert.ok(requestId&&csrfToken);
  const consent=await runtime.mf.dispatchFetch(url,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Origin:'https://console.example.com','Content-Type':'application/x-www-form-urlencoded',Accept:'text/html'},
    body:new URLSearchParams({requestId,csrfToken,decision:'allow',mailboxId:box.id,scope:'mail:read'}).toString(),redirect:'manual'});assert.equal(consent.status,303);
  const returned=new URL(consent.headers.get('Location'));
  return json(await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',
    client_id:registered.client_id,resource:apiResource,code:returned.searchParams.get('code'),redirect_uri:redirect,code_verifier:verifier}).toString()}));
}
async function listHistory(runtime,box,kind,query=''){const result=await json(await runtime.request(`${base(box)}/history?kind=${kind}${query}`));safe(result);assert.ok(Array.isArray(result.history));return result;}
async function detail(runtime,box,id,kind){const result=await json(await runtime.request(`${base(box)}/history/${id}?kind=${kind}`));safe(result);assert.ok(Array.isArray(result.timeline));return result;}
async function cached(runtime,box,id){const result=await json(await runtime.request(base(box)));return result.suppressions.find(item=>item.id===id);}
const releaseInput=item=>({clientRequestId:randomUUID(),expectedVersion:item.version,confirmationAddress:item.address,confirmationScope:item.scope.type==='account'?'account':item.scope.value});

test('Owner history persists failed/successful syncs, paginates safely and creates one parent-linked retry while denying Agent and OAuth history access',{timeout:120_000},async t=>{
  const state={rows:[row('history-only@example.net')],calls:[],deletes:0,listFailure:true};const runtime=await createOwnerRuntime({bindings,outboundService:provider(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),credential=await token(runtime,box);
  assert.equal((await runtime.request(`${base(box)}/sync`,{method:'POST',body:{clientRequestId:randomUUID()}})).status,502);
  const failed=(await listHistory(runtime,box,'sync')).history[0];assert.equal(failed.state,'failed');assert.equal(failed.canRetry,true);assert.ok(failed.errorCode);
  state.listFailure=false;
  for(let index=0;index<2;index++)await json(await runtime.request(`${base(box)}/sync`,{method:'POST',body:{clientRequestId:randomUUID()}}));
  const first=await listHistory(runtime,box,'sync','&limit=1');assert.equal(first.history.length,1);assert.ok(first.nextCursor);
  const next=await listHistory(runtime,box,'sync',`&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);assert.notEqual(next.history[0].id,first.history[0].id);
  const failedDetail=await detail(runtime,box,failed.id,'sync');assert.equal(failedDetail.item.id,failed.id);assert.ok(failedDetail.timeline.length>=1);
  const retryPath=`${base(box)}/history/${failed.id}/retry`,retryBody={kind:'sync',clientRequestId:randomUUID()};
  const beforeDenied=state.calls.length;assert.equal((await runtime.request(retryPath,{method:'POST',headers:{Origin:'https://evil.example'},body:retryBody})).status,403);assert.equal(state.calls.length,beforeDenied);
  const retried=await json(await runtime.request(retryPath,{method:'POST',body:retryBody}));assert.equal(retried.synced,true);
  const child=await detail(runtime,box,retried.runId,'sync');assert.equal(child.item.retryOf,failed.id);assert.equal(child.item.state,'succeeded');assert.equal(child.item.canRetry,false);
  const callCount=state.calls.length;const duplicate=await json(await runtime.request(retryPath,{method:'POST',body:retryBody}));assert.equal(duplicate.runId,retried.runId);assert.equal(state.calls.length,callCount);
  for(const path of [`${base(box)}/history?kind=sync`,`${base(box)}/history/${failed.id}?kind=sync`]){
    assert.equal((await runtime.request(path,{authenticated:false})).status,401);
    assert.equal((await runtime.request(path,{authenticated:false,headers:{Authorization:`Bearer ${credential.secret}`}})).status,401);
  }
  const oauth=await oauthToken(runtime,box);assert.equal((await runtime.request(`${base(box)}/history?kind=sync`,{authenticated:false,headers:{Authorization:`Bearer ${oauth.access_token}`}})).status,401);
  const client=await clientFor(t,runtime,credential.secret);assert.equal((await client.listTools()).tools.some(item=>item.name.includes('history')||item.name.includes('cloudflare')),false);
  await runtime.updateBindings({EMAIL_SUPPRESSIONS_API_TOKEN:''});assert.ok((await listHistory(runtime,box,'sync')).history.some(item=>item.id===failed.id),'History survives removal of the private credential');
  await runtime.updateBindings({EMAIL_SUPPRESSIONS_ACCOUNT_ID:'d'.repeat(32)});assert.deepEqual((await listHistory(runtime,box,'sync')).history,[]);
  assert.equal((await runtime.request(`${base(box)}/history/${failed.id}?kind=sync`)).status,404);
});

test('unknown DELETE history reconciles with GET only, records an idempotent proof and cannot retry a successful absence result',{timeout:120_000},async t=>{
  const remote=row('reconcile-absent@example.net'),state={rows:[remote],calls:[],deletes:0,unknownDelete:true};
  const runtime=await createOwnerRuntime({bindings,outboundService:provider(state)});t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime);
  await json(await runtime.request(`${base(box)}/sync`,{method:'POST',body:{clientRequestId:randomUUID()}}));const item=await cached(runtime,box,remote.id),input=releaseInput(item);
  const lost=await json(await runtime.request(`${base(box)}/${remote.id}/release`,{method:'POST',body:input}),202);assert.equal(lost.remoteStatus,'unknown');assert.equal(state.deletes,1);
  const pending=await detail(runtime,box,lost.operationId,'release');assert.equal(pending.item.canReconcile,true);assert.equal(pending.item.canRetry,false);
  const reconcilePath=`${base(box)}/history/${lost.operationId}/reconcile`,body={clientRequestId:randomUUID()},before=state.calls.length;
  assert.equal((await runtime.request(reconcilePath,{method:'POST',headers:{Origin:'null'},body})).status,403);assert.equal(state.calls.length,before);
  const proof=await json(await runtime.request(reconcilePath,{method:'POST',body}));assert.equal(proof.operation.remoteStatus,'already_absent');assert.ok(proof.reconciliationId);
  assert.equal(state.deletes,1);assert.equal(state.calls.length,before+1);assert.equal(state.calls.at(-1).method,'GET');
  const again=await json(await runtime.request(reconcilePath,{method:'POST',body}));assert.equal(again.reconciliationId,proof.reconciliationId);assert.equal(state.calls.length,before+1);
  const completed=await detail(runtime,box,lost.operationId,'release');assert.equal(completed.item.canRetry,false);assert.equal(completed.item.canReconcile,false);assert.ok(completed.timeline.length>=2);
  assert.equal((await runtime.request(`${base(box)}/history/${lost.operationId}/retry`,{method:'POST',body:{kind:'release',...input,clientRequestId:randomUUID()}})).status,409);
  assert.equal(state.deletes,1);safe(proof);safe(completed);
});

test('aged-present and crashed operations recover safely; a fresh parent-linked retry rechecks snapshot, read_only and local CAS before one new DELETE',{timeout:120_000},async t=>{
  const remote=row('aged-present@example.net'),crashed=row('crashed-present@example.net'),state={rows:[remote,crashed],calls:[],deletes:0};
  const runtime=await createOwnerRuntime({bindings,outboundService:provider(state)});t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),now=Date.now(),old=now-180_000,localId=randomUUID();
  await runtime.db.prepare(`INSERT INTO recipient_suppressions(id,mailbox_id,address,reason,last_event_at,last_event_id,created_at,updated_at)
    VALUES(?,?,?,'hard_bounce',?,'fixture:history-local',?,?)`).bind(localId,box.id,remote.email,old,old,old).run();
  await json(await runtime.request(`${base(box)}/sync`,{method:'POST',body:{clientRequestId:randomUUID()}}));const snapshot=await cached(runtime,box,remote.id),crashSnapshot=await cached(runtime,box,crashed.id);
  // Initial old receipts model elapsed grace and process death without bypassing immutable timestamp triggers.
  const parentId=randomUUID(),crashId=randomUUID();
  await runtime.db.prepare(`INSERT INTO cloudflare_suppression_operations(id,request_hash,account_id,domain,mailbox_id,remote_id,address,scope_type,scope_value,version_hash,
    release_local,local_id,local_version,state,remote_status,local_status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'account','',?,1,?,1,'unknown','unknown','pending',?,?)`).bind(parentId,'0'.repeat(64),accountId,domain,box.id,remote.id,remote.email,snapshot.version,localId,old,old).run();
  const reconciled=await json(await runtime.request(`${base(box)}/history/${parentId}/reconcile`,{method:'POST',body:{clientRequestId:randomUUID()}}));
  assert.equal(reconciled.operation.remoteStatus,'failed');assert.equal(reconciled.operation.canRetry,true);assert.equal(state.deletes,0);
  const retryPath=`${base(box)}/history/${parentId}/retry`,fresh={kind:'release',...releaseInput(snapshot),releaseLocal:true,expectedLocalVersion:1};
  assert.equal((await runtime.request(retryPath,{method:'POST',body:{...fresh,clientRequestId:randomUUID(),expectedVersion:'0'.repeat(64)}})).status,409);
  assert.equal((await runtime.request(retryPath,{method:'POST',body:{...fresh,clientRequestId:randomUUID(),expectedLocalVersion:2}})).status,409);
  state.freshReadOnly=true;assert.equal((await runtime.request(retryPath,{method:'POST',body:{...fresh,clientRequestId:randomUUID()}})).status,409);assert.equal(state.deletes,0);
  state.freshReadOnly=false;
  const retried=await json(await runtime.request(retryPath,{method:'POST',body:{...fresh,clientRequestId:randomUUID()}}));assert.equal(retried.remoteStatus,'deleted');assert.equal(retried.localStatus,'released');assert.equal(state.deletes,1);
  const child=await detail(runtime,box,retried.operationId,'release');assert.equal(child.item.retryOf,parentId);assert.equal(child.item.canRetry,false);
  assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(localId).first('status'),'released');
  await runtime.db.prepare(`INSERT INTO cloudflare_suppression_operations(id,request_hash,account_id,domain,mailbox_id,remote_id,address,scope_type,scope_value,version_hash,
    release_local,state,remote_status,local_status,lease_token,lease_until,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'account','',?,0,'deleting','in_progress','not_requested',?,0,?,?)`).bind(crashId,'1'.repeat(64),accountId,domain,box.id,crashed.id,crashed.email,crashSnapshot.version,randomUUID(),old,old).run();
  await json(await runtime.request(`${base(box)}/sync`,{method:'POST',body:{clientRequestId:randomUUID()}}));
  const recovered=await detail(runtime,box,crashId,'release');assert.equal(recovered.item.remoteStatus,'unknown');assert.equal(recovered.item.canReconcile,true);
  assert.equal(recovered.item.errorCode,'operation_lease_expired');assert.ok(recovered.timeline.length>=1);assert.equal(state.deletes,1,'Crash recovery only reads provider state');
});
