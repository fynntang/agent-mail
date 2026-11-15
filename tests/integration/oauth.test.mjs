import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {auth,Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';
import {seedMessages} from '../helpers/mail-fixtures.mjs';
import {seedAttachment} from '../helpers/attachment-fixtures.mjs';

const api='https://api.example.com',resource=`${api}/mcp`,consoleOrigin='https://console.example.com';
const callback='https://client.example/callback',allScopes='mail:read mail:draft mail:send';
const digest=value=>createHash('sha256').update(value).digest('hex');
const challenge=value=>createHash('sha256').update(value).digest('base64url');

async function ownerJson(runtime,path,options={},expected=200) {
  const response=await runtime.request(path,options);assert.equal(response.status,expected,await response.clone().text());return response.json();
}
async function mailbox(runtime,name='OAuth agent') {
  return (await ownerJson(runtime,'/owner/api/mailboxes',{method:'POST',body:{name,localPart:`oauth-${randomUUID()}`}},201)).mailbox;
}
async function publicRequest(runtime,path,{method='GET',body,headers={}}={}) {
  return runtime.mf.dispatchFetch(new URL(path,api),{method,headers,...(body===undefined?{}:{body}),redirect:'manual'});
}
async function register(runtime,overrides={}) {
  const response=await publicRequest(runtime,'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    client_name:'OAuth integration',redirect_uris:[callback],scope:allScopes,token_endpoint_auth_method:'none',
    grant_types:['authorization_code','refresh_token'],response_types:['code'],...overrides
  })});
  assert.equal(response.status,201,await response.clone().text());return response.json();
}
function authorization(clientId,{redirect=callback,scope=allScopes,verifier=randomBytes(32).toString('base64url'),state=randomUUID(),...overrides}={}) {
  const url=new URL('/owner/oauth/authorize',consoleOrigin);
  const params={client_id:clientId,redirect_uri:redirect,response_type:'code',resource,scope,state,
    code_challenge:challenge(verifier),code_challenge_method:'S256',...overrides};
  Object.entries(params).forEach(([key,value])=>{if(value!==undefined)url.searchParams.set(key,value);});
  return {url,verifier,state,redirect};
}
async function consentPage(runtime,url) {
  const response=await runtime.mf.dispatchFetch(url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'},redirect:'manual'});
  assert.equal(response.status,200,'Owner authorization page must render successfully');
  const html=await response.text();
  const requestId=/name="requestId"[^>]*value="([^"]+)"/.exec(html)?.[1];
  const csrfToken=/name="csrfToken"[^>]*value="([^"]+)"/.exec(html)?.[1];
  assert.ok(requestId&&csrfToken,'Owner consent must contain an opaque request handle and CSRF nonce');
  return {html,requestId,csrfToken};
}
async function decide(runtime,url,fields,{decision='allow',mailboxId,scopes=['mail:read'],directSending=false,headers={},overrides={}}={}) {
  const form=new URLSearchParams({requestId:fields.requestId,csrfToken:fields.csrfToken,decision,...(mailboxId?{mailboxId}:{}),
    ...(directSending?{directSending:'1'}:{}),...overrides});
  scopes.forEach(scope=>form.append('scope',scope));
  return runtime.mf.dispatchFetch(url,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Origin:consoleOrigin,
    'Content-Type':'application/x-www-form-urlencoded',Accept:'text/html',...headers},body:form.toString(),redirect:'manual'});
}
async function issueCode(runtime,box,client,{scope=allScopes,scopes=scope.split(' '),directSending=false,...options}={}) {
  const request=authorization(client.client_id,{scope,...options}),page=await consentPage(runtime,request.url);
  const response=await decide(runtime,request.url,page,{mailboxId:box.id,scopes,directSending});
  assert.equal(response.status,303,'Owner consent must redirect to the registered client');
  const redirect=new URL(response.headers.get('Location'));
  assert.equal(redirect.origin,new URL(request.redirect).origin);assert.equal(redirect.searchParams.get('state'),request.state);
  assert.equal(redirect.searchParams.get('iss'),api);assert.ok(redirect.searchParams.get('code'));assert.equal(redirect.searchParams.has('error'),false);
  return {...request,code:redirect.searchParams.get('code'),page};
}
async function tokenRequest(runtime,body,expected=200,headers={}) {
  const response=await publicRequest(runtime,'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(body).toString()});
  assert.equal(response.status,expected,await response.clone().text());
  assert.match(response.headers.get('cache-control'),/no-store/);return {response,value:await response.json()};
}
function codeFields(client,issued,overrides={}) {
  return {grant_type:'authorization_code',client_id:client.client_id,resource,code:issued.code,redirect_uri:issued.redirect,code_verifier:issued.verifier,...overrides};
}
function refreshFields(client,tokens,overrides={}) {return {grant_type:'refresh_token',client_id:client.client_id,resource,refresh_token:tokens.refresh_token,...overrides};}
function fetchFor(runtime,traffic=[]) {
  return async(input,init)=>{
    const request=new Request(input,init),url=new URL(request.url);
    assert.equal(url.origin,api,'OAuth SDK network must remain inside the local test adapter');
    const body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();
    traffic.push({path:url.pathname,method:request.method,
      form:request.headers.get('Content-Type')?.includes('application/x-www-form-urlencoded')?new URLSearchParams(new TextDecoder().decode(body)):null});
    return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body,signal:request.signal,redirect:'manual'});
  };
}
function provider({redirect=callback,scope=allScopes,clientMetadataUrl}={}) {
  const values={state:randomUUID()};
  return {values,redirectUrl:redirect,...(clientMetadataUrl?{clientMetadataUrl}:{}),
    clientMetadata:{client_name:'Official SDK OAuth',redirect_uris:[redirect],scope,grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'},
    state:()=>values.state,clientInformation:()=>values.clientInformation,saveClientInformation:value=>{values.clientInformation=value;},
    tokens:()=>values.tokens,saveTokens:value=>{values.tokens=value;},
    redirectToAuthorization:url=>{values.authorizationUrl=url;},saveCodeVerifier:value=>{values.verifier=value;},codeVerifier:()=>values.verifier,
    saveDiscoveryState:value=>{values.discovery=value;},discoveryState:()=>values.discovery,
    invalidateCredentials:scope=>{if(scope==='all'||scope==='tokens')delete values.tokens;if(scope==='all'||scope==='client')delete values.clientInformation;}
  };
}
async function connected(t,runtime,oauthProvider) {
  const client=new Client({name:'oauth-integration',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  registerMcpClient(runtime,client);
  await client.connect(new StreamableHTTPClientTransport(new URL(resource),{authProvider:oauthProvider,fetch:fetchFor(runtime)}),{timeout:10_000});
  return client;
}
async function tool(client,name,args={}) {
  const result=await client.callTool({name,arguments:args},{timeout:10_000});assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent;
}
async function rawMcp(runtime,token,{origin,path='/mcp',method='tools/list',args={},name,scheme='Bearer'}={}) {
  const params={...(name?{name,arguments:args}:{}),_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28',
    'io.modelcontextprotocol/clientInfo':{name:'oauth-raw',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}};
  return runtime.mf.dispatchFetch(new URL(path,api),{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',
    'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(name?{'Mcp-Name':name}:{}),...(token?{Authorization:`${scheme} ${token}`}:{ }),...(origin?{Origin:origin}:{})},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
}

test('official OAuth SDK discovers, obtains Owner consent, uses mailbox scopes and refreshes without losing draft identity',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),[source]=await seedMessages(runtime,box.id,{text:'Original OAuth message'});
  const challengeResponse=await rawMcp(runtime);
  assert.equal(challengeResponse.status,401);assert.match(challengeResponse.headers.get('WWW-Authenticate'),/resource_metadata="https:\/\/api\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  for(const path of ['/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource']) {
    const response=await publicRequest(runtime,path);assert.equal(response.status,200);
    const metadata=await response.json();assert.equal(metadata.resource,resource);assert.deepEqual(metadata.authorization_servers,[api]);
  }
  const metadata=await(await publicRequest(runtime,'/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.issuer,api);assert.equal(metadata.authorization_endpoint,`${consoleOrigin}/owner/oauth/authorize`);
  assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);assert.deepEqual(metadata.token_endpoint_auth_methods_supported,['none']);
  assert.equal(metadata.authorization_response_iss_parameter_supported,true);assert.equal(metadata.client_id_metadata_document_supported,false);
  const oauth=provider(),traffic=[],fetchFn=fetchFor(runtime,traffic);
  assert.equal(await auth(oauth,{serverUrl:new URL(resource),scope:allScopes,fetchFn}),'REDIRECT');
  assert.ok(oauth.values.clientInformation.client_id);assert.ok(oauth.values.discovery);
  const requested=oauth.values.authorizationUrl;
  assert.equal(requested.origin,consoleOrigin);assert.equal(requested.searchParams.get('resource'),resource);
  assert.equal(requested.searchParams.get('code_challenge_method'),'S256');
  const page=await consentPage(runtime,requested);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM oauth_grants').first('n'),0);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM oauth_access_tokens').first('n'),0);
  const consent=await decide(runtime,requested,page,{mailboxId:box.id,scopes:allScopes.split(' ')});
  assert.equal(consent.status,303,'Owner consent must redirect to the registered client');
  const returned=new URL(consent.headers.get('Location'));
  assert.equal(returned.searchParams.get('state'),oauth.values.state);assert.equal(returned.searchParams.get('iss'),api);
  assert.equal(await auth(oauth,{serverUrl:new URL(resource),authorizationCode:returned.searchParams.get('code'),iss:returned.searchParams.get('iss'),fetchFn}),'AUTHORIZED');
  assert.match(oauth.values.tokens.access_token,/^amo_/);assert.match(oauth.values.tokens.refresh_token,/^amr_/);
  assert.equal(oauth.values.tokens.scope,allScopes);assert.equal(oauth.values.tokens.expires_in,600);
  assert.equal((await rawMcp(runtime,oauth.values.tokens.access_token,{scheme:'bEaReR'})).status,200,'OAuth HTTP authentication scheme is case-insensitive');
  const principal=await runtime.db.prepare('SELECT mailbox_token_id FROM oauth_grants').first('mailbox_token_id');
  assert.equal(await runtime.db.prepare('SELECT requires_approval FROM mailbox_tokens WHERE id=?').bind(principal).first('requires_approval'),1);
  const client=await connected(t,runtime,oauth);
  assert.equal((await client.listTools()).tools.length,21);
  assert.equal((await tool(client,'get_mailbox')).mailbox.id,box.id);
  let reply=(await tool(client,'reply_message',{messageId:source.id,text:'OAuth reply'})).draft;
  const oauthFile=Buffer.from('OAuth draft attachment 😀');
  const upload=(await tool(client,'begin_draft_attachment_upload',{draftId:reply.id,expectedVersion:reply.version,
    filename:'OAuth报告.txt',contentType:'text/plain',totalBytes:oauthFile.length})).upload;
  await tool(client,'upload_draft_attachment_chunk',{draftId:reply.id,uploadId:upload.id,offset:0,data:oauthFile.toString('base64')});
  const pending=await tool(client,'send_message',{draftId:reply.id,expectedVersion:reply.version,clientRequestId:'oauth-request-approval'});
  assert.equal(pending.status,'approval_required');assert.equal(await runtime.db.prepare('SELECT count(*) n FROM outbound_messages').first('n'),0);
  const beforeRefresh={...oauth.values.tokens};
  assert.equal(await auth(oauth,{serverUrl:new URL(resource),fetchFn}),'AUTHORIZED');
  assert.notEqual(oauth.values.tokens.refresh_token,beforeRefresh.refresh_token);assert.notEqual(oauth.values.tokens.access_token,beforeRefresh.access_token);
  assert.equal(await runtime.db.prepare('SELECT mailbox_token_id FROM oauth_grants').first('mailbox_token_id'),principal);
  assert.equal((await tool(client,'get_draft',{draftId:reply.id})).draft.id,reply.id);
  reply=(await tool(client,'complete_draft_attachment_upload',{draftId:reply.id,uploadId:upload.id})).draft;
  assert.equal(reply.content.attachments.length,1,'OAuth refresh retains private staged upload identity');
  const approved=await ownerJson(runtime,`/owner/api/mailboxes/${box.id}/drafts/${reply.id}/approve`,{method:'POST',body:{expectedVersion:reply.version,contentSha256:reply.contentSha256}});
  const sendArgs={draftId:reply.id,expectedVersion:approved.draft.version,clientRequestId:'oauth-approved-send'};
  const queued=await tool(client,'send_message',sendArgs);assert.equal(queued.status,'queued');
  assert.equal((await tool(client,'send_message',sendArgs)).outboundId,queued.outboundId);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_reservations').first('n'),1);
  await(await runtime.mf.getWorker()).scheduled();
  assert.equal(await runtime.db.prepare('SELECT status FROM outbound_messages WHERE id=?').bind(queued.outboundId).first('status'),'accepted');
  assert.equal(await runtime.db.prepare('SELECT created_by_token_id FROM drafts WHERE id=?').bind(reply.id).first('created_by_token_id'),principal);
  const sentFiles=await ownerJson(runtime,`/owner/api/mailboxes/${box.id}/messages/${queued.outboundId}/attachments`);
  assert.equal(sentFiles.attachments.length,1);
  const downloaded=await runtime.request(`/owner/api/mailboxes/${box.id}/messages/${queued.outboundId}/attachments/${sentFiles.attachments[0].id}/download`);
  assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),oauthFile);
  assert.ok(traffic.filter(entry=>entry.path==='/oauth/token').every(entry=>entry.form.get('resource')===resource));
  const data=JSON.stringify((await runtime.db.prepare('SELECT * FROM oauth_access_tokens').all()).results);
  for(const secret of [beforeRefresh.access_token,oauth.values.tokens.access_token,beforeRefresh.refresh_token,oauth.values.tokens.refresh_token,returned.searchParams.get('code')]) assert.ok(!data.includes(secret));
});

