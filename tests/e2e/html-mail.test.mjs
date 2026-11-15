import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {seedMessages} from '../helpers/mail-fixtures.mjs';

const imageUrl='https://images.example.net/report.png';
const linkUrl='https://reports.example.net/build?run=42';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=','base64');

async function inbound(runtime,box,subject,html,inlineParts=[]) {
  const related=inlineParts.length>0;
  const eml=[`From: Build Agent <build@example.net>`,`To: ${box.address}`,`Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@html-browser.test>`,'MIME-Version: 1.0',
    related?'Content-Type: multipart/related; boundary="html-related"':'Content-Type: multipart/alternative; boundary="html-reader"','',
    ...(related?['--html-related','Content-Type: multipart/alternative; boundary="html-reader"','']:[]),
    '--html-reader','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',Buffer.from(`纯文本内容：${subject}\n不自动加载远程图片。`).toString('base64'),
    '--html-reader','Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',Buffer.from(html).toString('base64'),
    '--html-reader--',...inlineParts.flatMap(part=>['--html-related',`Content-Type: ${part.contentType}`,
      `Content-Disposition: inline; filename="${part.filename}"`,`Content-ID: <${part.contentId}>`,'Content-Transfer-Encoding: base64','',part.bytes.toString('base64')]),
    ...(related?['--html-related--']:[]),''].join('\r\n');
  const delivered=await runtime.mf.dispatchFetch(`http://localhost/cdn-cgi/local/email?from=build%40example.net&to=${encodeURIComponent(box.address)}&format=json`,{
    method:'POST',headers:{'Content-Type':'message/rfc822'},body:eml});
  assert.equal(delivered.status,200,await delivered.clone().text());assert.equal((await delivered.json()).outcome,'ok');
  assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');
  return runtime.db.prepare('SELECT id FROM messages WHERE mailbox_id=? AND subject=?').bind(box.id,subject).first();
}

