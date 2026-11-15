import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';
import {seedMessages} from '../helpers/mail-fixtures.mjs';
import {seedAttachment} from '../helpers/attachment-fixtures.mjs';

const version='2026-07-28';
const endpoint='https://api.example.com/mcp';
const readTools=['get_mailbox','list_attachments','list_mail_events','list_messages','list_webhook_deliveries','list_webhook_subscriptions','read_message','search_messages'];
const draftTools=['begin_draft_attachment_upload','complete_draft_attachment_upload','create_draft','get_draft','list_drafts','list_outbound',
  'read_draft_attachment','remove_draft_attachment','update_draft','upload_draft_attachment_chunk'];
const runFile=promisify(execFile);

async function ownerJson(runtime,path,options={},expected=200) {
  const response=await runtime.request(path,options);
  assert.equal(response.status,expected,await response.clone().text());
  return response.json();
}
async function mailbox(runtime,name) {
  return (await ownerJson(runtime,'/owner/api/mailboxes',{method:'POST',body:{name,localPart:`mcp-${randomUUID()}`}},201)).mailbox;
}
async function issue(runtime,box,scopes,requiresApproval=true) {
  return ownerJson(runtime,`/owner/api/mailboxes/${box.id}/tokens`,{method:'POST',body:{name:'MCP integration',scopes,requiresApproval}},201);
}
async function clientFor(t,runtime,secret,legacy=false) {
  const traffic=[];
  const client=new Client({name:'agent-mail-integration',version:'1.0.0'},
    {capabilities:{},versionNegotiation:{mode:legacy?'legacy':{pin:version}}});
  const transport=new StreamableHTTPClientTransport(new URL(endpoint),{
    requestInit:{headers:{Authorization:`Bearer ${secret}`}},
    fetch:async(input,init)=>{
      const request=new Request(input,init),url=new URL(request.url);
      assert.equal(url.origin,'https://api.example.com','MCP client must never leave the local test adapter');
      let body;
      if(!['GET','HEAD'].includes(request.method)) body=await request.arrayBuffer();
      const response=await runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body,signal:request.signal});
      traffic.push({method:request.method,protocol:request.headers.get('MCP-Protocol-Version'),
        rpc:body?.byteLength?JSON.parse(new TextDecoder().decode(body)):null,status:response.status,session:response.headers.get('Mcp-Session-Id')});
      return response;
    }
  });
  registerMcpClient(runtime,client);
  await client.connect(transport,{timeout:10_000});
  return {client,traffic};
}
async function tool(client,name,args={}) {
  const result=await client.callTool({name,arguments:args},{timeout:10_000});
  assert.notEqual(result.isError,true,JSON.stringify(result));
  assert.ok(result.structuredContent&&typeof result.structuredContent==='object');
  return result.structuredContent;
}
async function toolError(client,name,args,code) {
  const result=await client.callTool({name,arguments:args},{timeout:10_000});
  assert.equal(result.isError,true,JSON.stringify(result));
  if(code) assert.equal(result.structuredContent?.error?.code,code,JSON.stringify(result));
  return result;
}
function rawRequest(runtime,secret,method,params={},options={}) {
  const meta={'io.modelcontextprotocol/protocolVersion':version,
    'io.modelcontextprotocol/clientInfo':{name:'raw-integration',version:'1.0.0'},'io.modelcontextprotocol/clientCapabilities':{}};
  const body={jsonrpc:'2.0',id:options.id??1,method,params:{...params,_meta:{...meta,...params._meta}}};
  return runtime.mf.dispatchFetch(endpoint,{method:options.httpMethod??'POST',headers:{
    Accept:'application/json, text/event-stream','Content-Type':'application/json','MCP-Protocol-Version':version,'Mcp-Method':method,
    ...(method==='tools/call'?{'Mcp-Name':params.name}:{}),...(secret?{Authorization:`Bearer ${secret}`}:{ }),...options.headers},
    ...(['GET','HEAD','DELETE'].includes(options.httpMethod)?{}:{body:options.rawBody??JSON.stringify(body)})});
}

