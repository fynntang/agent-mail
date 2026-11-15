import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';

const api='https://api.example.com',consoleOrigin='https://console.example.com',resource=`${api}/mcp`;
const keyring=JSON.stringify({activeKid:'key-1',keys:{'key-1':'A'.repeat(43)}});
const bindings={WEBHOOK_KEYRING:keyring};
const types=['message.received','outbound.accepted','outbound.failed','outbound.unknown',
  'outbound.delivered','outbound.deferred','outbound.bounced','outbound.rejected','outbound.complained'];
const privateMarker='WEBHOOK_PRIVATE_CONTENT_'+randomUUID();
const base=box=>`/owner/api/mailboxes/${box.id}`;
async function json(response,status=200) {assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime) {
  return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Webhook agent',localPart:`wh-${randomUUID()}`}}),201)).mailbox;
}
async function token(runtime,box,scopes=['mail:read']) {
  return json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'Webhook observer',scopes}}),201);
}
function agent(runtime,secret,path,{method='GET',body,headers={}}={}) {
  return runtime.mf.dispatchFetch(new URL(path,api),{method,headers:{Authorization:`Bearer ${secret}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function endpoint(runtime,box,url='https://hooks.example.net/mail?private_token=DESTINATION_QUERY_SECRET',eventTypes=types) {
  const result=await json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url,eventTypes}}),201);
  assert.match(result.secret,/^whsec_/);assert.equal(result.endpoint.url,url);return result;
}
async function patch(runtime,box,subscription,changes) {
  return (await json(await runtime.request(`${base(box)}/webhooks/${subscription.id}`,{method:'PATCH',body:{expectedUpdatedAt:subscription.updatedAt,...changes}}))).endpoint;
}
async function delivery(runtime,box,id) {
  return json(await runtime.request(`${base(box)}/webhook-deliveries/${id}`));
}
async function deliveries(runtime,box) {
  return (await json(await runtime.request(`${base(box)}/webhook-deliveries`))).deliveries;
}
async function tick(runtime) {assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
async function inbound(runtime,box) {
  const subject=`${privateMarker} ${randomUUID()}`,raw=[`Message-ID: <${randomUUID()}@agentmail.test>`,
    'From: Private Sender <private-sender@example.net>',`To: ${box.address}`,`Subject: ${subject}`,
    'MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','',`${privateMarker} body and private-bcc@example.net`,''].join('\r\n');
  const response=await runtime.mf.dispatchFetch(`http://localhost/cdn-cgi/local/email?from=private-sender%40example.net&to=${encodeURIComponent(box.address)}&format=json`,{
    method:'POST',headers:{'Content-Type':'message/rfc822'},body:raw
  });assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).outcome,'ok');await tick(runtime);
  const message=await runtime.db.prepare('SELECT * FROM messages WHERE mailbox_id=? AND subject=?').bind(box.id,subject).first();assert.ok(message);return message;
}
async function capture(request,calls,status=204,headers={}) {
  calls.push({url:request.url,method:request.method,headers:Object.fromEntries(request.headers),body:await request.text()});
  return new Response(status===204?null:'UPSTREAM_PRIVATE_DIAGNOSTIC',{status,headers});
}
function signed(call,secret,{eventType,attempt=1,secretVersion=1}={}) {
  assert.equal(call.method,'POST');assert.match(call.headers['content-type'],/^application\/json/);
  assert.equal(call.headers['x-agent-mail-attempt'],String(attempt));assert.equal(call.headers['x-agent-mail-secret-version'],String(secretVersion));
  assert.equal(call.headers['x-agent-mail-event'],eventType);assert.match(call.headers['x-agent-mail-delivery'],/^[a-f0-9-]{36}$/);
  const signature=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(call.headers['x-agent-mail-signature']);assert.ok(signature);
  const expected=createHmac('sha256',secret).update(`${signature[1]}.${call.headers['x-agent-mail-delivery']}.${call.body}`).digest('hex');assert.equal(signature[2],expected);
  assert.ok(Math.abs(Number(signature[1])-Math.floor(Date.now()/1000))<120);
  for(const header of ['authorization','cookie','cf-access-jwt-assertion','origin','referer'])assert.equal(call.headers[header],undefined,header);
  const body=JSON.parse(call.body);assert.deepEqual(Object.keys(body).sort(),['v','id','type','mailboxId','occurredAt','data'].sort());
  assert.equal(body.v,1);assert.equal(body.type,eventType);assert.ok(Number.isSafeInteger(body.occurredAt));
  assert.equal(call.body.includes(privateMarker),false);assert.equal(call.body.includes('private-sender@example.net'),false);assert.equal(call.body.includes('private-bcc@example.net'),false);
  return body;
}
function redacted(value,secrets=[]) {
  const serialized=JSON.stringify(value);
  for(const forbidden of [privateMarker,'DESTINATION_QUERY_SECRET','https://hooks.','private-sender@example.net','private-bcc@example.net',
    'UPSTREAM_PRIVATE_DIAGNOSTIC','signing_secret_ciphertext','ciphertext','whsec_','WEBHOOK_KEYRING','activeKid',keyring,'payload_json','object_key','sha256',...secrets])assert.equal(serialized.includes(forbidden),false,forbidden);
}
async function clientFor(t,runtime,secret) {
  const client=new Client({name:'webhook-observer',version:'1.0.0'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});registerMcpClient(runtime,client);
  await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},
    fetch:async(input,init)=>{const request=new Request(input,init);assert.equal(new URL(request.url).origin,api);
      const body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body,signal:request.signal});}
  }),{timeout:10_000});return client;
}
async function tool(client,name,args={}) {
  const result=await client.callTool({name,arguments:args},{timeout:10_000});assert.notEqual(result.isError,true,JSON.stringify(result));assert.ok(result.structuredContent);return result.structuredContent;
}
async function oauthRead(runtime,box) {
  const redirect='https://webhook-client.example/callback',verifier=randomBytes(32).toString('base64url');
  const registered=await json(await runtime.mf.dispatchFetch(`${api}/oauth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    client_name:'Webhook OAuth reader',redirect_uris:[redirect],scope:'mail:read',token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']
  })}),201);
  const url=new URL('/owner/oauth/authorize',consoleOrigin);url.search=new URLSearchParams({client_id:registered.client_id,redirect_uri:redirect,response_type:'code',
    resource,scope:'mail:read',state:randomUUID(),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const page=await runtime.mf.dispatchFetch(url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'}});assert.equal(page.status,200);const html=await page.text();
  const requestId=/name="requestId"[^>]*value="([^"]+)"/.exec(html)?.[1],csrfToken=/name="csrfToken"[^>]*value="([^"]+)"/.exec(html)?.[1];assert.ok(requestId&&csrfToken);
  const consent=await runtime.mf.dispatchFetch(url,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Origin:consoleOrigin,'Content-Type':'application/x-www-form-urlencoded',Accept:'text/html'},
    body:new URLSearchParams({requestId,csrfToken,decision:'allow',mailboxId:box.id,scope:'mail:read'}).toString(),redirect:'manual'});
  assert.equal(consent.status,303);const returned=new URL(consent.headers.get('Location'));
  return json(await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
    grant_type:'authorization_code',client_id:registered.client_id,resource,code:returned.searchParams.get('code'),redirect_uri:redirect,code_verifier:verifier
  }).toString()}));
}

test('native inbound and outbound events fan out once to signed privacy-preserving HTTPS POSTs in the same scheduled Worker',{timeout:120_000},async t=>{
  const calls=[];const runtime=await createOwnerRuntime({bindings,outboundService:request=>capture(request,calls)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),created=await endpoint(runtime,box),read=await token(runtime,box);
  const message=await inbound(runtime,box);assert.equal(calls.length,1);const received=signed(calls[0],created.secret,{eventType:'message.received'});
  assert.equal(received.mailboxId,box.id);assert.deepEqual(received.data,{messageId:message.id});
  let draft=(await json(await runtime.request(`${base(box)}/drafts`,{method:'POST',body:{to:['recipient@example.net'],bcc:['private-bcc@example.net'],subject:privateMarker,text:privateMarker}}),201)).draft;
  draft=(await json(await runtime.request(`${base(box)}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:draft.version,contentSha256:draft.contentSha256}}))).draft;
  const sent=await json(await runtime.request(`${base(box)}/drafts/${draft.id}/send`,{method:'POST',headers:{'Idempotency-Key':'webhook-native-outbound'},body:{expectedVersion:draft.version}}),202);
  await tick(runtime);assert.equal(calls.length,2);const accepted=signed(calls[1],created.secret,{eventType:'outbound.accepted'});
  assert.deepEqual(accepted.data,{outboundId:sent.outboundId,status:'accepted'});assert.equal(accepted.mailboxId,box.id);
  assert.equal(await runtime.db.prepare('SELECT status FROM outbound_messages WHERE id=?').bind(sent.outboundId).first('status'),'accepted');
  await tick(runtime);assert.equal(calls.length,2,'Re-running scheduled never duplicates an endpoint/event delivery');
  // Provider outcomes may contain additional untrusted data. Only the four public event projections may leave the Worker.
  const projected=['outbound.failed','outbound.unknown','outbound.opened'];
  await runtime.db.batch(projected.map(type=>runtime.db.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at)
    VALUES(?,?,'app',?,?,?,?,?)`).bind(randomUUID(),box.id,randomUUID(),type,JSON.stringify({outboundId:randomUUID(),status:type.split('.')[1],subject:privateMarker,
      bcc:['private-bcc@example.net'],body:privateMarker,object_key:'PRIVATE_R2_KEY'}),Date.now(),Date.now())));
  await tick(runtime);assert.equal(calls.length,4);for(const call of calls.slice(2)){const eventType=JSON.parse(call.body).type;assert.ok(['outbound.failed','outbound.unknown'].includes(eventType));
    const projectedBody=signed(call,created.secret,{eventType});assert.deepEqual(Object.keys(projectedBody.data).sort(),['outboundId','status']);}
  const page=await json(await agent(runtime,read.secret,'/v1/events'));assert.equal(page.events.length,4);redacted(page,[created.secret]);
  const rows=await deliveries(runtime,box);assert.equal(rows.length,4);assert.ok(rows.every(row=>row.state==='succeeded'&&row.attempts===1&&row.attemptBudget===8));
  assert.equal(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read'),0);
});

test('Owner Access/Origin, HTTPS target rules and immutable URLs protect subscription management while Agent endpoints remain read-only',{timeout:120_000},async t=>{
  const calls=[];const runtime=await createOwnerRuntime({bindings,outboundService:request=>capture(request,calls)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),other=await mailbox(runtime),read=await token(runtime,box),path=`${base(box)}/webhooks`;
  assert.equal((await runtime.request(path,{method:'POST',authenticated:false,body:{url:'https://hooks.example.net/denied',eventTypes:types}})).status,401);
  assert.equal((await runtime.request(path,{method:'POST',headers:{Origin:'https://evil.example'},body:{url:'https://hooks.example.net/denied',eventTypes:types}})).status,403);
  for(const url of ['http://hooks.example.net/mail','https://127.0.0.1/mail','https://[::1]/mail','https://localhost/mail','https://single/mail',
    'https://private.internal/mail','https://console.example.com/owner/api/setup','https://api.example.com/v1/messages','https://user:pass@hooks.example.net/mail','https://hooks.example.net:8443/mail']) {
    assert.equal((await runtime.request(path,{method:'POST',body:{url,eventTypes:types}})).status,400,url);
  }
  assert.equal((await runtime.request(path,{method:'POST',body:{url:'https://hooks.example.net/mail',eventTypes:['outbound.opened']}})).status,400);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM webhook_endpoints').first('n'),0);
  const created=await endpoint(runtime,box),ownerList=await json(await runtime.request(path));assert.equal(ownerList.endpoints[0].url,created.endpoint.url);assert.equal('secret' in ownerList.endpoints[0],false);
  const listing=await json(await agent(runtime,read.secret,'/v1/webhooks'));assert.equal(listing.configured,true);assert.deepEqual([...listing.eventTypes].sort(),[...types].sort());
  assert.equal(listing.endpoints[0].url,null);redacted(listing,[created.secret]);
  for(const method of ['POST','PATCH','DELETE'])assert.equal((await agent(runtime,read.secret,'/v1/webhooks',{method,body:{url:'https://hooks.example.net/injected'}})).status,405);
  assert.equal((await runtime.request(`${path}/${created.endpoint.id}`,{method:'PATCH',body:{expectedUpdatedAt:created.endpoint.updatedAt,url:'https://hooks.example.net/changed'}})).status,400);
  assert.equal((await runtime.request(`${base(other)}/webhooks/${created.endpoint.id}`,{method:'PATCH',body:{expectedUpdatedAt:created.endpoint.updatedAt,status:'paused'}})).status,404);
  assert.equal((await runtime.request(`${path}/${created.endpoint.id}/rotate`,{method:'POST',authenticated:false,headers:{Authorization:`Bearer ${read.secret}`},body:{expectedUpdatedAt:created.endpoint.updatedAt}})).status,401);
  for(let index=1;index<10;index++)await endpoint(runtime,box,`https://hooks.example.net/cap-${index}`);
  assert.equal((await runtime.request(path,{method:'POST',body:{url:'https://hooks.example.net/over-cap',eventTypes:types}})).status,409);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM webhook_endpoints WHERE mailbox_id=?').bind(box.id).first('n'),10);
  await patch(runtime,box,created.endpoint,{status:'disabled'});await endpoint(runtime,box,'https://hooks.example.net/replacement');
  assert.equal(await runtime.db.prepare("SELECT count(*) n FROM webhook_endpoints WHERE mailbox_id=? AND status<>'disabled'").bind(box.id).first('n'),10);
  assert.deepEqual(calls,[],'Management validation and listing do not contact destinations');
});

