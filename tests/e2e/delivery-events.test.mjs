import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

test('Owner delivery events: native queue, verified bridge, recipient statuses, complaints and signed webhook fan-out',{timeout:120_000},async t=>{
  const port=Number(process.env.DELIVERY_EVENTS_E2E_PORT??4203),origin=`http://127.0.0.1:${port}`;
  const queueName='agent-mail-email-events',accountId='a'.repeat(32),zoneId='b'.repeat(32),subscriptionId='c'.repeat(32);
  const bridgeSecret='bridge-secret-'.repeat(4),privateMarker='PRIVATE_PROVIDER_SUBJECT_AND_SMTP <script>top.__deliveryXss=true</script>';
  const notifications=[],external=[],unexpectedUpstream=[],errors=[];let webhookSecret='';
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings:{
    EMAIL_EVENT_QUEUE:queueName,EMAIL_EVENT_ACCOUNT_ID:accountId,EMAIL_EVENT_ZONE_ID:zoneId,EMAIL_EVENT_SUBSCRIPTION_ID:subscriptionId,EMAIL_EVENT_DOMAIN:'agent.example.com',
    EMAIL_EVENT_BRIDGE_SECRET:bridgeSecret,WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:Buffer.alloc(32).toString('base64url')}})
  },outboundService:async request=>{
    if(request.url!=='https://hooks.example.net/delivery-events'){unexpectedUpstream.push(request.url);return new Response('Unexpected external request',{status:502});}
    const body=await request.text(),signature=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(request.headers.get('X-Agent-Mail-Signature')??'');assert.ok(signature);
    assert.equal(signature[2],createHmac('sha256',webhookSecret).update(`${signature[1]}.${request.headers.get('X-Agent-Mail-Delivery')}.${body}`).digest('hex'));
    notifications.push(JSON.parse(body));return new Response('ok');
  }});let browser;
  t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const json=async(path,options={},status=200)=>{const response=await runtime.request(path,options);assert.equal(response.status,status,await response.clone().text());return response.json();};
  const box=(await json('/owner/api/mailboxes',{method:'POST',body:{name:'投递状态 Agent',localPart:'delivery-status'}},201)).mailbox;
  const base=`/owner/api/mailboxes/${box.id}`;
  const hook=await json(`${base}/webhooks`,{method:'POST',body:{url:'https://hooks.example.net/delivery-events',eventTypes:['outbound.delivered','outbound.deferred','outbound.bounced','outbound.rejected','outbound.failed','outbound.complained']}},201);webhookSecret=hook.secret;
  let draft=(await json(`${base}/drafts`,{method:'POST',body:{to:['delivered@example.net'],cc:['deferred@example.net'],bcc:['bounced@example.net','rejected@example.net','failed@example.net'],subject:'逐个收件人的服务事件',text:'每位收件人的状态需要分别核对。',html:'<h2>投递状态测试</h2><p>发送服务接受后，继续等待收件服务器事件。</p>'}},201)).draft;
  draft=(await json(`${base}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:draft.version,contentSha256:draft.contentSha256}})).draft;
  const queued=await json(`${base}/drafts/${draft.id}/send`,{method:'POST',body:{expectedVersion:draft.version},headers:{'Idempotency-Key':randomUUID()}},202);
  const worker=await runtime.mf.getWorker();assert.equal((await worker.scheduled()).outcome,'ok');
  const sent=await runtime.db.prepare('SELECT * FROM outbound_messages WHERE id=?').bind(queued.outboundId).first();assert.equal(sent.status,'accepted');assert.ok(sent.provider_message_id);
  await runtime.mf.ready;
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1488,height:1056}});
  await context.route('**/*',async route=>{const request=route.request();if(new URL(request.url()).origin===origin){await route.continue({headers:{...request.headers(),'Cf-Access-Jwt-Assertion':runtime.jwt}});return;}external.push(request.url());await route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
  await page.goto(`${origin}/owner/mailboxes/${box.id}/outbound`);await expect(page).toHaveTitle('投递状态 Agent · 草稿与发信 · Agent Mail');await expect(page.getByRole('heading',{level:1})).toHaveText('投递状态 Agent');
  const history=page.getByRole('region',{name:'发送记录',exact:true}),record=history.locator(`[data-outbound-id="${sent.id}"]`);
  await expect(record.getByText('已接受（非送达）',{exact:true})).toBeVisible();
  await expect(record.locator('.outbound-recipient-statuses>li')).toHaveCount(5);await expect(record.getByText('服务已接受（非送达）',{exact:true})).toHaveCount(5);
  await expect(record).not.toContainText('最新服务事件');
  const eventAt=Date.now();
  function event(kind,recipient,at=eventAt) {return {type:`cf.email.sending.message.${kind}`,source:{type:'email.sending',zoneId,domain:'agent.example.com'},
    payload:{eventId:randomUUID(),messageId:sent.provider_message_id,sender:box.address,recipient,terminal:kind!=='deferred',delivery:{status:kind,response:privateMarker,error:privateMarker,smtp:privateMarker},subject:privateMarker},
    metadata:{accountId,eventSubscriptionId:subscriptionId,eventSchemaVersion:1,eventTimestamp:new Date(at).toISOString()}};}
  const events=[event('delivered','delivered@example.net'),event('deferred','deferred@example.net'),event('bounced','bounced@example.net'),event('rejected','rejected@example.net'),event('failed','failed@example.net')];
  const batch=await worker.queue(queueName,events.map(body=>({id:randomUUID(),timestamp:new Date(),attempts:1,body})));assert.equal(batch.outcome,'ok');
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(record.getByText('收件人状态不一致',{exact:true})).toBeVisible();
  const recipient=address=>record.locator(`[data-recipient="${address}"]`);
  await expect(recipient('delivered@example.net').getByText('收件服务器已接收',{exact:true})).toBeVisible();
  await expect(recipient('deferred@example.net').getByText('投递暂时延迟',{exact:true})).toBeVisible();
  await expect(recipient('bounced@example.net').getByText('已退信',{exact:true})).toBeVisible();
  await expect(recipient('rejected@example.net').getByText('投递失败',{exact:true})).toBeVisible();await expect(recipient('rejected@example.net')).toContainText('发送被拒绝');
  await expect(recipient('failed@example.net').getByText('投递失败',{exact:true})).toBeVisible();
  await expect(record).toContainText('最新服务事件');await expect(record.locator('.outbound-recipient-event time')).toHaveCount(5);

  const complaint=event('complained','delivered@example.net',Date.now()),raw=JSON.stringify(complaint),timestamp=String(Math.floor(Date.now()/1000));
  const bridge=signature=>runtime.mf.dispatchFetch('https://api.example.com/callbacks/cloudflare-email',{method:'POST',headers:{'Content-Type':'application/json','X-Agent-Mail-Timestamp':timestamp,'X-Agent-Mail-Signature':signature},body:raw});
  assert.equal((await bridge(`v1=${'0'.repeat(64)}`)).status,401);
  const valid=await bridge(`v1=${createHmac('sha256',bridgeSecret).update(`${timestamp}.${raw}`).digest('hex')}`);assert.equal(valid.status,200,await valid.clone().text());
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(recipient('delivered@example.net').getByText('收件服务器已接收',{exact:true})).toBeVisible();await expect(recipient('delivered@example.net').getByText('收到投诉',{exact:true})).toBeVisible();
  await expect(recipient('delivered@example.net')).toContainText('投诉时间');
  await expect(recipient('delivered@example.net').locator('.outbound-recipient-event').filter({hasText:'投递结果事件：'})).toHaveText('投递结果事件：收件服务器已接收');
  await expect(recipient('delivered@example.net').locator('.outbound-recipient-event').filter({hasText:'最新服务事件时间：'})).toContainText('UTC');
  assert.equal((await worker.queue(queueName,[{id:randomUUID(),timestamp:new Date(),attempts:2,body:events[0]}])).outcome,'ok');
  for(let pass=0;pass<4;pass++)assert.equal((await worker.scheduled()).outcome,'ok');
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_attempts').first('n'),1,'Provider events must never trigger another send');
  assert.equal(notifications.length,6);assert.equal(new Set(notifications.map(item=>item.id)).size,6);
  for(const notification of notifications){assert.equal(notification.data.outboundId,sent.id);assert.deepEqual(Object.keys(notification.data).sort(),['outboundId','status']);assert.equal(JSON.stringify(notification).includes('@example.net'),false);assert.equal(JSON.stringify(notification).includes(privateMarker),false);}
  const records=await json(`${base}/outbound`),safe=JSON.stringify(records);assert.equal(safe.includes(privateMarker),false);assert.equal(safe.includes(bridgeSecret),false);assert.equal(safe.includes('subject'),false);
  const current=records.outbound.find(item=>item.id===sent.id);assert.equal(current.status,'partial');
  const deliveredRecipient=current.recipients.find(item=>item.address==='delivered@example.net');assert.equal(deliveredRecipient.status,'delivered');assert.equal(deliveredRecipient.deliveryEventType,'delivered');
  assert.equal(deliveredRecipient.complainedAt,Date.parse(complaint.metadata.eventTimestamp));assert.equal(deliveredRecipient.lastProviderEventAt,deliveredRecipient.complainedAt);
  assert.equal(await page.evaluate(()=>globalThis.__deliveryXss),undefined);assert.equal((await page.content()).includes(privateMarker),false);
  const directory=process.env.DELIVERY_EVENTS_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-delivery-events-qa-'));await mkdir(directory,{recursive:true});
  await history.scrollIntoViewIfNeeded();await page.screenshot({path:join(directory,'delivery-events-desktop.png'),fullPage:false});
  await page.setViewportSize({width:390,height:844});await history.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await history.screenshot({path:join(directory,'delivery-events-mobile.png')});
  await page.goto(`${origin}/owner/mailboxes/${box.id}/webhooks`);
  const form=page.getByRole('region',{name:'新增 Webhook',exact:true});
  for(const label of ['收件服务器已接收','投递暂时延迟','邮件退信','发送被拒绝','收到投诉'])await expect(form.getByRole('checkbox',{name:new RegExp(`^${label}`)})).toBeVisible();
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(unexpectedUpstream,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);
  console.log(`Delivery-event browser QA passed: ${origin}, desktop1488x1056 / mobile390x844; screenshots: ${directory}`);
});
