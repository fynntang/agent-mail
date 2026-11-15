import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';

const api='https://api.example.com',consoleOrigin='https://console.example.com',resource=`${api}/mcp`,queueName='suppression-events';
const bindings={EMAIL_EVENT_QUEUE:queueName,EMAIL_EVENT_ACCOUNT_ID:'a'.repeat(32),EMAIL_EVENT_ZONE_ID:'b'.repeat(32),
  EMAIL_EVENT_SUBSCRIPTION_ID:'c'.repeat(32),EMAIL_EVENT_DOMAIN:'agent.example.com'};
const base=box=>`/owner/api/mailboxes/${box.id}`;
async function json(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime){return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Suppression agent',localPart:`supp-${randomUUID()}`}}),201)).mailbox;}
async function token(runtime,box,scopes=['mail:read','attachments:read','mail:draft','mail:send']){
  return json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'Suppression test',scopes}}),201);
}
function agent(runtime,secret,path,body){return runtime.mf.dispatchFetch(new URL(path,api),{method:body===undefined?'GET':'POST',
  headers:{Authorization:`Bearer ${secret}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function seedRisk(runtime,box,credential){
  const hard='hard@example.net',soft='soft@example.net',hidden='private-bcc@example.net';
  let draft=(await json(await agent(runtime,credential.secret,'/v1/drafts',{to:[hard,soft],bcc:[hidden],subject:'Suppression integration',text:'Private body'}),201)).draft;
  draft=(await json(await runtime.request(`${base(box)}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:draft.version,contentSha256:draft.contentSha256}}))).draft;
  const queued=await json(await runtime.mf.dispatchFetch(`${api}/v1/drafts/${draft.id}/send`,{method:'POST',headers:{Authorization:`Bearer ${credential.secret}`,
    'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({expectedVersion:draft.version})}),202);
  await (await runtime.mf.getWorker()).scheduled();
  const outbound=await runtime.db.prepare('SELECT * FROM outbound_messages WHERE id=?').bind(queued.outboundId).first();assert.equal(outbound.status,'accepted');assert.ok(outbound.provider_message_id);
  const bodies=[['bounced',hard,'hard'],['bounced',soft,'soft'],['complained',hidden]].map(([kind,recipient,bounce])=>({
    type:`cf.email.sending.message.${kind}`,source:{type:'email.sending',zoneId:bindings.EMAIL_EVENT_ZONE_ID,domain:bindings.EMAIL_EVENT_DOMAIN},
    payload:{eventId:randomUUID(),messageId:outbound.provider_message_id,sender:box.address,recipient,terminal:true,delivery:{status:kind},
      ...(bounce?{bounce:{type:bounce}}:{}),subject:'DO_NOT_EXPOSE_PRIVATE_SUBJECT'},
    metadata:{accountId:bindings.EMAIL_EVENT_ACCOUNT_ID,eventSubscriptionId:bindings.EMAIL_EVENT_SUBSCRIPTION_ID,eventSchemaVersion:1,eventTimestamp:new Date().toISOString()}
  }));
  const messages=bodies.map(body=>({id:randomUUID(),timestamp:new Date(),attempts:1,body}));
  const result=await (await runtime.mf.getWorker()).queue(queueName,messages);assert.equal(result.outcome,'ok');assert.equal(result.explicitAcks.length,3);
  return {hard,soft,hidden,outbound};
}
async function clientFor(t,runtime,secret){
  const client=new Client({name:'suppression-integration',version:'1'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});registerMcpClient(runtime,client);
  await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},fetch:async(input,init)=>{
    const request=new Request(input,init),body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();
    assert.equal(new URL(request.url).origin,api);return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body,signal:request.signal});
  }}),{timeout:10_000});return client;
}
async function tool(client,addresses){const result=await client.callTool({name:'check_recipient_suppressions',arguments:{addresses}},{timeout:10_000});
  assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent;}
