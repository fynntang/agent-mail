import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=','base64');
const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="parent.CID_XSS=1"/>');
const MiB=1024*1024;
const base=(box,message)=>`/owner/api/mailboxes/${box.id}/messages/${message.id}`;
const cid=(id,alt=id)=>`<img src="cid:${id}" alt="${alt}">`;
const file=(id,options={})=>({id,bytes:png,type:'image/png',filename:`${id.replaceAll('@','_')}.png`,...options});
const renderedImages=document=>[...document.matchAll(/<img\b[^>]*\bsrc="(data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*)"/g)].map(match=>match[1]);

async function mailbox(runtime,localPart=`cid-${randomUUID()}`) {
  const response=await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:localPart,localPart}});
  assert.equal(response.status,201,await response.clone().text());return (await response.json()).mailbox;
}
async function issue(runtime,box,scopes=['mail:read']) {
  const response=await runtime.request(`/owner/api/mailboxes/${box.id}/tokens`,{method:'POST',body:{name:'CID integration',scopes}});
  assert.equal(response.status,201,await response.clone().text());return response.json();
}
/** Exercise the deployed native email -> scheduled parser -> D1/private R2 path, not seeded HTML. */
async function inbound(runtime,box,html,files=[],text='CID_PLAIN_TEXT_ONLY') {
  const related=`related-${randomUUID()}`,alternative=`alternative-${randomUUID()}`,subject=`CID ${randomUUID()}`;
  const lines=[`Message-ID: <${randomUUID()}@agentmail.test>`,'From: CID Sender <sender@example.net>',`To: ${box.address}`,
    `Subject: ${subject}`,'MIME-Version: 1.0',`Content-Type: multipart/related; boundary="${related}"`,'',
    `--${related}`,`Content-Type: multipart/alternative; boundary="${alternative}"`,'',
    `--${alternative}`,'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',Buffer.from(text).toString('base64'),
    `--${alternative}`,'Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',Buffer.from(html).toString('base64'),
    `--${alternative}--`];
  for(const part of files)lines.push(`--${related}`,`Content-Type: ${part.type}`,
    `Content-Disposition: inline; filename="${part.filename}"`,`Content-ID: <${part.id}>`,
    'Content-Transfer-Encoding: base64','',part.bytes.toString('base64'));
  lines.push(`--${related}--`,'');
  const response=await runtime.mf.dispatchFetch(`http://localhost/cdn-cgi/local/email?from=sender%40example.net&to=${encodeURIComponent(box.address)}&format=json`,{
    method:'POST',headers:{'Content-Type':'message/rfc822'},body:lines.join('\r\n')
  });
  assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).outcome,'ok');
  assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');
  const message=await runtime.db.prepare('SELECT * FROM messages WHERE mailbox_id=? AND subject=?').bind(box.id,subject).first();
  assert.ok(message,'The native scheduled handler publishes the related MIME message');assert.equal(message.parse_state,'ready');
  assert.equal(message.attachments_state,'ready');return message;
}
async function info(runtime,box,message) {
  const response=await runtime.request(`${base(box,message)}/html-info`);assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();assert.equal(result.status,'available');
  for(const internal of ['html','remoteImageUrls','inlineImageIds','embeddedImageBytes'])assert.equal(internal in result,false,internal);
  return result;
}
async function html(runtime,box,message) {
  const response=await runtime.request(`${base(box,message)}/html`);assert.equal(response.status,200,await response.clone().text());
  return {response,document:await response.text()};
}
function counts(result,expected) {
  for(const [key,value] of Object.entries(expected))assert.equal(result[key],value,key);
}
async function state(runtime,message) {
  return runtime.db.prepare(`SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM jobs) jobs,
    (SELECT count(*) FROM objects) objects,(SELECT count(*) FROM attachments) attachments,is_read,body_object_id,parse_state,deleted_at
    FROM messages WHERE id=?`).bind(message.id).first();
}
async function rawTool(runtime,token,name,args={}) {
  const version='2026-07-28';
  const response=await runtime.mf.dispatchFetch('https://api.example.com/mcp',{method:'POST',headers:{
    Authorization:`Bearer ${token}`,Accept:'application/json, text/event-stream','Content-Type':'application/json',
    'MCP-Protocol-Version':version,'Mcp-Method':'tools/call','Mcp-Name':name
  },body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{
    'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientInfo':{name:'cid-integration',version:'1.0.0'},
    'io.modelcontextprotocol/clientCapabilities':{}
  }}})});
  assert.equal(response.status,200,await response.clone().text());const result=await response.json();
  assert.notEqual(result.result?.isError,true,JSON.stringify(result));assert.ok(result.result?.structuredContent);return result.result.structuredContent;
}