test('HTTP failures retry with frozen signed content, exhaust eight attempts and permit only Owner dead-delivery replay with a larger monotonic budget',{timeout:120_000},async t=>{
  let responseStatus=500;const calls=[];const runtime=await createOwnerRuntime({bindings,outboundService:request=>capture(request,calls,responseStatus,{'Retry-After':'999999'})});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),created=await endpoint(runtime,box,undefined,['message.received']);await inbound(runtime,box);
  let rows=await deliveries(runtime,box),current=rows[0];assert.equal(current.state,'pending');assert.equal(current.attempts,1);assert.ok(current.availableAt>Date.now()+50_000);
  assert.ok(current.availableAt<=Date.now()+24*60*60*1000+5000,'Retry-After is capped at24hours');
  assert.equal((await runtime.request(`${base(box)}/webhook-deliveries/${current.id}/retry`,{method:'POST',body:{}})).status,409);
  for(let attempt=2;attempt<=8;attempt++) {await runtime.db.prepare("UPDATE webhook_deliveries SET available_at=0 WHERE id=? AND state='pending'").bind(current.id).run();await tick(runtime);}
  const dead=await delivery(runtime,box,current.id);assert.equal(dead.delivery.state,'dead');assert.equal(dead.delivery.attempts,8);assert.equal(dead.delivery.attemptBudget,8);
  assert.equal(dead.attempts.length,8);assert.deepEqual(dead.attempts.map(item=>item.attemptNo).sort((a,b)=>a-b),[1,2,3,4,5,6,7,8]);
  for(let index=0;index<calls.length;index++){signed(calls[index],created.secret,{eventType:'message.received',attempt:index+1});assert.equal(calls[index].body,calls[0].body);}
  redacted(dead,[created.secret]);assert.equal(calls.length,8);
  assert.equal((await runtime.request(`${base(box)}/webhook-deliveries/${current.id}/retry`,{method:'POST',headers:{Origin:'https://evil.example'},body:{}})).status,403);
  const replay=await json(await runtime.request(`${base(box)}/webhook-deliveries/${current.id}/retry`,{method:'POST',body:{}}));
  assert.equal(replay.delivery.id,current.id);assert.equal(replay.delivery.attempts,8);assert.equal(replay.delivery.attemptBudget,16);responseStatus=204;
  await tick(runtime);assert.equal(calls.length,9);signed(calls[8],created.secret,{eventType:'message.received',attempt:9});assert.equal(calls[8].body,calls[0].body);
  const completed=await delivery(runtime,box,current.id);assert.equal(completed.delivery.state,'succeeded');assert.equal(completed.delivery.attempts,9);assert.equal(completed.attempts.length,9);
});

