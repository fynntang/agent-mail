import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';

const api='https://api.example.com',accountId='a'.repeat(32),domain='agent.example.com';
const providerToken='DECISIONS_CF_PRIVATE_TEST_ONLY_12345678901234567890';
const createdType='cloudflare.suppression.alert.created',resolvedType='cloudflare.suppression.alert.resolved';
const bindings={EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain,
  WEBHOOK_KEYRING:JSON.stringify({activeKid:'decision-key',keys:{'decision-key':'A'.repeat(43)}})};
const cfPath=`/client/v4/accounts/${accountId}/email/sending/suppressions`;
const base=box=>`/owner/api/mailboxes/${box.id}`,recordPath=box=>`${base(box)}/alert-notification-decisions`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime,name='Decision records'){return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name,localPart:`decisions-${randomUUID()}`}}),201)).mailbox;}
async function tick(runtime){assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
function stateFor(){return {failSync:true,cloudflare:[],webhooks:[]};}
function upstream(state){return async request=>{
  const url=new URL(request.url);
  if(url.hostname==='hooks.example.net'){
    state.webhooks.push({url:request.url,headers:Object.fromEntries(request.headers),body:await request.text()});
    return new Response(url.pathname==='/pending'?'PRIVATE_DECISION_WEBHOOK_RESPONSE':null,{status:url.pathname==='/pending'?500:204});
  }
  assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(url.pathname,cfPath);assert.equal(request.method,'GET');
  assert.equal(request.headers.get('Authorization'),`Bearer ${providerToken}`);state.cloudflare.push(request.url);
  return state.failSync?Response.json({success:false,errors:[{message:'PRIVATE_DECISION_PROVIDER_RESPONSE'}]},{status:500}):
    Response.json({success:true,result:[],result_info:{next_cursor:null}});
};}
async function subscription(runtime,box,path='/success'){
  return json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net${path}?private=PRIVATE_DECISION_URL`,eventTypes:[createdType,resolvedType]}}),201);
}
async function policy(runtime,box,changes={}){
  const current=(await json(await runtime.request(`${base(box)}/alert-notification-policy`))).policy,{version,updatedAt,...settings}=current;
  return (await json(await runtime.request(`${base(box)}/alert-notification-policy`,{method:'PATCH',body:{...settings,...changes,expectedVersion:version}}))).policy;
}
async function fail(runtime,box,id=randomUUID()){
  await json(await runtime.request(`${base(box)}/cloudflare-suppressions/sync`,{method:'POST',body:{clientRequestId:id}}),502);return id;
}
async function retry(runtime,box,parent,failed=true){
  return json(await runtime.request(`${base(box)}/cloudflare-suppressions/history/${parent}/retry`,{method:'POST',body:{kind:'sync',clientRequestId:randomUUID()}}),failed?502:200);
}
async function records(runtime,box,params={}){
  const query=new URLSearchParams(Object.entries(params).map(([key,value])=>[key,String(value)]));
  const result=await json(await runtime.request(`${recordPath(box)}${query.size?'?'+query:''}`));safe(result);return result;
}
function safe(value,more=[]){
  const serialized=JSON.stringify(value);
  for(const text of [providerToken,accountId,domain,'PRIVATE_DECISION_PROVIDER_RESPONSE','PRIVATE_DECISION_WEBHOOK_RESPONSE','PRIVATE_DECISION_URL',
    'claim_token','url_snapshot','signing_secret_ciphertext','payload_json','request_hash','lease_token',...more])assert.equal(serialized.includes(text),false,text);
}
function signed(record,secret){
  const signature=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(record.headers['x-agent-mail-signature']);assert.ok(signature);
  assert.equal(signature[2],createHmac('sha256',secret).update(`${signature[1]}.${record.headers['x-agent-mail-delivery']}.${record.body}`).digest('hex'));
  return JSON.parse(record.body);
}
async function receipt(runtime,box,{alertId,at,payload,type=createdType}={}){
  const eventId=randomUUID(),claim=randomUUID();
  await runtime.db.batch([
    runtime.db.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at,webhook_published_at)
      VALUES(?,?,'app',?,?,?,?,?,?)`).bind(eventId,box.id,randomUUID(),type,JSON.stringify(payload??{alertId,kind:'sync',status:'open',outcome:'failed',errorCode:'cloudflare_api_unavailable'}),at,at,at),
    runtime.db.prepare(`INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token)
      VALUES(?,?,?,'no_subscribers',0,?,?)`).bind(eventId,box.id,alertId,at,claim)
  ]);return {eventId,claim};
}
async function evidence(runtime){
  const value={};for(const table of ['alert_notification_decisions','alert_notification_state','cloudflare_suppression_alerts','events','audit_events','webhook_deliveries','webhook_delivery_attempts'])
    value[table]=(await runtime.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return value;
}

test('decision history counts one mailbox notification across two destinations and reports all six admission reasons separately from live delivery outcomes',{timeout:120_000},async t=>{
  const state=stateFor(),runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),success=await subscription(runtime,box),pending=await subscription(runtime,box,'/pending');
  await policy(runtime,box,{repeatIntervalSeconds:3600});const source=await fail(runtime,box);await tick(runtime);
  assert.equal(state.webhooks.length,2);for(const record of state.webhooks)signed(record,record.url.includes('/pending')?pending.secret:success.secret);
  const first=await records(runtime,box);assert.equal(first.summary.total,1);assert.equal(first.summary.allowed,1);assert.equal(first.summary.skipped,0);
  assert.equal(first.summary.delivery.total,2);assert.equal(first.summary.delivery.succeeded,1);assert.equal(first.summary.delivery.pending,1);assert.equal(first.summary.delivery.attempts,2);
  const admitted=first.decisions[0];assert.equal(admitted.decision,'allowed');assert.equal(admitted.eventType,'created');assert.equal(admitted.eventAvailable,true);assert.equal(admitted.policyVersion,1);
  const detail=await json(await runtime.request(`${recordPath(box)}/${admitted.eventId}`));safe(detail,[success.secret,pending.secret]);
  assert.equal(detail.deliveries.length,2);assert.equal(detail.deliveriesTruncated,false);assert.equal(detail.decision.eventId,admitted.eventId);
  assert.deepEqual(detail.deliveries.map(item=>item.state).sort(),['pending','succeeded']);
  for(const delivery of detail.deliveries){const attempt=await json(await runtime.request(`${base(box)}/webhook-deliveries/${delivery.id}`));assert.equal(attempt.attempts.length,1);}
  await retry(runtime,box,source);await tick(runtime);
  const minute=new Date().getUTCHours()*60+new Date().getUTCMinutes();await policy(runtime,box,{quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440});
  await retry(runtime,box,source);await tick(runtime);
  await policy(runtime,box,{enabled:false,quietEnabled:false});await retry(runtime,box,source);await tick(runtime);
  await policy(runtime,box,{enabled:true,recoveryEnabled:false});state.failSync=false;await retry(runtime,box,source,false);await tick(runtime);
  for(const endpoint of [success.endpoint,pending.endpoint])await json(await runtime.request(`${base(box)}/webhooks/${endpoint.id}`,{method:'PATCH',body:{expectedUpdatedAt:endpoint.updatedAt,status:'paused'}}));
  state.failSync=true;await fail(runtime,box);await tick(runtime);
  const final=await records(runtime,box);assert.equal(final.summary.total,6);assert.equal(final.summary.allowed,1);assert.equal(final.summary.skipped,5);
  assert.deepEqual(final.summary.byDecision,{allowed:1,disabled:1,quiet_hours:1,repeat_limited:1,recovery_disabled:1,no_subscribers:1});
  assert.equal(final.summary.delivery.total,2);assert.equal(final.summary.delivery.succeeded,1);assert.equal(final.summary.delivery.cancelled,1);assert.equal(final.summary.delivery.pending,0);assert.equal(final.summary.delivery.attempts,2);
  assert.equal(state.webhooks.length,2,'Reading and suppressed events cannot issue fresh requests');
  for(const reason of Object.keys(final.summary.byDecision)){
    const filtered=await records(runtime,box,{decision:reason});assert.equal(filtered.decisions.length,1);assert.equal(filtered.summary.total,1);assert.equal(filtered.summary.byDecision[reason],1);
  }
  const recovery=await records(runtime,box,{eventType:'resolved'});assert.equal(recovery.summary.total,1);assert.equal(recovery.decisions[0].outcome,'resolved');assert.equal(recovery.decisions[0].decision,'recovery_disabled');
  assert.equal((await records(runtime,box,{eventType:'created'})).summary.total,5);
});