async function oauth(runtime,box){
  const redirect='https://suppression-client.example/callback',verifier=randomBytes(32).toString('base64url'),scope='mail:draft mail:send';
  const registered=await json(await runtime.mf.dispatchFetch(`${api}/oauth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    client_name:'Suppression OAuth',redirect_uris:[redirect],scope,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']
  })}),201);
  const url=new URL('/owner/oauth/authorize',consoleOrigin);url.search=new URLSearchParams({client_id:registered.client_id,redirect_uri:redirect,response_type:'code',resource,scope,
    state:randomUUID(),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const page=await runtime.mf.dispatchFetch(url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'}});assert.equal(page.status,200);const html=await page.text();
  const requestId=/name="requestId"[^>]*value="([^"]+)"/.exec(html)?.[1],csrfToken=/name="csrfToken"[^>]*value="([^"]+)"/.exec(html)?.[1];assert.ok(requestId&&csrfToken);
  const form=new URLSearchParams({requestId,csrfToken,decision:'allow',mailboxId:box.id});scope.split(' ').forEach(value=>form.append('scope',value));
  const consent=await runtime.mf.dispatchFetch(url,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Origin:consoleOrigin,'Content-Type':'application/x-www-form-urlencoded',Accept:'text/html'},body:form.toString(),redirect:'manual'});
  assert.equal(consent.status,303);const returned=new URL(consent.headers.get('Location'));
  const tokens=await json(await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
    grant_type:'authorization_code',client_id:registered.client_id,resource,code:returned.searchParams.get('code'),redirect_uri:redirect,code_verifier:verifier
  }).toString()}));return {tokens,clientId:registered.client_id};
}

test('native hard bounce and complaint suppress only proven recipients; scoped API checks and Owner release enforce privacy, Origin and CAS',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime({bindings});t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),other=await mailbox(runtime),sender=await token(runtime,box);
  const reader=await token(runtime,box,['mail:read']),drafter=await token(runtime,box,['mail:draft']),peer=await token(runtime,box,['mail:draft','mail:send']),outsider=await token(runtime,other,['mail:draft','mail:send']);
  const risk=await seedRisk(runtime,box,sender);
  const checked=await json(await agent(runtime,peer.secret,'/v1/recipient-suppressions/check',{addresses:[risk.hard,risk.soft]}));
  assert.deepEqual(checked,{recipients:[{address:risk.hard,suppressed:true,reason:'hard_bounce'},{address:risk.soft,suppressed:false,reason:null}]});
  for(const forbidden of [risk.hidden,'lastEventId','mailboxId','DO_NOT_EXPOSE_PRIVATE_SUBJECT'])assert.equal(JSON.stringify(checked).includes(forbidden),false);
  const complaint=await json(await agent(runtime,peer.secret,'/v1/recipient-suppressions/check',{addresses:[risk.hidden]}));assert.equal(complaint.recipients[0].reason,'complaint');
  assert.equal((await json(await agent(runtime,outsider.secret,'/v1/recipient-suppressions/check',{addresses:[risk.hard]}))).recipients[0].suppressed,false);
  for(const credential of [reader,drafter])assert.equal((await agent(runtime,credential.secret,'/v1/recipient-suppressions/check',{addresses:[risk.hard]})).status,403);
  assert.equal((await agent(runtime,peer.secret,'/v1/recipient-suppressions/check',{addresses:[risk.hard],mailboxId:other.id})).status,400);
  assert.equal((await agent(runtime,peer.secret,'/v1/recipient-suppressions/check',{addresses:[]})).status,400);
  assert.equal((await runtime.request(`${base(box)}/suppressions`,{authenticated:false})).status,401);
  const listing=await json(await runtime.request(`${base(box)}/suppressions`));assert.equal(listing.suppressions.length,2);
  const target=listing.suppressions.find(row=>row.address===risk.hard);assert.ok(target);const path=`${base(box)}/suppressions/${target.id}/release`;
  assert.equal((await runtime.request(path,{method:'POST',headers:{Origin:'https://evil.example'},body:{expectedVersion:target.version}})).status,403);
  assert.equal((await runtime.request(path,{method:'POST',authenticated:false,body:{expectedVersion:target.version}})).status,401);
  assert.equal((await runtime.request(`${base(other)}/suppressions/${target.id}/release`,{method:'POST',body:{expectedVersion:target.version}})).status,404);
  assert.equal((await runtime.request(path,{method:'POST',body:{expectedVersion:target.version+1}})).status,409);
  const released=await json(await runtime.request(path,{method:'POST',body:{expectedVersion:target.version}}));assert.equal(released.suppression.status,'released');assert.equal(released.suppression.version,target.version+1);
  assert.equal((await runtime.request(path,{method:'POST',body:{expectedVersion:target.version}})).status,409);
  assert.equal((await json(await agent(runtime,peer.secret,'/v1/recipient-suppressions/check',{addresses:[risk.hard]}))).recipients[0].suppressed,false);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_attempts').first('n'),1);
});

test('actual MCP static and OAuth checks require live send grants, accept explicitly named addresses only and honor refresh narrowing and revocation',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime({bindings});t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),sender=await token(runtime,box),reader=await token(runtime,box,['mail:read']);
  const risk=await seedRisk(runtime,box,sender),client=await clientFor(t,runtime,sender.secret),readClient=await clientFor(t,runtime,reader.secret);
  const names=(await client.listTools()).tools.map(item=>item.name);assert.equal(names.length,22);assert.ok(names.includes('check_recipient_suppressions'));
  assert.equal(names.includes('list_recipient_suppressions'),false);assert.equal(names.includes('release_recipient_suppression'),false);
  assert.equal((await readClient.listTools()).tools.some(item=>item.name==='check_recipient_suppressions'),false);
  const checked=await tool(client,[risk.hard]);assert.deepEqual(checked,{recipients:[{address:risk.hard,suppressed:true,reason:'hard_bounce'}]});assert.equal(JSON.stringify(checked).includes(risk.hidden),false);
  const injection=await client.callTool({name:'check_recipient_suppressions',arguments:{addresses:[risk.hard],mailboxId:randomUUID()}});assert.equal(injection.isError,true);
  const authorized=await oauth(runtime,box),oauthClient=await clientFor(t,runtime,authorized.tokens.access_token);assert.equal((await tool(oauthClient,[risk.hidden])).recipients[0].reason,'complaint');
  assert.equal((await agent(runtime,authorized.tokens.access_token,'/v1/recipient-suppressions/check',{addresses:[risk.hard]})).status,401);
  const narrowed=await json(await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
    grant_type:'refresh_token',client_id:authorized.clientId,resource,refresh_token:authorized.tokens.refresh_token,scope:'mail:draft'
  }).toString()}));const draftOnly=await clientFor(t,runtime,narrowed.access_token);
  assert.equal((await draftOnly.listTools()).tools.some(item=>item.name==='check_recipient_suppressions'),false);
  assert.equal((await runtime.mf.dispatchFetch(`${api}/oauth/revoke`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
    token:narrowed.access_token,client_id:authorized.clientId
  }).toString()})).status,200);await assert.rejects(draftOnly.callTool({name:'check_recipient_suppressions',arguments:{addresses:[risk.hard]}}));
  await runtime.request(`${base(box)}/tokens/${sender.token.id}`,{method:'DELETE'});
  assert.equal((await agent(runtime,sender.secret,'/v1/recipient-suppressions/check',{addresses:[risk.hard]})).status,401);
  await assert.rejects(client.callTool({name:'check_recipient_suppressions',arguments:{addresses:[risk.hard]}}));
});
