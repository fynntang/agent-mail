import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';

const api='https://api.example.com',consoleOrigin='https://console.example.com',resource=`${api}/mcp`;
const queueName='agent-mail-email-events',subscriptionId='c'.repeat(32),bridgeSecret='bridge-secret-'.repeat(4);
const eventBindings={EMAIL_EVENT_QUEUE:queueName,EMAIL_EVENT_ACCOUNT_ID:'a'.repeat(32),EMAIL_EVENT_ZONE_ID:'b'.repeat(32),
  EMAIL_EVENT_SUBSCRIPTION_ID:subscriptionId,EMAIL_EVENT_DOMAIN:'agent.example.com'};
const webhookKeyring=JSON.stringify({activeKid:'key-1',keys:{'key-1':'A'.repeat(43)}});
const fullBindings={...eventBindings,EMAIL_EVENT_BRIDGE_SECRET:bridgeSecret,WEBHOOK_KEYRING:webhookKeyring};
const marker=`DELIVERY_PRIVATE_DIAGNOSTIC_${randomUUID()}`;
const kinds=['delivered','deferred','bounced','failed','rejected','complained'];
const base=box=>`/owner/api/mailboxes/${box.id}`;
function cleanupRuntime(t,runtime){
  t.after(()=>disposeOwnerRuntime(runtime));
}
async function json(response,status=200) {assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime) {
  return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Delivery agent',localPart:`delivery-${randomUUID()}`}}),201)).mailbox;
}
async function token(runtime,box,scopes=['mail:read','attachments:read','mail:draft','mail:send']) {
  return json(await runtime.request(`${base(box)}/tokens`,{method:'POST',body:{name:'Delivery integration',scopes}}),201);
}
function agent(runtime,secret,path,{method='GET',body,headers={}}={}) {
  return runtime.mf.dispatchFetch(new URL(path,api),{method,headers:{Authorization:`Bearer ${secret}`,
    ...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function tick(runtime) {assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
async function accepted(runtime,box,credential,recipients={to:['recipient@example.net']}) {
  let draft=(await json(await agent(runtime,credential.secret,'/v1/drafts',{method:'POST',body:{...recipients,subject:marker,text:marker}}),201)).draft;
  draft=(await json(await runtime.request(`${base(box)}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:draft.version,contentSha256:draft.contentSha256}}))).draft;
  const queued=await json(await agent(runtime,credential.secret,`/v1/drafts/${draft.id}/send`,{method:'POST',headers:{'Idempotency-Key':randomUUID()},body:{expectedVersion:draft.version}}),202);
  assert.equal(queued.status,'queued');await tick(runtime);
  const row=await runtime.db.prepare('SELECT * FROM outbound_messages WHERE id=?').bind(queued.outboundId).first();assert.equal(row.status,'accepted');assert.ok(row.provider_message_id);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_attempts WHERE outbound_id=?').bind(row.id).first('n'),1);return row;
}
function envelope(box,outbound,kind='delivered',recipient='recipient@example.net',at=Date.now()) {
  return {type:`cf.email.sending.message.${kind}`,source:{type:'email.sending',zoneId:eventBindings.EMAIL_EVENT_ZONE_ID,domain:eventBindings.EMAIL_EVENT_DOMAIN},
    payload:{eventId:randomUUID(),messageId:outbound.provider_message_id,sender:box.address,recipient,terminal:kind!=='deferred',
      delivery:{status:kind,response:marker,smtp:{response:marker}},subject:marker,body:marker,bcc:['private-delivery-bcc@example.net']},
    metadata:{accountId:eventBindings.EMAIL_EVENT_ACCOUNT_ID,eventSubscriptionId:subscriptionId,eventSchemaVersion:1,eventTimestamp:new Date(at).toISOString()}};
}
async function queue(runtime,events,{name=queueName,scheduled=true}={}) {
  const messages=(Array.isArray(events)?events:[events]).map(body=>({id:randomUUID(),timestamp:new Date(),attempts:1,body}));
  const result=await (await runtime.mf.getWorker()).queue(name,messages);assert.equal(result.outcome,'ok');
  if(name===queueName){assert.equal(result.retryBatch.retry,false);assert.deepEqual([...result.explicitAcks].sort(),messages.map(message=>message.id).sort());assert.deepEqual(result.retryMessages,[]);}
  if(scheduled)await tick(runtime);return result;
}
async function summary(runtime,box,id) {
  const result=await json(await runtime.request(`${base(box)}/outbound`));const row=result.outbound.find(out=>out.id===id);assert.ok(row);return row;
}
async function noResend(runtime,id) {
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_attempts WHERE outbound_id=?').bind(id).first('n'),1);
  assert.equal(await runtime.db.prepare("SELECT count(*) n FROM jobs WHERE kind='send_email' AND dedupe_key=?").bind(id).first('n'),1);
  assert.equal(await runtime.db.prepare('SELECT state FROM send_reservations WHERE operation_id=?').bind(id).first('state'),'committed');
}
function privateFree(value,forbidden=[]) {
  const serialized=JSON.stringify(value);
  for(const text of [marker,bridgeSecret,'EMAIL_EVENT_BRIDGE_SECRET','payload_json','object_key','signing_secret_ciphertext',...forbidden])assert.equal(serialized.includes(text),false,text);
}
async function stored(runtime) {return (await runtime.db.prepare('SELECT * FROM email_delivery_events').all()).results;}
function persistedSafe(rows) {
  const serialized=JSON.stringify(rows);for(const privateValue of [marker,bridgeSecret])assert.equal(serialized.includes(privateValue),false,privateValue);
}
function bridge(runtime,body,{timestamp=String(Math.floor(Date.now()/1000)),signature,method='POST',path='/callbacks/cloudflare-email',headers={}}={}) {
  const raw=typeof body==='string'?body:JSON.stringify(body),sig=signature??`v1=${createHmac('sha256',bridgeSecret).update(`${timestamp}.${raw}`).digest('hex')}`;
  return runtime.mf.dispatchFetch(new URL(path,api),{method,headers:{'Content-Type':'application/json','X-Agent-Mail-Timestamp':timestamp,'X-Agent-Mail-Signature':sig,...headers},
    ...(['GET','HEAD'].includes(method)?{}:{body:raw})});
}
async function clientFor(t,runtime,secret) {
  const client=new Client({name:'delivery-events-integration',version:'1.0.0'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});
  registerMcpClient(runtime,client);
  await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},fetch:async(input,init)=>{
    const request=new Request(input,init);assert.equal(new URL(request.url).origin,api);const body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();
    return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body,signal:request.signal});
  }}),{timeout:10_000});return client;
}
async function tool(client,name,args={}) {
  const result=await client.callTool({name,arguments:args},{timeout:10_000});assert.notEqual(result.isError,true,JSON.stringify(result));assert.ok(result.structuredContent);return result.structuredContent;
}
async function oauthRead(runtime,box) {
  const redirect='https://delivery-client.example/callback',verifier=randomBytes(32).toString('base64url');
  const registered=await json(await runtime.mf.dispatchFetch(`${api}/oauth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    client_name:'Delivery OAuth observer',redirect_uris:[redirect],scope:'mail:read',token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']
  })}),201);
  const url=new URL('/owner/oauth/authorize',consoleOrigin);url.search=new URLSearchParams({client_id:registered.client_id,redirect_uri:redirect,response_type:'code',resource,scope:'mail:read',
    state:randomUUID(),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const response=await runtime.mf.dispatchFetch(url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'}});assert.equal(response.status,200);const html=await response.text();
  const requestId=/name="requestId"[^>]*value="([^"]+)"/.exec(html)?.[1],csrfToken=/name="csrfToken"[^>]*value="([^"]+)"/.exec(html)?.[1];assert.ok(requestId&&csrfToken);
  const consent=await runtime.mf.dispatchFetch(url,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Origin:consoleOrigin,'Content-Type':'application/x-www-form-urlencoded',Accept:'text/html'},
    body:new URLSearchParams({requestId,csrfToken,decision:'allow',mailboxId:box.id,scope:'mail:read'}).toString(),redirect:'manual'});assert.equal(consent.status,303);
  const returned=new URL(consent.headers.get('Location'));
  return json(await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',
    client_id:registered.client_id,resource,code:returned.searchParams.get('code'),redirect_uri:redirect,code_verifier:verifier}).toString()}));
}