test('rotation preserves pending delivery signing secrets while subsequent events use the newly issued version and redirects are never followed',{timeout:120_000},async t=>{
  const calls=[];const runtime=await createOwnerRuntime({bindings,outboundService:request=>capture(request,calls,
    request.url.includes('/redirect')?302:calls.length===0?500:204,request.url.includes('/redirect')?{Location:'https://127.0.0.1/private'}:{})});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),created=await endpoint(runtime,box,'https://hooks.example.net/rotate',['message.received']);await inbound(runtime,box);
  const pending=(await deliveries(runtime,box))[0];assert.equal(pending.state,'pending');
  const rotated=await json(await runtime.request(`${base(box)}/webhooks/${created.endpoint.id}/rotate`,{method:'POST',body:{expectedUpdatedAt:created.endpoint.updatedAt}}));
  assert.notEqual(rotated.secret,created.secret);assert.equal(rotated.endpoint.secretVersion,2);await runtime.db.prepare('UPDATE webhook_deliveries SET available_at=0 WHERE id=?').bind(pending.id).run();
  await tick(runtime);signed(calls[1],created.secret,{eventType:'message.received',attempt:2,secretVersion:1});assert.equal(calls[1].body,calls[0].body);
  await inbound(runtime,box);signed(calls[2],rotated.secret,{eventType:'message.received',secretVersion:2});
  assert.notEqual(JSON.parse(calls[2].body).id,JSON.parse(calls[0].body).id);assert.equal((await delivery(runtime,box,pending.id)).delivery.secretVersion,1);
  const redirectBox=await mailbox(runtime),redirect=await endpoint(runtime,redirectBox,'https://hooks.example.net/redirect',['message.received']);await inbound(runtime,redirectBox);
  const rejected=(await deliveries(runtime,redirectBox))[0];assert.equal(rejected.state,'dead');assert.equal(rejected.lastHttpStatus,302);
  assert.equal(calls.length,4);assert.ok(calls.every(call=>new URL(call.url).hostname==='hooks.example.net'));signed(calls[3],redirect.secret,{eventType:'message.received'});
});