test('native related MIME CID images render by default as verified local data without network, state writes or remote permission',{timeout:120_000},async t=>{
  const upstream=[];
  const runtime=await createOwnerRuntime({outboundService:request=>{
    upstream.push(request.url);return new Response(png,{headers:{'Content-Type':'image/png'}});
  }});t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),message=await inbound(runtime,box,'<h2>CID_LOCAL_MARKER</h2>'+cid('Logo.Mixed%40Agent'),[file('Logo.Mixed@Agent')]);
  const before=await state(runtime,message),objectKeys=(await runtime.bucket.list()).objects.map(object=>object.key).sort();
  const metadata=await info(runtime,box,message);counts(metadata,{inlineImages:1,loadedInlineImages:1,remoteImages:0,loadedImages:0,blockedImages:0});
  const {response,document}=await html(runtime,box,message);
  assert.deepEqual(renderedImages(document),[`data:image/png;base64,${png.toString('base64')}`]);assert.match(document,/<h2>CID_LOCAL_MARKER<\/h2>/);
  assert.equal(document.includes('cid:'),false);assert.match(document,/referrerpolicy="no-referrer"/);
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');const csp=response.headers.get('content-security-policy');
  assert.match(csp,/img-src data:(?:;|$)/);assert.doesNotMatch(csp,/img-src[^;]*https:|allow-scripts|allow-same-origin/);
  assert.match(csp,/(?:^|; )sandbox(?:;|$)/);assert.match(csp,/frame-ancestors 'self'/);assert.match(csp,/connect-src 'none'/);
  const optIn=await runtime.request(`${base(box,message)}/html`,{method:'POST',body:{allowRemoteImages:true}});
  assert.equal(optIn.status,200);const allowed=await optIn.json();counts(allowed,{inlineImages:1,loadedInlineImages:1,remoteImages:0,loadedImages:0,blockedImages:0});
  assert.deepEqual(renderedImages(allowed.document),renderedImages(document));assert.deepEqual(upstream,[],'CID rendering never requests the network');
  assert.deepEqual(await state(runtime,message),before);assert.equal(before.is_read,0);
  assert.deepEqual((await runtime.bucket.list()).objects.map(object=>object.key).sort(),objectKeys);
  const mixed=await inbound(runtime,box,'<img src="https://images.example.net/mixed.png">'+cid('mixed'),[file('mixed')]);
  counts(await info(runtime,box,mixed),{inlineImages:1,loadedInlineImages:1,remoteImages:1,loadedImages:0,blockedImages:1});
  assert.equal(renderedImages((await html(runtime,box,mixed)).document).length,1);assert.deepEqual(upstream,[]);
  const mixedOptIn=await runtime.request(`${base(box,mixed)}/html`,{method:'POST',body:{allowRemoteImages:true}});assert.equal(mixedOptIn.status,200);
  const mixedResult=await mixedOptIn.json();counts(mixedResult,{inlineImages:1,loadedInlineImages:1,remoteImages:1,loadedImages:1,blockedImages:0});
  assert.equal(renderedImages(mixedResult.document).length,2);assert.deepEqual(upstream,['https://images.example.net/mixed.png']);
  counts(await info(runtime,box,mixed),{loadedInlineImages:1,loadedImages:0,blockedImages:1});
  assert.deepEqual(upstream,['https://images.example.net/mixed.png'],'Remote permission is never persisted by a prior POST');
});

test('CID matching preserves case, decodes URL escaping once, rejects ambiguous duplicates and stays inside the current message/mailbox',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),other=await mailbox(runtime);
  await inbound(runtime,box,cid('Foreign%40Agent'),[file('Foreign@Agent')]);
  await inbound(runtime,other,cid('Foreign%40Agent'),[file('Foreign@Agent')]);
  const refs=['Logo.Mixed%40Agent','logo.mixed%40Agent','Logo.Mixed%2540Agent','Missing%40Agent','Duplicate%40Agent','Foreign%40Agent','Percent%2540Id%40Agent'];
  const message=await inbound(runtime,box,refs.map(id=>cid(id)).join(''),[
    file('Logo.Mixed@Agent'),file('Duplicate@Agent'),file('Duplicate@Agent',{bytes:svg,type:'image/svg+xml',filename:'duplicate.svg'}),file('Percent%40Id@Agent')
  ]);
  const metadata=await info(runtime,box,message);counts(metadata,{inlineImages:7,loadedInlineImages:2,blockedImages:5,remoteImages:0,loadedImages:0});
  const {document}=await html(runtime,box,message);assert.equal(renderedImages(document).length,2);
  assert.doesNotMatch(document,/<svg\b|onload=|src="cid:|src="https:/);assert.match(document,/图片已屏蔽/);
  assert.equal((await runtime.request(`${base(other,message)}/html`)).status,404);
  const foreignOnly=await inbound(runtime,box,cid('Foreign%40Agent'));
  counts(await info(runtime,box,foreignOnly),{inlineImages:1,loadedInlineImages:0,blockedImages:1});
  assert.equal(renderedImages((await html(runtime,box,foreignOnly)).document).length,0,'A matching CID in another message cannot supply bytes');
});

