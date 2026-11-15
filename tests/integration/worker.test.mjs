import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { parseJsonc } from '../../scripts/sync-svelte-config.mjs';

const config = parseJsonc(await readFile('wrangler.jsonc','utf8'));
const eml = await readFile(new URL('../fixtures/inbound.eml',import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');

async function createRuntime() {
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers:[{
    name:'agent-mail-test', modules:true, scriptPath:resolve('dist/worker/entry.js'),
    compatibilityDate:config.compatibility_date,
    compatibilityFlags:config.compatibility_flags,
    bindings:config.vars,
    d1Databases:{DB:'agent-mail-test-db'}, r2Buckets:{MAIL_BLOBS:'agent-mail-test-blobs'},
    email:{send_email:[{name:'EMAIL'}]},
    assets:{directory:resolve('.svelte-kit/cloudflare'),binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true}}
    }],
    unsafeTriggerHandlers:true,
    log:new Log(LogLevel.ERROR)
  }));
  const db = await mf.getD1Database('DB');
  for(const migration of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${migration}`,'utf8')).map(statement=>db.prepare(statement)));
  }
  return {mf,db,bucket:await mf.getR2Bucket('MAIL_BLOBS')};
}

async function seedMailbox(db,address,name='Research') {
  const id=randomUUID(), tokenId=randomUUID();
  const token=`am_${tokenId}_${randomBytes(32).toString('base64url')}`;
  const now=Date.now();
  await db.batch([
    db.prepare('INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(id,name,now,now),
    db.prepare('INSERT INTO mailbox_addresses(id,mailbox_id,address,is_primary,created_at) VALUES(?,?,?,1,?)').bind(randomUUID(),id,address,now),
    db.prepare('INSERT INTO mailbox_tokens(id,mailbox_id,name,secret_sha256,created_at) VALUES(?,?,?,?,?)')
      .bind(tokenId,id,'integration test',digest(token),now)
  ]);
  return {id,token,tokenId};
}

function deliver(mf,body=eml,to='research@agent.example.com') {
  return mf.dispatchFetch(`http://localhost/cdn-cgi/local/email?from=sender%40example.net&to=${encodeURIComponent(to)}&format=json`,
    {method:'POST',headers:{'Content-Type':'message/rfc822'},body});
}

