import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

test('Owner browser flow: create multiple mailboxes, edit, issue once, revoke, pause, retire and expire session',{timeout:120_000},async t=>{
  const port=Number(process.env.OWNER_E2E_PORT??4193);
  const origin=`http://127.0.0.1:${port}`;
  const runtime=await createOwnerRuntime({consoleOrigin:origin,port});
  let browser;
  t.after(async()=>{await browser?.close();await runtime.mf.dispose();});
  await runtime.mf.ready;
  const channel=process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'
    ?existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'chrome':'msedge':undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{})});
  const context=await browser.newContext({viewport:{width:1488,height:1056},extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':runtime.jwt}});
  const page=await context.newPage();
  const errors=[];
  let expectedAuthFailure=false;
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{
    if(message.type()!=='error' && message.type()!=='warning')return;
    if(expectedAuthFailure && /401|Unauthorized/.test(message.text()))return;
    errors.push(message.text());
  });
  await page.goto(`${origin}/owner/mailboxes`);
  await expect(page).toHaveTitle('Agent 邮箱 · Agent Mail');
  await expect(page.getByRole('heading',{name:'创建你的第一个 Agent 邮箱'})).toBeVisible();
  assert.equal(await page.locator('vite-error-overlay').count(),0);

  async function createMailbox(name,localPart,first=false) {
    if(first)await page.getByRole('button',{name:'新建邮箱',exact:true}).first().click();
    else await page.getByRole('link',{name:'新建邮箱',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'新建邮箱'});
    await dialog.getByLabel('邮箱名称',{exact:true}).fill(name);
    await dialog.getByLabel('邮箱前缀',{exact:true}).fill(localPart);
    await dialog.getByRole('button',{name:'创建邮箱',exact:true}).click();
    await expect(page).toHaveURL(/\/owner\/mailboxes\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading',{level:1})).toHaveText(name);
    return page.url().split('/').at(-1);
  }
  const research=await createMailbox('Research','research',true);
  await createMailbox('Assistant','assistant');
  await createMailbox('Monitor','monitor');
  const navigation=page.getByRole('navigation',{name:'邮箱列表'});
  await navigation.locator(`a[href="/owner/mailboxes/${research}/messages"]`).click();
  await page.getByRole('link',{name:'邮箱设置',exact:true}).click();
  await expect(page.getByRole('heading',{level:1})).toHaveText('Research');

  async function issue(name,days='30') {
    await page.getByRole('button',{name:'签发 Token',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'签发 Token',exact:true});
    await dialog.getByLabel('名称',{exact:true}).fill(name);
    await dialog.getByLabel('有效期',{exact:true}).selectOption(days);
    await dialog.getByRole('button',{name:'签发 Token',exact:true}).click();
    const result=page.getByRole('dialog',{name:'Token 已签发'});
    await expect(result).toBeVisible();
    const secret=await result.getByLabel('完整 Token',{exact:true}).inputValue();
    assert.match(secret,/^am_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
    await result.getByRole('button',{name:'我已保存'}).click();
    await expect(page.getByLabel('完整 Token',{exact:true})).toHaveCount(0);
    assert.equal((await page.content()).includes(secret),false);
    return secret;
  }
  const researchSecret=await issue('Research Agent');
  await issue('Local CLI','never');
  const oldSecret=await issue('Old Agent');
  const tokenRequest=secret=>context.request.get(`${origin}/v1/mailbox`,{headers:{Authorization:`Bearer ${secret}`}});
  assert.equal((await tokenRequest(researchSecret)).status(),200);
  await page.getByRole('button',{name:'撤销 Old Agent',exact:true}).click();
  await page.getByRole('dialog',{name:'撤销 Token'}).getByRole('button',{name:'确认撤销'}).click();
  await expect(page.getByRole('row').filter({hasText:'Old Agent'})).toContainText('已撤销');
  assert.equal((await tokenRequest(oldSecret)).status(),401);

  await page.getByLabel('邮箱名称',{exact:true}).fill('Research Updated');
  await page.getByLabel('邮件大小上限',{exact:true}).fill('2');
  await page.getByRole('button',{name:'保存更改'}).click();
  await expect(page.getByRole('heading',{level:1})).toHaveText('Research Updated');
  await page.reload();
  await expect(page.getByLabel('邮件大小上限',{exact:true})).toHaveValue('2');
  await page.getByLabel('邮箱名称',{exact:true}).fill('Research');
  await page.getByLabel('邮件大小上限',{exact:true}).fill('10');
  await page.getByRole('button',{name:'保存更改'}).click();
  await expect(page.getByRole('heading',{level:1})).toHaveText('Research');
  await page.getByRole('button',{name:'暂停邮箱'}).click();
  await expect(page.getByRole('button',{name:'恢复邮箱'})).toBeVisible();
  await expect(page.getByRole('button',{name:'签发 Token',exact:true})).toBeDisabled();
  assert.equal((await tokenRequest(researchSecret)).status(),401);
  await page.getByRole('button',{name:'恢复邮箱'}).click();
  await expect(page.getByRole('button',{name:'暂停邮箱'})).toBeVisible();
  assert.equal((await tokenRequest(researchSecret)).status(),200);
  await page.reload();
  await expect(page.getByRole('table',{name:'邮箱 Token'}).getByRole('row')).toHaveCount(4);
  assert.equal((await page.content()).includes(researchSecret),false);
  const storage=await page.evaluate(()=>`${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`);
  assert.equal(storage.includes(researchSecret),false);

  const directory=process.env.OWNER_QA_DIR??await mkdtemp(join(tmpdir(),'agent-mail-owner-qa-'));
  await mkdir(directory,{recursive:true});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:join(directory,'owner-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'签发 Token',exact:true}).click();
  await page.getByRole('dialog',{name:'签发 Token',exact:true}).getByLabel('名称',{exact:true}).fill('New Agent');
  await page.screenshot({path:join(directory,'owner-token-dialog.png'),fullPage:false});
  await page.getByRole('dialog',{name:'签发 Token',exact:true}).getByRole('button',{name:'取消'}).click();

  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.scrollTo(0,0));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile page must not overflow horizontally');
  await page.screenshot({path:join(directory,'owner-mobile.png'),fullPage:true});
  await createMailbox('Mobile Agent','mobile-agent');
  await page.getByRole('button',{name:'退役邮箱',exact:true}).click();
  const retire=page.getByRole('dialog',{name:'退役邮箱',exact:true});
  await retire.getByLabel('输入完整邮箱地址以确认').fill('mobile-agent@agent.example.com');
  await retire.getByRole('button',{name:'确认退役'}).click();
  await expect(page).toHaveURL(`${origin}/owner/mailboxes`);
  await expect(page.getByRole('main').getByText('Mobile Agent',{exact:true})).toHaveCount(0);
  await page.getByRole('navigation',{name:'邮箱列表'}).locator(`a[href="/owner/mailboxes/${research}/messages"]`).click();
  await page.getByRole('link',{name:'邮箱设置',exact:true}).click();

  expectedAuthFailure=true;
  await context.setExtraHTTPHeaders({});
  await page.getByRole('button',{name:'签发 Token',exact:true}).click();
  const expiredDialog=page.getByRole('dialog',{name:'签发 Token',exact:true});
  await expiredDialog.getByLabel('名称',{exact:true}).fill('Expired session');
  await expiredDialog.getByRole('button',{name:'签发 Token',exact:true}).click();
  await expect(expiredDialog.getByRole('alert')).toHaveText('登录状态已失效，请重新打开控制台登录。');
  assert.deepEqual(errors,[],'no console warnings/errors or page runtime errors');
  console.log(`Browser QA passed: desktop 1488x1056, mobile 390x844; screenshots: ${directory}`);
});