test('native EMAIL acceptance followed by native Queues projects six recipient outcomes and private signed Webhook events without resending',{timeout:120_000},async t=>{
  const calls=[];const runtime=await createOwnerRuntime({bindings:fullBindings,outboundService:async request=>{
    calls.push({url:request.url,headers:Object.fromEntries(request.headers),body:await request.text()});return new Response(null,{status:204});
  }});cleanupRuntime(t,runtime);const box=await mailbox(runtime),credential=await token(runtime,box);
  const subscription=await json(await runtime.request(`${base(box)}/webhooks`,{method:'POST',body:{url:'https://hooks.example.net/provider-events',eventTypes:kinds.map(kind=>`outbound.${kind}`)}}),201);
  const recipientAddresses=kinds.map(kind=>`${kind}@example.net`),outbound=await accepted(runtime,box,credential,{to:recipientAddresses.slice(0,5),bcc:[recipientAddresses[5]]});
  assert.deepEqual(calls,[],'Submission acceptance alone cannot claim a subscribed recipient delivery outcome');
  const count=(await runtime.bucket.list()).objects.length,events=kinds.map((kind,index)=>envelope(box,outbound,kind,recipientAddresses[index]));
  await queue(runtime,events);for(let drain=0;drain<3;drain++)await tick(runtime);
  const out=await summary(runtime,box,outbound.id);assert.equal(out.status,'partial');assert.ok(Number.isSafeInteger(out.lastProviderEventAt));
  const expected={delivered:'delivered',deferred:'deferred',bounced:'bounced',failed:'failed',rejected:'failed',complained:'accepted'};
  for(const kind of kinds){const recipient=out.recipients.find(item=>item.address===`${kind}@example.net`);assert.ok(recipient);assert.equal(recipient.status,expected[kind]);
    assert.equal(recipient.deliveryEventType,kind==='complained'?null:kind);assert.ok(Number.isSafeInteger(recipient.lastProviderEventAt));privateFree(recipient);
    assert.equal(recipient.complainedAt!==null,kind==='complained');}
  assert.equal(calls.length,6);assert.deepEqual(calls.map(call=>JSON.parse(call.body).type).sort(),kinds.map(kind=>`outbound.${kind}`).sort());
  for(const call of calls){privateFree(JSON.parse(call.body),recipientAddresses);assert.equal(call.headers.authorization,undefined);assert.equal(call.headers.cookie,undefined);
    const signature=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(call.headers['x-agent-mail-signature']);assert.ok(signature);
    assert.equal(signature[2],createHmac('sha256',subscription.secret).update(`${signature[1]}.${call.headers['x-agent-mail-delivery']}.${call.body}`).digest('hex'));}
  persistedSafe(await stored(runtime));assert.equal((await runtime.bucket.list()).objects.length,count);await noResend(runtime,outbound.id);
});