test('Token REST, MCP and OAuth expose only mailbox-scoped metadata; pauses cancel pending work and revoked readers lose access',{timeout:120_000},async t=>{
  const calls=[];let status=500;const runtime=await createOwnerRuntime({bindings,outboundService:request=>capture(request,calls,status)});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),other=await mailbox(runtime),created=await endpoint(runtime,box),hidden=await endpoint(runtime,other,'https://hooks.other-example.net/private');
  const read=await token(runtime,box),outsider=await token(runtime,other),draftOnly=await token(runtime,box,['mail:draft']);
  const message=await inbound(runtime,box),pending=(await deliveries(runtime,box))[0];const beforeCalls=calls.length;
  const client=await clientFor(t,runtime,read.secret),names=(await client.listTools()).tools.map(item=>item.name);
  for(const name of ['list_mail_events','list_webhook_subscriptions','list_webhook_deliveries'])assert.ok(names.includes(name));
  assert.equal(names.length,8);for(const forbidden of ['create_webhook','rotate_webhook','retry_webhook_delivery'])assert.equal(names.includes(forbidden),false);
  const draftClient=await clientFor(t,runtime,draftOnly.secret);assert.equal((await draftClient.listTools()).tools.some(item=>item.name.startsWith('list_webhook')||item.name==='list_mail_events'),false);
  const subscriptions=await tool(client,'list_webhook_subscriptions');assert.equal(subscriptions.endpoints.length,1);assert.equal(subscriptions.endpoints[0].id,created.endpoint.id);assert.equal(subscriptions.endpoints[0].url,null);
  const events=await tool(client,'list_mail_events',{limit:1});assert.equal(events.events.length,1);assert.equal(events.events[0].data.messageId,message.id);
  const records=await tool(client,'list_webhook_deliveries',{endpointId:created.endpoint.id,limit:1});assert.equal(records.deliveries[0].id,pending.id);redacted({subscriptions,events,records},[created.secret,hidden.secret]);
  const foreignFilter=await client.callTool({name:'list_webhook_deliveries',arguments:{endpointId:hidden.endpoint.id}});
  assert.equal(foreignFilter.isError,true);assert.equal(foreignFilter.structuredContent.error.status,404);
  const scopeInjection=await client.callTool({name:'list_mail_events',arguments:{mailboxId:other.id}});assert.equal(scopeInjection.isError,true);
  const detail=await json(await agent(runtime,read.secret,`/v1/webhook-deliveries/${pending.id}`));redacted(detail,[created.secret]);assert.equal(detail.delivery.id,pending.id);
  assert.equal((await agent(runtime,outsider.secret,`/v1/webhook-deliveries/${pending.id}`)).status,404);assert.equal((await agent(runtime,draftOnly.secret,'/v1/events')).status,403);
  assert.equal((await agent(runtime,read.secret,`/v1/webhook-deliveries/${pending.id}/retry`,{method:'POST',body:{}})).status,404);
  const oauth=await oauthRead(runtime,box),oauthClient=await clientFor(t,runtime,oauth.access_token);
  const oauthMetadata=await tool(oauthClient,'list_webhook_subscriptions');assert.equal(oauthMetadata.endpoints[0].url,null);redacted(oauthMetadata,[created.secret]);
  assert.equal((await agent(runtime,oauth.access_token,'/v1/events')).status,401);assert.equal(calls.length,beforeCalls,'Read-only records never send callbacks');
  const paused=await patch(runtime,box,created.endpoint,{status:'paused'});assert.equal((await delivery(runtime,box,pending.id)).delivery.state,'cancelled');
  await tick(runtime);assert.equal(calls.length,beforeCalls);await inbound(runtime,box);assert.equal(calls.length,beforeCalls);
  const resumed=await patch(runtime,box,paused,{status:'active'});status=204;await inbound(runtime,box);assert.equal(calls.length,beforeCalls+1,'Resume subscribes only to future events');
  const disabled=await patch(runtime,box,resumed,{status:'disabled'});assert.equal((await runtime.request(`${base(box)}/webhooks/${disabled.id}`,{method:'PATCH',body:{expectedUpdatedAt:disabled.updatedAt,status:'active'}})).status,409);
  await runtime.request(`${base(box)}/tokens/${read.token.id}`,{method:'DELETE'});assert.equal((await agent(runtime,read.secret,'/v1/events')).status,401);
  await assert.rejects(client.callTool({name:'list_mail_events',arguments:{}}));
  const allEvents=await json(await agent(runtime,(await token(runtime,box)).secret,'/v1/events?limit=1'));assert.ok(allEvents.nextCursor);
  const nextEvents=await json(await agent(runtime,(await token(runtime,box)).secret,`/v1/events?limit=1&cursor=${encodeURIComponent(allEvents.nextCursor)}`));
  assert.equal(nextEvents.events.length,1);assert.notEqual(nextEvents.events[0].id,allEvents.events[0].id);
  const oauthPage=await tool(oauthClient,'list_mail_events',{limit:1});assert.ok(oauthPage.nextCursor);
  const oauthNext=await tool(oauthClient,'list_mail_events',{limit:1,cursor:oauthPage.nextCursor});assert.notEqual(oauthNext.events[0].id,oauthPage.events[0].id);
  const otherPage=await agent(runtime,outsider.secret,`/v1/events?limit=1&cursor=${encodeURIComponent(allEvents.nextCursor)}`);assert.ok([400,404].includes(otherPage.status));
  assert.equal(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read'),0);
});

