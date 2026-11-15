import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';

const api='https://api.example.com',accountId='a'.repeat(32),domain='agent.example.com';
const providerToken='ALERT_CF_PRIVATE_API_TOKEN_TEST_ONLY_1234567890';
const bindings={EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain,
  WEBHOOK_KEYRING:JSON.stringify({activeKid:'key-1',keys:{'key-1':'A'.repeat(43)}})};
const providerBase=`/client/v4/accounts/${accountId}/email/sending/suppressions`;
const base=box=>`/owner/api/mailboxes/${box.id}`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime){return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Suppression alerts',localPart:`cf-alert-${randomUUID()}`}}),201)).mailbox;}
async function token(runtime,box){return json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'Alert denied',scopes:['mail:read','mail:draft','mail:send']}}),201);}
async function tick(runtime){assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
const remoteRow=email=>({id:randomUUID(),email,reason:'manual',scope:{type:'account'},read_only:false,created_at:'2026-11-01T10:00:00Z',expires_at:null});
function upstream(state){return async request=>{
  const url=new URL(request.url);
  if(url.hostname==='hooks.example.net'){state.webhooks.push({headers:Object.fromEntries(request.headers),body:await request.text()});return new Response(state.webhookStatus===500?'PRIVATE_ALERT_UPSTREAM_DIAGNOSTIC':null,{status:state.webhookStatus??204});}
  assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(request.headers.get('authorization'),`Bearer ${providerToken}`);state.cloudflare.push({method:request.method,path:url.pathname});
  if(url.pathname===providerBase){if(state.failSync)return Response.json({success:false,errors:[{message:'PRIVATE_ALERT_PROVIDER_DIAGNOSTIC'}]},{status:500});
    return Response.json({success:true,result:url.searchParams.get('scope_type')==='account'?state.rows:[],result_info:{next_cursor:null}});}
  const id=url.pathname.slice(providerBase.length+1),row=state.rows.find(item=>item.id===id);
  if(request.method==='GET')return row?Response.json({success:true,result:row}):Response.json({success:false,result:null},{status:404});
  assert.equal(request.method,'DELETE');state.deletes++;state.rows=state.rows.filter(item=>item.id!==id);if(state.unknownDelete)throw new Error('PRIVATE_ALERT_PROVIDER_DIAGNOSTIC');return Response.json({success:true,result:{id}});
};}
function safe(value,extra=[]){const serialized=JSON.stringify(value);for(const text of [providerToken,'PRIVATE_ALERT_PROVIDER_DIAGNOSTIC','PRIVATE_ALERT_UPSTREAM_DIAGNOSTIC','lease_token','request_hash',...extra])assert.equal(serialized.includes(text),false,text);}

const createdType='cloudflare.suppression.alert.created',resolvedType='cloudflare.suppression.alert.resolved';
const alertBase=box=>`${base(box)}/cloudflare-suppression-alerts`;
const cfBase=box=>`${base(box)}/cloudflare-suppressions`;
const stateFor=rows=>({rows,cloudflare:[],webhooks:[],deletes:0});
async function alerts(runtime,box,status='all'){const result=await json(await runtime.request(`${alertBase(box)}?status=${status}`));safe(result);return result;}
async function subscription(runtime,box){return json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:'https://hooks.example.net/admin-alerts',eventTypes:[createdType,resolvedType]}}),201);}
function signed(record,secret,forbidden=[]){
  const signature=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(record.headers['x-agent-mail-signature']);assert.ok(signature);
  assert.equal(signature[2],createHmac('sha256',secret).update(`${signature[1]}.${record.headers['x-agent-mail-delivery']}.${record.body}`).digest('hex'));
  for(const name of ['authorization','cookie','cf-access-jwt-assertion','origin','referer'])assert.equal(record.headers[name],undefined,name);
  const body=JSON.parse(record.body);assert.ok([createdType,resolvedType].includes(body.type));
  assert.ok(Object.keys(body.data).every(key=>['alertId','kind','status','outcome','errorCode'].includes(key)));safe(body,[accountId,domain,...forbidden]);return body;
}
async function clientFor(t,runtime,secret){
  const client=new Client({name:'alert-negative-integration',version:'1'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});registerMcpClient(runtime,client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},fetch:async(input,init)=>{
    const request=new Request(input,init),body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();
    assert.equal(new URL(request.url).origin,api);return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body,signal:request.signal});
  }}),{timeout:10_000});return client;
}
async function tool(client,name,args={}){const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent;}
function agent(runtime,secret,path){return runtime.mf.dispatchFetch(new URL(path,api),{headers:{Authorization:`Bearer ${secret}`}});}
async function oauthToken(runtime,box){
  const resource=`${api}/mcp`,redirect='https://alert-client.example/callback',verifier=randomBytes(32).toString('base64url');
  const registered=await json(await runtime.mf.dispatchFetch(`${api}/oauth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Alert denied OAuth',redirect_uris:[redirect],scope:'mail:read',token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']})}),201);
  const url=new URL('/owner/oauth/authorize','https://console.example.com');url.search=new URLSearchParams({client_id:registered.client_id,redirect_uri:redirect,response_type:'code',resource,scope:'mail:read',state:randomUUID(),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const page=await runtime.mf.dispatchFetch(url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'}});assert.equal(page.status,200);const html=await page.text();
  const requestId=/name="requestId"[^>]*value="([^"]+)"/.exec(html)?.[1],csrfToken=/name="csrfToken"[^>]*value="([^"]+)"/.exec(html)?.[1];assert.ok(requestId&&csrfToken);
  const consent=await runtime.mf.dispatchFetch(url,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Origin:'https://console.example.com','Content-Type':'application/x-www-form-urlencoded',Accept:'text/html'},body:new URLSearchParams({requestId,csrfToken,decision:'allow',mailboxId:box.id,scope:'mail:read'}).toString(),redirect:'manual'});assert.equal(consent.status,303);
  const returned=new URL(consent.headers.get('Location'));return json(await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:registered.client_id,resource,code:returned.searchParams.get('code'),redirect_uri:redirect,code_verifier:verifier}).toString()}));
}

test('fresh sync failure and unknown DELETE create deduplicated Owner alerts and private signed notifications; verified absence resolves only its release alert',{timeout:120_000},async t=>{
  const remote=remoteRow('PRIVATE_ALERT_RECIPIENT@example.net'),state=stateFor([remote]);const runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),endpoint=await subscription(runtime,box);await json(await runtime.request(`${cfBase(box)}/sync`,{method:'POST',body:{clientRequestId:randomUUID()}}));
  const cached=(await json(await runtime.request(cfBase(box)))).suppressions[0],failedId=randomUUID();state.failSync=true;
  assert.equal((await runtime.request(`${cfBase(box)}/sync`,{method:'POST',body:{clientRequestId:failedId}})).status,502);
  state.unknownDelete=true;const lost=await json(await runtime.request(`${cfBase(box)}/${remote.id}/release`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:cached.version,confirmationAddress:cached.address,confirmationScope:'account'}}),202);
  assert.equal(lost.remoteStatus,'unknown');await tick(runtime);const current=await alerts(runtime,box);assert.equal(current.summary.open,2);assert.equal(current.alerts.length,2);
  const syncAlert=current.alerts.find(item=>item.kind==='sync'),releaseAlert=current.alerts.find(item=>item.kind==='release');assert.equal(syncAlert.outcome,'failed');assert.equal(releaseAlert.outcome,'unknown');
  assert.equal(state.webhooks.length,2);for(const record of state.webhooks){const body=signed(record,endpoint.secret,[remote.email,remote.id,lost.operationId,failedId]);assert.equal(body.type,createdType);assert.ok([syncAlert.id,releaseAlert.id].includes(body.data.alertId));}
  await tick(runtime);await alerts(runtime,box);await json(await runtime.request(`${cfBase(box)}/sync`,{method:'POST',body:{clientRequestId:failedId}}));await tick(runtime);
  assert.equal(state.webhooks.length,2);assert.ok((await alerts(runtime,box)).alerts.every(item=>item.occurrences===1));
  const verified=await json(await runtime.request(`${cfBase(box)}/history/${lost.operationId}/reconcile`,{method:'POST',body:{clientRequestId:randomUUID()}}));assert.equal(verified.operation.remoteStatus,'already_absent');await tick(runtime);
  const resolved=await alerts(runtime,box);assert.equal(resolved.alerts.find(item=>item.id===releaseAlert.id).status,'resolved');assert.equal(resolved.alerts.find(item=>item.id===syncAlert.id).status,'open');
  assert.equal(state.deletes,1);assert.equal(state.webhooks.length,3);assert.equal(signed(state.webhooks[2],endpoint.secret,[remote.email,remote.id]).type,resolvedType);
});

test('Owner acknowledgment is a CAS-only local action; a failed parent-linked retry reopens the same alert and only actual success resolves it',{timeout:120_000},async t=>{
  const state=stateFor([]);state.failSync=true;const runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),credential=await token(runtime,box),sourceId=randomUUID();
  assert.equal((await runtime.request(`${cfBase(box)}/sync`,{method:'POST',body:{clientRequestId:sourceId}})).status,502);const initial=(await alerts(runtime,box)).alerts[0],path=`${alertBase(box)}/${initial.id}/acknowledge`;
  const before=state.cloudflare.length;
  assert.equal((await runtime.request(path,{method:'POST',authenticated:false,body:{expectedVersion:initial.version}})).status,401);
  assert.equal((await runtime.request(path,{method:'POST',headers:{Origin:'https://evil.example'},body:{expectedVersion:initial.version}})).status,403);
  assert.equal((await runtime.request(path,{method:'POST',authenticated:false,headers:{Authorization:`Bearer ${credential.secret}`},body:{expectedVersion:initial.version}})).status,401);
  const acknowledged=await json(await runtime.request(path,{method:'POST',body:{expectedVersion:initial.version}}));assert.equal(acknowledged.alert.status,'acknowledged');assert.ok(acknowledged.alert.version>initial.version);
  assert.equal((await runtime.request(path,{method:'POST',body:{expectedVersion:initial.version}})).status,409);assert.equal(state.cloudflare.length,before);assert.equal(state.deletes,0);
  const retryPath=`${cfBase(box)}/history/${sourceId}/retry`;
  assert.equal((await runtime.request(retryPath,{method:'POST',body:{kind:'sync',clientRequestId:randomUUID()}})).status,502);
  const reopened=(await alerts(runtime,box)).alerts[0];assert.equal(reopened.id,initial.id);assert.equal(reopened.status,'open');assert.equal(reopened.occurrences,2);
  state.failSync=false;await json(await runtime.request(retryPath,{method:'POST',body:{kind:'sync',clientRequestId:randomUUID()}}));
  const resolved=(await alerts(runtime,box)).alerts[0];assert.equal(resolved.id,initial.id);assert.equal(resolved.status,'resolved');assert.ok(resolved.resolvedAt);
  state.failSync=true;assert.equal((await runtime.request(retryPath,{method:'POST',body:{kind:'sync',clientRequestId:randomUUID()}})).status,502);
  const next=(await alerts(runtime,box)).alerts[0];assert.equal(next.id,initial.id);assert.equal(next.status,'open');assert.equal(next.generation,initial.generation+1);
  const detail=await json(await runtime.request(`${alertBase(box)}/${initial.id}`));assert.ok(detail.timeline.length>=4);safe(detail);assert.equal(state.deletes,0);
});

test('global cron alerts target active matching-domain mailboxes only; webhook retries cannot resolve alerts and Agents cannot enumerate alert events or delivery records',{timeout:120_000},async t=>{
  const state=stateFor([]);state.failSync=true;state.webhookStatus=500;const runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const a=await mailbox(runtime),b=await mailbox(runtime),paused=await mailbox(runtime),foreign={id:randomUUID()},now=Date.now();
  await runtime.db.batch([runtime.db.prepare('INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(foreign.id,'Foreign sender',now,now),
    runtime.db.prepare('INSERT INTO mailbox_addresses(id,mailbox_id,address,is_primary,created_at) VALUES(?,?,?,1,?)').bind(randomUUID(),foreign.id,'foreign@unrelated.example.net',now)]);
  const firstEndpoint=await subscription(runtime,a);await subscription(runtime,b);await subscription(runtime,paused);await subscription(runtime,foreign);
  await json(await runtime.request(`${base(paused)}`,{method:'PATCH',body:{status:'paused',expectedUpdatedAt:paused.updatedAt}}));const credential=await token(runtime,a);
  await tick(runtime);const first=(await alerts(runtime,a)).alerts[0];assert.equal(first.global,true);assert.equal(first.status,'open');assert.equal((await alerts(runtime,b)).alerts[0].id,first.id);assert.equal((await alerts(runtime,paused)).alerts[0].id,first.id);
  assert.equal(state.webhooks.length,2);assert.deepEqual(state.webhooks.map(record=>JSON.parse(record.body).mailboxId).sort(),[a.id,b.id].sort());
  const ownerDeliveries=await json(await runtime.request(`${base(a)}/webhook-deliveries`));const admin=ownerDeliveries.deliveries.find(item=>item.eventType===createdType);assert.ok(admin);assert.equal(admin.state,'pending');
  const events=await json(await agent(runtime,credential.secret,'/v1/events')),deliveries=await json(await agent(runtime,credential.secret,'/v1/webhook-deliveries')),subscriptions=await json(await agent(runtime,credential.secret,'/v1/webhooks'));
  for(const value of [events,deliveries,subscriptions])safe(value,[createdType,resolvedType,first.id]);assert.deepEqual(events.events,[]);assert.deepEqual(deliveries.deliveries,[]);
  assert.equal(events.nextCursor,null);assert.equal(deliveries.nextCursor,null,'Hidden operational deliveries cannot leak through pagination metadata');
  assert.equal((await agent(runtime,credential.secret,`/v1/webhook-deliveries/${admin.id}`)).status,404);
  const client=await clientFor(t,runtime,credential.secret);assert.equal((await client.listTools()).tools.some(item=>item.name.includes('alert')),false);
  for(const name of ['list_mail_events','list_webhook_subscriptions','list_webhook_deliveries'])safe(await tool(client,name),[createdType,resolvedType,first.id]);
  const oauth=await oauthToken(runtime,a);assert.equal((await runtime.request(alertBase(a),{authenticated:false,headers:{Authorization:`Bearer ${oauth.access_token}`}})).status,401);
  assert.equal((await runtime.request(`${alertBase(a)}/${first.id}`,{authenticated:false})).status,401);
  state.webhookStatus=204;await runtime.db.prepare("UPDATE webhook_deliveries SET available_at=0 WHERE state='pending'").run();await tick(runtime);
  const stillOpen=(await alerts(runtime,a)).alerts[0];assert.equal(stillOpen.status,'open');assert.equal(stillOpen.occurrences,first.occurrences);assert.equal(stillOpen.version,first.version);
  const history=await json(await runtime.request(`${base(a)}/webhook-deliveries/${admin.id}`));assert.equal(history.delivery.state,'succeeded');assert.equal(history.attempts.length,2);
  signed(state.webhooks.find(record=>JSON.parse(record.body).mailboxId===a.id),firstEndpoint.secret);
  state.failSync=false;await runtime.db.prepare('UPDATE cloudflare_suppression_sync SET last_attempt_at=0').run();await tick(runtime);
  const resolved=(await alerts(runtime,a)).alerts[0];assert.equal(resolved.id,first.id);assert.equal(resolved.status,'resolved');assert.equal(state.webhooks.length,6);
  assert.ok(state.webhooks.every(record=>[a.id,b.id].includes(JSON.parse(record.body).mailboxId)));assert.equal(state.deletes,0);
});