test('decision cursors bind mailbox, filters, window and size and preserve a high-water snapshot even when a later insert is backdated',{timeout:120_000},async t=>{
  const state=stateFor(),runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),other=await mailbox(runtime);const source=await fail(runtime,box);await tick(runtime);
  for(let index=0;index<4;index++){await retry(runtime,box,source);await tick(runtime);}
  const page=await records(runtime,box,{limit:2});assert.equal(page.decisions.length,2);assert.equal(page.summary.total,5);assert.ok(page.nextCursor);
  const backdated=await receipt(runtime,box,{alertId:page.decisions[0].alertId,at:page.window.from+1});
  const ids=page.decisions.map(item=>item.eventId);let cursor=page.nextCursor;
  while(cursor){const next=await records(runtime,box,{limit:2,cursor});assert.deepEqual(next.window,page.window);assert.equal(next.summary.total,5);ids.push(...next.decisions.map(item=>item.eventId));cursor=next.nextCursor;}
  assert.equal(ids.length,5);assert.equal(new Set(ids).size,5);assert.equal(ids.includes(backdated.eventId),false);
  const fresh=await records(runtime,box,{from:page.window.from,to:page.window.to});assert.equal(fresh.summary.total,6);assert.ok(fresh.decisions.some(item=>item.eventId===backdated.eventId));
  const exact=await records(runtime,box,{from:page.window.from+1,to:page.window.from+2});assert.equal(exact.summary.total,1);assert.equal(exact.decisions[0].eventId,backdated.eventId);
  const mismatch=[`${recordPath(other)}?limit=2&cursor=${page.nextCursor}`,`${recordPath(box)}?limit=3&cursor=${page.nextCursor}`,
    `${recordPath(box)}?limit=2&decision=disabled&cursor=${page.nextCursor}`,`${recordPath(box)}?limit=2&eventType=resolved&cursor=${page.nextCursor}`,
    `${recordPath(box)}?limit=2&from=${page.window.from+1}&to=${page.window.to}&cursor=${page.nextCursor}`];
  for(const path of mismatch)assert.equal((await runtime.request(path)).status,400,path);
  for(const query of ['limit=0','limit=101','limit=2.5','decision=private','eventType=unknown','from=abc','from=1&to=1','from=0&to=2678400001','cursor=bad!',
    'decision=allowed&decision=quiet_hours','extra=1'])assert.equal((await runtime.request(`${recordPath(box)}?${query}`)).status,400,query);
  const before=await evidence(runtime),network=state.cloudflare.length+state.webhooks.length;
  const detail=await json(await runtime.request(`${recordPath(box)}/${backdated.eventId}`));safe(detail,[backdated.claim]);assert.equal(detail.decision.eventAvailable,true);assert.deepEqual(detail.deliveries,[]);
  await records(runtime,box,{from:page.window.from,to:page.window.to,limit:1});assert.deepEqual(await evidence(runtime),before);assert.equal(state.cloudflare.length+state.webhooks.length,network);
  assert.equal((await runtime.request(`${recordPath(other)}/${backdated.eventId}`)).status,404);assert.equal((await runtime.request(`${recordPath(box)}/not-uuid`)).status,404);
});