test('HTML reader: isolated CID previews, explicit Worker image retrieval without CORS and reset to blocked/plain text',{timeout:120_000},async t=>{
  const port=Number(process.env.HTML_MAIL_E2E_PORT??4200),origin=`http://127.0.0.1:${port}`;
  const imageRequests=[],unexpectedUpstream=[],unexpectedExternal=[],errors=[];
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,outboundService:async request=>{
    const url=new URL(request.url);
    if(url.origin==='https://images.example.net'){
      imageRequests.push({url:request.url,headers:Object.fromEntries(request.headers)});
      // Deliberately no Access-Control-Allow-Origin: the Worker supplies validated image bytes, not browser CORS URLs.
      if(url.pathname==='/report.png')return new Response(Uint8Array.from(png),{headers:{'Content-Type':'image/png'}});
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',{headers:{'Content-Type':'image/svg+xml'}});
    }
    unexpectedUpstream.push(request.url);return new Response('Unexpected external request',{status:502});
  }});let browser;
  t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const created=await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'HTML Reader Agent',localPart:'html-reader'}});
  assert.equal(created.status,201);const box=(await created.json()).mailbox;
  const html=`<!DOCTYPE html><html><head><base href="https://tracking.example.net/"><meta http-equiv="refresh" content="0;url=https://tracking.example.net/refresh"><style>body{background-image:url(https://tracking.example.net/css.gif)}</style></head><body>
    <h2 style="color:#255c44">构建结果</h2><p>你好，<strong>安全格式正文</strong>已经准备好。</p>
    <table><thead><tr><th>检查项目</th><th>结果</th></tr></thead><tbody><tr><td>单 Worker 构建</td><td>通过</td></tr></tbody></table>
    <a href="${linkUrl}" target="_top">查看构建报告</a><a href="javascript:top.__mailHtmlXss=true">恶意链接</a>
    <img src="${imageUrl}" srcset="https://tracking.example.net/srcset.png 2x" onerror="top.__mailHtmlXss=true" alt="构建配图">
    <img src="https://images.example.net/vector.svg" alt="不支持的远程图片">
    <img src="cid:build.logo%40example.net" alt="邮件内嵌标志">
    <img src="cid:missing@example.net" alt="缺少的内嵌图片"><img src="cid:vector@example.net" alt="不支持的内嵌图片">
    <img src="cid:bad%ZZ" alt="无效 CID 图片"><img src="data:image/svg+xml,%3Csvg%20onload='alert(1)'%3E" alt="数据图片">
    <script>top.__mailHtmlXss=true;fetch('https://tracking.example.net/script')</script><iframe src="https://tracking.example.net/frame"></iframe>
    <form action="https://tracking.example.net/submit"><input autofocus onfocus="top.__mailHtmlXss=true"><button>提交</button></form>
    <svg onload="top.__mailHtmlXss=true"><image href="https://tracking.example.net/svg"/></svg>
    <object data="https://tracking.example.net/object"></object><video poster="https://tracking.example.net/poster"></video>
    </body></html>`;
  const first=await inbound(runtime,box,'HTML 安全阅读',html,[
    {filename:'logo.png',contentType:'image/png',contentId:'build.logo@example.net',bytes:png},
    {filename:'vector.svg',contentType:'image/svg+xml',contentId:'vector@example.net',bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')}
  ]);
  const second=await inbound(runtime,box,'第二封 HTML 邮件',`<h2>第二封格式正文</h2><p>图片许可不能跨邮件沿用。</p><img src="${imageUrl}?second=1" alt="第二封图片">`);
  const [legacy]=await seedMessages(runtime,box.id,{prefix:'旧正文格式',receivedAt:Date.now()-1000});
  const initial=await (await runtime.request(`/owner/api/mailboxes/${box.id}/messages/${first.id}`)).json();
  assert.equal(initial.body.htmlStatus,'available');
  assert.equal(initial.attachments.attachments.length,2);
  const inlinePng=initial.attachments.attachments.find(part=>part.filename==='logo.png');assert.ok(inlinePng);
  const metadata=await (await runtime.request(`/owner/api/mailboxes/${box.id}/messages/${first.id}/html-info`)).json();
  assert.equal(metadata.inlineImages,3);assert.equal(metadata.loadedInlineImages,1);assert.equal(metadata.remoteImages,2);assert.equal(metadata.loadedImages,0);
  assert.equal(Object.hasOwn(metadata,'html'),false);assert.equal(Object.hasOwn(metadata,'document'),false);assert.equal(JSON.stringify(metadata).includes('data:image/'),false);
  assert.deepEqual(imageRequests,[]);
  const issued=await runtime.request(`/owner/api/mailboxes/${box.id}/tokens`,{method:'POST',body:{name:'HTML read only',scopes:['mail:read']}});
  assert.equal(issued.status,201);const readToken=(await issued.json()).secret;
  assert.equal((await runtime.request(`/owner/api/mailboxes/${box.id}/messages/${first.id}/html`,{authenticated:false,headers:{Authorization:`Bearer ${readToken}`}})).status,401);
  assert.equal((await runtime.mf.dispatchFetch(`https://api.example.com/v1/messages/${first.id}/attachments/${inlinePng.id}/download`,{headers:{Authorization:`Bearer ${readToken}`}})).status,403);
  const sendIssued=await runtime.request(`/owner/api/mailboxes/${box.id}/tokens`,{method:'POST',body:{name:'Send only agent',scopes:['mail:draft','mail:send']}});
  assert.equal(sendIssued.status,201);const sendToken=(await sendIssued.json()).secret;
  assert.equal((await runtime.request(`/owner/api/mailboxes/${box.id}/messages/${first.id}/html`,{authenticated:false,headers:{Authorization:`Bearer ${sendToken}`}})).status,401);
  assert.equal((await runtime.mf.dispatchFetch(`https://api.example.com/v1/messages/${first.id}/attachments/${inlinePng.id}/download`,{headers:{Authorization:`Bearer ${sendToken}`}})).status,403);
  assert.equal(JSON.stringify(initial).includes('<script>'),false,'Raw HTML must not be serialized into the reader data');
  await runtime.mf.ready;
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:[
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server'
  ]});
  const context=await browser.newContext({viewport:{width:1488,height:1056}});
  await context.addCookies([{name:'image-tracking-cookie',value:'must-not-be-sent',url:'https://images.example.net',secure:true,sameSite:'None'}]);
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===origin){await route.continue({headers:{...request.headers(),'Cf-Access-Jwt-Assertion':runtime.jwt}});return;}
    unexpectedExternal.push(request.url());await route.abort();
  });
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
  const base=`${origin}/owner/mailboxes/${box.id}/messages`;
  await page.goto(`${base}?message=${first.id}`);
  await expect(page).toHaveTitle('HTML Reader Agent · 邮件 · Agent Mail');
  await expect(page.getByRole('heading',{level:1})).toHaveText('HTML Reader Agent');
  const region=page.getByRole('region',{name:'邮件正文',exact:true});
  await expect(region.getByRole('button',{name:'纯文本',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(region.locator('.message-body')).toContainText('纯文本内容：HTML 安全阅读');
  assert.equal(await region.locator('iframe').count(),0);assert.deepEqual(imageRequests,[]);assert.deepEqual(unexpectedExternal,[]);
  await region.getByRole('button',{name:'HTML 正文',exact:true}).click();
  const iframe=page.locator('iframe[title="HTML 邮件正文"]');
  await expect(iframe).toBeVisible();await expect(iframe).toHaveAttribute('sandbox','');await expect(iframe).toHaveAttribute('referrerpolicy','no-referrer');
  const frame=page.frameLocator('iframe[title="HTML 邮件正文"]');
  await expect(frame.getByRole('heading',{name:'构建结果',exact:true})).toBeVisible();
  await expect(frame.locator('table')).toContainText('单 Worker 构建');await expect(frame.locator('strong')).toHaveText('安全格式正文');
  assert.equal(await frame.locator('script,form,input,button,iframe,object,embed,svg,math,base,link,meta[http-equiv="refresh"]').count(),0);
  assert.equal(await frame.locator('a[href],img[srcset]').count(),0);
  await expect(frame.locator('img[src]')).toHaveCount(1);
  await expect(frame.locator('img[src]')).toHaveAttribute('src',/^data:image\/png;base64,/);
  await expect.poll(()=>frame.locator('img[src]').evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true);
  await expect(frame.locator('body')).toContainText('缺少的内嵌图片');await expect(frame.locator('body')).toContainText('不支持的内嵌图片');
  await expect(frame.locator('body')).toContainText('无效 CID 图片');
  await expect(region).toContainText(/内嵌图片已显示 1 \/ \d+ 处，无需访问外站/);
  assert.deepEqual(imageRequests,[]);assert.deepEqual(unexpectedExternal,[]);
  assert.equal(await page.evaluate(()=>globalThis.__mailHtmlXss),undefined);
  const blockedParentAccess=await iframe.evaluate(element=>{try{void element.contentWindow.document;return false;}catch{return true;}});
  assert.equal(blockedParentAccess,true,'The sandboxed document must have an opaque origin');
  const externalLink=region.getByRole('link',{name:linkUrl,exact:true});
  await expect(externalLink).toHaveAttribute('href',linkUrl);await expect(externalLink).toHaveAttribute('target','_blank');await expect(externalLink).toHaveAttribute('rel','noopener noreferrer');
  await expect(region).toContainText('远程图片默认屏蔽');
  const downloadPromise=page.waitForEvent('download');
  await region.getByRole('link',{name:'下载 logo.png',exact:true}).click();
  const download=await downloadPromise;assert.equal(await download.failure(),null);assert.deepEqual(await readFile(await download.path()),png);
  assert.deepEqual(imageRequests,[]);
  page.once('dialog',dialog=>dialog.dismiss());await region.getByRole('button',{name:'加载远程图片',exact:true}).click();
  assert.deepEqual(imageRequests,[]);await expect(iframe).not.toHaveAttribute('srcdoc',/.+/);
  const directory=process.env.HTML_MAIL_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-html-reader-qa-'));
  await mkdir(directory,{recursive:true});
  await page.screenshot({path:join(directory,'html-mail-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await iframe.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(directory,'html-mail-mobile.png'),fullPage:true});
  page.once('dialog',dialog=>dialog.accept());
  await region.getByRole('button',{name:'加载远程图片',exact:true}).click();
  await expect(iframe).toHaveAttribute('srcdoc',/构建结果/);
  await expect.poll(()=>imageRequests.length).toBe(2);
  await expect(frame.locator('img[src]')).toHaveCount(2);
  assert.equal(await frame.locator('img[src]').evaluateAll(images=>images.every(image=>image.src.startsWith('data:image/png;base64,'))),true);
  await expect.poll(()=>frame.locator('img[src]').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0))).toBe(true);
  for(const captured of imageRequests) {
    assert.equal(captured.headers.referer,undefined);assert.equal(captured.headers.cookie,undefined);
    assert.equal(captured.headers['cf-access-jwt-assertion'],undefined);assert.equal(captured.headers.authorization,undefined);assert.equal(captured.headers.origin,undefined);
  }
  await expect(region).toContainText('已仅为此邮件加载 1 处远程图片');
  await expect(region).toContainText(/内嵌图片已显示 1 \/ \d+ 处/);
  await expect(region).toContainText('不可用或超过限制的图片资源仍被屏蔽');
  assert.deepEqual(unexpectedUpstream,[]);assert.deepEqual(unexpectedExternal,[]);
  assert.equal(await page.evaluate(()=>globalThis.__mailHtmlXss),undefined);
  await region.getByRole('button',{name:'恢复屏蔽图片',exact:true}).click();
  await expect(iframe).toHaveAttribute('src',/\/html$/);await expect(frame.locator('img[src]')).toHaveCount(1);
  assert.equal(imageRequests.length,2);
  await region.getByRole('button',{name:'纯文本',exact:true}).click();await expect(iframe).toHaveCount(0);
  await region.getByRole('button',{name:'HTML 正文',exact:true}).click();await expect(iframe).toBeVisible();assert.equal(imageRequests.length,2);
  await page.locator(`a.mail-summary[href*="message=${second.id}"]`).click();
  await expect(region.getByRole('button',{name:'纯文本',exact:true})).toHaveAttribute('aria-pressed','true');await expect(iframe).toHaveCount(0);
  await region.getByRole('button',{name:'HTML 正文',exact:true}).click();
  await expect(frame.getByRole('heading',{name:'第二封格式正文',exact:true})).toBeVisible();assert.equal(imageRequests.length,2);
  await expect(frame.locator('img[src]')).toHaveCount(0);await expect(region).not.toContainText('内嵌图片已显示');
  await expect(region.getByRole('button',{name:'加载远程图片',exact:true})).toBeVisible();
  await page.locator(`a.mail-summary[href*="message=${legacy.id}"]`).click();
  await expect(region.getByRole('button',{name:'HTML 正文',exact:true})).toBeDisabled();await expect(region).toContainText('尚未提取 HTML 正文');
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM messages WHERE mailbox_id=? AND is_read=1').bind(box.id).first('n'),0);
  assert.equal(await page.locator('vite-error-overlay').count(),0);assert.deepEqual(unexpectedExternal,[]);assert.deepEqual(unexpectedUpstream,[]);assert.deepEqual(errors,[]);
  console.log(`HTML reader browser QA passed: ${origin}, desktop1488x1056 / mobile390x844; screenshots: ${directory}`);
});
