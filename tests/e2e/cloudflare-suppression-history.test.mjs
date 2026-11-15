import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const accountId='a'.repeat(32),domain='agent.example.com',providerToken='CF_HISTORY_TOKEN_TEST_ONLY_abcdefghijklmnopqrstuvwxyz';
const providerPath=`/client/v4/accounts/${accountId}/email/sending/suppressions`;
const bindings={EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain};
const providerRecord=address=>({id:randomUUID(),email:address,reason:'hard_bounce',scope:{type:'sending_domain',value:domain},read_only:false,created_at:'2026-11-01T10:00:00Z',expires_at:null});

async function browserFor(runtime,origin,errors,external,expectedHttpErrors=new Map()) {
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  const browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1488,height:1056}});
  await context.route('**/*',async route=>{const request=route.request();if(new URL(request.url()).origin===origin){await route.continue({headers:{...request.headers(),'Cf-Access-Jwt-Assertion':runtime.jwt}});return;}external.push(request.url());await route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{
    if(!['error','warning'].includes(message.type()))return;
    let path='';try{path=new URL(message.location().url).pathname;}catch{}
    const expected=expectedHttpErrors.get(path);
    if(message.type()==='error'&&expected?.remaining>0&&message.text().includes(String(expected.status))){expected.remaining--;return;}
    errors.push(message.text());
  });return {browser,page,context};
}

function upstream(state) {return async request=>{
  const url=new URL(request.url);assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(request.headers.get('Authorization'),`Bearer ${providerToken}`);
  for(const header of ['Cookie','Origin','Referer','Cf-Access-Jwt-Assertion'])assert.equal(request.headers.get(header),null);
  state.calls.push({method:request.method,path:url.pathname,search:url.search});
  if(url.pathname===providerPath){
    assert.equal(request.method,'GET');assert.equal(url.searchParams.get('per_page'),'100');
    if(state.failList)return Response.json({success:false,errors:[{message:'PRIVATE_HISTORY_DIAGNOSTIC'}]},{status:500});
    const scope=url.searchParams.get('scope_type');assert.ok(['account','sending_domain'].includes(scope));if(scope==='sending_domain')assert.equal(url.searchParams.get('scope_value'),domain);
    return Response.json({success:true,result:state.rows.filter(row=>row.scope.type===scope),result_info:{next_cursor:null}});
  }
  const id=url.pathname.slice(providerPath.length+1),row=state.rows.find(row=>row.id===id);
  if(request.method==='GET'){
    if(state.failGetOnce){state.failGetOnce=false;return Response.json({success:false,errors:[{message:'PRIVATE_HISTORY_DIAGNOSTIC'}]},{status:503});}
    return row?Response.json({success:true,result:row}):Response.json({success:false,result:null},{status:404});
  }
  assert.equal(request.method,'DELETE');assert.ok(row);assert.equal(row.read_only,false);state.deletes++;state.rows=state.rows.filter(row=>row.id!==id);return Response.json({success:true,result:{id}});
};}
const json=async(runtime,path,options={},status=200)=>{const response=await runtime.request(path,options);assert.equal(response.status,status,await response.clone().text());return response.json();};

