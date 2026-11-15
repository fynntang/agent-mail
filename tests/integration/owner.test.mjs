import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPair} from 'jose';
import {createHash} from 'node:crypto';
import {createOwnerRuntime} from '../helpers/owner-runtime.mjs';

test('real Access JWT protects every Owner page/API and every management write Origin',{timeout:120_000},async t=>{
  const runtime=await createOwnerRuntime();t.after(()=>runtime.mf.dispose());
  const {request,sign,mf}=runtime;
  assert.equal((await request('/owner/mailboxes',{authenticated:false})).status,401);
  for(const path of ['/own%65r/api/mailboxes','/own%65r/api/setup/checks']) {
    assert.ok([401,404].includes((await request(path,{authenticated:false})).status),'encoded route must not bypass Owner authentication');
  }
  assert.equal((await request('/owner/api/mailboxes',{authenticated:false,headers:{'Cf-Access-Authenticated-User-Email':'owner@example.com','X-Owner':'true'}})).status,401);
  const claims=[{aud:'wrong-app'},{iss:'https://wrong.cloudflareaccess.com'},{email:'someone@example.com'},
    {exp:Math.floor(Date.now()/1000)-30},{exp:undefined},{nbf:Math.floor(Date.now()/1000)+3600}];
  for(const claim of claims) {
    const response=await request('/owner/api/mailboxes',{headers:{'Cf-Access-Jwt-Assertion':await sign(claim)}});
    assert.equal(response.status,401,JSON.stringify(claim));
  }
  const otherKeys=await generateKeyPair('RS256');
  for(const jwt of [await sign({},otherKeys.privateKey),await sign({},undefined,'unknown-key'),'not-a-jwt']) {
    assert.equal((await request('/owner/api/mailboxes',{headers:{'Cf-Access-Jwt-Assertion':jwt}})).status,401);
  }
  for(const origin of ['https://evil.example','null','https://console.example.com.evil.example','']) {
    const response=await request('/owner/api/mailboxes',{method:'POST',body:{name:'Denied',localPart:'denied'},headers:{Origin:origin}});
    assert.equal(response.status,403,origin);
  }
  const missingOrigin=await mf.dispatchFetch('https://console.example.com/owner/api/mailboxes',{method:'POST',
    headers:{'Cf-Access-Jwt-Assertion':runtime.jwt,'Content-Type':'application/json'},body:'{"name":"Denied","localPart":"denied"}'});
  assert.equal(missingOrigin.status,403);
  assert.equal((await request('/owner/api/mailboxes',{method:'POST',authenticated:false,body:{name:'Denied',localPart:'denied'}})).status,401);
  const valid=await request('/owner/mailboxes');
  assert.equal(valid.status,200,await valid.clone().text());
  assert.match(valid.headers.get('cache-control'),/no-store/);
  assert.equal(valid.headers.get('x-frame-options'),'DENY');
  assert.match(await valid.text(),/创建你的第一个 Agent 邮箱/);
  const unauthenticatedHtml=await mf.dispatchFetch('https://console.example.com/owner/mailboxes',{headers:{Accept:'text/html'}});
  assert.equal(unauthenticatedHtml.status,401);assert.match(await unauthenticatedHtml.text(),/需要 Owner 身份/);
  const checks=await request('/owner/api/setup/checks');
  assert.deepEqual(await checks.json(),{d1:'migrated',r2:'connected'});
  assert.equal(await runtime.db.prepare('SELECT count(*) n FROM mailboxes').first('n'),0);
});

