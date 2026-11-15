import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';
import {seedMessages} from '../helpers/mail-fixtures.mjs';

test('Attachments browser: parsed metadata, safe downloads, legacy state and explicit mailbox/OAuth scopes',{timeout:120_000},async t=>{
  const port=Number(process.env.ATTACHMENTS_E2E_PORT??4198),origin=`http://127.0.0.1:${port}`;
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port});let browser;
  t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const created=await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'Attachment Agent',localPart:'attachment-agent'}});
  assert.equal(created.status,201);const box=(await created.json()).mailbox;
  const text=Buffer.from('附件内容：Agent report\n','utf8');
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>globalThis.__attachmentXss=true</script><image href="https://tracking.invalid/pixel"/></svg>');
  const html=Buffer.from('<script>globalThis.__attachmentXss=true</script>');
  const maliciousName='../../<img src=x onerror=globalThis.__attachmentXss=true>.html';
  const eml=[
    'From: Build Agent <build@example.net>',`To: ${box.address}`,'Subject: 附件安全检查','Message-ID: <attachment-browser@example.net>',
    'MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="attachment-browser"','',
    '--attachment-browser','Content-Type: text/plain; charset=utf-8','','请核对附件后再下载。',
    '--attachment-browser','Content-Type: text/plain; charset=utf-8',`Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent('资料_报告.txt')}`,
    'Content-Transfer-Encoding: base64','',text.toString('base64'),
    '--attachment-browser','Content-Type: image/svg+xml','Content-Disposition: inline; filename="pixel.svg"','Content-ID: <browser-inline>',
    'Content-Transfer-Encoding: base64','',svg.toString('base64'),
    '--attachment-browser','Content-Type: text/html',`Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(maliciousName)}`,
    'Content-Transfer-Encoding: base64','',html.toString('base64'),'--attachment-browser--',''
  ].join('\r\n');
  const delivered=await runtime.mf.dispatchFetch(`http://localhost/cdn-cgi/local/email?from=build%40example.net&to=${encodeURIComponent(box.address)}&format=json`,{
    method:'POST',headers:{'Content-Type':'message/rfc822'},body:eml
  });
  assert.equal(delivered.status,200,await delivered.clone().text());
  assert.equal((await delivered.json()).outcome,'ok');
  assert.equal((await (await runtime.mf.getWorker()).scheduled({cron:'* * * * *'})).outcome,'ok');
  const message=await runtime.db.prepare('SELECT id,is_read FROM messages WHERE mailbox_id=?').bind(box.id).first();
  assert.ok(message);
  const response=await runtime.request(`/owner/api/mailboxes/${box.id}/messages/${message.id}`);
  assert.equal(response.status,200);const detail=await response.json();
  assert.equal(detail.attachments.status,'ready');assert.equal(detail.attachments.attachments.length,3);
  const first=detail.attachments.attachments.find(value=>value.filename==='资料_报告.txt');
  const inline=detail.attachments.attachments.find(value=>value.disposition==='inline');
  const blocked=detail.attachments.attachments.find(value=>value.id!==first?.id&&value.id!==inline?.id);
  assert.ok(first);assert.ok(inline);assert.ok(blocked);
  assert.equal(first.sizeBytes,text.byteLength);
  await runtime.db.prepare("UPDATE attachments SET scan_status='blocked' WHERE id=?").bind(blocked.id).run();
  const [legacy]=await seedMessages(runtime,box.id,{prefix:'旧邮件附件状态',receivedAt:Date.now()-1000});
  await runtime.mf.ready;
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{})});
  const context=await browser.newContext({viewport:{width:1488,height:1056},acceptDownloads:true,extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':runtime.jwt}});
  const page=await context.newPage(),errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
  page.on('request',request=>{if(new URL(request.url()).hostname==='tracking.invalid')external.push(request.url());});
  const base=`${origin}/owner/mailboxes/${box.id}/messages`;
  await page.goto(`${base}?message=${message.id}`);
  await expect(page).toHaveTitle('Attachment Agent · 邮件 · Agent Mail');
  await expect(page.getByRole('heading',{level:1})).toHaveText('Attachment Agent');
  const attachments=page.getByRole('region',{name:'邮件附件',exact:true});
  await expect(attachments.getByRole('heading',{name:'附件',exact:true})).toBeVisible();
  await expect(attachments.locator('.attachment-list>li')).toHaveCount(3);
  await expect(attachments).toContainText('资料_报告.txt');await expect(attachments).toContainText('内嵌资源');
  await expect(attachments).toContainText('未进行病毒扫描');await expect(attachments).toContainText('禁止下载');
  assert.equal(await attachments.locator('img,iframe,script,object,embed').count(),0);
  assert.equal(await attachments.locator(`a[href*="${blocked.id}"]`).count(),0);
  assert.equal(await page.evaluate(()=>globalThis.__attachmentXss),undefined);assert.deepEqual(external,[]);
  const downloadPromise=page.waitForEvent('download');
  await attachments.getByRole('link',{name:'下载 资料_报告.txt',exact:true}).click();
  const downloaded=await downloadPromise;
  assert.equal(await downloaded.failure(),null,'The browser must allow the authenticated attachment download');
  assert.equal(downloaded.suggestedFilename(),'资料_报告.txt');
  assert.deepEqual(await readFile(await downloaded.path()),text);
  const inlineDownloadPromise=page.waitForEvent('download');
  await attachments.getByRole('link',{name:`下载 ${inline.filename}`,exact:true}).click();
  const inlineDownload=await inlineDownloadPromise;
  assert.equal(await inlineDownload.failure(),null,'Inline MIME resources must download as files');
  assert.deepEqual(await readFile(await inlineDownload.path()),svg);
  assert.equal(await page.evaluate(()=>globalThis.__attachmentXss),undefined);assert.deepEqual(external,[]);
  assert.equal(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read'),0);

  const directory=process.env.ATTACHMENTS_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-attachments-qa-'));
  await mkdir(directory,{recursive:true});await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:join(directory,'attachments-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await attachments.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Attachment metadata must wrap on mobile');
  await expect(attachments.getByRole('link',{name:'下载 资料_报告.txt',exact:true})).toBeVisible();
  await page.screenshot({path:join(directory,'attachments-mobile.png'),fullPage:true});
  await page.goto(`${base}?message=${legacy.id}`);
  await expect(attachments).toContainText('此邮件尚未提取附件');
  assert.equal(await attachments.getByRole('link').count(),0);

  await page.goto(`${origin}/owner/mailboxes/${box.id}`);
  await page.getByRole('button',{name:'签发 Token',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'签发 Token',exact:true});
  const reads=dialog.getByLabel(/^邮件读取/),files=dialog.getByLabel(/^附件下载/);
  await expect(reads).toBeChecked();await expect(files).not.toBeChecked();
  await files.check();await reads.uncheck();await expect(files).not.toBeChecked();await expect(files).toBeDisabled();
  await reads.check();await files.check();
  await dialog.getByLabel('名称',{exact:true}).fill('Attachment Reader');
  await dialog.getByRole('button',{name:'签发 Token',exact:true}).click();
  const issued=page.getByRole('dialog',{name:'Token 已签发'});await expect(issued).toBeVisible();
  const secret=await issued.getByLabel('完整 Token',{exact:true}).inputValue();
  await issued.getByRole('button',{name:'我已保存'}).click();
  await expect(page.getByRole('row').filter({hasText:'Attachment Reader'})).toContainText('附件下载');
  const stored=await runtime.db.prepare('SELECT can_read,can_read_attachments FROM mailbox_tokens WHERE name=?').bind('Attachment Reader').first();
  assert.deepEqual(stored,{can_read:1,can_read_attachments:1});
  const apiDownload=await runtime.mf.dispatchFetch(`https://api.example.com/v1/messages/${message.id}/attachments/${first.id}/download`,{headers:{Authorization:`Bearer ${secret}`}});
  assert.equal(apiDownload.status,200,await apiDownload.clone().text());assert.deepEqual(Buffer.from(await apiDownload.arrayBuffer()),text);
  assert.equal((await page.content()).includes(secret),false);

  const callback='https://client.example/attachments-callback';
  const registration=await runtime.mf.dispatchFetch('https://api.example.com/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client_name:'Attachment MCP Client',redirect_uris:[callback],token_endpoint_auth_method:'none',scope:'mail:read attachments:read'})});
  assert.equal(registration.status,201,await registration.clone().text());const client=await registration.json();
  const verifier=randomBytes(32).toString('base64url');
  const authorize=new URL('/owner/oauth/authorize',origin);
  authorize.search=new URLSearchParams({client_id:client.client_id,redirect_uri:callback,response_type:'code',resource:'https://api.example.com/mcp',
    scope:'mail:read attachments:read',state:'attachment-browser',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  await page.goto(authorize.href);
  await expect(page.getByRole('heading',{level:1})).toHaveText('授权 MCP 客户端');
  const consentFiles=page.getByLabel(/下载邮件附件/),consentRead=page.getByLabel(/查询和阅读邮件/);
  await expect(consentFiles).toBeChecked();await expect(consentRead).toBeChecked();
  await consentRead.uncheck();await expect(consentFiles).not.toBeChecked();
  await consentFiles.check();await expect(consentRead).toBeChecked();
  await page.getByLabel('授权邮箱',{exact:true}).selectOption(box.id);
  await expect(page.getByRole('button',{name:'授权此客户端',exact:true})).toBeEnabled();
  await page.screenshot({path:join(directory,'attachments-consent-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('vite-error-overlay').count(),0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log(`Attachments browser QA passed: ${origin}, desktop 1488x1056 / mobile 390x844; screenshots: ${directory}`);
});