test('cold email → real R2/D1 → native scheduled → authenticated SvelteKit API',{timeout:120_000},async(t)=>{
  const {mf,db,bucket}=await createRuntime();
  t.after(()=>mf.dispose());
  const first=await seedMailbox(db,'research@agent.example.com');
  const second=await seedMailbox(db,'other@agent.example.com','Other');

  // No HTTP application request precedes this native email event.
  const delivery=await deliver(mf);
  assert.equal(delivery.status,200,await delivery.clone().text());
  assert.equal((await delivery.json()).outcome,'ok');
  const receipt=await db.prepare('SELECT r.*,o.object_key,o.sha256 FROM ingest_receipts r JOIN objects o ON o.id=r.raw_object_id').first();
  assert.equal(receipt.status,'stored');
  const stored=await bucket.get(receipt.object_key);
  assert.equal(digest(Buffer.from(await stored.arrayBuffer())),digest(eml));
  assert.equal(receipt.sha256,digest(eml));
  assert.equal(await db.prepare("SELECT count(*) n FROM jobs WHERE kind='parse_email' AND state='pending'").first('n'),1);

  const worker=await mf.getWorker();
  assert.equal((await worker.scheduled({cron:'* * * * *'})).outcome,'ok');
  assert.equal(await db.prepare("SELECT count(*) n FROM jobs WHERE state='done'").first('n'),1);
  const message=await db.prepare('SELECT * FROM messages').first();
  assert.equal(message.mailbox_id,first.id);
  assert.equal(message.subject,'Local agent mail test');
  assert.equal(message.preview,'Hello from the local email event.');
  assert.equal(await db.prepare('SELECT status FROM ingest_receipts WHERE id=?').bind(receipt.id).first('status'),'indexed');
  assert.equal(await db.prepare('SELECT count(*) n FROM attachments').first('n'),1);
  const bodyObject=await db.prepare('SELECT object_key FROM objects WHERE id=?').bind(message.body_object_id).first();
  const body=JSON.parse(await (await bucket.get(bodyObject.object_key)).text());
  assert.match(body.text,/Hello from the local email event/);
  assert.equal(body.attachmentsExtracted,true);

  // Reprocessing the same receipt must not duplicate messages, addresses or events.
  await db.prepare('UPDATE messages SET is_read=1 WHERE id=?').bind(message.id).run();
  await db.prepare("UPDATE jobs SET state='pending',available_at=? WHERE id=?").bind(Date.now(),receipt.id).run();
  await worker.scheduled();
  assert.equal(await db.prepare('SELECT count(*) n FROM messages').first('n'),1);
  assert.equal(await db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read'),1);
  assert.equal(await db.prepare('SELECT count(*) n FROM events').first('n'),1);

  const auth={authorization:`Bearer ${first.token}`};
  const response=await mf.dispatchFetch('https://api.example.com/v1/messages',{headers:auth});
  assert.equal(response.status,200,await response.clone().text());
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal((await response.json()).messages[0].id,message.id);
  const isolated=await mf.dispatchFetch(`https://api.example.com/v1/messages?mailboxId=${first.id}`,{
    headers:{authorization:`Bearer ${second.token}`}
  });
  assert.deepEqual((await isolated.json()).messages,[]);
  assert.equal((await mf.dispatchFetch('https://api.example.com/v1/messages')).status,401);
  const invalidToken=first.token.slice(0,-1)+(first.token.endsWith('a')?'b':'a');
  assert.equal((await mf.dispatchFetch('https://api.example.com/v1/messages',{headers:{authorization:`Bearer ${invalidToken}`}})).status,401);
  assert.equal((await mf.dispatchFetch('https://api.example.com/v1/messages',{headers:{...auth,Origin:'https://evil.example'}})).status,403);
  const mailboxResponse=await mf.dispatchFetch('https://api.example.com/v1/mailbox',{headers:auth});
  const mailboxData=await mailboxResponse.json();
  assert.equal(mailboxData.mailbox.id,first.id);
  assert.equal(mailboxData.capabilities.attachmentExtraction,true);
  assert.equal(mailboxData.capabilities.outboundEmail,true);
  assert.equal((await mf.dispatchFetch('https://api.example.com/mcp',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{}'})).status,406);
  assert.equal((await mf.dispatchFetch('https://api.example.com/mcp',{headers:auth})).status,405);
  await db.prepare('UPDATE mailbox_tokens SET can_read=0,can_draft=1 WHERE id=?').bind(first.tokenId).run();
  assert.equal((await mf.dispatchFetch('https://api.example.com/v1/messages',{headers:auth})).status,403);
  await db.prepare('UPDATE mailbox_tokens SET revoked_at=? WHERE id=?').bind(Date.now(),first.tokenId).run();
  assert.equal((await mf.dispatchFetch('https://api.example.com/v1/messages',{headers:auth})).status,401);
  await db.prepare('UPDATE mailbox_tokens SET expires_at=created_at+1 WHERE id=?').bind(second.tokenId).run();
  assert.equal((await mf.dispatchFetch('https://api.example.com/v1/messages',{headers:{authorization:`Bearer ${second.token}`}})).status,401);

  const health=await mf.dispatchFetch('http://localhost/healthz');
  assert.deepEqual(await health.json(),{status:'ok',service:'agent-mail'});
  const page=await mf.dispatchFetch('http://localhost/');
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Agent Mail/);
  assert.match(html,/基础服务已就绪/);
  const assetPath=html.match(/(?:src|href)="([^"\s]*_app\/immutable\/[^"\s]+\.js)"/)?.[1];
  assert.ok(assetPath,'SSR page must reference a real client JavaScript asset');
  assert.equal((await mf.dispatchFetch(new URL(assetPath,'http://localhost/'))).status,200);
  assert.equal((await mf.dispatchFetch('http://localhost/_worker.js')).status,404,'server entry must not be public static content');
  const owner=await mf.dispatchFetch('http://localhost/owner/api/setup/checks',{headers:{'X-Owner':'true'}});
  assert.equal(owner.status,503);
  assert.equal((await owner.json()).error.code,'owner_not_configured');

  const rejected=await deliver(mf,eml,'missing@agent.example.com');
  assert.match((await rejected.json()).rejectReason,/Unknown or inactive/);
  await db.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(first.id).run();
  assert.match((await (await deliver(mf)).json()).rejectReason,/inactive/);
  assert.equal(await db.prepare('SELECT count(*) n FROM ingest_receipts').first('n'),1);
});

test('D1 finalization failure after R2 write is reconciled; duplicate Message-ID deliveries are retained',{timeout:120_000},async(t)=>{
  const {mf,db,bucket}=await createRuntime(); t.after(()=>mf.dispose());
  const mailbox=await seedMailbox(db,'research@agent.example.com');
  await db.prepare("CREATE TRIGGER test_fail_enqueue BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'injected_finalize_failure'); END;").run();
  const delivery=await deliver(mf);
  assert.equal(delivery.status,500);
  const receipt=await db.prepare('SELECT r.*,o.object_key FROM ingest_receipts r JOIN objects o ON o.id=r.raw_object_id').first();
  assert.equal(receipt.status,'pending_blob');
  assert.ok(await bucket.head(receipt.object_key));
  assert.equal(await db.prepare('SELECT count(*) n FROM jobs').first('n'),0);
  await db.prepare('DROP TRIGGER test_fail_enqueue').run();
  await db.prepare('UPDATE ingest_receipts SET received_at=? WHERE id=?').bind(Date.now()-60_000,receipt.id).run();
  const worker=await mf.getWorker();
  assert.equal((await worker.scheduled()).outcome,'ok');
  assert.equal(await db.prepare('SELECT status FROM ingest_receipts WHERE id=?').bind(receipt.id).first('status'),'indexed');
  assert.equal(await db.prepare('SELECT count(*) n FROM messages').first('n'),1);
  assert.equal((await deliver(mf)).status,200);
  await worker.scheduled();
  assert.equal(await db.prepare('SELECT count(*) n FROM messages WHERE rfc_message_id=?').bind('<local-test@example.net>').first('n'),2);
  // Unsupported outbound work is neither completed nor submitted by this scheduler.
  await db.prepare("INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,available_at,created_at) VALUES(?,?,'send_email','no-send',?,?)")
    .bind(randomUUID(),mailbox.id,Date.now(),Date.now()).run();
  await worker.scheduled();
  assert.equal(await db.prepare("SELECT state FROM jobs WHERE kind='send_email'").first('state'),'dead');
});

test('cold scheduled handles no jobs and reclaims an expired parse lease',{timeout:120_000},async(t)=>{
  const {mf,db}=await createRuntime(); t.after(()=>mf.dispose());
  const worker=await mf.getWorker();
  assert.equal((await worker.scheduled()).outcome,'ok');
  const mailbox=await seedMailbox(db,'research@agent.example.com');
  const now=Date.now();
  await db.prepare(`INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,payload_json,state,available_at,lease_token,lease_until,attempts,max_attempts,created_at)
    VALUES(?,?,'parse_email','expired','{}','running',?,'old-lease',?,1,1,?)`).bind(randomUUID(),mailbox.id,now,now-1,now).run();
  await worker.scheduled();
  const job=await db.prepare("SELECT * FROM jobs WHERE dedupe_key='expired'").first();
  assert.equal(job.state,'dead'); assert.equal(job.lease_token,null); assert.equal(job.last_error_code,'lease_expired');
});
