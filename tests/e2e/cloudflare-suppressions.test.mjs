import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

test('Owner Cloudflare suppressions: private sync, explicit scope confirmation, durable delete and independent local CAS',{timeout:120_000},async t=>{
  const port=Number(process.env.CLOUDFLARE_SUPPRESSIONS_E2E_PORT??4205),origin=`http://127.0.0.1:${port}`;
  const accountId='a'.repeat(32),domain='agent.example.com',providerToken='CF_PROVIDER_TOKEN_TEST_ONLY_abcdefghijklmnopqrstuvwxyz';
  const upstreamBase=`/client/v4/accounts/${accountId}/email/sending/suppressions`,errors=[],external=[],calls=[],releaseRequests=[];
  const remote=(address,scope,readOnly=false)=>({id:randomUUID(),email:address,reason:'hard_bounce',scope,read_only:readOnly,created_at:'2026-11-01T10:00:00Z',expires_at:readOnly?'2026-12-31T23:59:59Z':null});
  const account=remote('account@example.net',{type:'account'}),protectedRow=remote('protected@example.net',{type:'account'},true);
  const linked=remote('linked@example.net',{type:'sending_domain',value:domain}),partial=remote('partial@example.net',{type:'sending_domain',value:domain}),unknown=remote('unknown@example.net',{type:'sending_domain',value:domain});
  const state={account:[account,protectedRow],sending:[linked,partial,unknown],deletes:0,unknownDelete:false,incomplete:false,beforePartialDelete:false};
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,outboundService:async request=>{
    const url=new URL(request.url);assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(request.headers.get('Authorization'),`Bearer ${providerToken}`);
    for(const header of ['Cookie','Origin','Referer','Cf-Access-Jwt-Assertion'])assert.equal(request.headers.get(header),null,header);
    calls.push({method:request.method,url:request.url});
    if(url.pathname===upstreamBase){
      assert.equal(request.method,'GET');assert.equal(url.searchParams.get('per_page'),'100');
      const scope=url.searchParams.get('scope_type');assert.ok(['account','sending_domain'].includes(scope));
      if(scope==='sending_domain')assert.equal(url.searchParams.get('scope_value'),domain);else assert.equal(url.searchParams.has('scope_value'),false);
      if(url.searchParams.has('cursor'))return Response.json({success:false,errors:[{message:`PRIVATE_CF_RESPONSE ${providerToken}`}],result:null},{status:503});
      return Response.json({success:true,result:scope==='account'?state.account:state.sending,result_info:{next_cursor:state.incomplete&&scope==='account'?'failed-next-page':null}});
    }
    const id=url.pathname.slice(upstreamBase.length+1),row=[...state.account,...state.sending].find(item=>item.id===id);
    if(request.method==='GET')return row?Response.json({success:true,result:row}):Response.json({success:false,result:null},{status:404});
    assert.equal(request.method,'DELETE');assert.ok(row);assert.equal(row.read_only,false);
    if(id===partial.id&&state.beforePartialDelete){state.beforePartialDelete=false;await runtime.db.prepare('UPDATE recipient_suppressions SET version=version+1,last_event_at=last_event_at+1,updated_at=updated_at+1 WHERE id=?').bind(locals.get(partial.email)).run();}
    state.deletes++;state.account=state.account.filter(item=>item.id!==id);state.sending=state.sending.filter(item=>item.id!==id);
    if(id===unknown.id&&state.unknownDelete)throw new Error('PRIVATE_CF_NETWORK_DIAGNOSTIC');
    return Response.json({success:true,result:{id}});
  }});let browser;
  t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const json=async(path,options={},status=200)=>{const response=await runtime.request(path,options);assert.equal(response.status,status,await response.clone().text());return response.json();};
  const box=(await json('/owner/api/mailboxes',{method:'POST',body:{name:'Cloudflare 名单 Agent',localPart:'cloudflare-list'}},201)).mailbox;
  const base=`/owner/api/mailboxes/${box.id}`,providerBase=`${base}/cloudflare-suppressions`,now=Date.now(),locals=new Map();
  for(const address of [linked.email,partial.email,unknown.email]){
    const id=randomUUID();locals.set(address,id);await runtime.db.prepare(`INSERT INTO recipient_suppressions(id,mailbox_id,address,reason,last_event_at,last_event_id,created_at,updated_at) VALUES(?,?,?,'hard_bounce',?,'fixture:provider-owner',?,?)`).bind(id,box.id,address,now-1000,now,now).run();
  }
  await runtime.mf.ready;
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1488,height:1056}});await context.addCookies([{name:'CF_OWNER_COOKIE',value:'owner-session-must-not-forward',url:origin}]);
  let loseFirstDeleteResponse=true;
  const lostReleasePath=`${providerBase}/${account.id}/release`;
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){external.push(request.url());await route.abort();return;}
    const headers={...request.headers(),'Cf-Access-Jwt-Assertion':runtime.jwt};
    if(url.pathname===lostReleasePath&&request.method()==='POST'&&loseFirstDeleteResponse){
      loseFirstDeleteResponse=false;const response=await route.fetch({headers});assert.equal(response.status(),200);await response.dispose();await route.abort('failed');return;
    }
    await route.continue({headers});
  });
  const page=await context.newPage();page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith(`${providerBase}/`)&&new URL(request.url()).pathname.endsWith('/release'))releaseRequests.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{
    if(!['error','warning'].includes(message.type()))return;
    let path='';try{path=new URL(message.location().url).pathname;}catch{}
    if(message.type()==='error'&&path===lostReleasePath&&message.text().includes('ERR_FAILED'))return;
    if(message.type()==='error'&&state.incomplete&&path===`${providerBase}/sync`&&['502','503'].some(code=>message.text().includes(code)))return;
    errors.push(message.text());
  });
  await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions`);await expect(page).toHaveTitle('Cloudflare 名单 Agent · 抑制名单 · Agent Mail');await expect(page.getByRole('heading',{level:1})).toHaveText('Cloudflare 名单 Agent');await expect(page.getByRole('heading',{level:1})).toBeInViewport();
  const local=page.getByRole('region',{name:'收件人抑制名单',exact:true}),provider=page.getByRole('region',{name:'Cloudflare 服务端抑制',exact:true});
  await expect(local.locator('.suppression-list>li')).toHaveCount(3);await expect(provider).toContainText('尚未配置 Cloudflare 名单管理');
  await expect(provider.getByRole('button',{name:'同步 Cloudflare 记录',exact:true})).toBeDisabled();assert.deepEqual(calls,[]);
  assert.equal(await provider.locator('input,textarea').count(),0,'Provider API credentials must never be entered in the Owner page');
  await runtime.updateBindings({EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain});
  await provider.getByRole('button',{name:'刷新缓存记录',exact:true}).click();await expect(provider).toContainText('尚未成功同步');assert.deepEqual(calls,[],'Reading the cache never calls the provider API');
  await provider.getByRole('button',{name:'同步 Cloudflare 记录',exact:true}).click();await expect(provider.locator('[data-provider-id]')).toHaveCount(5);assert.equal(calls.length,2);
  const remoteRow=id=>provider.locator(`[data-provider-id="${id}"]`),dialog=page.getByRole('dialog',{name:'解除 Cloudflare 服务端抑制',exact:true});
  await expect(remoteRow(protectedRow.id)).toContainText('只读');await expect(remoteRow(protectedRow.id)).toContainText('2026-12-31');await expect(remoteRow(protectedRow.id).getByRole('button')).toHaveCount(0);
  await expect(remoteRow(account.id).getByRole('button',{name:`解除 Cloudflare 记录 ${account.email}`,exact:true})).toBeEnabled();await expect(remoteRow(account.id)).toContainText('账户范围 · 所有发信域');
  await expect(remoteRow(linked.id)).toContainText(`发信域 · ${domain}`);await expect(remoteRow(linked.id)).toContainText('当前邮箱也有此地址的本地抑制');
  const directory=process.env.CLOUDFLARE_SUPPRESSIONS_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-cloudflare-suppressions-qa-'));await mkdir(directory,{recursive:true});
  await provider.screenshot({path:join(directory,'cloudflare-suppressions-desktop.png')});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await provider.screenshot({path:join(directory,'cloudflare-suppressions-mobile.png')});
  await page.setViewportSize({width:1488,height:1056});
  await remoteRow(account.id).getByRole('button',{name:`解除 Cloudflare 记录 ${account.email}`,exact:true}).click();await expect(dialog).toContainText('包括当前邮箱之外的发信域');
  const confirm=dialog.getByRole('button',{name:'确认解除 Cloudflare 记录',exact:true});await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox',{name:'输入完整收件地址以确认',exact:true}).fill(account.email);await expect(confirm).toBeDisabled();
  await dialog.getByRole('checkbox',{name:'我确认解除账户范围记录，会影响此账户的所有发信域。',exact:true}).check();await expect(confirm).toBeEnabled();
  await page.screenshot({path:join(directory,'cloudflare-suppressions-account-confirm.png'),fullPage:false});
  await confirm.click();await expect(dialog.getByRole('alert')).toContainText('请求未完成');assert.equal(state.deletes,1);
  await expect(dialog.getByRole('textbox',{name:'输入完整收件地址以确认',exact:true})).toBeDisabled();const beforeRetry=calls.length;
  await confirm.click();await expect(dialog).toHaveCount(0);assert.equal(state.deletes,1);assert.equal(calls.length,beforeRetry,'Lost-response retry must return the durable result without another provider request');
  const accountRequests=releaseRequests.filter(item=>item.path===lostReleasePath);assert.equal(accountRequests.length,2);assert.deepEqual(accountRequests[0].body,accountRequests[1].body);assert.match(accountRequests[0].body.clientRequestId,/^[0-9a-f-]{36}$/);assert.equal(accountRequests[0].body.confirmationScope,'account');

  await remoteRow(linked.id).getByRole('button',{name:`解除 Cloudflare 记录 ${linked.email}`,exact:true}).click();
  await dialog.getByRole('textbox',{name:'输入完整收件地址以确认',exact:true}).fill(linked.email);
  const alsoLocal=dialog.getByRole('checkbox',{name:`同时解除当前邮箱 ${box.address} 中匹配的本地抑制`,exact:true});await expect(alsoLocal).not.toBeChecked();await alsoLocal.check();await confirm.click();await expect(dialog).toHaveCount(0);
  await expect(local.locator(`[data-address="${linked.email}"]`)).toHaveCount(0);assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(locals.get(linked.email)).first('status'),'released');
  await expect(provider.getByRole('status')).toContainText('已同时解除当前邮箱匹配的本地抑制');assert.equal(state.deletes,2);

  await remoteRow(partial.id).getByRole('button',{name:`解除 Cloudflare 记录 ${partial.email}`,exact:true}).click();await dialog.getByRole('textbox',{name:'输入完整收件地址以确认',exact:true}).fill(partial.email);await alsoLocal.check();
  state.beforePartialDelete=true;
  await confirm.click();await expect(dialog).toHaveCount(0);await expect(provider.getByRole('status')).toContainText('Cloudflare 记录已解除');await expect(provider.getByRole('status')).toContainText('本地记录已变化，仍保留抑制');
  await expect(local.locator(`[data-address="${partial.email}"]`)).toContainText('抑制中');assert.equal(state.deletes,3);

  state.unknownDelete=true;await remoteRow(unknown.id).getByRole('button',{name:`解除 Cloudflare 记录 ${unknown.email}`,exact:true}).click();await dialog.getByRole('textbox',{name:'输入完整收件地址以确认',exact:true}).fill(unknown.email);await alsoLocal.check();await confirm.click();
  await expect(dialog.getByRole('status')).toContainText('删除结果暂未确认');await expect(confirm).toHaveCount(0);assert.equal(state.deletes,4);
  await dialog.getByRole('button',{name:'关闭并同步记录',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(remoteRow(unknown.id)).toHaveCount(0);
  await expect(local.locator(`[data-address="${unknown.email}"]`)).toContainText('抑制中');assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(locals.get(unknown.email)).first('status'),'active');assert.equal(state.deletes,4,'Syncing an unknown outcome must not retry DELETE or release local policy');

  state.incomplete=true;await provider.getByRole('button',{name:'同步 Cloudflare 记录',exact:true}).click();await expect(provider.getByRole('alert')).toBeVisible();await expect(remoteRow(protectedRow.id)).toBeVisible();await expect(provider).toContainText('同步诊断代码');
  assert.equal((await page.content()).includes(providerToken),false);assert.equal((await page.content()).includes('PRIVATE_CF_'),false);
  assert.equal(await page.evaluate(value=>Object.values(localStorage).concat(Object.values(sessionStorage)).some(item=>item.includes(value)),providerToken),false);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);
  console.log(`Cloudflare suppression browser QA passed: ${origin}, desktop1488x1056 / mobile390x844; screenshots: ${directory}`);
});
