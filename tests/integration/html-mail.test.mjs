import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {seedMessages} from '../helpers/mail-fixtures.mjs';

async function mailbox(runtime,localPart='html-reader') {
  const response=await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:localPart,localPart}});
  assert.equal(response.status,201);return (await response.json()).mailbox;
}
async function inbound(runtime,box,html,text='PLAIN_ONLY_BODY') {
  const boundary=`html-${randomUUID()}`;
  const body=[`Message-ID: <${randomUUID()}@agentmail.test>`,'From: Sender <sender@example.net>',`To: ${box.address}`,
    'Subject: HTML rendering integration','MIME-Version: 1.0',`Content-Type: multipart/alternative; boundary="${boundary}"`,'',
    ...(text===null?[]:[`--${boundary}`,'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',Buffer.from(text).toString('base64')]),
    `--${boundary}`,'Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',Buffer.from(html).toString('base64'),`--${boundary}--`,''
  ].join('\r\n');
  const response=await runtime.mf.dispatchFetch(`http://localhost/cdn-cgi/local/email?from=sender%40example.net&to=${encodeURIComponent(box.address)}&format=json`,{
    method:'POST',headers:{'Content-Type':'message/rfc822'},body
  });
  assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).outcome,'ok');
  await (await runtime.mf.getWorker()).scheduled();
  return runtime.db.prepare('SELECT * FROM messages WHERE mailbox_id=? ORDER BY received_at DESC,id DESC LIMIT 1').bind(box.id).first();
}
const base=(box,message)=>`/owner/api/mailboxes/${box.id}/messages/${message.id}`;
const attack=`<html><head><meta http-equiv="refresh" content="0;url=https://tracking.invalid/refresh"><base href="https://tracking.invalid/"><style>@import url(https://tracking.invalid/style);</style></head>
  <body onload="globalThis.__htmlXss=1"><h1>Invoice HTML</h1><p><strong>HTML_FORMATTED_MARKER</strong> and <em>emphasis</em></p>
  <table><tr><th>Item</th><td>Report</td></tr></table><script>fetch('https://tracking.invalid/script');parent.__htmlXss=1</script>
  <form action="https://tracking.invalid/form"><input name="secret"><button>submit</button></form>
  <iframe src="https://tracking.invalid/frame"></iframe><svg onload="alert(1)"><foreignObject>bad</foreignObject></svg>
  <img src="https://images.example.net/pixel.png" srcset="https://tracking.invalid/srcset 2x" onerror="alert(1)" alt="Chart">
  <img src="cid:private-image"><img src="data:image/svg+xml;base64,PHN2Zz4=">
  <a href="https://docs.example.net/guide">Documentation</a><a href="javascript:alert(1)">Bad link</a>
  <a href="https://console.example.com/owner/api/setup">Own origin</a><a href="https://127.0.0.1/private">Private IP</a>
  <div style="background-image:url(https://tracking.invalid/css);position:fixed;color:#123456">Safe text</div></body></html>`;

