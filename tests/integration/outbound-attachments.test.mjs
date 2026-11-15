import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import PostalMime from 'postal-mime';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {disposeOwnerRuntime,registerMcpClient} from '../helpers/mcp-cleanup.mjs';

const api='https://api.example.com';
async function json(response,status=200) {assert.equal(response.status,status,await response.clone().text());return response.json();}
async function box(runtime,localPart='sending-files') {
  return (await json(await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:localPart,localPart}}),201)).mailbox;
}
async function issue(runtime,mailbox,scopes=['mail:draft','mail:send']) {
  return json(await runtime.request(`/owner/api/mailboxes/${mailbox.id}/tokens`,{method:'POST',body:{name:'File sender',scopes}}),201);
}
function agent(runtime,secret,path,{method='GET',body,headers={}}={}) {
  return runtime.mf.dispatchFetch(new URL(path,api),{method,headers:{Authorization:`Bearer ${secret}`,
    ...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
function upload(runtime,mailbox,draft,bytes,{secret,filename='资料.bin',headers={}}={}) {
  const path=secret?`/v1/drafts/${draft.id}/attachments`:`/owner/api/mailboxes/${mailbox.id}/drafts/${draft.id}/attachments`;
  return runtime.mf.dispatchFetch(new URL(path,secret?api:'https://console.example.com'),{method:'POST',headers:{
    ...(secret?{Authorization:`Bearer ${secret}`}:{'Cf-Access-Jwt-Assertion':runtime.jwt,Origin:'https://console.example.com'}),
    'Content-Type':'application/octet-stream','X-Draft-Version':String(draft.version),'X-Attachment-Filename':encodeURIComponent(filename),
    'X-Attachment-Content-Type':'application/octet-stream',...headers},body:bytes});
}
async function approve(runtime,mailbox,draft) {
  return (await json(await runtime.request(`/owner/api/mailboxes/${mailbox.id}/drafts/${draft.id}/approve`,{
    method:'POST',body:{expectedVersion:draft.version,contentSha256:draft.contentSha256}}))).draft;
}
const content={to:['recipient@example.net'],bcc:['private-bcc@example.net'],subject:'Files attached',text:'Please review the files.'};

test('draft upload/delete changes invalidate approval; frozen native send produces byte-exact MIME and authorized Sent attachments',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  const mailbox=await box(runtime),token=await issue(runtime,mailbox),base=`/owner/api/mailboxes/${mailbox.id}`;
  let draft=(await json(await agent(runtime,token.secret,'/v1/drafts',{method:'POST',body:content}),201)).draft;
  const originalHash=draft.contentSha256;
  assert.equal((await json(await agent(runtime,token.secret,`/v1/drafts/${draft.id}/send`,{method:'POST',
    body:{expectedVersion:draft.version},headers:{'Idempotency-Key':'request-initial-approval'}}),202)).status,'approval_required');
  draft=await approve(runtime,mailbox,draft);assert.equal(draft.state,'approved');
  const binary=Uint8Array.from([0,1,127,128,255,0,65]);
  draft=(await json(await upload(runtime,mailbox,draft,binary,{secret:token.secret}),201)).draft;
  assert.equal(draft.version,2);assert.equal(draft.state,'editing');assert.notEqual(draft.contentSha256,originalHash);
  const row=await runtime.db.prepare('SELECT approved_version,approved_sha256,approved_at FROM drafts WHERE id=?').bind(draft.id).first();
  assert.deepEqual(row,{approved_version:null,approved_sha256:null,approved_at:null});
  assert.equal((await agent(runtime,token.secret,`/v1/drafts/${draft.id}/send`,{method:'POST',body:{expectedVersion:1},headers:{'Idempotency-Key':'stale-version'}})).status,409);
  const detached=draft.content.attachments[0];
  draft=(await json(await agent(runtime,token.secret,`/v1/drafts/${draft.id}/attachments/${detached.id}`,{
    method:'DELETE',body:{expectedVersion:draft.version}}))).draft;
  assert.equal(draft.version,3);assert.deepEqual(draft.content.attachments,[]);
  assert.equal((await agent(runtime,token.secret,`/v1/drafts/${draft.id}/attachments/${detached.id}/download`)).status,404);
  draft=(await json(await upload(runtime,mailbox,draft,binary,{secret:token.secret}),201)).draft;
  const second=Buffer.from('second file 😀\n');
  draft=(await json(await upload(runtime,mailbox,draft,second,{secret:token.secret,filename:'../../第二份报告.txt'}),201)).draft;
  const manifest=draft.content.attachments;assert.equal(manifest.length,2);
  draft=(await json(await agent(runtime,token.secret,`/v1/drafts/${draft.id}`,{method:'PATCH',body:{...content,text:'Edited text retains both files.',expectedVersion:draft.version}}))).draft;
  assert.deepEqual(draft.content.attachments,manifest);
  const downloaded=await agent(runtime,token.secret,`/v1/drafts/${draft.id}/attachments/${manifest[0].id}/download`);
  assert.equal(downloaded.status,200);assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()),binary);
  draft=await approve(runtime,mailbox,draft);
  const queued=await json(await agent(runtime,token.secret,`/v1/drafts/${draft.id}/send`,{method:'POST',body:{expectedVersion:draft.version},
    headers:{'Idempotency-Key':'send-approved-files'}}),202);assert.equal(queued.status,'queued');
  assert.equal((await upload(runtime,mailbox,draft,binary,{secret:token.secret})).status,409,'Submitted manifests are immutable');
  assert.equal((await agent(runtime,token.secret,`/v1/drafts/${draft.id}/attachments/${manifest[0].id}`,{method:'DELETE',body:{expectedVersion:draft.version}})).status,409);
  const duplicate=await json(await agent(runtime,token.secret,`/v1/drafts/${draft.id}/send`,{method:'POST',body:{expectedVersion:draft.version},
    headers:{'Idempotency-Key':'send-approved-files'}}),202);assert.equal(duplicate.outboundId,queued.outboundId);
  await (await runtime.mf.getWorker()).scheduled();
  const outbound=await runtime.db.prepare('SELECT status,last_error_code FROM outbound_messages WHERE id=?').bind(queued.outboundId).first();
  assert.equal(outbound.status,'accepted',JSON.stringify(outbound));
  const sent=await json(await runtime.request(`${base}/messages/${queued.outboundId}`));
  assert.equal(sent.attachments.status,'ready');assert.equal(sent.attachments.attachments.length,2);
  const raw=await runtime.db.prepare('SELECT o.object_key FROM messages m JOIN objects o ON o.id=m.raw_object_id WHERE m.id=?').bind(queued.outboundId).first();
  const rawBytes=Buffer.from(await (await runtime.bucket.get(raw.object_key)).arrayBuffer());
  assert.equal(rawBytes.includes(Buffer.from('private-bcc@example.net')),false);
  const mime=await PostalMime.parse(rawBytes);assert.equal(mime.attachments.length,2);assert.match(mime.text,/Edited text/);
  for(let index=0;index<2;index++) {
    const expected=index===0?Buffer.from(binary):second;
    assert.equal(mime.attachments[index].filename,manifest[index].filename);
    assert.deepEqual(Buffer.from(mime.attachments[index].content),expected);
    const file=sent.attachments.attachments[index];
    const response=await runtime.request(`${base}/messages/${queued.outboundId}/attachments/${file.id}/download`);
    assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
  }
  assert.equal((await agent(runtime,token.secret,`/v1/messages/${queued.outboundId}/attachments`)).status,403,'Draft permission does not grant received/Sent mail reading');
  await (await runtime.mf.getWorker()).scheduled();
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_attempts').first('n'),1);
});

test('draft attachment routes reject other principals, missing Origin, stale versions, injected manifests and corrupt preflight bytes',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  const mailbox=await box(runtime),otherBox=await box(runtime,'other-files'),token=await issue(runtime,mailbox),peer=await issue(runtime,mailbox),outsider=await issue(runtime,otherBox);
  let draft=(await json(await agent(runtime,token.secret,'/v1/drafts',{method:'POST',body:content}),201)).draft;
  const binary=Buffer.from('private attachment');
  assert.equal((await upload(runtime,mailbox,draft,binary,{secret:peer.secret})).status,404);
  assert.equal((await upload(runtime,mailbox,draft,binary,{secret:outsider.secret})).status,404);
  assert.equal((await upload(runtime,mailbox,draft,binary,{headers:{Origin:''}})).status,403);
  assert.equal((await upload(runtime,mailbox,draft,binary,{headers:{'Cf-Access-Jwt-Assertion':''}})).status,401);
  assert.equal((await upload(runtime,mailbox,draft,binary,{secret:token.secret,headers:{'X-Draft-Version':'0'}})).status,400);
  assert.equal((await agent(runtime,token.secret,`/v1/drafts/${draft.id}`,{method:'PATCH',body:{...content,expectedVersion:draft.version,attachments:[{id:randomUUID()}]}})).status,400);
  const before=draft.version;
  draft=(await json(await upload(runtime,mailbox,draft,binary,{secret:token.secret}),201)).draft;
  assert.equal((await upload(runtime,mailbox,{...draft,version:before},binary,{secret:token.secret})).status,409);
  const file=draft.content.attachments[0];
  assert.equal((await agent(runtime,peer.secret,`/v1/drafts/${draft.id}/attachments/${file.id}/download`)).status,404);
  draft=await approve(runtime,mailbox,draft);
  const queued=await json(await runtime.request(`/owner/api/mailboxes/${mailbox.id}/drafts/${draft.id}/send`,{method:'POST',
    body:{expectedVersion:draft.version},headers:{'Idempotency-Key':'owner-sends-file'}}),202);
  const stored=await runtime.db.prepare('SELECT o.object_key FROM draft_attachments a JOIN objects o ON o.id=a.object_id AND o.mailbox_id=a.mailbox_id WHERE a.id=?').bind(file.id).first();
  await runtime.bucket.put(stored.object_key,'CORRUPTED_ATTACHMENT');
  await (await runtime.mf.getWorker()).scheduled();
  const failed=await runtime.db.prepare('SELECT status,last_error_code FROM outbound_messages WHERE id=?').bind(queued.outboundId).first();
  assert.equal(failed.status,'failed',JSON.stringify(failed));assert.ok(failed.last_error_code);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_attempts').first('n'),0,'Corruption must fail before external submission');
  assert.equal(await runtime.db.prepare('SELECT state FROM send_reservations').first('state'),'released');
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM messages WHERE direction=\'outbound\'').first('n'),0);
});

