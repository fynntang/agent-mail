import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';

const api='https://api.example.com',consoleOrigin='https://console.example.com';
const base=box=>`/owner/api/mailboxes/${box.id}`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime){return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Cloudflare suppressions',localPart:`cf-supp-${randomUUID()}`}}),201)).mailbox;}
async function token(runtime,box,scopes=['mail:read','mail:draft','mail:send']){
  return json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'Provider check',scopes}}),201);
}
function agent(runtime,secret,path,body){return runtime.mf.dispatchFetch(new URL(path,api),{method:body===undefined?'GET':'POST',
  headers:{Authorization:`Bearer ${secret}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function clientFor(t,runtime,secret){
  const client=new Client({name:'cloudflare-suppression-integration',version:'1'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});registerMcpClient(runtime,client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},fetch:async(input,init)=>{
    const request=new Request(input,init),body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();
    assert.equal(new URL(request.url).origin,api);return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body,signal:request.signal});
  }}),{timeout:10_000});return client;
}

const accountId='a'.repeat(32),domain='agent.example.com',providerToken='CF_PRIVATE_API_TOKEN_TEST_ONLY_1234567890';
const bindings={EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain};
const providerBase=`/client/v4/accounts/${accountId}/email/sending/suppressions`;
const page=box=>`${base(box)}/cloudflare-suppressions`;
const providerRow=(email,scope={type:'account'},readOnly=false)=>({id:randomUUID(),email,reason:'manual',scope,read_only:readOnly,created_at:'2026-11-01T10:00:00Z',expires_at:null});
function provider(state){return async request=>{
  const url=new URL(request.url);assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(request.headers.get('authorization'),`Bearer ${providerToken}`);
  for(const header of ['cookie','cf-access-jwt-assertion','origin','referer'])assert.equal(request.headers.get(header),null,header);
  state.calls.push({method:request.method,url:request.url});
  if(url.pathname===providerBase){
    assert.equal(request.method,'GET');assert.equal(url.searchParams.get('per_page'),'100');
    const scope=url.searchParams.get('scope_type');assert.ok(['account','sending_domain'].includes(scope));
    if(scope==='sending_domain')assert.equal(url.searchParams.get('scope_value'),domain);else assert.equal(url.searchParams.has('scope_value'),false);
    if(state.incomplete&&url.searchParams.get('cursor'))return Response.json({success:false,errors:[{code:1000,message:'PRIVATE_CF_NETWORK_DIAGNOSTIC'}]},{status:500});
    if(state.paginated&&scope==='account')return Response.json({success:true,result:url.searchParams.get('cursor')?state.account.slice(1):state.account.slice(0,1),
      result_info:{next_cursor:url.searchParams.get('cursor')?null:'account-next'}});
    return Response.json({success:true,result:scope==='account'?state.account:state.sending,result_info:{next_cursor:state.incomplete&&scope==='account'?'unfetched-page':null}});
  }
  const id=url.pathname.slice(providerBase.length+1),row=[...state.account,...state.sending].find(item=>item.id===id);
  if(request.method==='GET')return row?Response.json({success:true,result:{...row,...(state.freshReadOnly?{read_only:true}:{})}}):Response.json({success:false,result:null,errors:[{code:1000,message:'not found'}]},{status:404});
  assert.equal(request.method,'DELETE');state.deletes++;if(state.beforeDelete)await state.beforeDelete();
  state.account=state.account.filter(item=>item.id!==id);state.sending=state.sending.filter(item=>item.id!==id);
  if(state.unknownDelete)throw new Error('PRIVATE_CF_NETWORK_DIAGNOSTIC');
  return Response.json({success:true,result:{id}});
};}
function safe(value){const serialized=JSON.stringify(value);for(const secret of [providerToken,'CF_OWNER_COOKIE','PRIVATE_CF_NETWORK_DIAGNOSTIC','signing_secret_ciphertext'])assert.equal(serialized.includes(secret),false,secret);}
async function cached(runtime,box){const result=await json(await runtime.request(page(box)));assert.equal(result.configured,true);safe(result);return result;}
async function localSuppression(runtime,box,address){
  const id=randomUUID(),now=Date.now();await runtime.db.prepare(`INSERT INTO recipient_suppressions(id,mailbox_id,address,reason,last_event_at,last_event_id,created_at,updated_at)
    VALUES(?,?,?,'hard_bounce',?,'fixture:cloudflare-local',?,?)`).bind(id,box.id,address,now-1000,now,now).run();return id;
}

test('Owner synchronizes exact account/domain scopes using private Worker credentials while Agent checks/send enforce cached policy without remote enumeration',{timeout:120_000},async t=>{
  const account=providerRow('account-private@example.net'),unrequested=providerRow('unrequested-account@example.net'),sending=providerRow('domain-private@example.net',{type:'sending_domain',value:domain},true);
  const state={account:[account,unrequested],sending:[sending],calls:[],deletes:0,paginated:true};const runtime=await createOwnerRuntime({bindings,outboundService:provider(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),credential=await token(runtime,box),path=page(box);
  assert.equal((await runtime.request(path,{authenticated:false})).status,401);
  assert.equal((await runtime.request(`${path}/sync`,{method:'POST',authenticated:false,body:{}})).status,401);
  assert.equal((await runtime.request(`${path}/sync`,{method:'POST',headers:{Origin:'https://evil.example'},body:{}})).status,403);
  assert.equal((await runtime.request(path,{authenticated:false,headers:{Authorization:`Bearer ${credential.secret}`}})).status,401);assert.deepEqual(state.calls,[]);
  const synced=await json(await runtime.request(`${path}/sync`,{method:'POST',headers:{Cookie:'CF_OWNER_COOKIE',Referer:'https://console.example.com/owner'},body:{}}));
  assert.equal(synced.synced,true);assert.equal(synced.count,3);assert.equal(state.calls.length,3);
  const list=await cached(runtime,box);assert.equal(list.suppressions.length,3);assert.deepEqual(list.suppressions.map(item=>item.address).sort(),[account.email,unrequested.email,sending.email].sort());
  assert.equal(list.suppressions.find(item=>item.id===sending.id).readOnly,true);
  const check=await json(await agent(runtime,credential.secret,'/v1/recipient-suppressions/check',{addresses:[account.email,'clear@example.net']}));
  assert.deepEqual(check,{recipients:[{address:account.email,suppressed:true,reason:'provider_suppression'},{address:'clear@example.net',suppressed:false,reason:null}]});
  assert.equal(JSON.stringify(check).includes(sending.email),false);assert.equal(JSON.stringify(check).includes(unrequested.email),false);assert.equal(JSON.stringify(check).includes(account.id),false);safe(check);
  const client=await clientFor(t,runtime,credential.secret),names=(await client.listTools()).tools.map(item=>item.name);
  assert.equal(names.some(name=>name.includes('cloudflare')),false);
  const result=await client.callTool({name:'check_recipient_suppressions',arguments:{addresses:[sending.email]}});assert.notEqual(result.isError,true);
  assert.deepEqual(result.structuredContent,{recipients:[{address:sending.email,suppressed:true,reason:'provider_suppression'}]});safe(result.structuredContent);
  let draft=(await json(await agent(runtime,credential.secret,'/v1/drafts',{to:[account.email],subject:'Blocked by provider cache',text:'Do not dispatch'}),201)).draft;
  draft=(await json(await runtime.request(`${base(box)}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:draft.version,contentSha256:draft.contentSha256}}))).draft;
  const blocked=await runtime.mf.dispatchFetch(`${api}/v1/drafts/${draft.id}/send`,{method:'POST',headers:{Authorization:`Bearer ${credential.secret}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({expectedVersion:draft.version})});
  assert.equal((await json(blocked,409)).error.code,'cloudflare_recipient_suppressed');assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_reservations').first('n'),0);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_attempts').first('n'),0);assert.equal(state.calls.length,3,'Cached checks do not issue Cloudflare API calls');
});

test('fresh provider read_only/CAS checks and idempotent deletion preserve newer local risks; incomplete synchronization preserves the last complete cache',{timeout:120_000},async t=>{
  const mutable=providerRow('linked-private@example.net'),other=providerRow('retained-domain@example.net',{type:'sending_domain',value:domain});
  const state={account:[mutable],sending:[other],calls:[],deletes:0};const runtime=await createOwnerRuntime({bindings,outboundService:provider(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),credential=await token(runtime,box),localId=await localSuppression(runtime,box,mutable.email),path=page(box);
  await json(await runtime.request(`${path}/sync`,{method:'POST',body:{}}));let row=(await cached(runtime,box)).suppressions.find(item=>item.id===mutable.id);
  assert.equal(row.localSuppression.id,localId);assert.equal(row.localSuppression.version,1);
  const releasePath=`${path}/${row.id}/release`,input={clientRequestId:randomUUID(),expectedVersion:row.version,confirmationAddress:row.address,confirmationScope:'account',releaseLocal:true,expectedLocalVersion:1};
  assert.equal((await runtime.request(releasePath,{method:'POST',headers:{Origin:'https://evil.example'},body:input})).status,403);assert.equal(state.deletes,0);
  state.freshReadOnly=true;assert.equal((await runtime.request(releasePath,{method:'POST',body:input})).status,409);assert.equal(state.deletes,0,'A cached mutable flag cannot authorize deletion after fresh GET says read_only');
  state.freshReadOnly=false;await json(await runtime.request(`${path}/sync`,{method:'POST',body:{}}));row=(await cached(runtime,box)).suppressions.find(item=>item.id===mutable.id);
  state.beforeDelete=()=>runtime.db.prepare('UPDATE recipient_suppressions SET version=version+1,last_event_at=last_event_at+1,updated_at=updated_at+1 WHERE id=?').bind(localId).run();
  const confirmed={...input,clientRequestId:randomUUID(),expectedVersion:row.version};const deleted=await json(await runtime.request(releasePath,{method:'POST',body:confirmed}));
  assert.equal(deleted.remoteStatus,'deleted');assert.equal(deleted.localStatus,'changed');assert.equal(state.deletes,1);
  assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(localId).first('status'),'active');
  const duplicate=await json(await runtime.request(releasePath,{method:'POST',body:confirmed}));assert.equal(duplicate.operationId,deleted.operationId);assert.equal(state.deletes,1);
  const before=await cached(runtime,box);assert.equal(before.suppressions.some(item=>item.id===mutable.id),false);
  state.account=[providerRow('uncommitted-new@example.net')];state.incomplete=true;
  assert.equal((await runtime.request(`${path}/sync`,{method:'POST',body:{}})).status,502);
  const after=await cached(runtime,box);assert.deepEqual(after.suppressions,before.suppressions,'Partial pages cannot overwrite the complete cache');
  const checked=await json(await agent(runtime,credential.secret,'/v1/recipient-suppressions/check',{addresses:[other.email,'uncommitted-new@example.net']}));
  assert.equal(checked.recipients[0].suppressed,true);assert.equal(checked.recipients[1].suppressed,false);safe(after);safe(deleted);
  state.incomplete=false;state.account=[];state.sending=[providerRow('foreign-domain@example.net',{type:'sending_domain',value:'unrelated.example.net'})];
  assert.equal((await runtime.request(`${path}/sync`,{method:'POST',body:{}})).status,502);
  assert.deepEqual((await cached(runtime,box)).suppressions,before.suppressions,'A foreign sending-domain result cannot be published into the configured cache');
});

test('an unknown DELETE outcome cannot cause a duplicate mutation or automatically clear local suppression after remote absence is synchronized',{timeout:120_000},async t=>{
  const remote=providerRow('unknown-delete@example.net'),state={account:[remote],sending:[],calls:[],deletes:0,unknownDelete:true};
  const runtime=await createOwnerRuntime({bindings,outboundService:provider(state)});t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),credential=await token(runtime,box);
  const localId=await localSuppression(runtime,box,remote.email),path=page(box);await json(await runtime.request(`${path}/sync`,{method:'POST',body:{}}));
  const row=(await cached(runtime,box)).suppressions[0],input={clientRequestId:randomUUID(),expectedVersion:row.version,confirmationAddress:row.address,
    confirmationScope:'account',releaseLocal:true,expectedLocalVersion:1};
  const unknown=await json(await runtime.request(`${path}/${row.id}/release`,{method:'POST',body:input}),202);
  assert.equal(unknown.remoteStatus,'unknown');assert.equal(unknown.localStatus,'pending');assert.equal(state.deletes,1);safe(unknown);
  const again=await json(await runtime.request(`${path}/${row.id}/release`,{method:'POST',body:input}),202);assert.equal(again.operationId,unknown.operationId);assert.equal(state.deletes,1);
  assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(localId).first('status'),'active');
  await json(await runtime.request(`${path}/sync`,{method:'POST',body:{}}));assert.deepEqual((await cached(runtime,box)).suppressions,[]);
  const reconciled=await json(await runtime.request(`${path}/${row.id}/release`,{method:'POST',body:input}));
  assert.equal(reconciled.operationId,unknown.operationId);assert.equal(reconciled.remoteStatus,'already_absent');assert.equal(reconciled.localStatus,'changed');
  assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(localId).first('status'),'active','Reconciliation never assumes permission to release a local risk');
  const checked=await json(await agent(runtime,credential.secret,'/v1/recipient-suppressions/check',{addresses:[remote.email]}));
  assert.deepEqual(checked,{recipients:[{address:remote.email,suppressed:true,reason:'hard_bounce'}]});assert.equal(state.deletes,1);
});