test('Owner HTML rendering sanitizes verified MIME into a no-network sandbox while API text and read state stay unchanged',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),message=await inbound(runtime,box,attack),url=base(box,message);
  const auditCount=await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n');
  const objectCount=(await runtime.bucket.list()).objects.length;
  const detail=await (await runtime.request(url)).json();
  assert.equal(detail.body.htmlStatus,'available');assert.equal(detail.body.text,'PLAIN_ONLY_BODY');
  assert.equal(detail.capabilities.htmlRendering,true);assert.equal('html' in detail.body,false);
  const info=await (await runtime.request(`${url}/html-info`)).json();
  assert.equal(info.status,'available');assert.ok(info.blockedImages>=3);assert.equal(info.remoteImages,1);
  assert.deepEqual(info.links.map(link=>link.url),['https://docs.example.net/guide']);assert.equal('html' in info,false);
  const response=await runtime.request(`${url}/html`);assert.equal(response.status,200,await response.clone().text());
  assert.match(response.headers.get('content-type'),/^text\/html/);assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  const csp=response.headers.get('content-security-policy');
  for(const rule of ["script-src 'none'","form-action 'none'","img-src 'none'","connect-src 'none'","frame-ancestors 'self'",'sandbox'])assert.ok(csp.includes(rule),rule);
  assert.ok(!csp.includes('allow-scripts')&&!csp.includes('allow-same-origin'));
  const document=await response.text();assert.match(document,/<strong>HTML_FORMATTED_MARKER<\/strong>/);assert.match(document,/<table/);
  for(const forbidden of ['<script','<form','<iframe','<svg','<base','<input','onerror=','onload=','srcset=','tracking.invalid','images.example.net','javascript:'])assert.equal(document.toLowerCase().includes(forbidden),false,forbidden);
  assert.equal((await runtime.request(url)).headers.get('x-frame-options'),'DENY','Other Owner endpoints retain their frame protection');
  const issue=await runtime.request(`/owner/api/mailboxes/${box.id}/tokens`,{method:'POST',body:{name:'Plain reader',scopes:['mail:read']}});
  const token=(await issue.json()).secret;
  const apiResponse=await runtime.mf.dispatchFetch(`https://api.example.com/v1/messages/${message.id}`,{headers:{Authorization:`Bearer ${token}`}});
  const plain=await apiResponse.json();assert.equal(plain.body.text,'PLAIN_ONLY_BODY');assert.equal(plain.capabilities.htmlRendering,false);
  assert.equal(JSON.stringify(plain).includes('<strong>HTML_FORMATTED_MARKER'),false);assert.equal('html' in plain.body,false);
  assert.equal(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read'),0);
  assert.equal((await runtime.bucket.list()).objects.length,objectCount);
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM audit_events').first('n'),auditCount+1,'Only explicit Token issuance records an audit event');
});

test('remote image permission requires authenticated same-Origin POST; shareable GETs cannot opt in or expose other mailboxes',{timeout:120_000},async t=>{
  const upstream=[];
  const runtime=await createOwnerRuntime({outboundService:request=>{
    upstream.push({url:request.url,headers:Object.fromEntries(request.headers)});
    if(request.url==='https://images.example.net/pixel.png')return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=','base64'),{headers:{'Content-Type':'image/png'}});
  }});t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),other=await mailbox(runtime,'other-html'),message=await inbound(runtime,box,attack),url=base(box,message);
  for(const path of [`${url}/html`,`${url}/html-info`])assert.equal((await runtime.request(path,{authenticated:false})).status,401);
  assert.equal((await runtime.request(`${base(other,message)}/html`)).status,404);
  assert.equal((await runtime.request(`${url}/html?images=allowed`)).status,400);
  assert.equal((await runtime.request(`${url}/html-info?allowRemoteImages=true`)).status,400);
  for(const Origin of ['https://evil.example','null','']) {
    assert.equal((await runtime.request(`${url}/html`,{method:'POST',headers:{Origin},body:{allowRemoteImages:true}})).status,403);
  }
  assert.equal((await runtime.request(`${url}/html`,{method:'POST',authenticated:false,body:{allowRemoteImages:true}})).status,401);
  assert.equal((await runtime.request(`${url}/html`,{method:'POST',body:{allowRemoteImages:true,extra:'denied'}})).status,400);
  assert.equal((await runtime.request(`${url}/html`,{method:'POST',body:{allowRemoteImages:true,url:'https://arbitrary.example.net/image'}})).status,400);
  assert.deepEqual(upstream,[],'Default views and rejected permissions never fetch images');
  const response=await runtime.request(`${url}/html`,{method:'POST',headers:{Cookie:'owner=secret',Referer:'https://console.example.com/owner'},body:{allowRemoteImages:true}});assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/application\/json/);assert.match(response.headers.get('cache-control'),/no-store/);
  const allowed=await response.json();assert.equal(allowed.status,'available');assert.match(allowed.document,/src="data:image\/png;base64,/);
  assert.equal(allowed.loadedImages,1);assert.equal('remoteImageUrls' in allowed,false);
  assert.match(allowed.document,/referrerpolicy="no-referrer"/);
  assert.match(allowed.document,/img-src data:/);assert.equal(allowed.document.includes('tracking.invalid'),false);assert.equal(allowed.document.includes('images.example.net'),false);
  assert.equal(upstream.length,1);assert.equal(upstream[0].url,'https://images.example.net/pixel.png');
  for(const header of ['cookie','authorization','cf-access-jwt-assertion','referer','origin'])assert.equal(upstream[0].headers[header],undefined,header);
  const blockedAgain=await (await runtime.request(`${url}/html`)).text();assert.equal(blockedAgain.includes('images.example.net'),false);
  assert.equal(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read'),0);
  await runtime.db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').bind(Date.now(),message.id).run();
  assert.equal((await runtime.request(`${url}/html`)).status,404);
});