async function oauthToken(runtime,box){
  const resource=`${api}/mcp`,redirect='https://decision-client.example/callback',verifier=randomBytes(32).toString('base64url');
  const registered=await json(await runtime.mf.dispatchFetch(`${api}/oauth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Decision denied OAuth',redirect_uris:[redirect],scope:'mail:read',token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']})}),201);
  const url=new URL('/owner/oauth/authorize','https://console.example.com');url.search=new URLSearchParams({client_id:registered.client_id,redirect_uri:redirect,response_type:'code',resource,scope:'mail:read',state:randomUUID(),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const response=await runtime.mf.dispatchFetch(url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'}});assert.equal(response.status,200);const html=await response.text();
  const requestId=/name="requestId"[^>]*value="([^"]+)"/.exec(html)?.[1],csrfToken=/name="csrfToken"[^>]*value="([^"]+)"/.exec(html)?.[1];assert.ok(requestId&&csrfToken);
  const consent=await runtime.mf.dispatchFetch(url,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Origin:'https://console.example.com','Content-Type':'application/x-www-form-urlencoded',Accept:'text/html'},body:new URLSearchParams({requestId,csrfToken,decision:'allow',mailboxId:box.id,scope:'mail:read'}).toString(),redirect:'manual'});assert.equal(consent.status,303);
  return json(await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:registered.client_id,resource,code:new URL(consent.headers.get('Location')).searchParams.get('code'),redirect_uri:redirect,code_verifier:verifier}).toString()}));
}
async function clientFor(t,runtime,secret){
  const client=new Client({name:'decision-negative-integration',version:'1'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});registerMcpClient(runtime,client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},fetch:async(input,init)=>{
    const request=new Request(input,init);return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),signal:request.signal});
  }}),{timeout:10_000});return client;
}

test('only Owner reads decision evidence, including paused and credential-missing mailboxes; static and OAuth MCP grants expose no operational decisions',{timeout:120_000},async t=>{
  const state=stateFor(),runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),endpoint=await subscription(runtime,box);await fail(runtime,box);await tick(runtime);
  const item=(await records(runtime,box)).decisions[0],path=`${recordPath(box)}/${item.eventId}`;
  const token=await json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'Decision denied',scopes:['mail:read']}}),201),oauth=await oauthToken(runtime,box);
  for(const location of [recordPath(box),path]){
    assert.equal((await runtime.request(location,{authenticated:false})).status,401);
    for(const secret of [token.secret,oauth.access_token])assert.equal((await runtime.request(location,{authenticated:false,headers:{Authorization:`Bearer ${secret}`}})).status,401);
    assert.equal((await runtime.request(location,{method:'POST',body:{}})).status,405);
  }
  assert.equal((await runtime.mf.dispatchFetch(`${api}/v1/alert-notification-decisions`,{headers:{Authorization:`Bearer ${token.secret}`}})).status,404);
  for(const secret of [token.secret,oauth.access_token]){
    const client=await clientFor(t,runtime,secret),tools=await client.listTools();assert.equal(tools.tools.some(tool=>tool.name.includes('notification_decision')),false);
    for(const name of ['list_mail_events','list_webhook_deliveries']){
      const result=await client.callTool({name,arguments:{}});assert.notEqual(result.isError,true);safe(result,[item.eventId,item.alertId]);
    }
  }
  await json(await runtime.request(base(box),{method:'PATCH',body:{status:'paused',expectedUpdatedAt:box.updatedAt}}));
  await runtime.updateBindings({EMAIL_SUPPRESSIONS_API_TOKEN:''});const before=await evidence(runtime),network=state.cloudflare.length+state.webhooks.length;
  const listResponse=await runtime.request(recordPath(box));assert.match(listResponse.headers.get('Cache-Control'),/no-store/);const result=await json(listResponse);assert.equal(result.summary.total,1);
  const detail=await json(await runtime.request(path));assert.equal(detail.deliveries[0].state,'succeeded');safe(detail,[endpoint.secret]);
  assert.deepEqual(await evidence(runtime),before);assert.equal(state.cloudflare.length+state.webhooks.length,network);
});

test('corrupt event metadata is reported as unavailable while immutable decision evidence and noise counts remain inspectable without exposing payload content',{timeout:120_000},async t=>{
  const state=stateFor(),runtime=await createOwnerRuntime({bindings,outboundService:upstream(state)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime);await fail(runtime,box);await tick(runtime);const original=(await records(runtime,box)).decisions[0];
  const corrupt=await receipt(runtime,box,{alertId:original.alertId,at:Date.now()-1,payload:{alertId:'invalid',kind:'PRIVATE_CORRUPT_BODY',status:'open',outcome:'PRIVATE_CORRUPT_BODY'}});
  const result=await records(runtime,box);assert.equal(result.summary.total,2);assert.equal(result.summary.byDecision.no_subscribers,2);
  const item=result.decisions.find(record=>record.eventId===corrupt.eventId);assert.ok(item);assert.equal(item.eventAvailable,false);
  for(const key of ['eventType','kind','outcome','errorCode','occurredAt'])assert.equal(item[key],null,key);
  const detail=await json(await runtime.request(`${recordPath(box)}/${corrupt.eventId}`));assert.equal(detail.decision.eventAvailable,false);assert.deepEqual(detail.deliveries,[]);safe(detail,[corrupt.claim,'PRIVATE_CORRUPT_BODY']);
});