test('Owner, Token REST, MCP and OAuth preserve recipient/Bcc authorization and expose only safe event metadata with unchanged tools',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime({bindings:fullBindings});cleanupRuntime(t,runtime);const box=await mailbox(runtime),other=await mailbox(runtime);
  const credential=await token(runtime,box),peer=await token(runtime,box),reader=await token(runtime,box,['mail:read']),outsider=await token(runtime,other);
  const bcc='private-delivery-bcc@example.net',outbound=await accepted(runtime,box,credential,{to:['visible@example.net'],bcc:[bcc]});
  await queue(runtime,[envelope(box,outbound,'delivered','visible@example.net'),envelope(box,outbound,'bounced',bcc)]);
  const owner=await summary(runtime,box,outbound.id);assert.equal(owner.status,'partial');assert.equal(owner.recipients.find(item=>item.kind==='bcc').address,bcc);
  const rest=await json(await agent(runtime,credential.secret,'/v1/outbound'));assert.equal(rest.outbound[0].status,'partial');assert.equal(rest.outbound[0].recipients.find(item=>item.kind==='bcc').status,'bounced');
  assert.deepEqual((await json(await agent(runtime,peer.secret,'/v1/outbound'))).outbound,[]);assert.deepEqual((await json(await agent(runtime,outsider.secret,'/v1/outbound'))).outbound,[]);
  assert.equal((await agent(runtime,reader.secret,'/v1/outbound')).status,403);assert.equal((await runtime.request(`${base(box)}/outbound`,{authenticated:false})).status,401);
  const client=await clientFor(t,runtime,credential.secret);assert.equal((await client.listTools()).tools.length,22);
  const mcp=await tool(client,'list_outbound');assert.equal(mcp.outbound[0].status,'partial');assert.equal(mcp.outbound[0].recipients.find(item=>item.kind==='bcc').address,bcc);
  const publicEvents=await json(await agent(runtime,reader.secret,'/v1/events'));privateFree(publicEvents,[bcc,'visible@example.net']);
  assert.ok(publicEvents.events.some(event=>event.type==='outbound.bounced'));const listed=await tool(client,'list_mail_events');privateFree(listed,[bcc,'visible@example.net']);
  const oauth=await oauthRead(runtime,box),oauthClient=await clientFor(t,runtime,oauth.access_token);assert.equal((await oauthClient.listTools()).tools.length,8);
  privateFree(await tool(oauthClient,'list_mail_events'),[bcc,'visible@example.net']);assert.equal((await agent(runtime,oauth.access_token,'/v1/events')).status,401);
  const sent=await json(await agent(runtime,credential.secret,`/v1/messages/${outbound.id}`));assert.equal(sent.addresses.some(address=>address.kind==='bcc'),false);
  const hidden=await json(await agent(runtime,outsider.secret,'/v1/events'));assert.equal(hidden.events.some(event=>event.data.outboundId===outbound.id),false);
  await noResend(runtime,outbound.id);
});