test('official modern MCP client reuses mailbox scopes, drafts, replies, Owner approval and native send',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  const a=await mailbox(runtime,'MCP Alpha'),b=await mailbox(runtime,'MCP Beta');
  const read=await issue(runtime,a,['mail:read']),draftOnly=await issue(runtime,a,['mail:draft']);
  const sender=await issue(runtime,a,['mail:read','mail:draft','mail:send']);
  const other=await issue(runtime,b,['mail:read','mail:draft','mail:send']);
  const ownMessages=await seedMessages(runtime,a.id,{count:4,prefix:'MCP report',text:'不可信邮件正文 <script>example()</script> 😀\n'+'x'.repeat(20_000)});
  const [otherMessage]=await seedMessages(runtime,b.id,{prefix:'Beta private',text:'BETA_PRIVATE_BODY'});
  await runtime.db.prepare('UPDATE messages SET rfc_message_id=? WHERE id=?').bind('<mcp-source@example.net>',ownMessages[0].id).run();
  const [{client:reader},{client:drafter},{client:agent,traffic},{client:otherAgent}]=await Promise.all([
    clientFor(t,runtime,read.secret),clientFor(t,runtime,draftOnly.secret),clientFor(t,runtime,sender.secret),clientFor(t,runtime,other.secret)]);
  assert.deepEqual((await reader.listTools()).tools.map(tool=>tool.name).sort(),readTools);
  assert.deepEqual((await drafter.listTools()).tools.map(tool=>tool.name).sort(),draftTools);
  const names=(await agent.listTools()).tools.map(tool=>tool.name);
  assert.equal(names.length,21);assert.ok(names.includes('reply_message')&&names.includes('send_message')&&names.includes('check_recipient_suppressions'));
  for(const name of ['approve_draft','issue_token','list_mailboxes','download_attachment']) assert.ok(!names.includes(name));
  assert.ok(traffic.some(entry=>entry.rpc?.method==='server/discover'&&entry.protocol===version));
  assert.ok(traffic.every(entry=>entry.session===null));
  const mailboxInfo=await tool(agent,'get_mailbox');
  assert.equal(mailboxInfo.mailbox.id,a.id);assert.equal(mailboxInfo.permissions.requiresApproval,true);
  assert.equal((await tool(reader,'get_mailbox')).permissions.canSend,false);

  const page=await tool(agent,'list_messages',{limit:2,folder:'inbox',read:'unread'});
  assert.equal(page.messages.length,2);assert.ok(page.nextCursor);
  const next=await tool(agent,'list_messages',{limit:2,folder:'inbox',read:'unread',cursor:page.nextCursor});
  assert.equal(next.messages.length,2);assert.equal(new Set([...page.messages,...next.messages].map(message=>message.id)).size,4);
  const found=await tool(agent,'search_messages',{q:'MCP report 002',limit:2});
  assert.deepEqual(found.messages.map(message=>message.id),[ownMessages[1].id]);
  assert.equal((await tool(agent,'search_messages',{q:'%'})).messages.length,0,'SQL wildcard characters are literal query text');
  const first=await tool(agent,'read_message',{messageId:ownMessages[0].id,limit:64});
  assert.equal(first.body.status,'ready');assert.equal(first.body.offset,0);assert.equal(first.body.truncated,true);
  assert.ok(first.body.text.length<=64);assert.ok(first.body.nextOffset>0);
  const second=await tool(agent,'read_message',{messageId:ownMessages[0].id,offset:first.body.nextOffset,limit:64});
  assert.equal(first.body.text+second.body.text,ownMessages[0].text.slice(0,second.body.nextOffset));
  assert.equal(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(ownMessages[0].id).first('is_read'),0);
  await toolError(agent,'read_message',{messageId:otherMessage.id},'not_found');
  await toolError(agent,'reply_message',{messageId:otherMessage.id,text:'Cross-box reply'},'not_found');
  const parallel=await Promise.all(Array.from({length:4},()=>Promise.all([
    tool(agent,'list_messages',{}),tool(otherAgent,'list_messages',{})])));
  for(const [left,right] of parallel) {
    assert.equal(left.messages.length,4);assert.equal(right.messages.length,1);
    assert.equal(right.messages[0].id,otherMessage.id);assert.ok(!JSON.stringify(left).includes('Beta private'));
  }

  const hidden=(await tool(drafter,'create_draft',{to:['recipient@example.net'],subject:'Private draft',text:'PRIVATE_DRAFT'})).draft;
  await toolError(agent,'get_draft',{draftId:hidden.id},'not_found');
  assert.equal((await tool(agent,'list_drafts',{})).drafts.length,0);
  const reply=(await tool(agent,'reply_message',{messageId:ownMessages[0].id,text:'Reply body'})).draft;
  assert.equal(reply.content.replyMessageId,ownMessages[0].id);assert.equal(reply.content.inReplyTo,'<mcp-source@example.net>');
  assert.deepEqual(reply.content.to,['build@example.net']);assert.match(reply.content.subject,/^Re:/);
  assert.equal(await runtime.db.prepare('SELECT count(*) FROM outbound_messages').first('count(*)'),0,'reply only creates a draft');
  let draft=(await tool(agent,'create_draft',{to:['recipient@example.net'],bcc:['hidden@example.net'],subject:'MCP send',text:'First version'})).draft;
  assert.equal(draft.requiresApproval,true);
  const summaries=await tool(agent,'list_drafts');
  assert.equal(summaries.drafts.length,2);assert.ok(summaries.drafts.every(summary=>summary.content===undefined));
  assert.ok(!JSON.stringify(summaries).includes('Reply body'));
  let pending=await tool(agent,'send_message',{draftId:draft.id,expectedVersion:1,clientRequestId:'mcp-approval-v1'});
  assert.equal(pending.status,'approval_required');
  assert.equal(await runtime.db.prepare('SELECT count(*) FROM send_reservations').first('count(*)'),0);
  const base=`/owner/api/mailboxes/${a.id}`;
  await ownerJson(runtime,`${base}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:1,contentSha256:draft.contentSha256}});
  draft=(await tool(agent,'update_draft',{draftId:draft.id,expectedVersion:1,to:['recipient@example.net'],bcc:['hidden@example.net'],subject:'MCP send',text:'Approved final version'})).draft;
  assert.equal(draft.version,2);assert.equal(draft.state,'editing');
  pending=await tool(agent,'send_message',{draftId:draft.id,expectedVersion:2,clientRequestId:'mcp-approval-v2'});
  assert.equal(pending.status,'approval_required');
  await toolError(agent,'send_message',{draftId:draft.id,expectedVersion:2,clientRequestId:'mcp-approval-v1'},'idempotency_conflict');
  await ownerJson(runtime,`${base}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:2,contentSha256:draft.contentSha256}});
  const submit={draftId:draft.id,expectedVersion:2,clientRequestId:'mcp-send-v2'};
  const queued=await tool(agent,'send_message',submit),repeat=await tool(agent,'send_message',submit);
  assert.equal(queued.status,'queued');assert.equal(repeat.outboundId,queued.outboundId);
  await toolError(agent,'send_message',{...submit,clientRequestId:'different-rpc-request'},'draft_changed');
  assert.equal(await runtime.db.prepare('SELECT count(*) FROM send_reservations').first('count(*)'),1);
  assert.equal(await runtime.db.prepare("SELECT count(*) FROM jobs WHERE kind='send_email'").first('count(*)'),1);
  assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');
  assert.equal((await tool(agent,'list_outbound',{})).outbound[0].status,'accepted');
  const sent=await tool(agent,'read_message',{messageId:queued.outboundId});
  assert.equal(sent.body.text,'Approved final version');
  assert.ok(!sent.addresses.some(address=>address.kind==='bcc'));
  await (await runtime.mf.getWorker()).scheduled();
  assert.equal(await runtime.db.prepare('SELECT count(*) FROM send_attempts').first('count(*)'),1);
  assert.equal(await runtime.db.prepare('SELECT used_units FROM daily_send_counters').first('used_units'),2);
  const serialized=JSON.stringify(await tool(agent,'get_draft',{draftId:draft.id}));
  for(const privateValue of [sender.secret,'secret_sha256','object_key','content_object_id','/draft/v1/']) assert.ok(!serialized.includes(privateValue));

  // Only an explicitly Owner-issued no-approval Token can queue without an Owner approval round trip.
  const directToken=await issue(runtime,b,['mail:draft','mail:send'],false);
  const {client:direct}=await clientFor(t,runtime,directToken.secret);
  const directDraft=(await tool(direct,'create_draft',{to:['recipient@example.net'],subject:'Direct',text:'Explicit grant'})).draft;
  assert.equal(directDraft.requiresApproval,false);
  assert.equal((await tool(direct,'send_message',{draftId:directDraft.id,expectedVersion:1,clientRequestId:'explicit-direct'})).status,'queued');
});