test('missing key configuration disables new subscriptions without resource writes while existing endpoints can still be safely paused or disabled',{timeout:120_000},async t=>{
  const calls=[];const runtime=await createOwnerRuntime({outboundService:request=>capture(request,calls)});t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),read=await token(runtime,box);
  const unconfigured=await json(await agent(runtime,read.secret,'/v1/webhooks'));assert.equal(unconfigured.configured,false);assert.deepEqual(unconfigured.endpoints,[]);
  const beforeObjects=(await runtime.bucket.list()).objects.length;
  assert.equal((await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:'https://hooks.example.net/unconfigured',eventTypes:types}})).status,503);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM webhook_endpoints').first('n'),0);assert.equal((await runtime.bucket.list()).objects.length,beforeObjects);
  await runtime.updateBindings(bindings);const created=await endpoint(runtime,box);await runtime.updateBindings({WEBHOOK_KEYRING:''});
  assert.equal((await json(await agent(runtime,read.secret,'/v1/webhooks'))).configured,false);
  assert.equal((await runtime.request(`${base(box)}/webhooks/${created.endpoint.id}/rotate`,{method:'POST',body:{expectedUpdatedAt:created.endpoint.updatedAt}})).status,503);
  const paused=await patch(runtime,box,created.endpoint,{status:'paused'});assert.equal(paused.status,'paused');
  assert.equal((await runtime.request(`${base(box)}/webhooks/${paused.id}`,{method:'PATCH',body:{expectedUpdatedAt:paused.updatedAt,status:'active'}})).status,503);
  const disabled=await patch(runtime,box,paused,{status:'disabled'});assert.equal(disabled.status,'disabled');
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM webhook_endpoints').first('n'),1);assert.equal((await runtime.bucket.list()).objects.length,beforeObjects);assert.deepEqual(calls,[]);
});
