import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const accountId='a'.repeat(32),domain='agent.example.com',providerToken='DECISION_EXPORT_CF_PRIVATE_TEST_TOKEN_abcdefghijklmnopqrstuvwxyz';
const bindings={EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain,
  WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})};
const json=async(runtime,path,options={},status=200)=>{const response=await runtime.request(path,options);assert.equal(response.status,status,await response.clone().text());return response.json();};
async function artifactDirectory(){const directory=process.env.ALERT_NOTIFICATION_EXPORT_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-alert-notification-export-qa-'));await mkdir(directory,{recursive:true});return directory;}
function csvRows(bytes){
  assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);const text=bytes.toString('utf8').slice(1),rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){const char=text[i];if(char==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(char===','&&!quoted){row.push(cell);cell='';}else if(char==='\r'&&!quoted&&text[i+1]==='\n'){row.push(cell);rows.push(row);row=[];cell='';i++;}else cell+=char;}
  assert.equal(quoted,false);assert.equal(cell,'');assert.equal(row.length,0);const headers=rows.shift();return rows.map(values=>{assert.equal(values.length,headers.length);return Object.fromEntries(headers.map((key,index)=>[key,values[index]]));});
}

test('Owner exports all applied decision filters to CSV/JSON with true statistics, safe downloads, visible failures and cancellation',{timeout:120_000},async t=>{
  // Browser plugin not available. Use the established Playwright/Chrome final-Worker workflow.
  const port=Number(process.env.ALERT_NOTIFICATION_EXPORT_E2E_PORT??4210),origin=`http://127.0.0.1:${port}`,calls=[],sent=[],errors=[],external=[],state={fail:true};
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings,outboundService:async request=>{
    const url=new URL(request.url);if(url.hostname==='hooks.example.net'){sent.push(await request.text());return new Response(null,{status:204});}
    assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(url.pathname,`/client/v4/accounts/${accountId}/email/sending/suppressions`);assert.equal(request.headers.get('Authorization'),`Bearer ${providerToken}`);calls.push(request.method);
    return state.fail?Response.json({success:false,errors:[{message:'PRIVATE_EXPORT_PROVIDER_ERROR'}]},{status:500}):Response.json({success:true,result:[],result_info:{next_cursor:null}});
  }});let browser;t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const box=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'导出记录 Agent',localPart:'export-records'}},201)).mailbox;
  const base=`/owner/api/mailboxes/${box.id}`,records=`${base}/alert-notification-decisions`,policyPath=`${base}/alert-notification-policy`,sourceId=randomUUID(),endpointIds=[],secrets=[];
  for(let i=0;i<2;i++){const endpoint=await json(runtime,`${base}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net/export-${i}?PRIVATE_EXPORT_ENDPOINT=${i}`,eventTypes:['cloudflare.suppression.alert.created','cloudflare.suppression.alert.resolved']}},201);endpointIds.push(endpoint.endpoint.id);secrets.push(endpoint.secret);}
  async function tick(){assert.equal((await (await runtime.mf.getWorker()).scheduled()).outcome,'ok');}
  async function savePolicy(changes){const {version,updatedAt,...fields}=(await json(runtime,policyPath)).policy;await json(runtime,policyPath,{method:'PATCH',body:{...fields,...changes,expectedVersion:version}});}
  async function failure(){await json(runtime,`${base}/cloudflare-suppressions/sync`,{method:'POST',body:{clientRequestId:randomUUID()}},502);}
  async function retry(success=false){await json(runtime,`${base}/cloudflare-suppressions/history/${sourceId}/retry`,{method:'POST',body:{kind:'sync',clientRequestId:randomUUID()}},success?200:502);}
  await json(runtime,`${base}/cloudflare-suppressions/sync`,{method:'POST',body:{clientRequestId:sourceId}},502);await tick();assert.equal(sent.length,2);
  await savePolicy({enabled:false});await failure();await tick();
  const minute=new Date().getUTCHours()*60+new Date().getUTCMinutes(),quiet={quietEnabled:true,quietStartMinute:(minute+1435)%1440,quietEndMinute:(minute+5)%1440,timeZone:'UTC'};
  await savePolicy({enabled:true,...quiet});await failure();await tick();await savePolicy({quietEnabled:false,recoveryEnabled:false,repeatIntervalSeconds:3600});await retry();await tick();state.fail=false;await retry(true);await tick();state.fail=true;
  for(const id of endpointIds){const endpoint=(await json(runtime,`${base}/webhooks`)).endpoints.find(value=>value.id===id);await json(runtime,`${base}/webhooks/${id}`,{method:'PATCH',body:{expectedUpdatedAt:endpoint.updatedAt,status:'disabled'}});}
  await failure();await tick();await savePolicy(quiet);for(let i=0;i<8;i++)await failure();await tick();
  const original=await json(runtime,records);assert.equal(original.summary.total,14);assert.equal(original.summary.delivery.succeeded,2);
  const counts=()=>runtime.db.prepare('SELECT (SELECT count(*) FROM alert_notification_decisions) decisions,(SELECT count(*) FROM webhook_deliveries) deliveries,(SELECT count(*) FROM webhook_delivery_attempts) attempts,(SELECT count(*) FROM audit_events) audits').first();
  const before=await counts(),beforeCalls=calls.length,directory=await artifactDirectory(),exportRequests=[],downloads=[];
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1488,height:1056},acceptDownloads:true});await context.route('**/*',async route=>{const request=route.request();if(new URL(request.url()).origin===origin){await route.continue({headers:{...request.headers(),'Cf-Access-Jwt-Assertion':runtime.jwt}});return;}external.push(request.url());await route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(['error','warning'].includes(message.type())&&!/413/.test(message.text()))errors.push(message.text());});page.on('download',download=>downloads.push(download));page.on('request',request=>{if(new URL(request.url()).pathname===`${records}/export`)exportRequests.push(new URL(request.url()));});
  await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions`);await expect(page).toHaveTitle('导出记录 Agent · 抑制名单 · Agent Mail');await expect(page.getByRole('heading',{name:'导出记录 Agent',exact:true})).toBeVisible();assert.equal(await page.locator('vite-error-overlay').count(),0);
  const panel=page.getByRole('region',{name:'通知决策与降噪',exact:true});await expect(panel.locator('[data-stat="total"]')).toHaveText('14');await panel.getByRole('button',{name:'查看通知决策',exact:true}).click();await panel.getByRole('combobox',{name:'通知决策每页条数',exact:true}).selectOption('10');await expect(panel.locator('li[data-decision-event]')).toHaveCount(10);
  const csvButton=panel.getByRole('button',{name:'导出 CSV',exact:true}),jsonButton=panel.getByRole('button',{name:'导出 JSON',exact:true}),exportPanel=panel.getByLabel('通知决策导出',{exact:true});
  async function download(format){const waiting=page.waitForEvent('download');await(format==='csv'?csvButton:jsonButton).click();const downloaded=await waiting;assert.equal(await downloaded.failure(),null);assert.match(downloaded.suggestedFilename(),new RegExp(`^alert-notification-decisions-${box.id}-\\d+-\\d+\\.${format}$`));const path=await downloaded.path();assert.ok(path);return readFile(path);}
  const rawJson=await download('json'),data=JSON.parse(rawJson);assert.equal(data.version,1);assert.equal(data.mailboxId,box.id);assert.deepEqual(data.filters,{decision:'all',eventType:'all'});assert.equal(data.decisions.length,14);assert.equal(data.summary.total,14);assert.equal(data.summary.allowed,1);assert.equal(data.summary.skipped,13);assert.equal(data.summary.byDecision.quiet_hours,9);assert.equal(data.summary.byDecision.repeat_limited,1);assert.equal(data.summary.delivery.succeeded,2);assert.equal(data.decisions.flatMap(item=>item.deliveries).length,2);
  const rawCsv=await download('csv'),csv=csvRows(rawCsv),summary=Object.fromEntries(csv.filter(row=>row.row_type==='summary').map(row=>[row.metric,row.value]));assert.equal(csv.filter(row=>row.row_type==='decision').length,14);assert.equal(csv.filter(row=>row.row_type==='delivery').length,2);assert.equal(summary.total,'14');assert.equal(summary['by_decision.quiet_hours'],'9');assert.equal(summary['delivery.succeeded'],'2');assert.deepEqual(csv.filter(row=>row.row_type==='decision').map(row=>row.event_id),data.decisions.map(item=>item.eventId));
  const filter=panel.getByRole('combobox',{name:'通知决策筛选',exact:true}),type=panel.getByRole('combobox',{name:'通知类型筛选',exact:true});await filter.selectOption('quiet_hours');await expect(panel.locator('[data-stat="total"]')).toHaveText('9');const filtered=JSON.parse(await download('json'));assert.equal(filtered.decisions.length,9);assert.equal(filtered.filters.decision,'quiet_hours');assert.ok(filtered.decisions.every(item=>item.decision==='quiet_hours'));assert.equal(filtered.summary.delivery.total,0);
  await filter.selectOption('all');await type.selectOption('resolved');await expect(panel.locator('[data-stat="total"]')).toHaveText('1');const recovery=JSON.parse(await download('json'));assert.equal(recovery.filters.eventType,'resolved');assert.equal(recovery.decisions.length,1);assert.equal(recovery.decisions[0].decision,'recovery_disabled');
  await type.selectOption('all');const start=panel.getByLabel('通知决策开始时间',{exact:true}),savedStart=await start.inputValue();await start.fill('2026-01-01T00:00');await expect(csvButton).toBeDisabled();await expect(jsonButton).toBeDisabled();await expect(exportPanel).toContainText('时间范围尚未查询');await start.fill(savedStart);await expect(csvButton).toBeEnabled();
  let mode='limit',holdRelease,holdStarted;await page.route(`**${records}/export?*`,async route=>{
    if(mode==='limit'){await route.fulfill({status:413,contentType:'application/json',body:JSON.stringify({error:{code:'alert_notification_export_too_large'}})});return;}
    if(mode==='login'){await route.fulfill({status:200,contentType:'text/html',body:'<html><script>window.UNTRUSTED_EXPORT_LOGIN=true</script>PRIVATE_LOGIN_CONTENT</html>'});return;}
    if(mode==='hold'){holdStarted?.();await new Promise(resolve=>holdRelease=resolve);try{await route.abort('aborted');}catch{}return;}
    await route.fallback();
  });
  const validDownloadCount=downloads.length;await csvButton.click();await expect(exportPanel.getByRole('alert')).toContainText('导出内容超过上限');await exportPanel.getByRole('alert').scrollIntoViewIfNeeded();await expect(exportPanel.getByRole('alert')).toBeInViewport();assert.equal(downloads.length,validDownloadCount);await page.screenshot({path:join(directory,'alert-export-limit-error.png'),fullPage:false});
  mode='login';await jsonButton.click();await expect(exportPanel.getByRole('alert')).toContainText('无法读取导出响应');assert.equal(await page.evaluate(()=>window.UNTRUSTED_EXPORT_LOGIN),undefined);assert.equal((await page.content()).includes('PRIVATE_LOGIN_CONTENT'),false);assert.equal(downloads.length,validDownloadCount);
  mode='hold';const started=new Promise(resolve=>holdStarted=resolve);await jsonButton.click();await started;await expect(panel.getByRole('button',{name:'取消导出',exact:true})).toBeVisible();await panel.getByRole('button',{name:'取消导出',exact:true}).click();await expect(exportPanel).toContainText('导出已取消');holdRelease?.();await expect(jsonButton).toBeEnabled();assert.equal(downloads.length,validDownloadCount);mode='normal';
  await exportPanel.evaluate(element=>element.scrollIntoView({block:'center',behavior:'instant'}));await page.screenshot({path:join(directory,'alert-export-desktop.png'),fullPage:false});await page.setViewportSize({width:390,height:844});await exportPanel.evaluate(element=>element.scrollIntoView({block:'center',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await expect(csvButton).toBeInViewport();await expect(jsonButton).toBeInViewport();await page.screenshot({path:join(directory,'alert-export-mobile.png'),fullPage:false});
  for(const request of exportRequests){assert.equal(request.searchParams.has('limit'),false);assert.equal(request.searchParams.has('cursor'),false);assert.ok(request.searchParams.has('from'));assert.ok(request.searchParams.has('to'));}
  assert.deepEqual(await counts(),before);assert.equal(calls.length,beforeCalls);assert.equal(sent.length,2);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);for(const marker of [providerToken,'PRIVATE_EXPORT_PROVIDER_ERROR','PRIVATE_EXPORT_ENDPOINT','claim_token','lease_token','signing_secret_ciphertext',...secrets]){assert.equal(rawJson.includes(marker),false);assert.equal(rawCsv.includes(marker),false);}
  console.log(`Alert decision export QA passed: ${origin}; desktop1488x1056/mobile390x844; screenshots: ${directory}`);
});