test('legacy MCP client interoperates while HTTP validation and every-request Token auth remain strict',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime,'Legacy MCP'),read=await issue(runtime,box,['mail:read']);
  const [message]=await seedMessages(runtime,box.id,{text:'Legacy client body'});
  const {client,traffic}=await clientFor(t,runtime,read.secret,true);
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name).sort(),readTools);
  assert.equal((await tool(client,'read_message',{messageId:message.id})).body.text,'Legacy client body');
  assert.ok(traffic.some(entry=>entry.rpc?.method==='initialize'&&entry.rpc.params.protocolVersion==='2025-11-25'));
  assert.ok(traffic.every(entry=>entry.session===null));
  for(const method of ['GET','DELETE']) {
    const response=await rawRequest(runtime,read.secret,'tools/list',{}, {httpMethod:method});
    assert.equal(response.status,405);assert.equal(response.headers.get('Allow'),'POST');
    assert.match(response.headers.get('Cache-Control'),/no-store/);
  }
  assert.equal((await rawRequest(runtime,null,'tools/list')).status,401);
  assert.equal((await rawRequest(runtime,'not-a-token','tools/list')).status,401);
  assert.equal((await rawRequest(runtime,read.secret,'tools/list',{}, {headers:{Origin:'https://evil.example'}})).status,403);
  const valid=await rawRequest(runtime,read.secret,'tools/list');
  assert.equal(valid.status,200,await valid.clone().text());assert.match(valid.headers.get('Cache-Control'),/no-store/);
  assert.equal(valid.headers.get('Mcp-Session-Id'),null);

  const malformed=await rawRequest(runtime,read.secret,'tools/list',{}, {rawBody:'{'});
  assert.equal(malformed.status,400);assert.equal((await malformed.json()).error.code,-32700);
  const batch=await rawRequest(runtime,read.secret,'tools/list',{}, {rawBody:JSON.stringify([{jsonrpc:'2.0',id:1,method:'tools/list'}])});
  assert.equal(batch.status,400);assert.ok((await batch.json()).error);
  const unsupported=await rawRequest(runtime,read.secret,'tools/list',{_meta:{'io.modelcontextprotocol/protocolVersion':'2099-01-01'}}, {headers:{'MCP-Protocol-Version':'2099-01-01'}});
  assert.equal(unsupported.status,400);assert.ok((await unsupported.json()).error);
  const mismatch=await rawRequest(runtime,read.secret,'tools/list',{}, {headers:{'Mcp-Method':'tools/call'}});
  assert.equal(mismatch.status,400);assert.equal((await mismatch.json()).error.code,-32020);
  const noMethod=await rawRequest(runtime,read.secret,'unsupported/method');
  assert.equal(noMethod.status,404);assert.equal((await noMethod.json()).error.code,-32601);
  // SvelteKit independently rejects cross-origin form-like requests; use the valid Origin to isolate media-type handling.
  const wrongType=await rawRequest(runtime,read.secret,'tools/list',{}, {headers:{'Content-Type':'text/plain',Origin:'https://api.example.com'}});
  assert.equal(wrongType.status,415);
  const wrongAccept=await rawRequest(runtime,read.secret,'tools/list',{}, {headers:{Accept:'application/json'}});
  assert.equal(wrongAccept.status,406);
  const oversized=await rawRequest(runtime,read.secret,'tools/list',{padding:'x'.repeat(270*1024)});
  assert.equal(oversized.status,413);

  const ungranted=await rawRequest(runtime,read.secret,'tools/call',{name:'create_draft',arguments:{subject:'Forbidden',text:'Read-only token cannot create'}});
  const ungrantedBody=await ungranted.json();
  assert.ok(ungrantedBody.error||ungrantedBody.result?.isError,'directly calling a hidden tool must still fail');
  assert.equal(await runtime.db.prepare('SELECT count(*) FROM drafts').first('count(*)'),0);

  // A caller cannot smuggle a mailbox or an approval policy through a tool's strict schema.
  const full=await issue(runtime,box,['mail:read','mail:draft','mail:send']);
  const injection=await rawRequest(runtime,full.secret,'tools/call',{name:'create_draft',arguments:{to:['recipient@example.net'],subject:'Invalid',text:'Must not persist',mailboxId:box.id,requiresApproval:false}});
  assert.equal(injection.status,200);assert.equal((await injection.json()).result.isError,true);
  assert.equal(await runtime.db.prepare('SELECT count(*) FROM drafts').first('count(*)'),0);
  const nameMismatch=await rawRequest(runtime,full.secret,'tools/call',{name:'create_draft',arguments:{}},{headers:{'Mcp-Name':'send_message'}});
  assert.equal(nameMismatch.status,400);assert.equal((await nameMismatch.json()).error.code,-32020);
  assert.equal(await runtime.db.prepare('SELECT count(*) FROM drafts').first('count(*)'),0);

  const expired=await issue(runtime,box,['mail:read']);
  await runtime.db.prepare('UPDATE mailbox_tokens SET expires_at=created_at+1 WHERE id=?').bind(expired.token.id).run();
  assert.equal((await rawRequest(runtime,expired.secret,'tools/list')).status,401);
  const revoked=await runtime.request(`/owner/api/mailboxes/${box.id}/tokens/${read.token.id}`,{method:'DELETE'});
  assert.equal(revoked.status,200);
  await assert.rejects(()=>client.listTools(undefined,{cache:'bypass'}));
  assert.equal((await rawRequest(runtime,read.secret,'tools/list',{}, {headers:{'Mcp-Session-Id':'not-an-authorization'}})).status,401);
  await ownerJson(runtime,`/owner/api/mailboxes/${box.id}`,{method:'PATCH',body:{status:'paused',expectedUpdatedAt:box.updatedAt}});
  assert.equal((await rawRequest(runtime,full.secret,'tools/list')).status,401);
});

