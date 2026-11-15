import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

test('Setup browser flow: public bootstrap, authenticated storage probe and pending-to-ready initialization',{timeout:120_000},async t=>{
  const port=Number(process.env.SETUP_E2E_PORT??4197);
  const origin=`http://127.0.0.1:${port}`;
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port});
  let browser;
  t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  await runtime.mf.ready;

  const bootstrap=await runtime.request('/setup',{authenticated:false});
  assert.equal(bootstrap.status,200);
  const bootstrapHtml=await bootstrap.text();
  assert.match(bootstrapHtml,/pnpm deploy:setup/);
  assert.match(bootstrapHtml,/\/owner\/setup/);
  const initial=await (await runtime.request('/owner/api/setup')).json();
  for(const value of [initial.setup.config.mailDomain,initial.setup.config.apiOrigin,runtime.ownerEmail,runtime.issuer,runtime.audience]) {
    assert.equal(bootstrapHtml.includes(value),false,'The anonymous bootstrap must not render instance configuration');
  }
  assert.equal((await runtime.request('/owner/setup',{authenticated:false})).status,401);
  assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM instance_settings').first()).count,0);

  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'
    ?existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge':undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{})});
  const context=await browser.newContext({viewport:{width:1488,height:1056},extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':runtime.jwt}});
  const page=await context.newPage();
  const errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
  page.on('request',request=>{if(new URL(request.url()).origin!==origin)external.push(request.url());});

  await page.goto(`${origin}/owner/setup`);
  await expect(page).toHaveTitle('初始化向导 · Agent Mail');
  await expect(page.getByRole('heading',{name:'初始化向导',exact:true})).toBeVisible();
  await expect(page.getByText('待初始化',{exact:true})).toBeVisible();
  await expect(page.getByText('结构检查通过',{exact:true})).toBeVisible();
  await expect(page.getByText(/需要的迁移：/)).toContainText('0003_setup.sql');
  const finish=page.getByRole('button',{name:'完成初始化',exact:true});
  await expect(finish).toBeDisabled();
  await expect(page.getByRole('button',{name:'检查存储读写',exact:true})).toBeEnabled();
  assert.equal((await runtime.db.prepare('SELECT count(*) AS count FROM instance_settings').first()).count,0);

  await page.getByRole('button',{name:'检查存储读写',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('存储读写检查通过，临时探针已清理。');
  assert.deepEqual((await runtime.bucket.list()).objects,[]);

  await page.getByLabel('实例名称',{exact:true}).fill('Personal Agents');
  const checks=[
    '我已在 Cloudflare 确认邮件域名和 DNS，不会覆盖现有个人邮箱配置。',
    '我已在 Cloudflare 确认控制台 Access 覆盖范围、Owner 策略和 API 域名分离。',
    '我已在 Cloudflare 确认 Email Routing 的 DNS、地址规则和目标 Worker。',
    '我已在 Cloudflare 确认 Email Sending、发送域名、DNS 和账户发送限制。'
  ];
  for(const label of checks)await page.getByRole('checkbox',{name:label,exact:true}).check();
  await expect(finish).toBeDisabled();
  await page.getByRole('button',{name:'保存确认记录',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('确认记录已保存。');
  let settings=await runtime.db.prepare('SELECT * FROM instance_settings WHERE id=1').first();
  assert.equal(settings.display_name,'Personal Agents');
  assert.equal(settings.setup_state,'pending');
  assert.deepEqual(JSON.parse(settings.setup_checks_json),{mailDomain:true,access:true,emailRouting:true,emailSending:true});
  assert.match(settings.setup_config_sha256,/^[0-9a-f]{64}$/);
  await expect(finish).toBeDisabled();

  await page.getByRole('link',{name:'创建或管理邮箱',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'新建邮箱',exact:true});
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('邮箱名称',{exact:true}).fill('Personal Assistant');
  await dialog.getByLabel('邮箱前缀',{exact:true}).fill('assistant');
  await dialog.getByRole('button',{name:'创建邮箱',exact:true}).click();
  await expect(page).toHaveURL(/\/owner\/mailboxes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading',{level:1})).toHaveText('Personal Assistant');
  await page.getByRole('link',{name:'初始化',exact:true}).click();
  await expect(page.getByRole('heading',{name:'初始化向导',exact:true})).toBeVisible();
  await expect(page.getByLabel('实例名称',{exact:true})).toHaveValue('Personal Agents');
  for(const label of checks)await expect(page.getByRole('checkbox',{name:label,exact:true})).toBeChecked();
  await expect(page.getByText('1 个启用邮箱',{exact:true})).toBeVisible();
  await expect(finish).toBeEnabled();
  await finish.click();
  await expect(page.getByRole('status')).toHaveText('初始化记录已完成。请继续从独立邮箱进行真实收发验收。');
  await expect(page.getByText('向导已完成',{exact:true})).toBeVisible();
  settings=await runtime.db.prepare('SELECT * FROM instance_settings WHERE id=1').first();
  assert.equal(settings.setup_state,'ready');
  assert.deepEqual((await runtime.bucket.list()).objects,[]);
  for(const table of ['mailbox_tokens','messages','outbound_messages','oauth_grants']) {
    assert.equal((await runtime.db.prepare(`SELECT count(*) AS count FROM ${table}`).first()).count,0,`Setup must not create ${table}`);
  }

  await page.reload();
  await expect(page.getByText('向导已完成',{exact:true})).toBeVisible();
  await expect(page.getByLabel('实例名称',{exact:true})).toHaveValue('Personal Agents');
  const directory=process.env.SETUP_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-setup-qa-'));
  await mkdir(directory,{recursive:true});
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:join(directory,'setup-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('heading',{name:'初始化向导',exact:true})).toBeVisible();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(directory,'setup-mobile.png'),fullPage:true});
  assert.equal(await page.locator('vite-error-overlay').count(),0);
  assert.deepEqual(errors,[]);
  assert.deepEqual(external,[]);
  console.log(`Setup browser QA passed: ${origin}, desktop 1488x1056 / mobile 390x844; screenshots: ${directory}`);
});