test('CID rendering rejects active, non-image, spoofed, oversized, corrupt, missing, blocked and wrong-purpose attachment objects',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime);
  const tooLarge=Buffer.alloc(MiB+1);png.copy(tooLarge);
  const hugeDimensions=Buffer.from(png);hugeDimensions.writeUInt32BE(4097,16);
  const parts=[file('svg',{type:'image/svg+xml',bytes:svg,filename:'active.svg'}),file('text',{type:'application/octet-stream',bytes:Buffer.from('PRIVATE_CID_TEXT'),filename:'text.bin'}),
    file('spoof',{bytes:svg}),file('oversize',{bytes:tooLarge}),file('dimensions',{bytes:hugeDimensions}),file('valid')];
  const message=await inbound(runtime,box,parts.map(part=>cid(part.id)).join(''),parts);
  counts(await info(runtime,box,message),{inlineImages:6,loadedInlineImages:1,blockedImages:5,remoteImages:0,loadedImages:0});
  const initial=(await html(runtime,box,message)).document;assert.equal(renderedImages(initial).length,1);assert.doesNotMatch(initial,/<svg\b|PRIVATE_CID_TEXT|parent.CID_XSS/);
  const attachment=await runtime.db.prepare("SELECT a.id,a.object_id,o.object_key FROM attachments a JOIN objects o ON o.id=a.object_id AND o.mailbox_id=a.mailbox_id WHERE a.message_id=? AND a.filename='valid.png'").bind(message.id).first();
  assert.ok(attachment,'The MIME Content-ID is persisted as attachment metadata');
  for(const scan of ['blocked','failed']) {
    await runtime.db.prepare('UPDATE attachments SET scan_status=? WHERE id=?').bind(scan,attachment.id).run();
    counts(await info(runtime,box,message),{loadedInlineImages:0,blockedImages:6});
    assert.equal(renderedImages((await html(runtime,box,message)).document).length,0,scan);
  }
  await runtime.db.prepare("UPDATE attachments SET scan_status='unscanned' WHERE id=?").bind(attachment.id).run();
  for(const failure of ['corrupt','missing']) {
    if(failure==='corrupt')await runtime.bucket.put(attachment.object_key,'PRIVATE_CORRUPT_CID_BYTES');else await runtime.bucket.delete(attachment.object_key);
    counts(await info(runtime,box,message),{loadedInlineImages:0,blockedImages:6});
    const document=(await html(runtime,box,message)).document;assert.equal(renderedImages(document).length,0);
    assert.equal(document.includes('PRIVATE_CORRUPT_CID_BYTES'),false);assert.equal(document.includes(attachment.object_key),false);
  }
  await runtime.bucket.put(attachment.object_key,png);
  await runtime.db.prepare('UPDATE attachments SET object_id=? WHERE id=?').bind(message.raw_object_id,attachment.id).run();
  counts(await info(runtime,box,message),{loadedInlineImages:0,blockedImages:6});
  await runtime.db.prepare('UPDATE attachments SET object_id=? WHERE id=?').bind(attachment.object_id,attachment.id).run();
  counts(await info(runtime,box,message),{loadedInlineImages:1,blockedImages:5});
});

test('CID and remote images share eight rendered nodes and four MiB while each CID image is limited to one MiB',{timeout:120_000},async t=>{
  const upstream=[];const runtime=await createOwnerRuntime({outboundService:request=>{upstream.push(request.url);return new Response(png,{headers:{'Content-Type':'image/png'}});}});
  t.after(()=>runtime.mf.dispose());const box=await mailbox(runtime),remote='<img src="https://images.example.net/shared-budget.png">';
  const many=await inbound(runtime,box,remote+cid('repeat').repeat(9),[file('repeat')]);
  counts(await info(runtime,box,many),{inlineImages:9,loadedInlineImages:8,blockedImages:2,remoteImages:1,loadedImages:0});
  const nodeOptIn=await runtime.request(`${base(box,many)}/html`,{method:'POST',body:{allowRemoteImages:true}});assert.equal(nodeOptIn.status,200);
  const nodeResult=await nodeOptIn.json();counts(nodeResult,{loadedInlineImages:8,loadedImages:0,blockedImages:2});assert.equal(renderedImages(nodeResult.document).length,8);
  const fullSize=Buffer.alloc(MiB);png.copy(fullSize);
  const large=await inbound(runtime,box,remote+cid('large').repeat(5),[file('large',{bytes:fullSize})]);
  counts(await info(runtime,box,large),{inlineImages:5,loadedInlineImages:4,blockedImages:2,remoteImages:1,loadedImages:0});
  const byteOptIn=await runtime.request(`${base(box,large)}/html`,{method:'POST',body:{allowRemoteImages:true}});assert.equal(byteOptIn.status,200);
  const bytesResult=await byteOptIn.json();counts(bytesResult,{inlineImages:5,loadedInlineImages:4,blockedImages:2,remoteImages:1,loadedImages:0});
  const images=renderedImages(bytesResult.document);assert.equal(images.length,4);
  assert.equal(images.reduce((sum,source)=>sum+Buffer.from(source.split(',')[1],'base64').length,0),4*MiB);
  assert.deepEqual(upstream,[],'Remote fetch is skipped when verified local CID images consume either shared budget');
});