test('documented MCP client example connects over real loopback HTTP without writes or credential output',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  const box=await mailbox(runtime,'Example MCP'),read=await issue(runtime,box,['mail:read']);
  const url=new URL('/mcp',await runtime.mf.ready);
  assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');
  const counts=async()=>runtime.db.prepare(`SELECT
    (SELECT count(*) FROM drafts) drafts,(SELECT count(*) FROM messages) messages,
    (SELECT count(*) FROM outbound_messages) outbound,(SELECT count(*) FROM jobs) jobs,
    (SELECT count(*) FROM send_reservations) reservations,(SELECT count(*) FROM audit_events) audits`).first();
  const before=await counts();
  const {stdout,stderr}=await runFile(process.execPath,['examples/mcp-client.mjs'],{cwd:process.cwd(),
    env:{...process.env,AGENT_MAIL_URL:url.href,AGENT_MAIL_TOKEN:read.secret},timeout:15_000,windowsHide:true});
  const output=stdout.trim().split(/\r?\n(?=\{)/).map(value=>JSON.parse(value));
  assert.equal(output.length,2);assert.deepEqual(output[0].tools.sort(),readTools);
  assert.equal(output[1].mailbox.id,box.id);
  for(const privateValue of [read.secret,'secret_sha256','object_key','content_object_id','/draft/v1/']) {
    assert.ok(!stdout.includes(privateValue));assert.ok(!stderr.includes(privateValue));
  }
  assert.equal(stderr,'');assert.deepEqual(await counts(),before);
  assert.equal(before.jobs,0);assert.equal(before.outbound,0);
});

