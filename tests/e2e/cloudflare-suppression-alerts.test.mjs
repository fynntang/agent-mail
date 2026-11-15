import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const accountId='a'.repeat(32),domain='agent.example.com',providerToken='CF_ALERT_TOKEN_TEST_ONLY_abcdefghijklmnopqrstuvwxyz';
const bindings={EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain};
const providerPath=`/client/v4/accounts/${accountId}/email/sending/suppressions`;
const providerRecord=address=>({id:randomUUID(),email:address,reason:'manual',scope:{type:'account'},read_only:false,created_at:'2026-11-01T10:00:00Z',expires_at:null});
const json=async(runtime,path,options={},status=200)=>{const response=await runtime.request(path,options);assert.equal(response.status,status,await response.clone().text());return response.json();};
async function artifactDirectory(){const directory=process.env.CLOUDFLARE_SUPPRESSION_ALERTS_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-cloudflare-suppression-alerts-qa-'));await mkdir(directory,{recursive:true});return directory;}

function upstream(state){return async request=>{
  const url=new URL(request.url);assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(request.headers.get('Authorization'),`Bearer ${providerToken}`);
  for(const header of ['Cookie','Origin','Referer','Cf-Access-Jwt-Assertion'])assert.equal(request.headers.get(header),null,header);
  state.calls.push({method:request.method,path:url.pathname,search:url.search});
  if(url.pathname===providerPath){
    assert.equal(request.method,'GET');assert.equal(url.searchParams.get('per_page'),'100');
    const scope=url.searchParams.get('scope_type');assert.ok(['account','sending_domain'].includes(scope));if(scope==='sending_domain')assert.equal(url.searchParams.get('scope_value'),domain);
    if(state.failList)return Response.json({success:false,errors:[{message:'PRIVATE_ALERT_DIAGNOSTIC'}]},{status:500});
    return Response.json({success:true,result:state.rows.filter(row=>row.scope.type===scope),result_info:{next_cursor:null}});
  }
  const id=url.pathname.slice(providerPath.length+1),row=state.rows.find(row=>row.id===id);
  if(request.method==='GET')return row?Response.json({success:true,result:row}):Response.json({success:false,result:null},{status:404});
  assert.equal(request.method,'DELETE');assert.ok(row);assert.equal(row.read_only,false);state.deletes++;state.rows=state.rows.filter(row=>row.id!==id);
  if(state.unknownDelete)throw new Error('PRIVATE_ALERT_DIAGNOSTIC');return Response.json({success:true,result:{id}});
};}

async function browserFor(runtime,origin,errors,external,expectedHttpErrors=new Map()){
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  const browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1488,height:1056}});
  await context.route('**/*',async route=>{const request=route.request();if(new URL(request.url()).origin===origin){await route.continue({headers:{...request.headers(),'Cf-Access-Jwt-Assertion':runtime.jwt}});return;}external.push(request.url());await route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{
    if(!['error','warning'].includes(message.type()))return;let path='';try{path=new URL(message.location().url).pathname;}catch{}
    const expected=expectedHttpErrors.get(path);if(message.type()==='error'&&expected?.remaining>0&&message.text().includes(String(expected.status))){expected.remaining--;return;}errors.push(message.text());
  });return {browser,page};
}
async function summary(alerts,values){for(const [key,label] of [['open','待处理'],['acknowledged','已知悉'],['resolved','已解决']])await expect(alerts.getByRole('button',{name:`筛选${label}提醒`,exact:true})).toContainText(String(values[key]));}
function safe(value){const serialized=typeof value==='string'?value:JSON.stringify(value);for(const text of [providerToken,'PRIVATE_ALERT_DIAGNOSTIC','request_hash','lease_token'])assert.equal(serialized.includes(text),false,text);}

