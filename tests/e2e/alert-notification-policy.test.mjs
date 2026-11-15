import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const accountId='a'.repeat(32),domain='agent.example.com',providerToken='CF_POLICY_TOKEN_TEST_ONLY_abcdefghijklmnopqrstuvwxyz';
const bindings={EMAIL_SUPPRESSIONS_API_TOKEN:providerToken,EMAIL_SUPPRESSIONS_ACCOUNT_ID:accountId,EMAIL_SUPPRESSIONS_DOMAIN:domain};
const json=async(runtime,path,options={},status=200)=>{const response=await runtime.request(path,options);assert.equal(response.status,status,await response.clone().text());return response.json();};
async function artifactDirectory(){const directory=process.env.ALERT_NOTIFICATION_POLICY_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-alert-notification-policy-qa-'));await mkdir(directory,{recursive:true});return directory;}

test('Owner policy controls persist per mailbox, expose safe CAS refresh, and retain alerts while notifications are muted',{timeout:120_000},async t=>{
  // Browser plugin not available. Exercise the final Worker with the repository's Playwright/Chrome flow.
  const port=Number(process.env.ALERT_NOTIFICATION_POLICY_E2E_PORT??4208),origin=`http://127.0.0.1:${port}`,calls=[],errors=[],external=[],expectedHttpErrors=new Map([[400,1],[409,1]]);
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings,outboundService:async request=>{
    const url=new URL(request.url);assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(url.pathname,`/client/v4/accounts/${accountId}/email/sending/suppressions`);assert.equal(request.headers.get('Authorization'),`Bearer ${providerToken}`);calls.push(request.method);
    return Response.json({success:false,errors:[{message:'PRIVATE_POLICY_DIAGNOSTIC'}]},{status:500});
  }});let browser;t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const box=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'通知策略 Agent',localPart:'policy-agent'}},201)).mailbox;
  const other=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'其他 Agent',localPart:'policy-other'}},201)).mailbox;
  const policyPath=`/owner/api/mailboxes/${box.id}/alert-notification-policy`,alertPath=`/owner/api/mailboxes/${box.id}/cloudflare-suppression-alerts`;
  await json(runtime,`/owner/api/mailboxes/${box.id}/cloudflare-suppressions/sync`,{method:'POST',body:{clientRequestId:randomUUID()}},502);assert.equal(calls.length,1);
  const beforeAlerts=await json(runtime,`${alertPath}?status=all`);assert.equal(beforeAlerts.summary.open,1);const alertId=beforeAlerts.alerts[0].id;
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1488,height:1056}});
  await context.route('**/*',async route=>{const request=route.request();if(new URL(request.url()).origin===origin){await route.continue({headers:{...request.headers(),'Cf-Access-Jwt-Assertion':runtime.jwt}});return;}external.push(request.url());await route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{
    if(!['error','warning'].includes(message.type()))return;let path='';try{path=new URL(message.location().url).pathname;}catch{}
    const expected=[...expectedHttpErrors.entries()].find(([status,remaining])=>remaining>0&&message.type()==='error'&&path===policyPath&&message.text().includes(String(status)));
    if(expected){expectedHttpErrors.set(expected[0],expected[1]-1);return;}errors.push(message.text());
  });
  const patches=[];page.on('request',request=>{if(request.method()==='PATCH'&&new URL(request.url()).pathname===policyPath)patches.push(request.postDataJSON());});
  await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions`);assert.equal(new URL(page.url()).pathname,`/owner/mailboxes/${box.id}/suppressions`);await expect(page).toHaveTitle('通知策略 Agent · 抑制名单 · Agent Mail');await expect(page.getByRole('heading',{name:'通知策略 Agent',exact:true})).toBeVisible();
  const panel=page.locator('.alert-policy'),alerts=page.getByRole('region',{name:'Cloudflare 运行提醒',exact:true});await expect(panel).toContainText('通知已开启');await expect(panel).toContainText('重复提醒不限频');await expect(page.locator('.suppression-alert-notice')).toContainText('1 项告警');
  const directory=await artifactDirectory();await page.screenshot({path:join(directory,'alert-policy-overview-desktop.png'),fullPage:false});
  await panel.getByRole('button',{name:'配置通知策略',exact:true}).click();const form=panel.getByRole('form',{name:'告警通知策略设置',exact:true});
  await expect(form).toContainText('仅影响此邮箱的告警 Webhook');await expect(form).toContainText('已有待投递通知在静默期顺延');
  const enabled=form.getByRole('checkbox',{name:'开启告警 Webhook 通知',exact:true}),recovery=form.getByRole('checkbox',{name:'发送恢复通知',exact:true}),quiet=form.getByRole('checkbox',{name:'启用每日静默时段',exact:true});
  const repeat=form.getByLabel('重复提醒间隔（秒）',{exact:true}),zone=form.getByLabel('静默时区',{exact:true}),start=form.getByLabel('静默开始',{exact:true}),end=form.getByLabel('静默结束',{exact:true});
  await expect(enabled).toBeChecked();await expect(recovery).toBeChecked();await expect(quiet).not.toBeChecked();await expect(start).toBeDisabled();await expect(end).toHaveValue('08:00');
  await enabled.uncheck();await recovery.uncheck();await quiet.check();await repeat.fill('1800');await zone.fill('Asia/Shanghai');await start.fill('22:00');await end.fill('08:00');
  const save=()=>page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname===policyPath);
  let savedResponse=save();await form.getByRole('button',{name:'保存通知策略',exact:true}).click();assert.equal((await savedResponse).status(),200);await expect(panel.getByRole('status')).toContainText('通知策略已保存');
  await expect(panel).toContainText('通知已关闭');await expect(panel).toContainText('不发送恢复通知');await expect(panel).toContainText('重复提醒间隔 30 分钟');await expect(panel).toContainText('每日静默 22:00–08:00 · Asia/Shanghai');
  const stored=(await json(runtime,policyPath)).policy;assert.equal(stored.enabled,false);assert.equal(stored.recoveryEnabled,false);assert.equal(stored.repeatIntervalSeconds,1800);assert.equal(stored.quietStartMinute,1320);assert.equal(stored.quietEndMinute,480);assert.equal(stored.timeZone,'Asia/Shanghai');assert.equal(stored.version,1);assert.equal(patches[0].expectedVersion,0);
  assert.equal((await json(runtime,`/owner/api/mailboxes/${other.id}/alert-notification-policy`)).policy.version,0);assert.equal(calls.length,1,'Policy reads and writes must not call Cloudflare');
  await page.reload();await expect(panel).toContainText('通知已关闭');await panel.getByRole('button',{name:'配置通知策略',exact:true}).click();await expect(enabled).not.toBeChecked();await expect(recovery).not.toBeChecked();await expect(quiet).toBeChecked();await expect(repeat).toHaveValue('1800');await expect(zone).toHaveValue('Asia/Shanghai');
  await form.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));await page.screenshot({path:join(directory,'alert-policy-settings-desktop.png'),fullPage:false});
  await page.setViewportSize({width:390,height:844});await form.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,'alert-policy-settings-mobile.png'),fullPage:false});await page.setViewportSize({width:1488,height:1056});
  const {version,updatedAt,...fields}=stored;await json(runtime,policyPath,{method:'PATCH',body:{...fields,enabled:true,repeatIntervalSeconds:3600,expectedVersion:version}});
  await repeat.fill('900');savedResponse=save();await form.getByRole('button',{name:'保存通知策略',exact:true}).click();assert.equal((await savedResponse).status(),409);await expect(panel.getByRole('alert')).toContainText('通知策略已变化，请重新读取后核对并保存。');await expect(form.getByRole('button',{name:'保存通知策略',exact:true})).toBeDisabled();
  await panel.getByRole('alert').scrollIntoViewIfNeeded();await expect(panel.getByRole('alert')).toBeInViewport();await page.screenshot({path:join(directory,'alert-policy-stale-cas-desktop.png'),fullPage:false});
  await form.getByRole('button',{name:'重新读取策略',exact:true}).click();await expect(enabled).toBeChecked();await expect(repeat).toHaveValue('3600');await expect(panel.getByRole('alert')).toHaveCount(0);
  await zone.fill('Invalid/Nowhere');savedResponse=save();await form.getByRole('button',{name:'保存通知策略',exact:true}).click();assert.equal((await savedResponse).status(),400);await expect(panel.getByRole('alert')).toContainText('通知策略无效');await zone.fill('UTC');
  await start.fill('08:00');const beforeInvalid=patches.length;await form.getByRole('button',{name:'保存通知策略',exact:true}).click();await expect(panel.getByRole('alert')).toContainText('开始与结束时间不能相同');assert.equal(patches.length,beforeInvalid,'Invalid equal window must not be submitted');
  await start.fill('23:00');await end.fill('07:30');await recovery.check();await repeat.fill('300');savedResponse=save();await form.getByRole('button',{name:'保存通知策略',exact:true}).click();assert.equal((await savedResponse).status(),200);await expect(panel.getByRole('status')).toContainText('通知策略已保存');
  const current=(await json(runtime,policyPath)).policy;assert.equal(current.version,3);assert.equal(current.enabled,true);assert.equal(current.recoveryEnabled,true);assert.equal(current.repeatIntervalSeconds,300);assert.equal(current.timeZone,'UTC');assert.equal(current.quietStartMinute,1380);assert.equal(current.quietEndMinute,450);assert.equal(patches.at(-1).expectedVersion,2);
  await alerts.getByRole('button',{name:'筛选待处理提醒',exact:true}).click();await expect(alerts.locator(`[data-alert-id="${alertId}"]`)).toContainText('失败');await expect(page.locator('.suppression-alert-notice')).toContainText('1 项告警');const afterAlerts=await json(runtime,`${alertPath}?status=all`);assert.deepEqual(afterAlerts,beforeAlerts);
  assert.equal(calls.length,1);assert.deepEqual([...expectedHttpErrors.values()],[0,0]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);const html=await page.content();for(const privateValue of [providerToken,'PRIVATE_POLICY_DIAGNOSTIC','request_hash','lease_token'])assert.equal(html.includes(privateValue),false);
  console.log(`Alert notification policy QA passed: ${origin}; desktop1488x1056/mobile390x844; screenshots: ${directory}`);
});