test('dedupe, conflicting IDs, stale deferred events and independent complaint ordering never regress a recipient or duplicate public events',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime({bindings:fullBindings});cleanupRuntime(t,runtime);const box=await mailbox(runtime),credential=await token(runtime,box),outbound=await accepted(runtime,box,credential);
  const complaint=envelope(box,outbound,'complained'),complaintAt=Date.parse(complaint.metadata.eventTimestamp);await queue(runtime,complaint);
  let out=await summary(runtime,box,outbound.id);assert.equal(out.status,'accepted');assert.equal(out.recipients[0].status,'accepted');assert.equal(out.recipients[0].complainedAt,complaintAt);
  const delivered=envelope(box,outbound,'delivered','recipient@example.net',complaintAt-1);await queue(runtime,delivered);
  out=await summary(runtime,box,outbound.id);assert.equal(out.status,'delivered');assert.equal(out.recipients[0].status,'delivered');assert.equal(out.recipients[0].complainedAt,complaintAt);
  const publicCount=await runtime.db.prepare('SELECT count(*) n FROM events WHERE mailbox_id=?').bind(box.id).first('n'),storedCount=(await stored(runtime)).length;
  await queue(runtime,delivered);assert.equal((await stored(runtime)).length,storedCount);assert.equal(await runtime.db.prepare('SELECT count(*) n FROM events WHERE mailbox_id=?').bind(box.id).first('n'),publicCount);
  const conflicting=structuredClone(delivered);conflicting.type='cf.email.sending.message.bounced';conflicting.payload.delivery.status='bounced';await queue(runtime,conflicting);
  assert.equal((await stored(runtime)).length,storedCount);assert.equal((await summary(runtime,box,outbound.id)).status,'delivered');
  const stale=envelope(box,outbound,'deferred','recipient@example.net',complaintAt-1000),newer=envelope(box,outbound,'deferred');await queue(runtime,[stale,newer]);
  assert.equal((await summary(runtime,box,outbound.id)).recipients[0].status,'delivered');assert.equal(await runtime.db.prepare('SELECT count(*) n FROM events WHERE mailbox_id=?').bind(box.id).first('n'),publicCount);
  assert.ok((await stored(runtime)).filter(row=>row.state==='ignored').length>=2);await noResend(runtime,outbound.id);
});

test('the optional operator HTTP bridge verifies timestamped raw-body HMAC before JSON parsing and never accepts mailbox/Owner authentication as a substitute',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime({bindings:fullBindings});cleanupRuntime(t,runtime);const box=await mailbox(runtime),credential=await token(runtime,box),outbound=await accepted(runtime,box,credential);
  const event=envelope(box,outbound),before=(await stored(runtime)).length;
  assert.equal((await bridge(runtime,event,{signature:'v1='+'0'.repeat(64),headers:{Authorization:`Bearer ${credential.secret}`,'Cf-Access-Jwt-Assertion':runtime.jwt}})).status,401);
  assert.equal((await bridge(runtime,event,{timestamp:String(Math.floor(Date.now()/1000)-301)})).status,401);
  assert.equal((await bridge(runtime,'{invalid-json',{signature:'v1='+'0'.repeat(64)})).status,401);
  assert.equal((await bridge(runtime,'{invalid-json')).status,400);assert.equal((await stored(runtime)).length,before);
  assert.equal((await bridge(runtime,event,{method:'GET'})).status,405);assert.equal((await bridge(runtime,event,{path:'/callbacks/cloudflare-email?extra=denied'})).status,400);
  assert.equal((await bridge(runtime,'x'.repeat(65_537))).status,413);
  const acceptedEvent=await json(await bridge(runtime,event));assert.equal(acceptedEvent.ok,true);assert.ok(['applied','pending'].includes(acceptedEvent.outcome));await tick(runtime);
  assert.equal((await summary(runtime,box,outbound.id)).status,'delivered');assert.equal((await json(await bridge(runtime,event))).outcome,'duplicate');
  const conflict=structuredClone(event);conflict.payload.recipient='other@example.net';assert.equal((await bridge(runtime,conflict)).status,409);
  assert.equal((await stored(runtime)).length,before+1);await runtime.updateBindings({EMAIL_EVENT_BRIDGE_SECRET:''});assert.equal((await bridge(runtime,event)).status,404);
  await noResend(runtime,outbound.id);
});