async function mcpClient(t,runtime,secret) {
  const client=new Client({name:'draft-file-integration',version:'1.0.0'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});
  const transport=new StreamableHTTPClientTransport(new URL(`${api}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${secret}`}},
    fetch:async(input,init)=>{
      const request=new Request(input,init);assert.equal(new URL(request.url).origin,api);
      const body=['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer();
      return runtime.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body,signal:request.signal});
    }});
  registerMcpClient(runtime,client);await client.connect(transport,{timeout:10_000});return client;
}
async function tool(client,name,args={}) {
  const result=await client.callTool({name,arguments:args},{timeout:10_000});
  assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent;
}
test('official MCP client stages large binary chunks idempotently, completes one revision, removes and sends through Owner approval',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>disposeOwnerRuntime(runtime));
  const mailbox=await box(runtime),token=await issue(runtime,mailbox),readerToken=await issue(runtime,mailbox,['mail:read']);
  const client=await mcpClient(t,runtime,token.secret),reader=await mcpClient(t,runtime,readerToken.secret);
  const names=(await client.listTools()).tools.map(value=>value.name);
  for(const name of ['begin_draft_attachment_upload','upload_draft_attachment_chunk','complete_draft_attachment_upload','remove_draft_attachment','read_draft_attachment'])assert.ok(names.includes(name));
  assert.ok(!(await reader.listTools()).tools.some(value=>value.name==='begin_draft_attachment_upload'));
  let draft=(await tool(client,'create_draft',content)).draft;
  const bytes=Buffer.from(Array.from({length:400_123},(_,index)=>(index*37)%256));
  const started=await tool(client,'begin_draft_attachment_upload',{draftId:draft.id,expectedVersion:draft.version,
    filename:'large-report.bin',contentType:'application/octet-stream',totalBytes:bytes.length});
  const uploadId=started.upload.id;assert.equal(started.upload.receivedBytes,0);
  for(let offset=0;offset<bytes.length;offset+=64*1024) {
    const data=bytes.subarray(offset,offset+64*1024).toString('base64');
    const chunk=await tool(client,'upload_draft_attachment_chunk',{draftId:draft.id,uploadId,offset,data});
    assert.equal(chunk.upload.receivedBytes,Math.min(bytes.length,offset+64*1024));
    if(offset===0) {
      const repeat=await tool(client,'upload_draft_attachment_chunk',{draftId:draft.id,uploadId,offset,data});
      assert.equal(repeat.upload.receivedBytes,chunk.upload.receivedBytes);
    }
  }
  draft=(await tool(client,'complete_draft_attachment_upload',{draftId:draft.id,uploadId})).draft;
  assert.equal(draft.version,2);assert.equal(draft.content.attachments.length,1);
  const repeat=(await tool(client,'complete_draft_attachment_upload',{draftId:draft.id,uploadId})).draft;assert.equal(repeat.version,draft.version);
  const attachment=draft.content.attachments[0],parts=[];let offset=0;
  do {
    const page=await tool(client,'read_draft_attachment',{draftId:draft.id,attachmentId:attachment.id,offset,limit:32*1024});
    parts.push(Buffer.from(page.data,'base64'));offset=page.nextOffset;
  }while(offset!==null);
  assert.deepEqual(Buffer.concat(parts),bytes);
  const pending=await tool(client,'send_message',{draftId:draft.id,expectedVersion:draft.version,clientRequestId:'mcp-file-approval'});
  assert.equal(pending.status,'approval_required');
  draft=await approve(runtime,mailbox,draft);
  draft=(await tool(client,'remove_draft_attachment',{draftId:draft.id,attachmentId:attachment.id,expectedVersion:draft.version})).draft;
  assert.equal(draft.state,'editing');assert.deepEqual(draft.content.attachments,[]);
  const second=await tool(client,'begin_draft_attachment_upload',{draftId:draft.id,expectedVersion:draft.version,filename:'empty.txt',totalBytes:0});
  draft=(await tool(client,'complete_draft_attachment_upload',{draftId:draft.id,uploadId:second.upload.id})).draft;
  draft=await approve(runtime,mailbox,draft);
  const queued=await tool(client,'send_message',{draftId:draft.id,expectedVersion:draft.version,clientRequestId:'mcp-approved-empty-file'});
  assert.equal(queued.status,'queued');await (await runtime.mf.getWorker()).scheduled();
  assert.equal(await runtime.db.prepare('SELECT status FROM outbound_messages WHERE id=?').bind(queued.outboundId).first('status'),'accepted');
  const sent=await json(await runtime.request(`/owner/api/mailboxes/${mailbox.id}/messages/${queued.outboundId}/attachments`));
  assert.equal(sent.attachments.length,1);assert.equal(sent.attachments[0].sizeBytes,0);
  const staged=await tool(client,'begin_draft_attachment_upload',{draftId:(await tool(client,'create_draft',content)).draft.id,
    expectedVersion:1,filename:'revoked.bin',totalBytes:1});
  await runtime.request(`/owner/api/mailboxes/${mailbox.id}/tokens/${token.token.id}`,{method:'DELETE'});
  await assert.rejects(client.callTool({name:'upload_draft_attachment_chunk',arguments:{draftId:staged.upload.draftId,uploadId:staged.upload.id,offset:0,data:'AQ=='}}));
});