test('Owner manages multiple mailboxes and one-time read tokens; revoke/pause/retire take effect immediately',{timeout:120_000},async t=>{
  const {mf,db,request}=await createOwnerRuntime();t.after(()=>mf.dispose());
  async function create(name,localPart) {
    const response=await request('/owner/api/mailboxes',{method:'POST',body:{name,localPart}});
    assert.equal(response.status,201,await response.clone().text());return (await response.json()).mailbox;
  }
  const a=await create('Research','Research');
  const b=await create('Assistant','assistant');
  assert.equal(a.address,'research@agent.example.com');
  assert.equal((await (await request('/owner/api/mailboxes')).json()).mailboxes.length,2);
  assert.equal((await request('/owner/api/mailboxes',{method:'POST',body:{name:'Duplicate',localPart:'research'}})).status,409);
  assert.equal(await db.prepare('SELECT count(*) n FROM mailboxes').first('n'),2);
  for(const body of [{name:'x',localPart:'a@evil.example'},{name:' ',localPart:'x'},{name:'x',localPart:'x',status:'deleted'}]) {
    assert.equal((await request('/owner/api/mailboxes',{method:'POST',body})).status,400);
  }
  const base=`/owner/api/mailboxes/${a.id}`;
  for(const scopes of [[],['mail:send'],['owner'],['*'],['mail:read','mail:read']]) {
    assert.equal((await request(`${base}/tokens`,{method:'POST',body:{name:'Bad',scopes}})).status,400);
  }
  assert.equal((await request(`${base}/tokens`,{method:'POST',body:{name:'Expired',scopes:['mail:read'],expiresAt:Date.now()-1}})).status,400);
  const issued=await request(`${base}/tokens`,{method:'POST',body:{name:'Research Agent',scopes:['mail:read'],expiresAt:Date.now()+86400000}});
  assert.equal(issued.status,201);assert.match(issued.headers.get('cache-control'),/no-store/);
  const {secret,token}=await issued.json();
  assert.match(secret,/^am_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(token.scopes,['mail:read']);
  const stored=await db.prepare('SELECT * FROM mailbox_tokens WHERE id=?').bind(token.id).first();
  assert.equal(stored.secret_sha256,createHash('sha256').update(secret).digest('hex'));
  assert.equal(JSON.stringify(stored).includes(secret),false);
  const bearer=()=>mf.dispatchFetch('https://api.example.com/v1/mailbox',{headers:{Authorization:`Bearer ${secret}`}});
  assert.equal((await bearer()).status,200);
  assert.equal((await mf.dispatchFetch('https://console.example.com/owner/api/mailboxes',{headers:{Authorization:`Bearer ${secret}`}})).status,401);
  const listText=await (await request(`${base}/tokens`)).text();
  assert.equal(listText.includes(secret),false);assert.equal(listText.includes('secret_sha256'),false);
  const html=await (await request(`/owner/mailboxes/${a.id}`)).text();
  assert.match(html,/Research Agent/);assert.equal(html.includes(secret),false);assert.equal(html.includes(stored.secret_sha256),false);
  assert.equal((await request(`/owner/api/mailboxes/${b.id}/tokens/${token.id}`,{method:'DELETE'})).status,404);
  assert.equal((await bearer()).status,200);
  let response=await request(base,{method:'PATCH',body:{name:'Research Updated',status:'paused',maxMessageBytes:2097152,expectedUpdatedAt:a.updatedAt}});
  assert.equal(response.status,200);let mailbox=(await response.json()).mailbox;
  assert.equal(mailbox.name,'Research Updated');assert.equal(mailbox.maxMessageBytes,2097152);
  assert.equal((await bearer()).status,401);
  assert.equal((await request(`${base}/tokens`,{method:'POST',body:{name:'Paused',scopes:['mail:read']}})).status,409);
  assert.equal((await request(base,{method:'PATCH',body:{name:'Stale',expectedUpdatedAt:a.updatedAt}})).status,409);
  assert.equal((await request(base,{method:'PATCH',body:{status:'deleted',expectedUpdatedAt:mailbox.updatedAt}})).status,400);
  response=await request(base,{method:'PATCH',body:{status:'active',expectedUpdatedAt:mailbox.updatedAt}});
  mailbox=(await response.json()).mailbox;assert.equal((await bearer()).status,200);
  const revoked=await request(`${base}/tokens/${token.id}`,{method:'DELETE'});assert.equal(revoked.status,200);
  const revokedAt=(await revoked.json()).token.revokedAt;
  assert.equal((await bearer()).status,401);
  assert.equal((await (await request(`${base}/tokens/${token.id}`,{method:'DELETE'})).json()).token.revokedAt,revokedAt);
  assert.equal(await db.prepare("SELECT count(*) n FROM audit_events WHERE action='token.revoked'").first('n'),1);
  const second=(await (await request(`${base}/tokens`,{method:'POST',body:{name:'Retire me',scopes:['mail:read'],expiresAt:null}})).json());
  assert.equal((await request(base,{method:'DELETE',body:{confirmAddress:'wrong',expectedUpdatedAt:mailbox.updatedAt}})).status,400);
  assert.equal((await request(base,{method:'DELETE',body:{confirmAddress:a.address,expectedUpdatedAt:a.updatedAt}})).status,409);
  assert.equal((await request(base,{method:'DELETE',body:{confirmAddress:a.address,expectedUpdatedAt:mailbox.updatedAt}})).status,204);
  assert.equal((await request(base)).status,404);
  assert.equal((await mf.dispatchFetch('https://api.example.com/v1/mailbox',{headers:{Authorization:`Bearer ${second.secret}`}})).status,401);
  assert.equal(await db.prepare('SELECT status FROM mailbox_addresses WHERE mailbox_id=?').bind(a.id).first('status'),'retired');
  assert.equal((await request('/owner/api/mailboxes',{method:'POST',body:{name:'Reuse',localPart:'research'}})).status,409);
  const audits=await db.prepare('SELECT * FROM audit_events').all();
  assert.equal(JSON.stringify(audits).includes(secret),false);assert.equal(JSON.stringify(audits).includes(second.secret),false);
  assert.equal((await (await request('/owner/api/mailboxes')).json()).mailboxes.length,1);
});