test('official MCP client lists attachment metadata and downloads exact bounded binary chunks under separate mailbox grants',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  const a=await mailbox(runtime,'MCP files'),b=await mailbox(runtime,'MCP private files');
  const grant=await issue(runtime,a,['mail:read','attachments:read']),metadataOnly=await issue(runtime,a,['mail:read']);
  const [message]=await seedMessages(runtime,a.id),[privateMessage]=await seedMessages(runtime,b.id);
  const bytes=Uint8Array.from({length:80_003},(_,index)=>(index*17)%256);
  const attachment=await seedAttachment(runtime,a.id,message.id,{bytes,filename:'../../文件<script>.bin'});
  const hidden=await seedAttachment(runtime,b.id,privateMessage.id,{bytes:new TextEncoder().encode('PRIVATE_OTHER_MAILBOX_ATTACHMENT')});
  const [{client:agent},{client:reader}]=await Promise.all([clientFor(t,runtime,grant.secret),clientFor(t,runtime,metadataOnly.secret)]);
  const names=(await agent.listTools()).tools.map(value=>value.name);
  assert.ok(names.includes('list_attachments')&&names.includes('read_attachment'));
  assert.equal((await reader.listTools()).tools.some(value=>value.name==='read_attachment'),false);
  const metadata=await tool(reader,'list_attachments',{messageId:message.id});
  assert.equal(metadata.canDownload,false);assert.equal(metadata.attachments[0].downloadable,false);
  assert.equal(metadata.attachments[0].scanStatus,'unscanned');assert.equal(metadata.attachments[0].sizeBytes,bytes.byteLength);
  assert.ok(!JSON.stringify(metadata).includes(attachment.key));assert.ok(!JSON.stringify(metadata).includes('object_id'));
  const chunks=[];let offset=0;
  do {
    const chunk=await tool(agent,'read_attachment',{messageId:message.id,attachmentId:attachment.id,offset,limit:32*1024});
    assert.equal(chunk.encoding,'base64');assert.equal(chunk.totalBytes,bytes.byteLength);assert.equal(chunk.offset,offset);
    const decoded=Buffer.from(chunk.data,'base64');assert.ok(decoded.byteLength<=32*1024);chunks.push(decoded);offset=chunk.nextOffset;
  }while(offset!==null);
  assert.deepEqual(Buffer.concat(chunks),Buffer.from(bytes));
  await toolError(agent,'read_attachment',{messageId:privateMessage.id,attachmentId:hidden.id},'not_found');
  await toolError(agent,'read_attachment',{messageId:message.id,attachmentId:hidden.id},'not_found');
  await toolError(agent,'read_attachment',{messageId:message.id,attachmentId:attachment.id,offset:bytes.length+1},'invalid_offset');
  const blocked=await seedAttachment(runtime,a.id,message.id,{scanStatus:'blocked'});
  await toolError(agent,'read_attachment',{messageId:message.id,attachmentId:blocked.id},'attachment_blocked');
  assert.equal(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read'),0);
  await ownerJson(runtime,`/owner/api/mailboxes/${a.id}/tokens/${grant.token.id}`,{method:'DELETE'});
  assert.equal((await rawRequest(runtime,grant.secret,'tools/call',{name:'read_attachment',arguments:{messageId:message.id,attachmentId:attachment.id}})).status,401);
});
