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

test('Owner stops pending batch entries, reconciles fenced unknown receipts and pages retained operation history without repeating queue mutations',{timeout:120_000},async t=>{
  // Browser plugin not available. Exercise the final single Worker through established Playwright/Chrome.
  // Flow: Owner batch details -> confirm stop -> replay lost response -> reconcile unknowns -> retained results/history.
  const port=Number(process.env.ASYNC_EXPORT_NOTIFICATION_RETRY_CONTROLS_E2E_PORT??4215),origin=`http://127.0.0.1:${port}`;
  const errors=[],external=[],unexpected=[],received=[],secrets=new Map();let responseStatus=400,expectedAborts=2;
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings:{WEBHOOK_KEYRING:keyring},outboundService:async request=>{
    const url=new URL(request.url),secret=secrets.get(url.pathname);if(url.hostname!=='hooks.example.net'||!secret){unexpected.push(request.url);return new Response(null,{status:502});}
    const body=await request.text(),headers=Object.fromEntries(request.headers),signature=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(headers['x-agent-mail-signature']??'');assert.ok(signature);
    assert.equal(signature[2],createHmac('sha256',secret).update(`${signature[1]}.${headers['x-agent-mail-delivery']}.${body}`).digest('hex'));
    for(const name of ['authorization','cookie','cf-access-jwt-assertion','origin','referer'])assert.equal(headers[name],undefined);received.push({body,headers});return new Response(null,{status:responseStatus});
  }});let browser;t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const box=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'可停止批次 Agent',localPart:'batch-retry-controls'}},201)).mailbox;
  const other=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'隔离邮箱 Agent',localPart:'batch-retry-controls-other'}},201)).mailbox;
  const base=`/owner/api/mailboxes/${box.id}`,batches=`${base}/export-notification-retry-batches`;
  for(let i=0;i<9;i++){const path=`/retry-control-${i}`,subscription=await json(runtime,`${base}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net${path}`,eventTypes:['alert_notification.export.succeeded']}},201);secrets.set(path,subscription.secret);}
  const job=(await json(runtime,`${base}/alert-notification-exports`,{method:'POST',body:{clientRequestId:randomUUID(),format:'csv'}},202)).job;
  const tick=async()=>assert.equal((await(await runtime.mf.getWorker()).scheduled()).outcome,'ok');
  for(let i=0;i<6;i++)await tick();assert.equal(received.length,9);
  const preview=(await json(runtime,`${batches}/preview`,{method:'POST',body:{clientRequestId:randomUUID(),reason:'http_rejected'}},201)).batch;
  await json(runtime,`${batches}/${preview.id}/commit`,{method:'POST',body:{clientRequestId:randomUUID(),expectedVersion:preview.version}},202);await tick();assert.equal(received.length,9);
  const source=await json(runtime,`${batches}/${preview.id}?limit=100`);assert.equal(source.batch.requeuedItems,5);
  const pending=source.items.filter(item=>item.state==='pending'),withReceipt=pending[0],withoutReceipt=pending[1];assert.equal(pending.length,4);
  const selected=await runtime.db.prepare('SELECT client_request_id FROM async_export_notification_retry_items WHERE batch_id=? AND delivery_id=?').bind(preview.id,withReceipt.deliveryId).first();
  // Model a crash after the real atomic retry receipt and before its batch checkpoint; the no-receipt lease models a crash before commit.
  const originalReceipt=await json(runtime,`${base}/export-notifications/${job.id}/deliveries/${withReceipt.deliveryId}/retry`,{method:'POST',body:{clientRequestId:selected.client_request_id,expectedUpdatedAt:withReceipt.expectedUpdatedAt}});
  const at=Date.now();await runtime.db.batch([...[withReceipt,withoutReceipt].map(item=>runtime.db.prepare("UPDATE async_export_notification_retry_items SET state='running',lease_token=?,lease_until=?,version=version+1,updated_at=MAX(updated_at+1,?) WHERE batch_id=? AND delivery_id=?").bind(randomUUID(),at+120000,at,preview.id,item.deliveryId)),
    runtime.db.prepare('UPDATE async_export_notification_retry_batches SET version=version+1,updated_at=MAX(updated_at+1,?) WHERE id=?').bind(at,preview.id)]);
  await runtime.db.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(box.id).run();
  const before=(await runtime.db.prepare('SELECT id,state,attempt_budget FROM webhook_deliveries WHERE mailbox_id=? ORDER BY id').bind(box.id).all()).results;
  const directory=process.env.ASYNC_EXPORT_NOTIFICATION_RETRY_CONTROLS_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-export-retry-controls-qa-'));await mkdir(directory,{recursive:true});
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1488,height:1056},extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':runtime.jwt}});
  await context.route(url=>url.origin!==origin,async route=>{external.push(route.request().url());await route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{
    if(!['error','warning'].includes(message.type()))return;if(expectedAborts&&/ERR_FAILED|Failed to fetch/.test(message.text())){expectedAborts--;return;}errors.push(message.text());
  });
  await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions#async-export-notifications`);await expect(page).toHaveTitle('可停止批次 Agent · 抑制名单 · Agent Mail');await expect(page.getByRole('heading',{level:1})).toHaveText('可停止批次 Agent');
  const panel=page.getByRole('region',{name:'失败投递批量重试',exact:true});await expect(panel).toBeVisible();await panel.getByRole('button',{name:`查看批量重试 ${preview.id}`,exact:true}).click();
  const detail=panel.getByRole('region',{name:'批量重试详情',exact:true}),stats=detail.getByLabel('批量重试统计');await expect(stats).toContainText('已处理 5/9 · 已排队 5');
  await detail.getByRole('button',{name:'停止未执行条目',exact:true}).click();const confirm=detail.getByRole('group',{name:'确认停止批量任务',exact:true});await expect(confirm).toContainText('停止后不能恢复');
  await confirm.getByRole('button',{name:'继续执行此批次',exact:true}).click();await expect(confirm).toHaveCount(0);assert.equal((await json(runtime,`${batches}/${preview.id}`)).batch.cancelledAt,null);
  const cancels=[];let loseCancel=true;
  await page.route(`**${batches}/${preview.id}/cancel`,async route=>{cancels.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),200);if(loseCancel){loseCancel=false;await route.abort('failed');return;}await route.fulfill({response});});
  await detail.getByRole('button',{name:'停止未执行条目',exact:true}).click();await confirm.getByRole('button',{name:'确认停止未执行条目',exact:true}).click();
  const intent=panel.getByRole('group',{name:'核对批量操作',exact:true});await expect(intent.getByRole('button',{name:'沿用标识核对停止操作',exact:true})).toBeVisible();await expect(panel.getByRole('alert')).toBeVisible();
  await intent.getByRole('button',{name:'沿用标识核对停止操作',exact:true}).click();await expect(intent).toHaveCount(0);assert.equal(cancels.length,2);assert.deepEqual(cancels[0],cancels[1]);
  await expect(detail).toContainText('已停止未执行条目');await expect(stats).toContainText('已处理 9/9 · 已排队 5 · 跳过 2 · 失败 0 · 待核对 2');
  await expect(detail.getByRole('button',{name:'停止未执行条目',exact:true})).toHaveCount(0);assert.equal(received.length,9);
  const cancelled=await json(runtime,`${batches}/${preview.id}?limit=100`);assert.equal(cancelled.batch.state,'cancelled');assert.ok(cancelled.batch.cancelledAt);assert.deepEqual(cancelled.items.filter(item=>item.state==='requeued'),source.items.filter(item=>item.state==='requeued'));
  assert.ok(pending.slice(2).every(item=>cancelled.items.find(row=>row.deliveryId===item.deliveryId).reason==='batch_cancelled'));
  const reconciles=[];let loseReconcile=true;
  await page.route(`**${batches}/${preview.id}/reconcile`,async route=>{reconciles.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),200);if(loseReconcile){loseReconcile=false;await route.abort('failed');return;}await route.fulfill({response});});
  await detail.getByRole('button',{name:`核对原操作收据 ${withoutReceipt.deliveryId}`,exact:true}).click();await expect(intent.getByRole('button',{name:'沿用标识核对未知结果',exact:true})).toBeVisible();
  await intent.getByRole('button',{name:'沿用标识核对未知结果',exact:true}).click();await expect(intent).toHaveCount(0);assert.equal(reconciles.length,2);assert.deepEqual(reconciles[0],reconciles[1]);assert.equal(reconciles[0].deliveryId,withoutReceipt.deliveryId);
  await expect(stats).toContainText('跳过 3 · 失败 0 · 待核对 1');await expect(detail.locator(`[data-batch-delivery="${withoutReceipt.deliveryId}"]`)).toContainText('确认未提交重试');
  await detail.getByRole('button',{name:'核对本批未知结果',exact:true}).click();await expect(stats).toContainText('已处理 9/9 · 已排队 6 · 跳过 3 · 失败 0 · 待核对 0');await expect(detail.getByRole('group',{name:'核对批量未知结果',exact:true})).toHaveCount(0);
  const completed=await json(runtime,`${batches}/${preview.id}?limit=100`);assert.equal(completed.batch.state,'cancelled');assert.equal(completed.items.find(item=>item.deliveryId===withReceipt.deliveryId).manualRetryId,originalReceipt.manualRetry.id);assert.equal(completed.items.find(item=>item.deliveryId===withoutReceipt.deliveryId).reason,'not_submitted');
  assert.deepEqual((await runtime.db.prepare('SELECT id,state,attempt_budget FROM webhook_deliveries WHERE mailbox_id=? ORDER BY id').bind(box.id).all()).results,before);assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE mailbox_id=? AND action='webhook.delivery_retried'").bind(box.id).first('n'),6);
  const history=detail.getByRole('region',{name:'批量任务操作历史',exact:true}),historyNav=history.getByRole('navigation',{name:'批量任务操作历史分页',exact:true});await expect(history.locator('li[data-batch-operation]')).toHaveCount(3);await expect(history).toContainText('确认未提交 1 条');await expect(history).toContainText('已有收据 1 条');
  await history.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,'batch-controls-history-desktop.png'),fullPage:false});
  await historyNav.getByRole('button',{name:'下一页',exact:true}).click();await expect(history.locator('li[data-batch-operation]')).toHaveCount(2);await expect(history).toContainText('创建固定预览');await expect(history).toContainText('确认提交');await historyNav.getByRole('button',{name:'上一页',exact:true}).click();await expect(history.locator('li[data-batch-operation]')).toHaveCount(3);
  const log=(await json(runtime,`${batches}/${preview.id}/operations?limit=100`)).operations;assert.equal(log.length,5);assert.equal(log.filter(row=>row.action==='cancel').length,1);assert.equal(log.filter(row=>row.action==='reconcile').length,2);
  const snapshot=await runtime.db.prepare('SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM webhook_delivery_attempts) attempts').first();await panel.getByRole('button',{name:'刷新批量重试记录',exact:true}).click();assert.deepEqual(await runtime.db.prepare('SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM webhook_delivery_attempts) attempts').first(),snapshot);
  await json(runtime,`/owner/api/mailboxes/${other.id}/export-notification-retry-batches/${preview.id}/operations`,{},404);await json(runtime,`${batches}/${preview.id}/operations`,{authenticated:false},401);
  await json(runtime,`${batches}/${preview.id}/cancel`,{method:'POST',headers:{Origin:'https://evil.example'},body:cancels[0]},403);await json(runtime,`${batches}/${preview.id}/reconcile`,{method:'POST',authenticated:false,headers:{Authorization:'Bearer unavailable'},body:reconciles[0]},401);
  await detail.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));await page.screenshot({path:join(directory,'batch-controls-results-desktop.png'),fullPage:false});
  await page.setViewportSize({width:390,height:844});await history.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,'batch-controls-mobile.png'),fullPage:false});
  responseStatus=204;await runtime.db.prepare("UPDATE mailboxes SET status='active' WHERE id=?").bind(box.id).run();for(let i=0;i<4;i++)await tick();assert.equal(received.length,15);assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE mailbox_id=? AND action='webhook.delivery_retried'").bind(box.id).first('n'),6);
  assert.equal((await json(runtime,`${batches}/${preview.id}`)).batch.state,'cancelled');assert.equal(expectedAborts,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(unexpected,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);
  const html=await panel.innerHTML();for(const marker of [...secrets.values(),'https://','payload_json','signing_secret','claim_token','lease_token','request_hash'])assert.equal(html.includes(marker),false,marker);
  console.log(`Export notification batch control QA passed: ${origin}; desktop1488x1056 / mobile390x844; screenshots: ${directory}`);
});