test('native queue/configuration and provider account/subscription/domain/sender/recipient checks reject untrusted scope without altering sends',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime({bindings:fullBindings});cleanupRuntime(t,runtime);const box=await mailbox(runtime),credential=await token(runtime,box),outbound=await accepted(runtime,box,credential);
  const event=envelope(box,outbound),before=(await stored(runtime)).length;
  const wrongQueue=await queue(runtime,event,{name:'untrusted-queue',scheduled:false});assert.equal(wrongQueue.retryBatch.retry,true);assert.equal((await stored(runtime)).length,before);
  await runtime.updateBindings({EMAIL_EVENT_ACCOUNT_ID:''});const unconfigured=await (await runtime.mf.getWorker()).queue(queueName,[{id:randomUUID(),timestamp:new Date(),attempts:1,body:event}]);
  assert.equal(unconfigured.outcome,'ok');assert.equal(unconfigured.retryBatch.retry,true);assert.equal((await stored(runtime)).length,before);await runtime.updateBindings(eventBindings);
  const invalid=[];
  for(const change of [value=>{value.metadata.accountId='d'.repeat(32);},value=>{value.metadata.eventSubscriptionId=randomUUID();},value=>{value.metadata.eventSchemaVersion=2;},
    value=>{value.source.zoneId='e'.repeat(32);},value=>{value.source.domain='untrusted.example.net';},value=>{value.source.type='http.webhook';},
    value=>{value.type='cf.email.sending.message.opened';},value=>{value.payload.terminal=false;}]){const value=structuredClone(event);value.payload.eventId=randomUUID();change(value);invalid.push(value);}
  await queue(runtime,invalid);assert.equal((await stored(runtime)).length,before);
  const wrongSender=envelope(box,outbound);wrongSender.payload.sender='different@agent.example.com';const wrongRecipient=envelope(box,outbound,'delivered','foreign@example.net');
  await queue(runtime,[wrongSender,wrongRecipient]);assert.equal((await summary(runtime,box,outbound.id)).status,'accepted');
  assert.ok((await stored(runtime)).every(row=>row.state!=='applied'));persistedSafe(await stored(runtime));await noResend(runtime,outbound.id);
});

test('events arriving before ACK remain pending until correlation, while unknown provider IDs stay bounded and can never cause an automatic resend',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime({bindings:fullBindings});cleanupRuntime(t,runtime);const box=await mailbox(runtime),credential=await token(runtime,box),outbound=await accepted(runtime,box,credential);
  // Model only the provider-ACK persistence gap; the real native send and its immutable Sent copy already exist.
  await runtime.db.prepare("UPDATE outbound_messages SET provider_message_id=NULL,status='submitting' WHERE id=?").bind(outbound.id).run();
  const early=envelope(box,outbound);await queue(runtime,early,{scheduled:false});assert.equal((await stored(runtime)).filter(row=>row.state==='pending').length,1);
  assert.equal((await summary(runtime,box,outbound.id)).status,'submitting');
  await runtime.db.prepare("UPDATE outbound_messages SET provider_message_id=?,status='accepted' WHERE id=?").bind(outbound.provider_message_id,outbound.id).run();
  await runtime.db.prepare("UPDATE email_delivery_events SET next_attempt_at=0 WHERE state='pending'").run();
  await tick(runtime);assert.equal((await summary(runtime,box,outbound.id)).status,'delivered');assert.equal((await stored(runtime)).filter(row=>row.state==='applied').length,1);
  const unknown=envelope(box,{provider_message_id:`unmapped-${randomUUID()}`});await queue(runtime,unknown);
  for(let attempt=0;attempt<3;attempt++)await tick(runtime);
  const pending=(await stored(runtime)).filter(row=>row.state==='pending');assert.ok(pending.length<=1);assert.equal((await stored(runtime)).length,2);
  // Exercise the finite reconciliation budget without sleeping through64backoff windows.
  await runtime.db.prepare("UPDATE email_delivery_events SET next_attempt_at=0,reconcile_attempts=64 WHERE state='pending'").run();await tick(runtime);
  const retired=(await stored(runtime)).find(row=>row.provider_message_id===unknown.payload.messageId);assert.equal(retired.state,'ignored');assert.equal(retired.ignore_reason,'unmatched_expired');
  assert.equal((await summary(runtime,box,outbound.id)).status,'delivered');persistedSafe(await stored(runtime));await noResend(runtime,outbound.id);
});
