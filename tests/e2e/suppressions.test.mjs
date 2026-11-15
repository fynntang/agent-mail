import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

test('Owner suppressions: hard bounce and complaint block sends, CAS release, paging and fresh-event re-suppression',{timeout:120_000},async t=>{
  const port=Number(process.env.SUPPRESSIONS_E2E_PORT??4204),origin=`http://127.0.0.1:${port}`;
  const queueName='agent-mail-email-events',accountId='a'.repeat(32),zoneId='b'.repeat(32),subscriptionId='c'.repeat(32);
  const errors=[],external=[],unexpectedUpstream=[],expectedConflictPaths=new Set();
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port,bindings:{EMAIL_EVENT_QUEUE:queueName,EMAIL_EVENT_ACCOUNT_ID:accountId,EMAIL_EVENT_ZONE_ID:zoneId,EMAIL_EVENT_SUBSCRIPTION_ID:subscriptionId,EMAIL_EVENT_DOMAIN:'agent.example.com'},outboundService:async request=>{
    unexpectedUpstream.push(request.url);return new Response('Unexpected external request',{status:502});
  }});let browser;
  t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  const json=async(path,options={},status=200)=>{const response=await runtime.request(path,options);assert.equal(response.status,status,await response.clone().text());return status===204?undefined:response.json();};
  const box=(await json('/owner/api/mailboxes',{method:'POST',body:{name:'抑制名单 Agent',localPart:'suppression-agent'}},201)).mailbox;
  const base=`/owner/api/mailboxes/${box.id}`;
  const createApproved=async(to,subject)=>{
    let draft=(await json(`${base}/drafts`,{method:'POST',body:{to,subject,text:'请核对收件人抑制状态后发送。'}},201)).draft;
    draft=(await json(`${base}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:draft.version,contentSha256:draft.contentSha256}})).draft;return draft;
  };
  const send=async draft=>json(`${base}/drafts/${draft.id}/send`,{method:'POST',body:{expectedVersion:draft.version},headers:{'Idempotency-Key':randomUUID()}},202);
  const extraAddresses=Array.from({length:10},(_,index)=>`page${String(index+1).padStart(2,'0')}@example.net`);
  const initialDraft=await createApproved([...extraAddresses,'soft@example.net','complaint@example.net','hard@example.net'],'创建真实退信与投诉证据');
  const initialQueued=await send(initialDraft),worker=await runtime.mf.getWorker();assert.equal((await worker.scheduled()).outcome,'ok');
  const initial=await runtime.db.prepare('SELECT * FROM outbound_messages WHERE id=?').bind(initialQueued.outboundId).first();assert.equal(initial.status,'accepted');assert.ok(initial.provider_message_id);
  const blockedDraft=await createApproved(['hard@example.net'],'受抑制收件人的发送请求');
  let eventTime=Date.now();
  function event(kind,address,providerId=initial.provider_message_id,bounceType=undefined) {return {type:`cf.email.sending.message.${kind}`,source:{type:'email.sending',zoneId,domain:'agent.example.com'},
    payload:{eventId:randomUUID(),messageId:providerId,sender:box.address,recipient:address,terminal:true,delivery:{status:kind},...(bounceType?{bounce:{type:bounceType}}:{}),subject:'PRIVATE_PROVIDER_SUBJECT'},
    metadata:{accountId,eventSubscriptionId:subscriptionId,eventSchemaVersion:1,eventTimestamp:new Date(eventTime++).toISOString()}};}
  const hardEvent=event('bounced','hard@example.net',initial.provider_message_id,'hard');
  const messages=[...extraAddresses.map(address=>event('bounced',address,initial.provider_message_id,'hard')),event('bounced','soft@example.net',initial.provider_message_id,'soft'),event('complained','complaint@example.net'),hardEvent];
  const queue=async bodies=>{const result=await worker.queue(queueName,bodies.map(body=>({id:randomUUID(),timestamp:new Date(),attempts:1,body})));assert.equal(result.outcome,'ok');};
  await queue(messages);
  const list=async(status='all')=>(await json(`${base}/suppressions?status=${status}&limit=50`)).suppressions;
  let all=await list();assert.equal(all.length,12);assert.equal(all.some(item=>item.address==='soft@example.net'),false);
  let hard=all.find(item=>item.address==='hard@example.net');assert.ok(hard);assert.equal(hard.reason,'hard_bounce');
  assert.equal(all.find(item=>item.address==='complaint@example.net').reason,'complaint');
  const token=await json(`${base}/tokens`,{method:'POST',body:{name:'Agent cannot release suppressions',scopes:['mail:read','mail:draft','mail:send']}},201);
  assert.equal((await runtime.request(`${base}/suppressions/${hard.id}/release`,{authenticated:false,method:'POST',headers:{Authorization:`Bearer ${token.secret}`},body:{expectedVersion:hard.version}})).status,401);
  const counters=async()=>({outbound:await runtime.db.prepare('SELECT count(*) n FROM outbound_messages WHERE mailbox_id=?').bind(box.id).first('n'),reservations:await runtime.db.prepare('SELECT count(*) n FROM send_reservations WHERE mailbox_id=?').bind(box.id).first('n'),quota:await runtime.db.prepare('SELECT reserved_units,used_units FROM daily_send_counters WHERE mailbox_id=?').bind(box.id).first()});
  const beforeBlocked=await counters();assert.deepEqual(beforeBlocked.quota,{reserved_units:0,used_units:13});
  await runtime.mf.ready;
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?(existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge'):undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{}),args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1488,height:1056}});
  await context.route('**/*',async route=>{const request=route.request();if(new URL(request.url()).origin===origin){await route.continue({headers:{...request.headers(),'Cf-Access-Jwt-Assertion':runtime.jwt}});return;}external.push(request.url());await route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{
    if(!['error','warning'].includes(message.type()))return;
    let path='';try{path=new URL(message.location().url).pathname;}catch{}
    if(message.type()==='error'&&message.text().includes('409')&&expectedConflictPaths.has(path))return;
    errors.push(message.text());
  });
  const pageBase=`${origin}/owner/mailboxes/${box.id}`;
  await page.goto(`${pageBase}/outbound`);await expect(page).toHaveTitle('抑制名单 Agent · 草稿与发信 · Agent Mail');
  await page.locator('.draft-list button').filter({hasText:blockedDraft.content.subject}).click();
  const suppressedSendPath=`${base}/drafts/${blockedDraft.id}/send`;expectedConflictPaths.add(suppressedSendPath);
  const failedSend=page.waitForResponse(response=>new URL(response.url()).pathname===suppressedSendPath&&response.request().method()==='POST');
  await page.getByRole('button',{name:'提交发送',exact:true}).click();const failed=await failedSend;assert.equal(failed.status(),409);assert.equal((await failed.json()).error.code,'recipient_suppressed');
  await expect(page.getByRole('alert')).toContainText('整封邮件未发送');assert.deepEqual(await counters(),beforeBlocked);
  const softDraft=await createApproved(['soft@example.net'],'软退信不自动抑制');const softQueued=await send(softDraft);assert.equal(softQueued.status,'queued');await json(`${base}/outbound/${softQueued.outboundId}/cancel`,{method:'POST',body:{}},204);

  await page.getByRole('navigation',{name:'邮箱功能'}).getByRole('link',{name:'抑制名单',exact:true}).click();
  await expect(page).toHaveTitle('抑制名单 Agent · 抑制名单 · Agent Mail');await expect(page.getByRole('heading',{level:1})).toHaveText('抑制名单 Agent');
  const region=page.getByRole('region',{name:'收件人抑制名单',exact:true});
  await expect(region.locator('.suppression-list>li')).toHaveCount(12);await expect(region).toContainText('Cloudflare 发送服务的抑制名单独立管理');
  await region.getByRole('combobox',{name:'抑制名单每页条数',exact:true}).selectOption('10');await expect(region.locator('.suppression-list>li')).toHaveCount(10);
  await region.getByRole('button',{name:'下一页',exact:true}).click();await expect(region.locator('.suppression-list>li')).toHaveCount(2);
  await region.getByRole('button',{name:'上一页',exact:true}).click();await expect(region.locator('.suppression-list>li')).toHaveCount(10);
  for(const item of all.filter(item=>item.address.startsWith('page')))await json(`${base}/suppressions/${item.id}/release`,{method:'POST',body:{expectedVersion:item.version}});
  await page.getByRole('button',{name:'刷新名单',exact:true}).click();await expect(region.locator('.suppression-list>li')).toHaveCount(2);
  const row=address=>region.locator(`[data-address="${address}"]`),dialog=page.getByRole('dialog',{name:'解除收件人抑制',exact:true});
  await expect(row('hard@example.net')).toContainText('永久退信');await expect(row('complaint@example.net')).toContainText('收件人投诉');
  await row('hard@example.net').getByRole('button',{name:'解除 hard@example.net 的抑制',exact:true}).click();await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('新的永久退信或投诉可能重新将其加入名单');await expect(dialog).toContainText('不会同步解除服务端限制');
  eventTime=Math.max(Date.now(),eventTime);await queue([event('bounced','hard@example.net',initial.provider_message_id,'hard')]);
  const releasePath=`${base}/suppressions/${hard.id}/release`;expectedConflictPaths.add(releasePath);
  const staleResponse=page.waitForResponse(response=>new URL(response.url()).pathname===releasePath&&response.request().method()==='POST');
  await dialog.getByRole('button',{name:'确认解除',exact:true}).click();const stale=await staleResponse;assert.equal(stale.status(),409);assert.equal((await stale.json()).error.code,'suppression_changed');
  await expect(dialog.getByRole('alert')).toContainText('抑制记录已变化');await expect(dialog.getByRole('button',{name:'确认解除',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'关闭并刷新名单',exact:true}).click();await expect(dialog).toHaveCount(0);
  await row('hard@example.net').getByRole('button',{name:'解除 hard@example.net 的抑制',exact:true}).click();await dialog.getByRole('button',{name:'确认解除',exact:true}).click();await expect(dialog).toHaveCount(0);
  await expect(row('hard@example.net')).toHaveCount(0);await expect(region.getByRole('status')).toContainText('已解除对 hard@example.net 的本地抑制');
  const released=(await list()).find(item=>item.address==='hard@example.net');assert.equal(released.status,'released');assert.ok(released.releasedAt);
  await queue([hardEvent]);assert.equal((await list('active')).some(item=>item.address==='hard@example.net'),false,'A duplicate old event must not restore a released suppression');
  await region.getByRole('group',{name:'抑制状态筛选'}).getByRole('button',{name:'已解除',exact:true}).click();await region.getByRole('combobox',{name:'抑制名单每页条数',exact:true}).selectOption('25');
  await expect(row('hard@example.net')).toContainText('解除时间');await expect(row('hard@example.net').getByRole('button',{name:/解除 .* 的抑制/})).toHaveCount(0);
  await region.getByRole('group',{name:'抑制状态筛选'}).getByRole('button',{name:'全部',exact:true}).click();await expect(region.locator('.suppression-list>li')).toHaveCount(12);

  await page.getByRole('navigation',{name:'邮箱功能'}).getByRole('link',{name:'草稿与发信',exact:true}).click();await page.locator('.draft-list button').filter({hasText:blockedDraft.content.subject}).click();
  await page.getByRole('button',{name:'提交发送',exact:true}).click();await expect(page.getByRole('region',{name:'发送记录',exact:true}).getByText('排队中',{exact:true})).toBeVisible();
  assert.equal((await worker.scheduled()).outcome,'ok');assert.equal(await runtime.db.prepare('SELECT count(*) n FROM send_attempts').first('n'),2);
  const resubmitted=await runtime.db.prepare('SELECT * FROM outbound_messages WHERE draft_id=?').bind(blockedDraft.id).first();assert.equal(resubmitted.status,'accepted');assert.ok(resubmitted.provider_message_id);
  eventTime=Math.max(Date.now(),released.releasedAt+1,eventTime);await queue([event('bounced','hard@example.net',resubmitted.provider_message_id,'hard')]);
  all=await list('active');hard=all.find(item=>item.address==='hard@example.net');assert.ok(hard);assert.equal(hard.status,'active');assert.ok(hard.version>released.version);assert.equal(hard.releasedAt,null);
  await page.getByRole('navigation',{name:'邮箱功能'}).getByRole('link',{name:'抑制名单',exact:true}).click();await expect(region.locator('.suppression-list>li')).toHaveCount(2);
  await expect(row('hard@example.net')).toContainText('抑制中');await expect(row('complaint@example.net')).toContainText('抑制中');
  const directory=process.env.SUPPRESSIONS_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-suppressions-qa-'));await mkdir(directory,{recursive:true});
  await page.screenshot({path:join(directory,'suppressions-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo({top:0,left:0,behavior:'instant'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(directory,'suppressions-mobile.png'),fullPage:true});
  assert.equal((await page.content()).includes('PRIVATE_PROVIDER_SUBJECT'),false);assert.equal((await page.content()).includes(token.secret),false);
  assert.deepEqual(external,[]);assert.deepEqual(unexpectedUpstream,[]);assert.deepEqual(errors,[]);assert.equal(await page.locator('vite-error-overlay').count(),0);
  console.log(`Suppression browser QA passed: ${origin}, desktop1488x1056 / mobile390x844; screenshots: ${directory}`);
});
