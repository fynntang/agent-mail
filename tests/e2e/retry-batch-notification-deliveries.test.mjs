import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

const json=async(runtime,path,options={},status=200)=>{const response=await runtime.request(path,options);assert.equal(response.status,status,await response.clone().text());return response.json();};
const keyring=JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}});

test('Owner tracks batch notification decisions and deliveries, safely replays lost manual retry responses and preserves signed transport history',{timeout:120_000},async t=>{
  // Browser plugin not available. Reuse the established Playwright/Chrome final-Worker workflow.
  const port=Number(process.env.RETRY_BATCH_NOTIFICATION_DELIVERIES_E2E_PORT??4217),origin=`http://127.0.0.1:${port}`;
  const errors=[],external=[],unexpected=[],received=[],secrets=new Map();let responseStatus=400,expectedConflicts=1,expectedAborts=1;
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings:{WEBHOOK_KEYRING:keyring},outboundService:async request=>{
    const url=new URL(request.url),secret=secrets.get(url.pathname);if(url.hostname!=='hooks.example.net'||!secret){unexpected.push(request.url);return new Response(null,{status:502});}
    const body=await request.text(),headers=Object.fromEntries(request.headers),signature=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(headers['x-agent-mail-signature']??'');
    assert.ok(signature);assert.equal(signature[2],createHmac('sha256',secret).update(`${signature[1]}.${headers['x-agent-mail-delivery']}.${body}`).digest('hex'));
    for(const name of ['authorization','cookie','cf-access-jwt-assertion','origin','referer'])assert.equal(headers[name],undefined);
    received.push({body,headers});return new Response(null,{status:responseStatus});
  }});let browser;t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const box=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'批量通知投递 Agent',localPart:'batch-notification-deliveries'}},201)).mailbox;
  const base=`/owner/api/mailboxes/${box.id}`,notices=`${base}/retry-batch-notifications`,jobs=`${base}/alert-notification-exports`;
  for(let index=0;index<6;index++){
    const path=`/export-delivery-${index}`,subscription=await json(runtime,`${base}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net${path}`,eventTypes:['alert_notification.retry_batch.completed']}},201);
    secrets.set(path,subscription.secret);
  }
  const create=async()=> (await json(runtime,jobs,{method:'POST',body:{clientRequestId:randomUUID(),format:'csv'}},202)).job;
  const sourcePath='/batch-source',source=await json(runtime,base+'/webhooks',{method:'POST',body:{url:'https://hooks.example.net'+sourcePath,eventTypes:['alert_notification.export.succeeded']}},201);secrets.set(sourcePath,source.secret);
  const makeBatch=async(empty=false)=>{const selected=await json(runtime,base+'/export-notification-retry-batches/preview',{method:'POST',body:{clientRequestId:randomUUID(),...(empty?{from:0,to:1}:{reason:'http_rejected'})}},201);return(await json(runtime,base+'/export-notification-retry-batches/'+selected.batch.id+'/commit',{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:selected.batch.version}},202)).batch;};
  const noticeCalls=()=>received.filter(item=>JSON.parse(item.body).type==='alert_notification.retry_batch.completed');
  const tick=async()=>assert.equal((await(await runtime.mf.getWorker()).scheduled()).outcome,'ok');
  await create();await tick();await tick();const batch=await makeBatch();await tick();await tick();await tick();await tick();await tick();const job=(await json(runtime,notices+'?status=all')).notifications.find(item=>item.batchId===batch.id);assert.ok(job);assert.equal(noticeCalls().length,6);
  const directory=process.env.RETRY_BATCH_NOTIFICATION_DELIVERIES_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-batch-notification-deliveries-qa-'));await mkdir(directory,{recursive:true});
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1488,height:1056},extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':runtime.jwt}});
  await context.route(url=>url.origin!==origin,async route=>{external.push(route.request().url());await route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{
    if(!['error','warning'].includes(message.type()))return;
    if(expectedConflicts&&/409/.test(message.text())){expectedConflicts--;return;}
    if(expectedAborts&&/ERR_FAILED|Failed to fetch/.test(message.text())){expectedAborts--;return;}
    errors.push(message.text());
  });
  await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions#retry-batch-notifications`);
  await expect(page).toHaveTitle('批量通知投递 Agent · 抑制名单 · Agent Mail');await expect(page.getByRole('heading',{level:1})).toHaveText('批量通知投递 Agent');
  const notifications=page.getByRole('region',{name:'批量任务完成与异常通知',exact:true});
  await notifications.locator(`[data-retry-batch-notification="${job.id}"]`).getByRole('button',{name:`查看批量任务通知 ${job.id}`,exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'批量任务通知详情',exact:true}),tracking=dialog.getByRole('region',{name:'批量任务通知投递追踪',exact:true});
  await expect(tracking.getByLabel('批量任务通知决策')).toContainText('已准入');await expect(tracking.getByLabel('通知投递统计')).toContainText('订阅投递 6');await expect(tracking.getByLabel('通知投递统计')).toContainText('停止 6');
  await expect(tracking.locator('li[data-notification-delivery]')).toHaveCount(5);
  const firstPage=await tracking.locator('li[data-notification-delivery]').evaluateAll(items=>items.map(item=>item.dataset.notificationDelivery));
  const pagination=tracking.getByRole('navigation',{name:'通知投递分页',exact:true});await pagination.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(tracking.locator('li[data-notification-delivery]')).toHaveCount(1);assert.equal(firstPage.includes(await tracking.locator('li[data-notification-delivery]').getAttribute('data-notification-delivery')),false);
  await expect(tracking.getByLabel('通知投递统计')).toContainText('订阅投递 6');await pagination.getByRole('button',{name:'上一页',exact:true}).click();
  const deliveryId=firstPage[0],deliveryCard=tracking.locator(`[data-notification-delivery="${deliveryId}"]`);
  await deliveryCard.getByRole('button',{name:`查看通知投递 ${deliveryId}`,exact:true}).click();
  const attempts=tracking.getByRole('region',{name:'通知投递详情',exact:true});await expect(attempts).toContainText('第 1 次 · 停止重试');await expect(attempts).toContainText('HTTP 400');await expect(attempts).toContainText('尚无手动重试记录');
  const retryRequests=[];let loseResponse=true;
  await page.route(`**${notices}/${job.id}/deliveries/${deliveryId}/retry`,async route=>{
    retryRequests.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),200);
    if(loseResponse){loseResponse=false;await route.abort('failed');return;}await route.fulfill({response});
  });
  await deliveryCard.getByRole('button',{name:`准备重试通知投递 ${deliveryId}`,exact:true}).click();const confirmation=tracking.getByRole('group',{name:'确认通知投递重试',exact:true});
  await confirmation.getByRole('button',{name:'确认重新排队',exact:true}).click();await expect(confirmation.getByRole('button',{name:'沿用标识核对重试',exact:true})).toBeVisible();await expect(tracking.getByRole('alert')).toBeVisible();
  const queued=await runtime.db.prepare('SELECT state,attempt_budget,updated_at FROM webhook_deliveries WHERE id=?').bind(deliveryId).first();assert.equal(queued.state,'pending');assert.equal(queued.attempt_budget,16);assert.equal(noticeCalls().length,6);
  await confirmation.getByRole('button',{name:'沿用标识核对重试',exact:true}).click();await expect(confirmation).toHaveCount(0);await expect(tracking).toContainText('本次没有增加预算或再次排队');assert.equal(retryRequests.length,2);assert.deepEqual(retryRequests[0],retryRequests[1]);
  assert.deepEqual(await runtime.db.prepare('SELECT state,attempt_budget,updated_at FROM webhook_deliveries WHERE id=?').bind(deliveryId).first(),queued);
  responseStatus=204;await tick();assert.equal(noticeCalls().length,7);const replay=received.at(-1),original=received.find(item=>item.headers['x-agent-mail-delivery']===deliveryId);assert.ok(original);assert.equal(replay.headers['x-agent-mail-delivery'],deliveryId);assert.equal(replay.body,original.body);assert.equal(replay.headers['x-agent-mail-secret-version'],original.headers['x-agent-mail-secret-version']);
  await tracking.getByRole('button',{name:'刷新投递结果',exact:true}).click();await expect(tracking.getByLabel('通知投递统计')).toContainText('成功 1');await expect(attempts).toContainText('第 2 次 · 成功');await expect(attempts).toContainText('HTTP 204');await expect(attempts).toContainText('尝试预算 8 → 16');await expect(deliveryCard.getByRole('button',{name:`准备重试通知投递 ${deliveryId}`,exact:true})).toHaveCount(0);
  await tracking.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth),true);await page.screenshot({path:join(directory,'notification-deliveries-desktop.png'),fullPage:false});
  const staleId=firstPage[1],staleCard=tracking.locator(`[data-notification-delivery="${staleId}"]`);await staleCard.getByRole('button',{name:`准备重试通知投递 ${staleId}`,exact:true}).click();
  await runtime.db.prepare('UPDATE webhook_deliveries SET updated_at=updated_at+1 WHERE id=?').bind(staleId).run();await confirmation.getByRole('button',{name:'确认重新排队',exact:true}).click();await expect(tracking.getByRole('alert')).toContainText('投递记录已变化');assert.equal(await runtime.db.prepare('SELECT state FROM webhook_deliveries WHERE id=?').bind(staleId).first('state'),'dead');
  await page.screenshot({path:join(directory,'notification-deliveries-conflict.png'),fullPage:false});await confirmation.getByRole('button',{name:'放弃本次核对',exact:true}).click();await tracking.getByRole('button',{name:'刷新投递结果',exact:true}).click();
  await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();await page.goto(`${origin}/owner/mailboxes/${box.id}/webhooks`);
  await page.getByRole('button',{name:`查看投递 ${staleId}`,exact:true}).click();const generic=page.getByRole('dialog',{name:'Webhook 投递详情',exact:true});page.once('dialog',native=>native.accept());
  const genericResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`${base}/webhook-deliveries/${staleId}/retry`);await generic.getByRole('button',{name:'重新排队此投递',exact:true}).click();const genericRequest=(await genericResponse).request().postDataJSON();assert.match(genericRequest.clientRequestId,/^[a-f0-9-]{36}$/);assert.equal(typeof genericRequest.expectedUpdatedAt,'number');assert.equal((await genericResponse).status(),200);await generic.getByRole('button',{name:'关闭对话框',exact:true}).click();await tick();assert.equal(noticeCalls().length,8);
  const policy=(await json(runtime,`${base}/alert-notification-policy`)).policy,{version,updatedAt,...settings}=policy;await json(runtime,`${base}/alert-notification-policy`,{method:'PATCH',body:{...settings,enabled:false,expectedVersion:version}});
  await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions#retry-batch-notifications`);await notifications.locator(`[data-retry-batch-notification="${job.id}"]`).getByRole('button',{name:`查看批量任务通知 ${job.id}`,exact:true}).click();await expect(tracking).toContainText('此邮箱的通知开关已关闭');await expect(tracking.locator('button[aria-label^="准备重试通知投递"]:enabled')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});await tracking.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth),true);await page.screenshot({path:join(directory,'notification-deliveries-mobile.png'),fullPage:false});await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();
  const muted=(await json(runtime,base+'/alert-notification-policy')).policy,{version:mutedVersion,updatedAt:mutedAt,...mutedSettings}=muted;
  const minute=new Date().getUTCHours()*60+new Date().getUTCMinutes();await json(runtime,base+'/alert-notification-policy',{method:'PATCH',body:{...mutedSettings,enabled:true,quietEnabled:true,quietStartMinute:(minute+1380)%1440,quietEndMinute:(minute+60)%1440,timeZone:'UTC',expectedVersion:mutedVersion}});
  await notifications.locator('[data-retry-batch-notification="'+job.id+'"]').getByRole('button',{name:'查看批量任务通知 '+job.id,exact:true}).click();await expect(tracking).toContainText('当前处于通知静默时段');await expect(tracking.locator('button[aria-label^="准备重试通知投递"]:enabled')).toHaveCount(0);await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();
  const quiet=(await json(runtime,base+'/alert-notification-policy')).policy,{version:quietVersion,updatedAt:quietAt,...quietSettings}=quiet;await json(runtime,base+'/alert-notification-policy',{method:'PATCH',body:{...quietSettings,enabled:false,quietEnabled:false,expectedVersion:quietVersion}});
  const skippedBatch=await makeBatch(true);await tick();await tick();const skipped=(await json(runtime,notices+'?status=all')).notifications.find(item=>item.batchId===skippedBatch.id);assert.ok(skipped);await notifications.getByRole('button',{name:'刷新批量任务通知',exact:true}).click();await notifications.locator(`[data-retry-batch-notification="${skipped.id}"]`).getByRole('button',{name:`查看批量任务通知 ${skipped.id}`,exact:true}).click();await expect(tracking.getByLabel('批量任务通知决策')).toContainText('通知关闭，已跳过');await expect(tracking).toContainText('不会补发，也不能手动生成投递');await expect(tracking.locator('li[data-notification-delivery]')).toHaveCount(0);
  const before=await runtime.db.prepare('SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM webhook_deliveries) deliveries,(SELECT count(*) FROM events) events').first();await tracking.getByRole('button',{name:'刷新投递结果',exact:true}).click();assert.deepEqual(await runtime.db.prepare('SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM webhook_deliveries) deliveries,(SELECT count(*) FROM events) events').first(),before);
  const other=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'隔离通知邮箱',localPart:'batch-delivery-other'}},201)).mailbox;
  const token=(await json(runtime,base+'/tokens',{method:'POST',body:{name:'Mailbox reader',scopes:['mail:read']}},201)).secret;
  await json(runtime,`${notices}/${job.id}/delivery-results`,{authenticated:false,headers:{Authorization:`Bearer ${token}`}},401);
  await json(runtime,`/owner/api/mailboxes/${other.id}/retry-batch-notifications/${job.id}/delivery-results`,{},404);
  await json(runtime,`${notices}/${job.id}/deliveries/${staleId}/retry`,{method:'POST',body:{clientRequestId:randomUUID(),expectedUpdatedAt:0},headers:{Origin:'https://evil.example'}},403);
  assert.equal(noticeCalls().length,8);assert.equal(expectedConflicts,0);assert.equal(expectedAborts,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(unexpected,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);
  const trackingHtml=await tracking.innerHTML();for(const marker of [...secrets.values(),'https://','claim_token','lease_token','object_key','payload_json'])assert.equal(trackingHtml.includes(marker),false,marker);
  console.log(`Batch notification delivery QA passed: ${origin}; desktop1488x1056 / mobile390x844; screenshots: ${directory}`);
});
