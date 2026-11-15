import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import PostalMime from 'postal-mime';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';
import {seedMessages} from '../helpers/mail-fixtures.mjs';

const api='https://api.example.com',consoleOrigin='https://console.example.com',resource=`${api}/mcp`;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=','base64');
const plain={to:['recipient@example.net'],bcc:['hidden-html-bcc@example.net'],subject:'HTML outbound',text:'HTML_PLAIN_FALLBACK'};
const markup=id=>`<h2>OUTBOUND_HTML_MARKER</h2><p>HTML &amp; plain alternatives.</p>${id?`<img src="cid:${id}">`:''}`;
const ownerBase=box=>`/owner/api/mailboxes/${box.id}`;
async function json(response,status=200) {assert.equal(response.status,status,await response.clone().text());return response.json();}
async function mailbox(runtime) {
  return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'HTML sender',localPart:`html-send-${randomUUID()}`}}),201)).mailbox;
}
async function issue(runtime,box,scopes=['mail:read','attachments:read','mail:draft','mail:send']) {
  return json(await runtime.request(`${ownerBase(box)}/tokens`,{method:'POST',body:{name:'HTML sender',scopes}}),201);
}
function agent(runtime,secret,path,{method='GET',body,headers={}}={}) {
  return runtime.mf.dispatchFetch(new URL(path,api),{method,headers:{Authorization:`Bearer ${secret}`,
    ...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function create(runtime,secret,content=plain) {
  return (await json(await agent(runtime,secret,'/v1/drafts',{method:'POST',body:content}),201)).draft;
}
async function update(runtime,secret,draft,content) {
  return (await json(await agent(runtime,secret,`/v1/drafts/${draft.id}`,{method:'PATCH',body:{...content,expectedVersion:draft.version}}))).draft;
}
async function upload(runtime,secret,draft,bytes=png,{filename='logo.png',contentType='image/png'}={}) {
  return (await json(await runtime.mf.dispatchFetch(`${api}/v1/drafts/${draft.id}/attachments`,{method:'POST',headers:{
    Authorization:`Bearer ${secret}`,'Content-Type':'application/octet-stream','X-Draft-Version':String(draft.version),
    'X-Attachment-Filename':encodeURIComponent(filename),'X-Attachment-Content-Type':contentType
  },body:bytes}),201)).draft;
}
async function approve(runtime,box,draft) {
  return (await json(await runtime.request(`${ownerBase(box)}/drafts/${draft.id}/approve`,{method:'POST',
    body:{expectedVersion:draft.version,contentSha256:draft.contentSha256}}))).draft;
}
function submit(runtime,secret,draft,key=randomUUID()) {
  return agent(runtime,secret,`/v1/drafts/${draft.id}/send`,{method:'POST',body:{expectedVersion:draft.version},headers:{'Idempotency-Key':key}});
}
async function sentMime(runtime,id) {
  const object=await runtime.db.prepare('SELECT o.object_key FROM messages m JOIN objects o ON o.id=m.raw_object_id AND o.mailbox_id=m.mailbox_id WHERE m.id=?').bind(id).first();
  assert.ok(object,'Accepted native sends publish their immutable local Sent MIME');
  const bytes=Buffer.from(await (await runtime.bucket.get(object.object_key)).arrayBuffer());return {bytes,mime:await PostalMime.parse(bytes)};
}
async function clientFor(t,runtime,secret) {
  const client=new Client({name:'html-outbound-integration',version:'1.0.0'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});
  registerMcpClient(runtime,client);
  await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},
    fetch:async(input,init)=>{const request=new Request(input,init);assert.equal(new URL(request.url).origin,api);
      const body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();
      return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body,signal:request.signal});}
  }),{timeout:10_000});return client;
}
async function tool(client,name,args={}) {
  const result=await client.callTool({name,arguments:args},{timeout:10_000});assert.notEqual(result.isError,true,JSON.stringify(result));
  assert.ok(result.structuredContent);return result.structuredContent;
}
async function mcpUpload(client,draft,bytes=png) {
  const {upload}=await tool(client,'begin_draft_attachment_upload',{draftId:draft.id,expectedVersion:draft.version,
    filename:'mcp-inline.png',contentType:'image/png',totalBytes:bytes.length});
  await tool(client,'upload_draft_attachment_chunk',{draftId:draft.id,uploadId:upload.id,offset:0,data:bytes.toString('base64')});
  return (await tool(client,'complete_draft_attachment_upload',{draftId:draft.id,uploadId:upload.id})).draft;
}
async function assertNoApproval(runtime,draft) {
  assert.deepEqual(await runtime.db.prepare('SELECT approved_version,approved_sha256,approved_at FROM drafts WHERE id=?').bind(draft.id).first(),
    {approved_version:null,approved_sha256:null,approved_at:null});assert.equal(draft.state,'editing');
}
async function assertNotQueued(runtime) {
  for(const table of ['outbound_messages','send_reservations','send_attempts'])assert.equal(await runtime.db.prepare(`SELECT count(*) n FROM ${table}`).first('n'),0,table);
}
/** Real public registration + Owner consent + PKCE, with credentials valid only at /mcp. */
async function oauth(runtime,box) {
  const callback='https://html-client.example/callback',scope='mail:read mail:draft mail:send',verifier=randomBytes(32).toString('base64url');
  const registration=await json(await runtime.mf.dispatchFetch(`${api}/oauth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    client_name:'HTML OAuth sender',redirect_uris:[callback],scope,token_endpoint_auth_method:'none',
    grant_types:['authorization_code','refresh_token'],response_types:['code']
  })}),201);
  const url=new URL('/owner/oauth/authorize',consoleOrigin);url.search=new URLSearchParams({client_id:registration.client_id,redirect_uri:callback,
    response_type:'code',resource,scope,state:randomUUID(),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const page=await runtime.mf.dispatchFetch(url,{headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Accept:'text/html'}});assert.equal(page.status,200);
  const document=await page.text(),requestId=/name="requestId"[^>]*value="([^"]+)"/.exec(document)?.[1],csrfToken=/name="csrfToken"[^>]*value="([^"]+)"/.exec(document)?.[1];
  assert.ok(requestId&&csrfToken);const form=new URLSearchParams({requestId,csrfToken,decision:'allow',mailboxId:box.id});
  scope.split(' ').forEach(value=>form.append('scope',value));
  const consent=await runtime.mf.dispatchFetch(url,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,Origin:consoleOrigin,
    'Content-Type':'application/x-www-form-urlencoded',Accept:'text/html'},body:form.toString(),redirect:'manual'});
  assert.equal(consent.status,303);const returned=new URL(consent.headers.get('Location'));assert.equal(returned.origin,new URL(callback).origin);
  const tokens=await json(await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'authorization_code',client_id:registration.client_id,resource,code:returned.searchParams.get('code'),
      redirect_uri:callback,code_verifier:verifier}).toString()}));
  return {tokens,clientId:registration.client_id};
}

test('REST HTML/CID approval freezes exact source and native sending publishes text+HTML MIME, inline bytes and safe Sent reading',{timeout:120_000},async t=>{
  const upstream=[];const runtime=await createOwnerRuntime({outboundService:request=>{upstream.push(request.url);}});t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime),token=await issue(runtime,box),raw=markup('Logo.Mixed%40Agent')+'<script>HTML_SEND_UNTRUSTED_SCRIPT</script>';
  let draft=await create(runtime,token.secret,{...plain,html:raw});assert.equal(draft.content.html,raw);
  draft=await upload(runtime,token.secret,draft);const image=draft.content.attachments[0],bindings=[{attachmentId:image.id,contentId:'Logo.Mixed@Agent'}];
  draft=await update(runtime,token.secret,draft,{...plain,inlineImages:bindings});assert.equal(draft.content.html,raw);assert.deepEqual(draft.content.inlineImages,bindings);
  const previewPath=`${ownerBase(box)}/drafts/${draft.id}/html?${new URLSearchParams({expectedVersion:String(draft.version),contentSha256:draft.contentSha256})}`;
  assert.equal((await runtime.request(previewPath,{authenticated:false})).status,401);
  const preview=await runtime.request(previewPath);assert.equal(preview.status,200,await preview.clone().text());const safe=await preview.text();
  assert.match(safe,/OUTBOUND_HTML_MARKER/);assert.match(safe,/src="data:image\/png;base64,/);assert.doesNotMatch(safe,/<script\b|HTML_SEND_UNTRUSTED_SCRIPT/);
  assert.match(preview.headers.get('content-security-policy'),/sandbox/);assert.match(preview.headers.get('content-security-policy'),/img-src data:/);
  assert.equal((await json(await submit(runtime,token.secret,draft,'rest-html-approval'),202)).status,'approval_required');await assertNotQueued(runtime);
  draft=await approve(runtime,box,draft);const queued=await json(await submit(runtime,token.secret,draft,'rest-html-send'),202);assert.equal(queued.status,'queued');
  const frozenRow=await runtime.db.prepare('SELECT o.object_key FROM outbound_messages out JOIN objects o ON o.id=out.frozen_object_id WHERE out.id=?').bind(queued.outboundId).first();
  const frozen=JSON.parse(await (await runtime.bucket.get(frozenRow.object_key)).text());assert.equal(frozen.v,3);assert.equal(frozen.content.html,raw);assert.deepEqual(frozen.content.inlineImages,bindings);
  assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');
  assert.equal(await runtime.db.prepare('SELECT status FROM outbound_messages WHERE id=?').bind(queued.outboundId).first('status'),'accepted');
  const {bytes,mime}=await sentMime(runtime,queued.outboundId);assert.equal(mime.text.trim(),plain.text);assert.equal(mime.html.trim(),raw);
  assert.equal(mime.attachments.length,1);assert.equal(mime.attachments[0].disposition,'inline');assert.equal(mime.attachments[0].contentId?.replace(/^<|>$/g,''),'Logo.Mixed@Agent');
  assert.deepEqual(Buffer.from(mime.attachments[0].content),png);assert.equal(bytes.includes(Buffer.from(plain.bcc[0])),false);assert.equal(mime.bcc,undefined);
  const detail=await json(await agent(runtime,token.secret,`/v1/messages/${queued.outboundId}`));assert.equal(detail.body.text,plain.text);assert.equal('html' in detail.body,false);
  assert.equal(detail.body.htmlStatus,'available');assert.equal(detail.attachments.attachments[0].disposition,'inline');assert.equal(detail.capabilities.htmlRendering,false);
  const rendered=await runtime.request(`${ownerBase(box)}/messages/${queued.outboundId}/html`);assert.equal(rendered.status,200);
  const html=await rendered.text();assert.match(html,/OUTBOUND_HTML_MARKER/);assert.match(html,/src="data:image\/png;base64,/);assert.doesNotMatch(html,/<script\b|HTML_SEND_UNTRUSTED_SCRIPT/);
  assert.deepEqual(upstream,[],'Preview and native EMAIL send never fetch sender HTML URLs');
});

test('official MCP edits preserve omitted HTML/bindings, clear them explicitly and invalidate approval on either source or mapping changes',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),token=await issue(runtime,box),client=await clientFor(t,runtime,token.secret);
  const tools=(await client.listTools()).tools;assert.equal(tools.length,22);const schema=tools.find(item=>item.name==='update_draft').inputSchema;
  assert.ok(schema.properties.html&&schema.properties.inlineImages);assert.equal(schema.additionalProperties,false);
  let draft=(await tool(client,'create_draft',{...plain,html:markup()})).draft;draft=await mcpUpload(client,draft);
  const image=draft.content.attachments[0],bindings=[{attachmentId:image.id,contentId:'Unused.Mixed@Agent'}];
  draft=(await tool(client,'update_draft',{...plain,draftId:draft.id,expectedVersion:draft.version,inlineImages:bindings})).draft;
  const preserved=await tool(client,'get_draft',{draftId:draft.id});assert.equal(preserved.draft.content.html,markup());assert.deepEqual(preserved.draft.content.inlineImages,bindings);
  draft=await approve(runtime,box,draft);const hash=draft.contentSha256,version=draft.version;
  draft=(await tool(client,'update_draft',{...plain,draftId:draft.id,expectedVersion:draft.version,html:markup()+'<p>Changed HTML</p>'})).draft;
  assert.equal(draft.version,version+1);assert.notEqual(draft.contentSha256,hash);assert.deepEqual(draft.content.inlineImages,bindings);await assertNoApproval(runtime,draft);
  assert.equal((await tool(client,'send_message',{draftId:draft.id,expectedVersion:draft.version,clientRequestId:'mcp-new-html-approval'})).status,'approval_required');
  draft=await approve(runtime,box,draft);const approvedHash=draft.contentSha256;
  draft=(await tool(client,'update_draft',{...plain,draftId:draft.id,expectedVersion:draft.version,inlineImages:[{attachmentId:image.id,contentId:'Other.Mixed@Agent'}]})).draft;
  assert.notEqual(draft.contentSha256,approvedHash);assert.match(draft.content.html,/Changed HTML/);await assertNoApproval(runtime,draft);
  const rejected=await client.callTool({name:'update_draft',arguments:{...plain,draftId:draft.id,expectedVersion:draft.version,attachments:[image]}});assert.equal(rejected.isError,true);
  for(const changes of [{html:'秘'.repeat(22_000)},{inlineImages:[{attachmentId:image.id,contentId:'<bracketed>'}]},
    {inlineImages:[{attachmentId:image.id,contentId:'a'},{attachmentId:image.id,contentId:'b'}]}]) {
    const invalid=await client.callTool({name:'update_draft',arguments:{...plain,draftId:draft.id,expectedVersion:draft.version,...changes}});assert.equal(invalid.isError,true);
  }
  assert.equal((await tool(client,'get_draft',{draftId:draft.id})).draft.version,draft.version);
  draft=(await tool(client,'update_draft',{...plain,draftId:draft.id,expectedVersion:draft.version,inlineImages:[]})).draft;
  assert.deepEqual(draft.content.inlineImages,[]);assert.match(draft.content.html,/Changed HTML/);assert.equal(draft.content.attachments.length,1);
  draft=(await tool(client,'update_draft',{...plain,draftId:draft.id,expectedVersion:draft.version,html:null})).draft;
  assert.equal(draft.content.html,null);assert.deepEqual(draft.content.inlineImages,[]);assert.equal(draft.content.attachments.length,1);
  await assertNotQueued(runtime);
});

test('HTML/CID preflight rejects missing plain text, dangling/malformed/duplicate/foreign bindings, active images and oversized rasters before approval or reservations',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),token=await issue(runtime,box);
  const incomplete=await create(runtime,token.secret,{...plain,text:'',html:markup()});
  assert.equal((await submit(runtime,token.secret,incomplete)).status,400);
  const dangling=await create(runtime,token.secret,{...plain,html:markup('Missing%40Agent')});
  assert.equal((await json(await runtime.request(`${ownerBase(box)}/drafts/${dangling.id}/approve`,{method:'POST',body:{expectedVersion:dangling.version,contentSha256:dangling.contentSha256}}),400)).error.code,'unresolved_cid');
  assert.equal((await json(await submit(runtime,token.secret,dangling),400)).error.code,'unresolved_cid');
  let donor=await create(runtime,token.secret,{...plain,html:markup()});donor=await upload(runtime,token.secret,donor);const foreign=donor.content.attachments[0];
  assert.equal((await json(await agent(runtime,token.secret,`/v1/drafts/${dangling.id}`,{method:'PATCH',body:{...plain,html:markup('foreign'),expectedVersion:dangling.version,
    inlineImages:[{attachmentId:foreign.id,contentId:'foreign'}]}}),400)).error.code,'invalid_inline_images');
  for(const bindings of [[{attachmentId:foreign.id,contentId:'same'},{attachmentId:foreign.id,contentId:'other'}],
    [{attachmentId:foreign.id,contentId:'same'},{attachmentId:randomUUID(),contentId:'same'}],[{attachmentId:foreign.id,contentId:'<angle>'}]]) {
    assert.equal((await agent(runtime,token.secret,`/v1/drafts/${donor.id}`,{method:'PATCH',body:{...plain,html:markup(),inlineImages:bindings,expectedVersion:donor.version}})).status,400);
  }
  const oversized=Buffer.alloc(1024*1024+1);png.copy(oversized);
  for(const [contentType,bytes] of [['image/svg+xml',Buffer.from('<svg onload="alert(1)"/>')],['image/png',Buffer.from('not-a-raster')],['image/png',oversized]]) {
    let draft=await create(runtime,token.secret,{...plain,html:markup('bad')});draft=await upload(runtime,token.secret,draft,bytes,{filename:'bad-image.bin',contentType});
    draft=await update(runtime,token.secret,draft,{...plain,inlineImages:[{attachmentId:draft.content.attachments[0].id,contentId:'bad'}]});
    const approval=await runtime.request(`${ownerBase(box)}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:draft.version,contentSha256:draft.contentSha256}});
    assert.equal((await json(approval,400)).error.code,'inline_image_invalid');assert.equal((await json(await submit(runtime,token.secret,draft),400)).error.code,'inline_image_invalid');
  }
  assert.equal((await agent(runtime,token.secret,'/v1/drafts',{method:'POST',body:{...plain,html:'秘'.repeat(22_000)}})).status,413);
  await assertNotQueued(runtime);
});