test('Owner history: failed sync pagination remains readable without token and an explicit retry creates a new parent-linked run',{timeout:120_000},async t=>{
  const port=Number(process.env.CLOUDFLARE_SUPPRESSION_HISTORY_E2E_PORT??4206),origin=`http://127.0.0.1:${port}`,state={rows:[providerRecord('history-sync@example.net')],calls:[],deletes:0,failList:true},errors=[],external=[];
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings,outboundService:upstream(state)});let browser;t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const box=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'同步历史 Agent',localPart:'sync-history'}},201)).mailbox,base=`/owner/api/mailboxes/${box.id}/cloudflare-suppressions`;
  for(let index=0;index<11;index++)assert.equal((await runtime.request(`${base}/sync`,{method:'POST',body:{clientRequestId:randomUUID()}})).status,502);
  state.failList=false;await runtime.updateBindings({EMAIL_SUPPRESSIONS_API_TOKEN:''});
  const opened=await browserFor(runtime,origin,errors,external);browser=opened.browser;const {page}=opened;
  await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions`);await expect(page).toHaveTitle('同步历史 Agent · 抑制名单 · Agent Mail');await expect(page.getByRole('heading',{level:1})).toBeInViewport();
  const history=page.getByRole('region',{name:'Cloudflare 操作历史',exact:true});
  await expect(page.getByRole('region',{name:'Cloudflare 服务端抑制',exact:true})).toContainText('尚未配置');
  await expect(history.locator('[data-history-id]')).toHaveCount(11);await expect(history.getByRole('button',{name:/^重新同步 /})).toHaveCount(0);
  await history.getByRole('combobox',{name:'Cloudflare 历史每页条数',exact:true}).selectOption('10');await expect(history.locator('[data-history-id]')).toHaveCount(10);
  await history.getByRole('button',{name:'下一页',exact:true}).click();await expect(history.locator('[data-history-id]')).toHaveCount(1);
  await history.getByRole('button',{name:'上一页',exact:true}).click();await expect(history.locator('[data-history-id]')).toHaveCount(10);
  const failedId=await history.locator('[data-history-id]').first().getAttribute('data-history-id');assert.ok(failedId);
  await runtime.updateBindings({EMAIL_SUPPRESSIONS_API_TOKEN:providerToken});await history.getByRole('button',{name:'刷新历史',exact:true}).click();
  const row=history.locator(`[data-history-id="${failedId}"]`),callsBeforeView=state.calls.length;
  await row.getByRole('button',{name:`查看同步记录 ${failedId}`,exact:true}).click();const detail=page.getByRole('dialog',{name:'Cloudflare 操作详情',exact:true});
  await expect(detail).toContainText('Owner 手动同步');await expect(detail).toContainText('cloudflare_api_unavailable');assert.ok(await detail.locator('.cf-history-timeline>li').count());assert.equal(state.calls.length,callsBeforeView,'History reads must not call the provider');
  const retryResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`${base}/history/${failedId}/retry`&&response.request().method()==='POST');
  await detail.getByRole('button',{name:'重新同步此记录',exact:true}).click();const retried=await retryResponse;assert.equal(retried.status(),200);const result=await retried.json();
  assert.notEqual(result.runId,failedId);const intent=retried.request().postDataJSON();assert.equal(intent.kind,'sync');assert.match(intent.clientRequestId,/^[0-9a-f-]{36}$/);
  await expect(detail).toHaveCount(0);await expect(history.getByRole('status')).toContainText('重新同步已完成');
  const child=await json(runtime,`${base}/history/${result.runId}?kind=sync`);assert.equal(child.item.retryOf,failedId);assert.equal(child.item.canRetry,false);assert.equal(child.item.state,'succeeded');
  const success=history.locator(`[data-history-id="${result.runId}"]`);await expect(success).toContainText('已完成');await expect(success.getByRole('button',{name:/^重新同步 /})).toHaveCount(0);
  const directory=await artifactDirectory();await history.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));await page.screenshot({path:join(directory,'cloudflare-history-sync-desktop.png'),fullPage:false});
  await page.setViewportSize({width:390,height:844});await history.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,'cloudflare-history-sync-mobile.png'),fullPage:false});
  assert.equal(state.deletes,0);assert.equal(state.calls.every(call=>call.method==='GET'),true);assert.equal((await page.content()).includes(providerToken),false);assert.equal((await page.content()).includes('PRIVATE_HISTORY_DIAGNOSTIC'),false);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);
  console.log(`Cloudflare sync-history QA passed: ${origin}; screenshots: ${directory}`);
});

test('Owner history: aged unknown is reconciled with GET only before a fresh confirmed retry; successful and readOnly records cannot retry',{timeout:120_000},async t=>{
  const port=Number(process.env.CLOUDFLARE_SUPPRESSION_HISTORY_E2E_PORT??4206),origin=`http://127.0.0.1:${port}`;
  const remote={...providerRecord('history-release@example.net'),scope:{type:'account'}},protectedRow={...providerRecord('history-readonly@example.net'),scope:{type:'account'},read_only:true};
  const state={rows:[remote,protectedRow],calls:[],deletes:0,failList:false,failGetOnce:false},errors=[],external=[];
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings,outboundService:upstream(state)});let browser;t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const box=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'解除历史 Agent',localPart:'release-history'}},201)).mailbox,base=`/owner/api/mailboxes/${box.id}/cloudflare-suppressions`;
  const old=Date.now()-180_000,localId=randomUUID(),parentId=randomUUID(),protectedId=randomUUID();
  await runtime.db.prepare(`INSERT INTO recipient_suppressions(id,mailbox_id,address,reason,last_event_at,last_event_id,created_at,updated_at) VALUES(?,?,?,'hard_bounce',?,'fixture:history-browser',?,?)`).bind(localId,box.id,remote.email,old,old,old).run();
  await json(runtime,`${base}/sync`,{method:'POST',body:{clientRequestId:randomUUID()}});const cached=await json(runtime,base),snapshot=cached.suppressions.find(row=>row.id===remote.id),protectedSnapshot=cached.suppressions.find(row=>row.id===protectedRow.id);assert.ok(snapshot&&protectedSnapshot);
  await runtime.db.prepare(`INSERT INTO cloudflare_suppression_operations(id,request_hash,account_id,domain,mailbox_id,remote_id,address,scope_type,scope_value,version_hash,release_local,local_id,local_version,state,remote_status,local_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'account','',?,1,?,1,'unknown','unknown','pending',?,?)`).bind(parentId,'0'.repeat(64),accountId,domain,box.id,remote.id,remote.email,snapshot.version,localId,old,old).run();
  await runtime.db.prepare(`INSERT INTO cloudflare_suppression_operations(id,request_hash,account_id,domain,mailbox_id,remote_id,address,scope_type,scope_value,version_hash,release_local,state,remote_status,local_status,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'account','',?,0,'failed','failed','not_requested','cloudflare_api_rejected',?,?)`).bind(protectedId,'1'.repeat(64),accountId,domain,box.id,protectedRow.id,protectedRow.email,protectedSnapshot.version,old+1,old+1).run();
  const expectedHttpErrors=new Map([[`${base}/history/${parentId}/reconcile`,{status:502,remaining:1}]]);
  const opened=await browserFor(runtime,origin,errors,external,expectedHttpErrors);browser=opened.browser;const {page}=opened;
  await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions`);await expect(page).toHaveTitle('解除历史 Agent · 抑制名单 · Agent Mail');
  const history=page.getByRole('region',{name:'Cloudflare 操作历史',exact:true});await history.getByRole('group',{name:'Cloudflare 历史类型',exact:true}).getByRole('button',{name:'解除记录',exact:true}).click();
  const parent=history.locator(`[data-history-id="${parentId}"]`),protectedHistory=history.locator(`[data-history-id="${protectedId}"]`);
  await expect(parent).toContainText('结果未知');await expect(parent.getByRole('button',{name:`重新确认解除 ${parentId}`,exact:true})).toHaveCount(0);await expect(protectedHistory.getByRole('button',{name:/^重新确认解除 /})).toHaveCount(0);
  const directory=await artifactDirectory(),callsBefore=state.calls.length;await parent.getByRole('button',{name:`查看解除记录 ${parentId}`,exact:true}).click();const detail=page.getByRole('dialog',{name:'Cloudflare 操作详情',exact:true});await expect(detail).toContainText('核对只读取 Cloudflare');assert.equal(state.calls.length,callsBefore);
  state.failGetOnce=true;remote.reason='manual';
  const failedCheck=page.waitForResponse(response=>new URL(response.url()).pathname===`${base}/history/${parentId}/reconcile`&&response.request().method()==='POST');
  await detail.getByRole('button',{name:'核对远端结果',exact:true}).click();const failed=await failedCheck;assert.equal(failed.status(),502);
  await expect(detail.getByRole('alert')).toBeVisible();assert.equal((await detail.textContent()).includes('PRIVATE_HISTORY_DIAGNOSTIC'),false);assert.equal(state.deletes,0);assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(localId).first('status'),'active');
  await page.screenshot({path:join(directory,'cloudflare-history-unknown-details.png'),fullPage:false});
  const repeatedCheck=page.waitForResponse(response=>new URL(response.url()).pathname===`${base}/history/${parentId}/reconcile`&&response.request().method()==='POST');
  await detail.getByRole('button',{name:'核对远端结果',exact:true}).click();const reconciled=await repeatedCheck;assert.equal(reconciled.status(),200);assert.notEqual(reconciled.request().postDataJSON().clientRequestId,failed.request().postDataJSON().clientRequestId);
  await expect(detail.getByRole('button',{name:'重新确认解除',exact:true})).toBeVisible();await expect(detail.getByRole('alert')).toHaveCount(0);await detail.getByRole('button',{name:'关闭对话框',exact:true}).click();
  const reconciliationCalls=state.calls.slice(callsBefore);assert.equal(reconciliationCalls.length,2);assert.equal(reconciliationCalls.every(call=>call.method==='GET'),true);assert.equal(state.deletes,0);assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(localId).first('status'),'active');
  await runtime.db.prepare('UPDATE recipient_suppressions SET version=version+1,last_event_at=last_event_at+1,updated_at=updated_at+1 WHERE id=?').bind(localId).run();
  const freshContext=await json(runtime,`${base}/history/${parentId}?kind=release`);assert.notEqual(freshContext.item.current.version,snapshot.version);assert.equal(freshContext.item.current.localSuppression.version,2);
  await parent.getByRole('button',{name:`重新确认解除 ${parentId}`,exact:true}).click();const confirmation=page.getByRole('dialog',{name:'重新确认 Cloudflare 解除操作',exact:true}),submit=confirmation.getByRole('button',{name:'确认新的解除操作',exact:true});
  await expect(confirmation).toContainText('按当前服务端快照重新校验');await expect(submit).toBeDisabled();await confirmation.getByRole('textbox',{name:'输入完整收件地址以重新确认',exact:true}).fill(remote.email);await expect(submit).toBeDisabled();
  await confirmation.getByRole('checkbox',{name:'我确认此次新操作影响 Cloudflare 账户的所有发信域。',exact:true}).check();await confirmation.getByRole('checkbox',{name:'同时解除当前邮箱匹配的本地抑制',exact:true}).check();
  await page.screenshot({path:join(directory,'cloudflare-history-release-confirm-desktop.png'),fullPage:false});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,'cloudflare-history-release-confirm-mobile.png'),fullPage:false});
  const retryResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`${base}/history/${parentId}/retry`&&response.request().method()==='POST');await submit.click();const retried=await retryResponse;assert.equal(retried.status(),200);const result=await retried.json(),intent=retried.request().postDataJSON();
  assert.equal(intent.kind,'release');assert.notEqual(intent.clientRequestId,parentId);assert.match(intent.clientRequestId,/^[0-9a-f-]{36}$/);assert.equal(intent.confirmationAddress,remote.email);assert.equal(intent.confirmationScope,'account');assert.equal(intent.expectedVersion,freshContext.item.current.version);assert.equal(intent.expectedLocalVersion,2);
  await expect(confirmation).toHaveCount(0);assert.equal(result.remoteStatus,'deleted');assert.equal(result.localStatus,'released');assert.equal(state.deletes,1);
  const child=await json(runtime,`${base}/history/${result.operationId}?kind=release`);assert.equal(child.item.retryOf,parentId);assert.equal(child.item.canRetry,false);assert.equal(child.item.canReconcile,false);
  const success=history.locator(`[data-history-id="${result.operationId}"]`);await expect(success).toContainText('远端已解除');await expect(success.getByRole('button',{name:/^重新确认解除 /})).toHaveCount(0);
  assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(localId).first('status'),'released');
  await history.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,'cloudflare-history-release-mobile.png'),fullPage:false});
  assert.equal((await page.content()).includes(providerToken),false);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);
  console.log(`Cloudflare release-history QA passed: ${origin}; screenshots: ${directory}`);
});

async function artifactDirectory() {
  const directory=process.env.CLOUDFLARE_SUPPRESSION_HISTORY_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-cloudflare-suppression-history-qa-'));
  await mkdir(directory,{recursive:true});return directory;
}