test('image fetching rejects private/app redirects and active or oversized content without breaking the safe document',{timeout:120_000},async t=>{
  const requested=[];
  const runtime=await createOwnerRuntime({outboundService:request=>{
    requested.push(request.url);
    if(request.url.endsWith('/app'))return new Response(null,{status:302,headers:{Location:'https://console.example.com/owner/api/setup'}});
    if(request.url.endsWith('/private'))return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/secret'}});
    if(request.url.endsWith('/http'))return new Response(null,{status:302,headers:{Location:'http://images.example.net/down'}});
    if(request.url.endsWith('/svg'))return new Response('<svg onload="alert(1)"/>',{headers:{'Content-Type':'image/svg+xml'}});
    if(request.url.endsWith('/large'))return new Response('large',{headers:{'Content-Type':'image/png','Content-Length':String(1024*1024+1)}});
  }});t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime,'image-rejections'),message=await inbound(runtime,box,'<p>Safe body survives</p>'+['app','private','http','svg','large'].map(path=>`<img src="https://images.example.net/${path}">`).join(''));
  const response=await runtime.request(`${base(box,message)}/html`,{method:'POST',body:{allowRemoteImages:true}});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.loadedImages,0);assert.equal(result.blockedImages,5);
  assert.match(result.document,/Safe body survives/);assert.doesNotMatch(result.document,/<img\b|<svg\b|https:\/\/images/);
  assert.deepEqual(requested.sort(),['app','private','http','svg','large'].map(path=>`https://images.example.net/${path}`).sort());
});

test('HTML-only mail has a text alternative; legacy, oversized and corrupt bodies report honest availability without backfills',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const box=await mailbox(runtime),only=await inbound(runtime,box,'<h2>HTML only</h2><p>First &amp; second</p><script>RAW_SCRIPT_SECRET</script>',null);
  let detail=await (await runtime.request(base(box,only))).json();
  assert.equal(detail.body.htmlStatus,'available');assert.equal(detail.body.status,'ready');assert.match(detail.body.text,/HTML only/);
  assert.match(detail.body.text,/First & second/);assert.equal(detail.body.text.includes('RAW_SCRIPT_SECRET'),false);
  const [legacy]=await seedMessages(runtime,box.id),legacyUrl=base(box,legacy);
  const count=(await runtime.bucket.list()).objects.length;
  assert.equal((await (await runtime.request(`${legacyUrl}/html-info`)).json()).status,'not_extracted');
  assert.equal((await runtime.request(`${legacyUrl}/html`)).status,409);assert.equal((await runtime.bucket.list()).objects.length,count);
  const large=await inbound(runtime,box,'<p>'+('X'.repeat(512*1024))+'</p>','Plain fallback retained');
  detail=await (await runtime.request(base(box,large))).json();assert.equal(detail.body.htmlStatus,'too_large');assert.equal(detail.body.text,'Plain fallback retained');
  assert.equal((await runtime.request(`${base(box,large)}/html`)).status,413);
  const body=await runtime.db.prepare('SELECT object_key FROM objects WHERE id=?').bind(only.body_object_id).first();
  await runtime.bucket.put(body.object_key,'PRIVATE_CORRUPT_BODY');
  const missing=await runtime.request(`${base(box,only)}/html`);assert.equal(missing.status,503);
  const error=await missing.text();assert.ok(error.includes('html_unavailable'));assert.equal(error.includes(body.object_key),false);assert.equal(error.includes('PRIVATE_CORRUPT_BODY'),false);
  await runtime.db.prepare('UPDATE messages SET body_object_id=? WHERE id=?').bind(only.raw_object_id,only.id).run();
  assert.equal((await (await runtime.request(`${base(box,only)}/html-info`)).json()).status,'unavailable');
});