test('Owner JWT/Origin and mailbox tokens remain separate; API/MCP stay text-only and preserve attachment download scopes',{timeout:120_000},async t=>{
  const upstream=[];const runtime=await createOwnerRuntime({outboundService:request=>{upstream.push(request.url);}});t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),other=await mailbox(runtime),message=await inbound(runtime,box,'<strong>CID_PRIVATE_HTML_MARKER</strong>'+cid('secret'),[file('secret')]);
  const reader=await issue(runtime,box),full=await issue(runtime,box,['mail:read','attachments:read']),outsider=await issue(runtime,other,['mail:read','attachments:read']);
  const url=base(box,message),before=await state(runtime,message);
  for(const suffix of ['/html','/html-info']) {
    assert.equal((await runtime.request(`${url}${suffix}`,{authenticated:false})).status,401);
    assert.equal((await runtime.request(`${url}${suffix}`,{authenticated:false,headers:{Authorization:`Bearer ${full.secret}`}})).status,401);
    assert.equal((await runtime.request(`${url}${suffix}?allowRemoteImages=true`)).status,400);
    assert.equal((await runtime.request(`${base(other,message)}${suffix}`)).status,404);
  }
  const wrongJwt=await runtime.sign({email:'different-owner@example.net'});
  assert.equal((await runtime.request(`${url}/html`,{headers:{'Cf-Access-Jwt-Assertion':wrongJwt}})).status,401);
  for(const Origin of ['https://evil.example','null',''])assert.equal((await runtime.request(`${url}/html`,{method:'POST',headers:{Origin},body:{allowRemoteImages:true}})).status,403);
  assert.equal((await runtime.request(`${url}/html`,{method:'POST',authenticated:false,body:{allowRemoteImages:true}})).status,401);
  const api=await runtime.mf.dispatchFetch(`https://api.example.com/v1/messages/${message.id}`,{headers:{Authorization:`Bearer ${reader.secret}`}});
  assert.equal(api.status,200);const detail=await api.json();assert.equal(detail.body.text,'CID_PLAIN_TEXT_ONLY');assert.equal(detail.capabilities.htmlRendering,false);
  assert.equal('html' in detail.body,false);assert.equal(detail.attachments.canDownload,false);assert.equal(detail.attachments.attachments[0].downloadable,false);
  const serialized=JSON.stringify(detail);for(const hidden of ['CID_PRIVATE_HTML_MARKER','data:image/','cid:secret','object_key','sha256'])assert.equal(serialized.includes(hidden),false,hidden);
  const messageTool=await rawTool(runtime,reader.secret,'read_message',{messageId:message.id});assert.equal(messageTool.body.text,'CID_PLAIN_TEXT_ONLY');
  assert.equal(messageTool.capabilities.htmlRendering,false);assert.equal(JSON.stringify(messageTool).includes('CID_PRIVATE_HTML_MARKER'),false);
  const metadata=await rawTool(runtime,reader.secret,'list_attachments',{messageId:message.id});assert.equal(metadata.canDownload,false);
  const attachment=metadata.attachments[0],path=`https://api.example.com/v1/messages/${message.id}/attachments/${attachment.id}/download`;
  assert.equal((await runtime.mf.dispatchFetch(path,{headers:{Authorization:`Bearer ${reader.secret}`}})).status,403);
  assert.equal((await runtime.mf.dispatchFetch(path,{headers:{Authorization:`Bearer ${outsider.secret}`}})).status,404);
  const download=await runtime.mf.dispatchFetch(path,{headers:{Authorization:`Bearer ${full.secret}`}});assert.equal(download.status,200);
  assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.deepEqual(Buffer.from(await download.arrayBuffer()),png);
  const chunk=await rawTool(runtime,full.secret,'read_attachment',{messageId:message.id,attachmentId:attachment.id,offset:0,limit:1024});
  assert.equal(chunk.encoding,'base64');assert.deepEqual(Buffer.from(chunk.data,'base64'),png);
  assert.deepEqual(await state(runtime,message),before);assert.deepEqual(upstream,[]);
});
