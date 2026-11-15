import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

test('OAuth browser: explicit Owner consent, mailbox scopes, approval, denial and revocation',{timeout:120_000},async t=>{
  const port=Number(process.env.OAUTH_E2E_PORT??4196),origin=`http://127.0.0.1:${port}`;
  const api='https://api.example.com',resource=`${api}/mcp`,callback='https://client.example/oauth-test-callback';
  const callbackHtml='<!doctype html><html lang="zh"><title>OAuth 测试回调</title><link rel="icon" href="data:,"><body>OAuth 回调已接收，未访问外部客户端。</body></html>';
  const callbackServer=createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'no-referrer'});response.end(callbackHtml);});
  await new Promise((resolve,reject)=>{callbackServer.once('error',reject);callbackServer.listen(0,'127.0.0.1',resolve);});
  const callbackPort=callbackServer.address().port,localCallback=`http://127.0.0.1:${callbackPort}/oauth-test-callback`;
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port});let browser;
  t.after(async()=>{await browser?.close();await runtime.mf.dispose();await new Promise(resolve=>callbackServer.close(resolve));});
  const created=await runtime.request('/owner/api/mailboxes',{method:'POST',body:{name:'OAuth Agent',localPart:'oauth-agent'}});
  assert.equal(created.status,201,await created.clone().text());const box=(await created.json()).mailbox;
  const staticIssued=await runtime.request(`/owner/api/mailboxes/${box.id}/tokens`,{method:'POST',body:{name:'Independent static reader',scopes:['mail:read']}});
  assert.equal(staticIssued.status,201);const staticToken=(await staticIssued.json()).secret;
  const clientName='Browser Client <img src=x onerror=globalThis.__oauthXss=true>';
  const registration=await runtime.mf.dispatchFetch(`${api}/oauth/register`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client_name:clientName,redirect_uris:[callback,localCallback],token_endpoint_auth_method:'none',
      grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'mail:read mail:draft mail:send'})});
  assert.equal(registration.status,201,await registration.clone().text());const client=await registration.json();
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  function authorization(state,redirectUri=callback) {
    const url=new URL('/owner/oauth/authorize',origin);
    url.search=new URLSearchParams({client_id:client.client_id,redirect_uri:redirectUri,response_type:'code',resource,
      scope:'mail:read mail:draft mail:send',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
    return url.href;
  }
  const anonymous=await runtime.mf.dispatchFetch(authorization('anonymous-state'),{headers:{Accept:'text/html'}});
  assert.equal(anonymous.status,401,'consent must require the existing Owner Access identity');
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM oauth_authorization_requests').first('n'),0);
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{})});
  const context=await browser.newContext({viewport:{width:1488,height:1056},extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':runtime.jwt}});
  const page=await context.newPage(),errors=[],external=[],ownerPosts=[],badResponses=[];
  page.on('response',response=>{if(response.status()>=400) {
    const url=new URL(response.url());badResponses.push({path:url.origin+url.pathname,status:response.status(),type:response.request().resourceType(),method:response.request().method()});
  }});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type())) {
    const source=message.location().url;let path='';try{const url=new URL(source);path=url.origin+url.pathname;}catch{}
    errors.push(`${message.text()}${path?` (${path})`:''}`);
  }});
  page.on('request',request=>{const url=new URL(request.url());if(url.origin!==origin&&url.href.split('?')[0]!==callback&&url.href.split('?')[0]!==localCallback)external.push(url.href);});
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/owner/')) {
    const headers=request.headers();ownerPosts.push({origin:headers.origin,host:headers.host,contentType:headers['content-type']});
  }});
  await page.route('**/oauth-test-callback**',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',
    body:callbackHtml}));
  const count=table=>runtime.db.prepare(`SELECT count(*) n FROM ${table}`).first('n');

  await page.goto(authorization('deny-state'));
  await expect(page).toHaveTitle('授权 MCP 客户端 · Agent Mail');
  await expect(page.getByRole('heading',{level:1})).toHaveText('授权 MCP 客户端');
  await expect(page.getByRole('heading',{name:clientName,exact:true})).toBeVisible();
  await expect(page.getByText(client.client_id,{exact:true})).toBeVisible();
  await expect(page.getByText('client.example',{exact:true})).toBeVisible();
  assert.equal(await page.locator('img').count(),0);
  assert.equal(await page.evaluate(()=>globalThis.__oauthXss),undefined);
  assert.equal(await count('oauth_grants'),0);assert.equal(await count('oauth_access_tokens'),0);
  assert.equal(await count('oauth_authorization_codes'),0);
  await page.getByRole('button',{name:'拒绝授权',exact:true}).click();
  await expect(page).toHaveURL(new RegExp('^https://client\\.example/oauth-test-callback\\?')).catch(async cause=>{
    throw new Error(`${cause.message}\nOwner POST headers: ${JSON.stringify(ownerPosts)}\nRendered body: ${await page.locator('body').innerText()}`);
  });
  const denied=new URL(page.url());assert.equal(denied.searchParams.get('error'),'access_denied');
  assert.equal(denied.searchParams.get('state'),'deny-state');assert.equal(denied.searchParams.get('iss'),api);
  assert.equal(denied.searchParams.has('code'),false);assert.equal(await count('oauth_grants'),0);

  await page.goto(authorization('allow-state'));
  await page.getByLabel('授权邮箱',{exact:true}).selectOption(box.id);
  await expect(page.getByRole('checkbox',{name:/^查询和阅读邮件/})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:/^创建和修改草稿/})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:/^提交邮件发送/})).toBeChecked();
  await page.getByRole('checkbox',{name:/^创建和修改草稿/}).uncheck();
  await expect(page.getByRole('checkbox',{name:/^提交邮件发送/})).not.toBeChecked();
  await page.getByRole('checkbox',{name:/^提交邮件发送/}).check();
  await expect(page.getByRole('checkbox',{name:/^创建和修改草稿/})).toBeChecked();
  const direct=page.getByRole('checkbox',{name:'允许此客户端无需逐封审批，直接提交发送',exact:true});
  await expect(direct).not.toBeChecked();
  const directory=process.env.OAUTH_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-oauth-qa-'));
  await mkdir(directory,{recursive:true});
  await page.screenshot({path:join(directory,'oauth-consent-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'授权此客户端',exact:true}).click();
  await expect(page).toHaveURL(new RegExp('^https://client\\.example/oauth-test-callback\\?'));
  const approved=new URL(page.url()),code=approved.searchParams.get('code');
  assert.ok(code);assert.equal(approved.searchParams.get('state'),'allow-state');assert.equal(approved.searchParams.get('iss'),api);
  assert.equal(await count('oauth_grants'),1);assert.equal(await count('oauth_access_tokens'),0);
  const grant=await runtime.db.prepare(`SELECT g.id,g.mailbox_id,g.scope,t.requires_approval FROM oauth_grants g
    JOIN mailbox_tokens t ON t.id=g.mailbox_token_id AND t.mailbox_id=g.mailbox_id`).first();
  assert.equal(grant.mailbox_id,box.id);assert.equal(grant.scope,'mail:read mail:draft mail:send');assert.equal(grant.requires_approval,1);
  const exchanged=await runtime.mf.dispatchFetch(`${api}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'authorization_code',code,client_id:client.client_id,redirect_uri:callback,resource,code_verifier:verifier}).toString()});
  assert.equal(exchanged.status,200,await exchanged.clone().text());const credentials=await exchanged.json();assert.ok(credentials.access_token);
  async function mcp(name,args={}) {
    return runtime.mf.dispatchFetch(resource,{method:'POST',headers:{Authorization:`Bearer ${credentials.access_token}`,
      Accept:'application/json, text/event-stream','Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':name},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{
        'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'browser-qa',version:'1'},
        'io.modelcontextprotocol/clientCapabilities':{}}}})});
  }
  const draftResponse=await mcp('create_draft',{to:['recipient@example.net'],subject:'OAuth 审批草稿',text:'这封邮件仍需要 Owner 审批。'});
  assert.equal(draftResponse.status,200);const draftResult=(await draftResponse.json()).result;
  assert.notEqual(draftResult.isError,true);const draft=draftResult.structuredContent.draft;
  const sendResponse=await mcp('send_message',{draftId:draft.id,expectedVersion:draft.version,clientRequestId:'oauth-browser-pending'});
  assert.equal(sendResponse.status,200);const sendResult=(await sendResponse.json()).result;
  assert.notEqual(sendResult.isError,true);assert.equal(sendResult.structuredContent.status,'approval_required');
  assert.equal(await count('outbound_messages'),0);assert.equal(await count('send_reservations'),0);

  await page.goto(`${origin}/owner/mailboxes/${box.id}/outbound`);
  await page.getByRole('button',{name:/OAuth 审批草稿/}).click();
  await expect(page.getByRole('heading',{name:'核对与审批',exact:true})).toBeVisible();
  await expect(page.getByText('待审批',{exact:true}).first()).toBeVisible();
  await expect(page.getByRole('button',{name:'提交发送',exact:true})).toBeDisabled();
  assert.equal(await count('outbound_messages'),0,'viewing the pending OAuth draft must not send it');

  await page.getByRole('link',{name:'MCP 授权',exact:true}).click();
  await expect(page.getByRole('heading',{level:1})).toHaveText('MCP 授权');
  await expect(page.getByRole('heading',{name:clientName,exact:true})).toBeVisible();
  await expect(page.getByText('每封发送需 Owner 审批',{exact:true})).toBeVisible();
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'撤销访问',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('授权已撤销，此客户端的新请求和刷新将被拒绝。').catch(async cause=>{
    throw new Error(`${cause.message}\nOwner POST headers: ${JSON.stringify(ownerPosts)}\nRendered body: ${await page.locator('body').innerText()}`);
  });
  await expect(page.getByText('已撤销',{exact:true})).toBeVisible();
  assert.equal((await mcp('get_mailbox')).status,401);
  const independent=await runtime.mf.dispatchFetch(`${api}/v1/mailbox`,{headers:{Authorization:`Bearer ${staticToken}`}});
  assert.equal(independent.status,200);

  await page.setViewportSize({width:390,height:844});
  await page.goto(authorization('mobile-deny-state',localCallback));
  await page.getByLabel('授权邮箱',{exact:true}).selectOption(box.id);
  await expect(page.getByText(/此客户端使用本机回调地址/)).toBeVisible();
  await expect(page.getByText(`127.0.0.1:${callbackPort}`,{exact:true})).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'允许此客户端无需逐封审批，直接提交发送',exact:true})).not.toBeChecked();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile OAuth consent must not overflow');
  await page.screenshot({path:join(directory,'oauth-consent-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'拒绝授权',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${callbackPort}/oauth-test-callback\\?`));
  const mobileDenied=new URL(page.url());assert.equal(mobileDenied.searchParams.get('error'),'access_denied');
  assert.equal(mobileDenied.searchParams.get('state'),'mobile-deny-state');
  assert.equal(await count('oauth_grants'),1);
  assert.equal(await page.locator('vite-error-overlay').count(),0);assert.deepEqual(errors,[],JSON.stringify(badResponses));assert.deepEqual(external,[]);
  console.log(`OAuth browser QA passed: ${origin}, desktop 1488x1056 / mobile 390x844; screenshots: ${directory}`);
});