test('OAuth MCP reply drafts retain HTML/CID across refresh and send valid multipart replies through Owner approval',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),[source]=await seedMessages(runtime,box.id,{text:'Original threaded message'});
  await runtime.db.prepare('UPDATE messages SET rfc_message_id=? WHERE id=?').bind('<html-source@example.net>',source.id).run();
  const authorized=await oauth(runtime,box),client=await clientFor(t,runtime,authorized.tokens.access_token);
  assert.equal((await agent(runtime,authorized.tokens.access_token,'/v1/drafts')).status,401,'OAuth credentials remain MCP-only');
  let draft=(await tool(client,'reply_message',{messageId:source.id,text:'OAuth HTML reply fallback',html:markup('Reply.Mixed%40Agent')})).draft;
  assert.equal(draft.content.inReplyTo,'<html-source@example.net>');assert.equal(draft.content.to[0],'build@example.net');draft=await mcpUpload(client,draft);
  const bindings=[{attachmentId:draft.content.attachments[0].id,contentId:'Reply.Mixed@Agent'}];
  draft=(await tool(client,'update_draft',{draftId:draft.id,expectedVersion:draft.version,to:draft.content.to,subject:draft.content.subject,
    text:draft.content.text,replyMessageId:source.id,inlineImages:bindings})).draft;
  const refreshed=await json(await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'refresh_token',client_id:authorized.clientId,resource,refresh_token:authorized.tokens.refresh_token}).toString()}));
  assert.notEqual(refreshed.access_token,authorized.tokens.access_token);const afterRefresh=await clientFor(t,runtime,refreshed.access_token);
  const same=(await tool(afterRefresh,'get_draft',{draftId:draft.id})).draft;assert.equal(same.content.html,markup('Reply.Mixed%40Agent'));assert.deepEqual(same.content.inlineImages,bindings);
  assert.equal((await tool(afterRefresh,'send_message',{draftId:draft.id,expectedVersion:draft.version,clientRequestId:'oauth-html-approval'})).status,'approval_required');
  draft=await approve(runtime,box,draft);const sent=await tool(afterRefresh,'send_message',{draftId:draft.id,expectedVersion:draft.version,clientRequestId:'oauth-html-send'});
  assert.equal(sent.status,'queued');await (await runtime.mf.getWorker()).scheduled();
  assert.equal(await runtime.db.prepare('SELECT status FROM outbound_messages WHERE id=?').bind(sent.outboundId).first('status'),'accepted');
  const {mime}=await sentMime(runtime,sent.outboundId);assert.equal(mime.text.trim(),'OAuth HTML reply fallback');assert.equal(mime.html.trim(),markup('Reply.Mixed%40Agent'));
  assert.equal(mime.inReplyTo,'<html-source@example.net>');assert.ok([mime.references].flat().includes('<html-source@example.net>'));
  assert.equal(mime.attachments[0].disposition,'inline');assert.deepEqual(Buffer.from(mime.attachments[0].content),png);
  const read=await tool(afterRefresh,'read_message',{messageId:sent.outboundId});assert.equal(read.body.text,'OAuth HTML reply fallback');assert.equal('html' in read.body,false);
});