test('OAuth authorization and exchange enforce Owner CSRF, redirect, PKCE, resource, scope and one-time codes',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),client=await register(runtime),other=await register(runtime,{client_name:'Other client'});
  const initial=authorization(client.client_id);
  assert.equal((await runtime.mf.dispatchFetch(initial.url)).status,401);
  const wrongRedirect=authorization(client.client_id,{redirect:'https://attacker.example/callback'});
  const rejected=await runtime.mf.dispatchFetch(wrongRedirect.url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'},redirect:'manual'});
  assert.equal(rejected.status,400);assert.equal(rejected.headers.has('Location'),false);
  for(const changes of [{code_challenge_method:'plain'},{resource:undefined},{code_challenge:undefined},{scope:'owner'}]) {
    const request=authorization(client.client_id,changes);
    const response=await runtime.mf.dispatchFetch(request.url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'},redirect:'manual'});
    assert.equal(response.status,303);const redirect=new URL(response.headers.get('Location'));
    assert.equal(redirect.origin,new URL(callback).origin);assert.ok(redirect.searchParams.get('error'));assert.equal(redirect.searchParams.get('iss'),api);
  }
  const denyRequest=authorization(client.client_id),denyPage=await consentPage(runtime,denyRequest.url);
  const denied=await decide(runtime,denyRequest.url,denyPage,{decision:'deny',scopes:[]});
  assert.equal(denied.status,303);const denyRedirect=new URL(denied.headers.get('Location'));
  assert.equal(denyRedirect.searchParams.get('error'),'access_denied');assert.equal(denyRedirect.searchParams.get('state'),denyRequest.state);assert.equal(denyRedirect.searchParams.get('iss'),api);
  const request=authorization(client.client_id),page=await consentPage(runtime,request.url);
  const before=await runtime.db.prepare('SELECT count(*) n FROM oauth_grants').first('n');
  assert.equal((await decide(runtime,request.url,page,{mailboxId:box.id,overrides:{csrfToken:'wrong'}})).status,400);
  assert.equal((await decide(runtime,request.url,page,{mailboxId:box.id,headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM oauth_grants').first('n'),before);
  const issued=await issueCode(runtime,box,client);
  for(const invalid of [{code_verifier:randomBytes(32).toString('base64url')},{client_id:other.client_id},
    {redirect_uri:'https://attacker.example/callback'},{resource:'https://other.example/mcp'},{resource:''}]) {
    const {value}=await tokenRequest(runtime,codeFields(client,issued,invalid),400);assert.ok(['invalid_grant','invalid_target'].includes(value.error));
  }
  const first=(await tokenRequest(runtime,codeFields(client,issued))).value;
  const replay=await tokenRequest(runtime,codeFields(client,issued),400);assert.equal(replay.value.error,'invalid_grant');
  assert.equal((await rawMcp(runtime,first.access_token)).status,401);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM oauth_access_tokens').first('n'),1);
  const basic=await tokenRequest(runtime,{grant_type:'client_credentials',client_id:client.client_id,resource},401,{Authorization:'Basic dGVzdDp0ZXN0'});
  assert.equal(basic.value.error,'invalid_client');
  const duplicate=await publicRequest(runtime,'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=refresh_token&client_id=a&client_id=b'});
  assert.equal(duplicate.status,400);assert.equal((await duplicate.json()).error,'invalid_request');
});

test('OAuth refresh rotation narrows scopes, detects replay, and revocation blocks queued sends and other resource use',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  let box=await mailbox(runtime),client=await register(runtime),other=await register(runtime,{client_name:'Revocation attacker'});
  const code=await issueCode(runtime,box,client,{directSending:true}),tokens=(await tokenRequest(runtime,codeFields(client,code))).value;
  assert.equal((await rawMcp(runtime,tokens.access_token,{path:'/v1/messages'})).status,401);
  assert.equal((await rawMcp(runtime,tokens.refresh_token)).status,401);
  const expiredId=randomUUID(),expiredSecret=`amo_${expiredId}_${randomBytes(32).toString('base64url')}`;
  const grant=await runtime.db.prepare('SELECT * FROM oauth_grants').first();
  await runtime.db.prepare('INSERT INTO oauth_access_tokens(id,grant_id,secret_sha256,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .bind(expiredId,grant.id,digest(expiredSecret),'mail:read',Date.now()-10_000,Date.now()-1).run();
  assert.equal((await rawMcp(runtime,expiredSecret)).status,401);
  const preflight=await runtime.mf.dispatchFetch(resource,{method:'OPTIONS',headers:{Origin:'https://client.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,mcp-method,mcp-name,mcp-protocol-version'}});
  assert.equal(preflight.status,204);assert.match(preflight.headers.get('Access-Control-Allow-Headers'),/Authorization/i);
  const allowed=await rawMcp(runtime,tokens.access_token,{origin:'https://client.example'});assert.equal(allowed.status,200);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'),'https://client.example');
  assert.equal((await rawMcp(runtime,tokens.access_token,{origin:'https://evil.example'})).status,403);
  assert.equal((await rawMcp(runtime,tokens.access_token,{origin:'null'})).status,403);
  box=(await ownerJson(runtime,`/owner/api/mailboxes/${box.id}`,{method:'PATCH',body:{status:'paused',expectedUpdatedAt:box.updatedAt}})).mailbox;
  assert.equal((await rawMcp(runtime,tokens.access_token)).status,401);
  assert.equal((await tokenRequest(runtime,refreshFields(client,tokens),400)).value.error,'invalid_grant');
  box=(await ownerJson(runtime,`/owner/api/mailboxes/${box.id}`,{method:'PATCH',body:{status:'active',expectedUpdatedAt:box.updatedAt}})).mailbox;
  assert.equal((await rawMcp(runtime,tokens.access_token)).status,200);
  const refresh=(await tokenRequest(runtime,refreshFields(client,tokens))).value;
  assert.notEqual(refresh.refresh_token,tokens.refresh_token);
  const invalidSecret=tokens.refresh_token.slice(0,-1)+(tokens.refresh_token.endsWith('a')?'b':'a');
  assert.equal((await tokenRequest(runtime,refreshFields(client,{refresh_token:invalidSecret}),400)).value.error,'invalid_grant');
  assert.equal((await rawMcp(runtime,refresh.access_token)).status,200,'guessing the spent RT id must not revoke its grant');
  const create=await rawMcp(runtime,refresh.access_token,{method:'tools/call',name:'create_draft',args:{to:['recipient@example.net'],subject:'Pending OAuth send',text:'Do not send after revoke'}});
  const draft=(await create.json()).result.structuredContent.draft;
  const send=await rawMcp(runtime,refresh.access_token,{method:'tools/call',name:'send_message',args:{draftId:draft.id,expectedVersion:draft.version,clientRequestId:'queued-before-replay'}});
  assert.equal((await send.json()).result.structuredContent.status,'queued');
  assert.equal((await tokenRequest(runtime,refreshFields(client,tokens),400)).value.error,'invalid_grant');
  assert.equal((await rawMcp(runtime,refresh.access_token)).status,401);
  assert.notEqual(await runtime.db.prepare('SELECT revoked_at FROM mailbox_tokens WHERE id=?').bind(grant.mailbox_token_id).first('revoked_at'),null);
  await(await runtime.mf.getWorker()).scheduled();
  assert.equal(await runtime.db.prepare('SELECT status FROM outbound_messages').first('status'),'failed');
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_attempts').first('n'),0);
  const secondCode=await issueCode(runtime,box,client),second=(await tokenRequest(runtime,codeFields(client,secondCode))).value;
  const narrowed=(await tokenRequest(runtime,refreshFields(client,second,{scope:'mail:read'}))).value;
  assert.equal(narrowed.scope,'mail:read');
  const list=await rawMcp(runtime,narrowed.access_token);assert.equal((await list.json()).result.tools.length,8);
  assert.equal((await tokenRequest(runtime,refreshFields(client,narrowed,{scope:allScopes}),400)).value.error,'invalid_scope');
  const wrongClient=await publicRequest(runtime,'/oauth/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:other.client_id,token:narrowed.access_token}).toString()});
  assert.equal(wrongClient.status,200);assert.equal((await rawMcp(runtime,narrowed.access_token)).status,200);
  const revoke=await publicRequest(runtime,'/oauth/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,token:narrowed.refresh_token,token_type_hint:'refresh_token'}).toString()});
  assert.equal(revoke.status,200);assert.equal((await rawMcp(runtime,narrowed.access_token)).status,401);
  assert.equal((await tokenRequest(runtime,refreshFields(client,narrowed),400)).value.error,'invalid_grant');
});

test('trusted CIMD clients use bounded cached metadata while untrusted hosts, mismatches and redirects are refused',{timeout:120_000},async t=>{
  const metadataId='https://metadata.example/client.json',calls=[];
  const runtime=await createOwnerRuntime({bindings:{OAUTH_CIMD_ALLOWED_HOSTS:'metadata.example'},outboundService:request=>{
    calls.push(request.url);
    if(request.url===metadataId) return Response.json({client_id:metadataId,client_name:'CIMD <script>untrusted</script>',redirect_uris:[callback],scope:'mail:read',token_endpoint_auth_method:'none'});
    if(request.url==='https://metadata.example/redirect.json') return new Response(null,{status:302,headers:{Location:'https://attacker.example/client.json'}});
    if(request.url==='https://metadata.example/mismatch.json') return Response.json({client_id:'https://attacker.example/id',client_name:'Wrong identifier',redirect_uris:[callback]});
    return null;
  }});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime);
  const metadata=await(await publicRequest(runtime,'/.well-known/oauth-authorization-server')).json();assert.equal(metadata.client_id_metadata_document_supported,true);
  const request=authorization(metadataId,{scope:'mail:read'}),page=await consentPage(runtime,request.url);
  assert.match(page.html,/metadata\.example/);assert.match(page.html,/&lt;script(?:&gt;|>)untrusted&lt;\/script(?:&gt;|>)/);
  assert.equal(page.html.includes('<script>untrusted</script>'),false);
  await consentPage(runtime,authorization(metadataId,{scope:'mail:read'}).url);
  assert.deepEqual(calls,[metadataId]);
  assert.equal(await runtime.db.prepare('SELECT kind FROM oauth_clients WHERE client_id=?').bind(metadataId).first('kind'),'cimd');
  const consent=await decide(runtime,request.url,page,{mailboxId:box.id,scopes:['mail:read']});assert.equal(consent.status,303);
  const returned=new URL(consent.headers.get('Location'));
  const access=(await tokenRequest(runtime,{grant_type:'authorization_code',client_id:metadataId,resource,code:returned.searchParams.get('code'),redirect_uri:callback,code_verifier:request.verifier})).value;
  assert.equal((await rawMcp(runtime,access.access_token)).status,200);
  for(const id of ['https://untrusted.example/client.json','https://127.0.0.1/client.json','https://metadata.example/redirect.json','https://metadata.example/mismatch.json']) {
    const attempt=authorization(id,{scope:'mail:read'});
    const response=await runtime.mf.dispatchFetch(attempt.url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'},redirect:'manual'});
    assert.equal(response.status,400);assert.equal(response.headers.has('Location'),false);
  }
  assert.ok(calls.every(value=>new URL(value).hostname==='metadata.example'));assert.equal(calls.includes('https://attacker.example/client.json'),false);
});

test('OAuth PKCE explicitly grants attachment bytes through MCP and downscoped refresh cannot regain them',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  const scopes='mail:read attachments:read',box=await mailbox(runtime,'OAuth attachment reader');
  const client=await register(runtime,{scope:scopes});
  const metadata=await(await publicRequest(runtime,'/.well-known/oauth-protected-resource/mcp')).json();
  assert.ok(metadata.scopes_supported.includes('attachments:read'));
  const [message]=await seedMessages(runtime,box.id);
  const bytes=Uint8Array.from({length:40_123},(_,index)=>(index*31)%256);
  const attachment=await seedAttachment(runtime,box.id,message.id,{bytes});
  const code=await issueCode(runtime,box,client,{scope:scopes});
  const tokens=(await tokenRequest(runtime,codeFields(client,code))).value;
  assert.equal(tokens.scope,scopes);
  const principal=await runtime.db.prepare('SELECT mailbox_token_id FROM oauth_grants').first('mailbox_token_id');
  assert.equal(await runtime.db.prepare('SELECT can_read_attachments FROM mailbox_tokens WHERE id=?').bind(principal).first('can_read_attachments'),1);
  const tools=(await(await rawMcp(runtime,tokens.access_token)).json()).result.tools;
  assert.ok(tools.some(value=>value.name==='read_attachment'));
  const chunks=[];let offset=0;
  do {
    const response=await rawMcp(runtime,tokens.access_token,{method:'tools/call',name:'read_attachment',args:{messageId:message.id,attachmentId:attachment.id,offset}});
    assert.equal(response.status,200);
    const result=(await response.json()).result;assert.notEqual(result.isError,true,JSON.stringify(result));
    const chunk=result.structuredContent;assert.equal(chunk.encoding,'base64');assert.equal(chunk.totalBytes,bytes.byteLength);
    chunks.push(Buffer.from(chunk.data,'base64'));offset=chunk.nextOffset;
  }while(offset!==null);
  assert.deepEqual(Buffer.concat(chunks),Buffer.from(bytes));
  const binaryUrl=`/v1/messages/${message.id}/attachments/${attachment.id}/download`;
  const http=await publicRequest(runtime,binaryUrl,{headers:{Authorization:`Bearer ${tokens.access_token}`}});
  assert.equal(http.status,401,'OAuth MCP credentials must not be repurposed for REST download URLs');
  const narrowed=(await tokenRequest(runtime,refreshFields(client,tokens,{scope:'mail:read'}))).value;
  assert.equal(narrowed.scope,'mail:read');
  const narrowTools=(await(await rawMcp(runtime,narrowed.access_token)).json()).result.tools;
  assert.equal(narrowTools.some(value=>value.name==='read_attachment'),false);
  const files=(await(await rawMcp(runtime,narrowed.access_token,{method:'tools/call',name:'list_attachments',args:{messageId:message.id}})).json()).result.structuredContent;
  assert.equal(files.canDownload,false);assert.equal(files.attachments[0].downloadable,false);
  assert.equal(await runtime.db.prepare('SELECT can_read_attachments FROM mailbox_tokens WHERE id=?').bind(principal).first('can_read_attachments'),1);
  assert.equal((await tokenRequest(runtime,refreshFields(client,narrowed,{scope:scopes}),400)).value.error,'invalid_scope');
  assert.equal(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read'),0);
  const revoke=await publicRequest(runtime,'/oauth/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:client.client_id,token:narrowed.refresh_token}).toString()});
  assert.equal(revoke.status,200);assert.equal((await rawMcp(runtime,tokens.access_token)).status,401);
});
