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

test('Owner previews fixed mailbox failures and confirms an idempotent bounded batch with progress and safe result records',{timeout:120_000},async t=>{
  // Browser plugin not available. Reuse the established Playwright/Chrome final-Worker workflow.
  const port=Number(process.env.ASYNC_EXPORT_NOTIFICATION_RETRY_BATCHES_E2E_PORT??4214),origin=`http://127.0.0.1:${port}`;
  const errors=[],external=[],unexpected=[],received=[],secrets=new Map();let responseStatus=400,expectedAborts=2;
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings:{WEBHOOK_KEYRING:keyring},outboundService:async request=>{
    const url=new URL(request.url),secret=secrets.get(url.pathname);if(url.hostname!=='hooks.example.net'||!secret){unexpected.push(request.url);return new Response(null,{status:502});}
    const body=await request.text(),headers=Object.fromEntries(request.headers),signature=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(headers['x-agent-mail-signature']??'');assert.ok(signature);
    assert.equal(signature[2],createHmac('sha256',secret).update(`${signature[1]}.${headers['x-agent-mail-delivery']}.${body}`).digest('hex'));
    for(const name of ['authorization','cookie','cf-access-jwt-assertion','origin','referer'])assert.equal(headers[name],undefined);received.push({body,headers});return new Response(null,{status:responseStatus});
  }});let browser;t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const box=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'批量通知重试 Agent',localPart:'batch-notification-retries'}},201)).mailbox;
  const other=(await json(runtime,'/owner/api/mailboxes',{method:'POST',body:{name:'独立批次 Agent',localPart:'other-batch-retries'}},201)).mailbox;
  const base=`/owner/api/mailboxes/${box.id}`,batches=`${base}/export-notification-retry-batches`,jobs=`${base}/alert-notification-exports`;
  for(let i=0;i<6;i++){const path=`/batch-retry-${i}`,subscription=await json(runtime,`${base}/webhooks`,{method:'POST',body:{url:`https://hooks.example.net${path}`,eventTypes:['alert_notification.export.succeeded']}},201);secrets.set(path,subscription.secret);}
  const create=async()=> (await json(runtime,jobs,{method:'POST',body:{clientRequestId:randomUUID(),format:'csv'}},202)).job;
  const tick=async()=>assert.equal((await(await runtime.mf.getWorker()).scheduled()).outcome,'ok');
  const originalJob=await create();await tick();await tick();await tick();await tick();assert.equal(received.length,6);
  const directory=process.env.ASYNC_EXPORT_NOTIFICATION_RETRY_BATCHES_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-export-retry-batches-qa-'));await mkdir(directory,{recursive:true});
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1488,height:1056},extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':runtime.jwt}});
  await context.route(url=>url.origin!==origin,async route=>{external.push(route.request().url());await route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{
    if(!['error','warning'].includes(message.type()))return;if(expectedAborts&&/ERR_FAILED|Failed to fetch/.test(message.text())){expectedAborts--;return;}errors.push(message.text());
  });
  await page.goto(`${origin}/owner/mailboxes/${box.id}/suppressions#async-export-notifications`);await expect(page).toHaveTitle('批量通知重试 Agent · 抑制名单 · Agent Mail');await expect(page.getByRole('heading',{level:1})).toHaveText('批量通知重试 Agent');
  const panel=page.getByRole('region',{name:'失败投递批量重试',exact:true}),filters=panel.getByRole('form',{name:'批量重试筛选',exact:true});await expect(panel).toBeVisible();
  await filters.getByLabel('失败原因',{exact:true}).selectOption('http_rejected');
  const previewRequests=[];let losePreview=true,firstBatch;
  await page.route(`**${batches}/preview`,async route=>{
    previewRequests.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),201);firstBatch=(await response.json()).batch;
    if(losePreview){losePreview=false;await route.abort('failed');return;}await route.fulfill({response});
  });
  await filters.getByRole('button',{name:'生成批量重试预览',exact:true}).click();const reconcile=panel.getByRole('group',{name:'核对批量操作',exact:true});await expect(reconcile.getByRole('button',{name:'沿用标识核对预览',exact:true})).toBeVisible();
  await expect(panel.getByRole('alert')).toBeVisible();assert.equal(await runtime.db.prepare('SELECT count(*) n FROM async_export_notification_retry_batches WHERE mailbox_id=?').bind(box.id).first('n'),1);
  await reconcile.getByRole('button',{name:'沿用标识核对预览',exact:true}).click();await expect(reconcile).toHaveCount(0);assert.equal(previewRequests.length,2);assert.deepEqual(previewRequests[0],previewRequests[1]);
  const detail=panel.getByRole('region',{name:'批量重试详情',exact:true}),confirmation=detail.getByRole('group',{name:'确认批量重试',exact:true});await expect(detail.getByLabel('批量重试统计')).toContainText('候选 6 · 预览可重试 6');await expect(detail.locator('li[data-batch-delivery]')).toHaveCount(6);
  await filters.getByLabel('失败原因',{exact:true}).selectOption('network_error');await expect(confirmation).toContainText('筛选条件已修改');await expect(confirmation.getByRole('button',{name:'确认提交批量重试',exact:true})).toBeDisabled();await filters.getByLabel('失败原因',{exact:true}).selectOption('http_rejected');await expect(confirmation.getByRole('button',{name:'确认提交批量重试',exact:true})).toBeEnabled();
  const frozen=(await json(runtime,`${batches}/${firstBatch.id}?limit=100`)).items;assert.equal(frozen.length,6);assert.ok(frozen.every(item=>item.jobId===originalJob.id));
  await create();await tick();await tick();await tick();await tick();assert.equal(received.length,12);assert.equal((await json(runtime,`${batches}/${firstBatch.id}?limit=100`)).items.length,6);
  const changed=frozen[0].deliveryId;await runtime.db.prepare('UPDATE webhook_deliveries SET updated_at=updated_at+1 WHERE id=?').bind(changed).run();
  const commits=[];let loseCommit=true;
  await page.route(`**${batches}/${firstBatch.id}/commit`,async route=>{
    commits.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),202);if(loseCommit){loseCommit=false;await route.abort('failed');return;}await route.fulfill({response});
  });
  await confirmation.getByRole('button',{name:'确认提交批量重试',exact:true}).click();await expect(reconcile.getByRole('button',{name:'沿用标识核对提交',exact:true})).toBeVisible();assert.equal(received.length,12);
  await reconcile.getByRole('button',{name:'沿用标识核对提交',exact:true}).click();await expect(reconcile).toHaveCount(0);assert.equal(commits.length,2);assert.deepEqual(commits[0],commits[1]);await expect(detail).toContainText('等待执行');
  responseStatus=204;await tick();await panel.getByRole('button',{name:'刷新批量重试记录',exact:true}).click();await expect(detail.getByLabel('批量重试统计')).toContainText('已处理 5/6');
  await detail.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,'batch-retry-progress-desktop.png'),fullPage:false});
  await tick();await panel.getByRole('button',{name:'刷新批量重试记录',exact:true}).click();await expect(detail).toContainText('处理完成');await expect(detail.getByLabel('批量重试统计')).toContainText('已处理 6/6 · 已排队 5 · 跳过 1 · 失败 0 · 待核对 0');await expect(detail).toContainText('投递版本已变化');
  const completed=await json(runtime,`${batches}/${firstBatch.id}?limit=100`);assert.equal(completed.batch.requeuedItems,5);assert.equal(completed.items.find(item=>item.deliveryId===changed).state,'skipped');assert.ok(completed.items.filter(item=>item.state==='requeued').every(item=>item.manualRetryId));
  await tick();await tick();await tick();assert.equal(received.length,17);assert.equal(await runtime.db.prepare("SELECT count(*) n FROM audit_events WHERE mailbox_id=? AND action='webhook.delivery_retried'").bind(box.id).first('n'),5);
  for(const item of completed.items.filter(item=>item.state==='requeued')){const calls=received.filter(call=>call.headers['x-agent-mail-delivery']===item.deliveryId);assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);assert.equal(calls[0].headers['x-agent-mail-secret-version'],calls[1].headers['x-agent-mail-secret-version']);}
  await panel.getByRole('button',{name:'刷新批量重试记录',exact:true}).click();await detail.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));await page.screenshot({path:join(directory,'batch-retry-results-desktop.png'),fullPage:false});
  await filters.getByLabel('失败时间范围',{exact:true}).selectOption('custom');await filters.getByLabel('失败开始时间',{exact:true}).fill('2026-11-15T20:00');await filters.getByLabel('失败结束时间',{exact:true}).fill('2026-11-15T19:00');
  await filters.getByRole('button',{name:'生成批量重试预览',exact:true}).click();await expect(panel.getByRole('alert')).toContainText('有效时间范围');assert.equal(previewRequests.length,2);await filters.getByLabel('失败时间范围',{exact:true}).selectOption('7d');
  const expiredId=randomUUID(),old=Date.now()-700000,source=await runtime.db.prepare('SELECT * FROM async_export_notification_retry_batches WHERE id=?').bind(firstBatch.id).first();
  const expired={...source,id:expiredId,preview_request_id:randomUUID(),state:'preview',version:1,created_at:old,updated_at:old,expires_at:old+86400000,preview_expires_at:old+600000,
    commit_request_id:null,commit_expected_version:null,committed_at:null,completed_at:null,total_items:0,eligible_items:0,processed_items:0,requeued_items:0,skipped_items:0,failed_items:0,unknown_items:0};
  const columns=Object.keys(expired);await runtime.db.prepare(`INSERT INTO async_export_notification_retry_batches(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(column=>expired[column])).run();
  await panel.getByRole('button',{name:'刷新批量重试记录',exact:true}).click();await panel.getByRole('button',{name:`查看批量重试 ${expiredId}`,exact:true}).click();await expect(detail).toContainText('预览已过期，不能提交');await expect(detail.getByRole('button',{name:'确认提交批量重试',exact:true})).toHaveCount(0);
  const snapshot=await runtime.db.prepare('SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM webhook_delivery_attempts) attempts,(SELECT count(*) FROM async_export_notification_retry_items) items').first();await panel.getByRole('button',{name:'刷新批量重试记录',exact:true}).click();assert.deepEqual(await runtime.db.prepare('SELECT (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM webhook_delivery_attempts) attempts,(SELECT count(*) FROM async_export_notification_retry_items) items').first(),snapshot);
  await json(runtime,`/owner/api/mailboxes/${other.id}/export-notification-retry-batches/${firstBatch.id}`,{},404);await json(runtime,batches,{authenticated:false},401);await json(runtime,`${batches}/${firstBatch.id}/commit`,{method:'POST',headers:{Origin:'https://evil.example'},body:commits[0]},403);
  await panel.getByRole('button',{name:`查看批量重试 ${firstBatch.id}`,exact:true}).click();await page.setViewportSize({width:390,height:844});await detail.evaluate(element=>element.scrollIntoView({block:'start',behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,'batch-retry-mobile.png'),fullPage:false});
  assert.equal(expectedAborts,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(unexpected,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);
  const html=await panel.innerHTML();for(const marker of [...secrets.values(),'https://','payload_json','signing_secret','claim_token','lease_token','request_hash'])assert.equal(html.includes(marker),false,marker);
  console.log(`Export notification batch retry QA passed: ${origin}; desktop1488x1056 / mobile390x844; screenshots: ${directory}`);
});