test('queued HTML snapshots reject later CID corruption before native submission and submitted mappings cannot change',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));const box=await mailbox(runtime),token=await issue(runtime,box);
  let draft=await create(runtime,token.secret,{...plain,html:markup('frozen')});draft=await upload(runtime,token.secret,draft);
  const attachment=draft.content.attachments[0];draft=await update(runtime,token.secret,draft,{...plain,inlineImages:[{attachmentId:attachment.id,contentId:'frozen'}]});
  draft=await approve(runtime,box,draft);const queued=await json(await submit(runtime,token.secret,draft,'frozen-html-send'),202);assert.equal(queued.status,'queued');
  assert.equal((await agent(runtime,token.secret,`/v1/drafts/${draft.id}`,{method:'PATCH',body:{...plain,html:null,expectedVersion:draft.version}})).status,409);
  assert.equal((await agent(runtime,token.secret,`/v1/drafts/${draft.id}/attachments/${attachment.id}`,{method:'DELETE',body:{expectedVersion:draft.version}})).status,409);
  const object=await runtime.db.prepare('SELECT o.object_key FROM draft_attachments a JOIN objects o ON o.id=a.object_id AND o.mailbox_id=a.mailbox_id WHERE a.id=?').bind(attachment.id).first();
  await runtime.bucket.put(object.object_key,'PRIVATE_CORRUPT_INLINE_FILE');await (await runtime.mf.getWorker()).scheduled();
  const failure=await runtime.db.prepare('SELECT status,last_error_code FROM outbound_messages WHERE id=?').bind(queued.outboundId).first();assert.equal(failure.status,'failed',JSON.stringify(failure));
  assert.ok(failure.last_error_code);assert.equal(failure.last_error_code.includes('PRIVATE_CORRUPT'),false);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_attempts').first('n'),0);assert.equal(await runtime.db.prepare("SELECT count(*) n FROM messages WHERE direction='outbound'").first('n'),0);
  assert.equal(await runtime.db.prepare('SELECT state FROM send_reservations').first('state'),'released');
});