test('Owner alerts: CAS acknowledgement never calls Cloudflare; failure reopens, actual success resolves, and records paginate',{timeout:120_000},async t=>{
  const port=Number(process.env.CLOUDFLARE_SUPPRESSION_ALERTS_E2E_PORT??4207),origin=`http://127.0.0.1:${port}`,state={rows:[],calls:[],deletes:0,failList:true},errors=[],external=[];
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings,outboundService:upstream(state)});let browser;t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const box=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'运行提醒 Agent',localPart:'alert-sync'}},201)).mailbox,base=`/owner/api/mailboxes/${box.id}/cloudflare-suppressions`,alertBase=`/owner/api/mailboxes/${box.id}/cloudflare-suppression-alerts`,sourceId=randomUUID();
  await json(runtime,`${base}/sync`,{method:'POST',body:{clientRequestId:sourceId}},502);
  const initial=(await json(runtime,`${alertBase}?status=all`)).alerts[0];assert.equal(initial.outcome,'failed');
  const acknowledgePath=`${alertBase}/${initial.id}/acknowledge`,expectedHttpErrors=new Map([[acknowledgePath,{status:409,remaining:1}]]);
  const opened=await browserFor(runtime,origin,errors,external,expectedHttpErrors);browser=opened.browser;const {page}=opened,directory=await artifactDirectory();
  await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions`);await expect(page).toHaveTitle('运行提醒 Agent · 抑制名单 · Agent Mail');await expect(page.getByRole('heading',{level:1})).toBeInViewport();
  const alerts=page.getByRole('region',{name:'Cloudflare 运行提醒',exact:true}),globalNotice=page.locator('.suppression-alert-notice');
  await summary(alerts,{open:1,acknowledged:0,resolved:0});await expect(globalNotice).toContainText('1 项告警');assert.equal(await alerts.getAttribute('id'),'cloudflare-suppression-alerts');
  await alerts.getByRole('button',{name:'筛选待处理提醒',exact:true}).click();const row=alerts.locator(`[data-alert-id="${initial.id}"]`);await expect(row).toContainText('失败');
  await row.getByRole('button',{name:`确认已知悉 ${initial.id}`,exact:true}).click();const confirmation=page.getByRole('dialog',{name:'确认已知悉提醒',exact:true});await expect(confirmation).toContainText('不会重试、核对远端、删除记录或解除抑制');
  await json(runtime,`${base}/history/${sourceId}/retry`,{method:'POST',body:{kind:'sync',clientRequestId:randomUUID()}},502);const newer=(await json(runtime,`${alertBase}?status=all`)).alerts[0];assert.ok(newer.version>initial.version);
  const callsBeforeStale=state.calls.length,conflict=page.waitForResponse(response=>new URL(response.url()).pathname===acknowledgePath&&response.request().method()==='POST');
  await confirmation.getByRole('button',{name:'确认已知悉',exact:true}).click();assert.equal((await conflict).status(),409);await expect(confirmation.getByRole('alert')).toContainText('提醒已发生变化，请关闭并刷新后重新确认。');assert.equal(state.calls.length,callsBeforeStale);await expect(confirmation.getByRole('button',{name:'确认已知悉',exact:true})).toBeDisabled();
  await page.screenshot({path:join(directory,'cloudflare-alert-stale-confirm.png'),fullPage:false});await confirmation.getByRole('button',{name:'关闭并刷新提醒',exact:true}).click();await expect(confirmation).toHaveCount(0);
  await row.getByRole('button',{name:`确认已知悉 ${initial.id}`,exact:true}).click();const callsBeforeAck=state.calls.length,ackResponse=page.waitForResponse(response=>new URL(response.url()).pathname===acknowledgePath&&response.request().method()==='POST');
  await confirmation.getByRole('button',{name:'确认已知悉',exact:true}).click();const ack=await ackResponse;assert.equal(ack.status(),200);assert.equal(ack.request().postDataJSON().expectedVersion,newer.version);await expect(confirmation).toHaveCount(0);await summary(alerts,{open:0,acknowledged:1,resolved:0});await expect(globalNotice).toHaveCount(0);assert.equal(state.calls.length,callsBeforeAck,'Acknowledgement and layout refresh must be D1-only');
  await alerts.getByRole('button',{name:'筛选已知悉提醒',exact:true}).click();await expect(row).toContainText('已知悉');await expect(row.getByRole('button',{name:/^确认已知悉 /})).toHaveCount(0);
  await json(runtime,`${base}/history/${sourceId}/retry`,{method:'POST',body:{kind:'sync',clientRequestId:randomUUID()}},502);await alerts.getByRole('button',{name:'刷新提醒',exact:true}).click();await summary(alerts,{open:1,acknowledged:0,resolved:0});await expect(globalNotice).toContainText('1 项告警');
  await alerts.getByRole('button',{name:'筛选待处理提醒',exact:true}).click();await expect(row).toContainText('已触发 3 次');
  state.failList=false;await json(runtime,`${base}/history/${sourceId}/retry`,{method:'POST',body:{kind:'sync',clientRequestId:randomUUID()}});await alerts.getByRole('button',{name:'刷新提醒',exact:true}).click();await summary(alerts,{open:0,acknowledged:0,resolved:1});await expect(globalNotice).toHaveCount(0);
  await alerts.getByRole('button',{name:'筛选已解决提醒',exact:true}).click();await expect(row).toContainText('实际恢复');await row.getByRole('button',{name:`查看提醒 ${initial.id}`,exact:true}).click();const detail=page.getByRole('dialog',{name:'Cloudflare 提醒详情',exact:true});await expect(detail).toContainText('实际恢复');assert.equal(await detail.locator('ol>li').count(),4);await expect(detail.getByRole('button',{name:'确认已知悉',exact:true})).toHaveCount(0);await detail.getByRole('button',{name:'关闭对话框',exact:true}).click();
  state.failList=true;for(let index=0;index<11;index++)await json(runtime,`${base}/sync`,{method:'POST',body:{clientRequestId:randomUUID()}},502);
  await alerts.getByRole('button',{name:'筛选待处理提醒',exact:true}).click();await summary(alerts,{open:11,acknowledged:0,resolved:1});await expect(globalNotice).toContainText('11 项告警');await alerts.getByRole('combobox',{name:'提醒每页条数',exact:true}).selectOption('10');await expect(alerts.locator('[data-alert-id]')).toHaveCount(10);
  await alerts.getByRole('navigation',{name:'运行提醒分页',exact:true}).getByRole('button',{name:'下一页',exact:true}).click();await expect(alerts.locator('[data-alert-id]')).toHaveCount(1);await alerts.getByRole('navigation',{name:'运行提醒分页',exact:true}).getByRole('button',{name:'上一页',exact:true}).click();await expect(alerts.locator('[data-alert-id]')).toHaveCount(10);
  await alerts.getByRole('combobox',{name:'提醒类型',exact:true}).selectOption('release');await expect(alerts.locator('[data-alert-id]')).toHaveCount(0);await alerts.getByRole('combobox',{name:'提醒类型',exact:true}).selectOption('sync');await expect(alerts.locator('[data-alert-id]')).toHaveCount(10);
  await alerts.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));await page.screenshot({path:join(directory,'cloudflare-alert-sync-desktop.png'),fullPage:false});await page.setViewportSize({width:390,height:844});await alerts.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,'cloudflare-alert-sync-mobile.png'),fullPage:false});
  assert.equal(state.deletes,0);assert.equal(expectedHttpErrors.get(acknowledgePath).remaining,0);safe(await page.content());assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);console.log(`Cloudflare sync-alert QA passed: ${origin}; screenshots: ${directory}`);
});

test('Owner unknown alert: acknowledging preserves local policy and only GET reconciliation confirms absence and resolves the incident',{timeout:120_000},async t=>{
  const port=Number(process.env.CLOUDFLARE_SUPPRESSION_ALERTS_E2E_PORT??4207),origin=`http://127.0.0.1:${port}`,remote=providerRecord('unknown-alert@example.net'),state={rows:[remote],calls:[],deletes:0,unknownDelete:true},errors=[],external=[];
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings,outboundService:upstream(state)});let browser;t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const box=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'未知结果提醒 Agent',localPart:'alert-unknown'}},201)).mailbox,base=`/owner/api/mailboxes/${box.id}/cloudflare-suppressions`,alertBase=`/owner/api/mailboxes/${box.id}/cloudflare-suppression-alerts`,localId=randomUUID(),now=Date.now();
  await runtime.db.prepare(`INSERT INTO recipient_suppressions(id,mailbox_id,address,reason,last_event_at,last_event_id,created_at,updated_at) VALUES(?,?,?,'hard_bounce',?,'fixture:alert-browser',?,?)`).bind(localId,box.id,remote.email,now-1000,now,now).run();
  await json(runtime,`${base}/sync`,{method:'POST',body:{clientRequestId:randomUUID()}});const snapshot=(await json(runtime,base)).suppressions[0];
  const lost=await json(runtime,`${base}/${remote.id}/release`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:snapshot.version,confirmationAddress:remote.email,confirmationScope:'account',releaseLocal:true,expectedLocalVersion:1}},202);assert.equal(lost.remoteStatus,'unknown');assert.equal(lost.localStatus,'pending');assert.equal(state.deletes,1);
  const initial=(await json(runtime,`${alertBase}?status=all`)).alerts[0];assert.equal(initial.kind,'release');assert.equal(initial.outcome,'unknown');assert.equal(initial.source.sourceId,lost.operationId);
  const opened=await browserFor(runtime,origin,errors,external);browser=opened.browser;const {page}=opened,directory=await artifactDirectory();await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions`);await expect(page).toHaveTitle('未知结果提醒 Agent · 抑制名单 · Agent Mail');
  const alerts=page.getByRole('region',{name:'Cloudflare 运行提醒',exact:true}),row=alerts.locator(`[data-alert-id="${initial.id}"]`);await alerts.getByRole('button',{name:'筛选待处理提醒',exact:true}).click();await expect(row).toContainText('结果未知');await expect(row).toContainText('不会自动重复删除');
  await row.getByRole('button',{name:`查看提醒 ${initial.id}`,exact:true}).click();const alertDetail=page.getByRole('dialog',{name:'Cloudflare 提醒详情',exact:true});await expect(alertDetail).toContainText('结果未知');await expect(alertDetail.locator('ol>li')).toHaveCount(1);await page.screenshot({path:join(directory,'cloudflare-alert-unknown-details.png'),fullPage:false});await alertDetail.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await row.getByRole('button',{name:`确认已知悉 ${initial.id}`,exact:true}).click();const confirmation=page.getByRole('dialog',{name:'确认已知悉提醒',exact:true}),callsBeforeAck=state.calls.length;await confirmation.getByRole('button',{name:'确认已知悉',exact:true}).click();await expect(confirmation).toHaveCount(0);await summary(alerts,{open:0,acknowledged:1,resolved:0});await expect(page.locator('.suppression-alert-notice')).toHaveCount(0);assert.equal(state.calls.length,callsBeforeAck);assert.equal(state.deletes,1);assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(localId).first('status'),'active');
  await alerts.getByRole('button',{name:'筛选已知悉提醒',exact:true}).click();const callsBeforeView=state.calls.length;await row.getByRole('link',{name:`查看关联历史 ${initial.id}`,exact:true}).click();const source=page.getByRole('dialog',{name:'Cloudflare 操作详情',exact:true});await expect(source).toContainText(lost.operationId);await expect(source).toContainText('核对只读取 Cloudflare');assert.equal(state.calls.length,callsBeforeView);await expect(source.getByRole('button',{name:'重新确认解除',exact:true})).toHaveCount(0);
  const reconciledResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`${base}/history/${lost.operationId}/reconcile`&&response.request().method()==='POST');await source.getByRole('button',{name:'核对远端结果',exact:true}).click();const reconciled=await reconciledResponse;assert.equal(reconciled.status(),200);assert.equal((await reconciled.json()).operation.remoteStatus,'already_absent');await expect(source).toContainText('已确认远端不存在');await source.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await summary(alerts,{open:0,acknowledged:0,resolved:1});await alerts.getByRole('button',{name:'筛选已解决提醒',exact:true}).click();await expect(row).toContainText('实际恢复');assert.equal(state.calls.slice(callsBeforeView).length,1);assert.equal(state.calls.at(-1).method,'GET');assert.equal(state.deletes,1);assert.equal(await runtime.db.prepare('SELECT status FROM recipient_suppressions WHERE id=?').bind(localId).first('status'),'active');
  await row.getByRole('button',{name:`查看提醒 ${initial.id}`,exact:true}).click();await expect(alertDetail.locator('ol>li')).toHaveCount(2);await expect(alertDetail).toContainText('实际恢复');await alertDetail.getByRole('button',{name:'关闭对话框',exact:true}).click();
  const callsBeforeDeepLink=state.calls.length;await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions?historyKind=release&historyId=${lost.operationId}`);await expect(source).toContainText(lost.operationId);assert.equal(state.calls.length,callsBeforeDeepLink,'Source deep links must only read persisted history');await source.getByRole('button',{name:'关闭对话框',exact:true}).click();
  await alerts.getByRole('button',{name:'筛选已解决提醒',exact:true}).click();await alerts.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));await page.screenshot({path:join(directory,'cloudflare-alert-resolved-desktop.png'),fullPage:false});await page.setViewportSize({width:390,height:844});await alerts.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,'cloudflare-alert-resolved-mobile.png'),fullPage:false});
  safe(await page.content());assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);console.log(`Cloudflare unknown-alert QA passed: ${origin}; screenshots: ${directory}`);
});
