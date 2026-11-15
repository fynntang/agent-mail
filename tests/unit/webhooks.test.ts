import {readFile,readdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {createWebhookEndpoint,listWebhookEndpoints,updateWebhookEndpoint,rotateWebhookSecret,listMailEvents,webhookPayload} from '../../src/lib/server/core/webhooks';
import {webhookConfigured,newWebhookSecret,encryptWebhookSecret,decryptWebhookSecret,signWebhook,validateWebhookUrl} from '../../src/lib/server/core/webhook-crypto';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

const ring={activeKid:'k1',keys:{k1:'A'.repeat(43)}};
let mf:Miniflare,ctx:OwnerContext;
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:{DB:'webhooks-core'},r2Buckets:{MAIL_BLOBS:'webhooks-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(n=>/^\d+.*\.sql$/.test(n)).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(sql=>db.prepare(sql)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',WEBHOOK_KEYRING:JSON.stringify(ring)} as unknown as RuntimeEnv,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterAll(async()=>{await mf?.dispose();});
const box=()=>createMailbox(ctx,{name:'Webhook',localPart:`hook-${crypto.randomUUID()}`});
it('wraps secrets with authenticated scope/version and retains old wrapping keys during rotation',async()=>{
  const secret=newWebhookSecret(),mailbox=crypto.randomUUID(),endpoint=crypto.randomUUID();
  const encrypted=await encryptWebhookSecret(ctx.env,mailbox,endpoint,1,secret),other=await encryptWebhookSecret(ctx.env,mailbox,endpoint,1,secret);
  expect(encrypted).not.toContain(secret);expect(encrypted).not.toBe(other);
  expect(await decryptWebhookSecret(ctx.env,mailbox,endpoint,1,encrypted)).toBe(secret);
  const changed={...ctx.env,WEBHOOK_KEYRING:JSON.stringify({activeKid:'k2',keys:{...ring.keys,k2:Buffer.alloc(32,1).toString('base64url')}})};
  expect(await decryptWebhookSecret(changed,mailbox,endpoint,1,encrypted)).toBe(secret);
  for(const [b,e,v] of [[crypto.randomUUID(),endpoint,1],[mailbox,crypto.randomUUID(),1],[mailbox,endpoint,2]] as const)await expect(decryptWebhookSecret(ctx.env,b,e,v,encrypted)).rejects.toMatchObject({code:'webhook_secret_unavailable'});
  const missing={...ctx.env,WEBHOOK_KEYRING:JSON.stringify({activeKid:'k2',keys:{k2:Buffer.alloc(32,1).toString('base64url')}})};
  await expect(decryptWebhookSecret(missing,mailbox,endpoint,1,encrypted)).rejects.toMatchObject({code:'webhook_secret_unavailable'});
});
it('fails closed for malformed keyrings and computes independently verifiable HMAC over exact bytes',async()=>{
  for(const value of ['', '{}',JSON.stringify({activeKid:'k1',keys:{k1:'bad'}}),JSON.stringify({activeKid:'missing',keys:ring.keys}),JSON.stringify({...ring,extra:'no'})])expect(webhookConfigured({...ctx.env,WEBHOOK_KEYRING:value})).toBe(false);
  const secret=newWebhookSecret(),body='{"text":"你好 😀"}',timestamp='1794614400',id=crypto.randomUUID();
  expect(await signWebhook(secret,timestamp,id,body)).toBe(createHmac('sha256',secret).update(`${timestamp}.${id}.${body}`).digest('hex'));
  expect(await signWebhook(secret,timestamp,id,body+' ')).not.toBe(await signWebhook(secret,timestamp,id,body));
});
it('rejects non-public URL forms and app origins before storing any endpoint',()=>{
  for(const value of ['http://hooks.example.net/','https://127.0.0.1/','https://[::1]/','https://localhost/x','https://foo.internal/x','https://console.example.com/owner','https://api.example.com/v1','https://hooks.example.net:8443/','https://u:p@hooks.example.net/','https://hooks.example.net/#','https://hooks.example.net/#fragment'])expect(()=>validateWebhookUrl(ctx.env,value)).toThrowError('invalid_webhook_url');
  expect(validateWebhookUrl(ctx.env,'https://hooks.example.net/notify?key=value')).toBe('https://hooks.example.net/notify?key=value');
});
it('protects management with Owner-only writes, CAS, terminal disable and secret-free read DTOs',async()=>{
  const mailbox=await box(),created=await createWebhookEndpoint(ctx,mailbox.id,{url:'https://hooks.example.net/?secret=query',eventTypes:['message.received']});
  expect(created.secret).toMatch(/^whsec_/);expect(created.endpoint.secretVersion).toBe(1);
  expect(JSON.stringify(await listWebhookEndpoints(ctx,mailbox.id))).not.toContain(created.secret);
  const stored=await ctx.env.DB.prepare('SELECT signing_secret_ciphertext FROM webhook_endpoints WHERE id=?').bind(created.endpoint.id).first<string>('signing_secret_ciphertext');expect(stored).not.toContain(created.secret);
  const rotated=await rotateWebhookSecret(ctx,mailbox.id,created.endpoint.id,{expectedUpdatedAt:created.endpoint.updatedAt});expect(rotated.secret).not.toBe(created.secret);expect(rotated.endpoint.secretVersion).toBe(2);
  await expect(updateWebhookEndpoint(ctx,mailbox.id,created.endpoint.id,{expectedUpdatedAt:created.endpoint.updatedAt,status:'paused'})).rejects.toMatchObject({code:'webhook_changed'});
  const disabled=await updateWebhookEndpoint(ctx,mailbox.id,created.endpoint.id,{expectedUpdatedAt:rotated.endpoint.updatedAt,status:'disabled'});
  await expect(updateWebhookEndpoint(ctx,mailbox.id,created.endpoint.id,{expectedUpdatedAt:disabled.endpoint.updatedAt,status:'active'})).rejects.toMatchObject({code:'webhook_disabled'});
  await expect(createWebhookEndpoint({...ctx,actor:null},mailbox.id,{url:'https://hooks.example.net/',eventTypes:['message.received']})).rejects.toMatchObject({status:401});
});
it('projects only stable resource fields and binds event cursors to a mailbox',async()=>{
  const first=await box(),second=await box();
  for(let i=0;i<3;i++)await ctx.env.DB.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES(?,?,'app',?,'message.received',?,?,?)`)
    .bind(crypto.randomUUID(),first.id,crypto.randomUUID(),JSON.stringify({messageId:crypto.randomUUID(),subject:'PRIVATE',body:'PRIVATE',bcc:['PRIVATE']}),i,i).run();
  const page=await listMailEvents(ctx,first.id,{limit:1});expect(page.events).toHaveLength(1);expect(page.nextCursor).toBeTruthy();expect(JSON.stringify(page)).not.toContain('PRIVATE');
  expect((await listMailEvents(ctx,first.id,{limit:1,cursor:page.nextCursor})).events[0].id).not.toBe(page.events[0].id);
  await expect(listMailEvents(ctx,second.id,{cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  expect(webhookPayload({id:crypto.randomUUID(),mailbox_id:first.id,source:'app',type:'outbound.delivered',payload_json:'{}',occurred_at:0,created_at:0})).toBeNull();
});
it('projects operational alerts from app events with a fixed safe payload and error allowlist',()=>{
  const id=crypto.randomUUID(),mailbox=crypto.randomUUID(),alertId=crypto.randomUUID();
  const row={id,mailbox_id:mailbox,source:'app',type:'cloudflare.suppression.alert.created',occurred_at:1,created_at:1,
    payload_json:JSON.stringify({alertId,kind:'release',status:'open',outcome:'unknown',errorCode:'cloudflare_delete_unknown',recipient:'PRIVATE',sourceId:'PRIVATE',token:'PRIVATE'})};
  const payload=JSON.parse(webhookPayload(row)!);
  expect(payload.data).toEqual({alertId,kind:'release',status:'open',outcome:'unknown',errorCode:'cloudflare_delete_unknown'});
  expect(JSON.stringify(payload)).not.toContain('PRIVATE');
  expect(webhookPayload({...row,source:'cloudflare'})).toBeNull();
  expect(webhookPayload({...row,payload_json:JSON.stringify({...payload.data,errorCode:'PRIVATE provider error'})})).not.toContain('PRIVATE');
  for(const data of [{...payload.data,alertId:'bad'},{...payload.data,status:'resolved'},{...payload.data,outcome:'resolved'}])
    expect(webhookPayload({...row,payload_json:JSON.stringify(data)})).toBeNull();
  const resolved=JSON.parse(webhookPayload({...row,type:'cloudflare.suppression.alert.resolved',payload_json:JSON.stringify({...payload.data,status:'resolved',outcome:'resolved'})})!);
  expect(resolved.data).toEqual({alertId,kind:'release',status:'resolved',outcome:'resolved'});
});
it('upgrades legacy tables without losing approvals and cancels rows that have no verified delivery snapshot',async()=>{
  const db=new DatabaseSync(':memory:');try{
    db.exec('PRAGMA foreign_keys=ON');
    const names=(await readdir('migrations')).filter(n=>/^\d+.*\.sql$/.test(n)).sort();
    for(const name of names.filter(n=>n<'0006_webhooks.sql'))db.exec(await readFile(`migrations/${name}`,'utf8'));
    db.exec("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('b','Box',1,1); INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES('e','b','app','e','message.received','{}',1,1); INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,created_at) VALUES('w','b','https://hooks.example.net/','[]','{}',1); INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,available_at,signed_secret_version,signing_secret_ciphertext,created_at) VALUES('d','b','w','e',1,1,'{}',1)");
    const hash='a'.repeat(64);
    db.prepare("INSERT INTO objects(id,mailbox_id,object_key,purpose,state,size_bytes,sha256,content_type,created_at,ready_at) VALUES('o','b','b/draft/o','draft','ready',2,?,'application/json',1,1)").run(hash);
    db.prepare("INSERT INTO drafts(id,mailbox_id,content_object_id,state,content_sha256,approved_version,approved_sha256,approved_at,created_at,updated_at) VALUES('draft','b','o','approved',?,1,?,1,1,1)").run(hash,hash);
    db.exec(await readFile('migrations/0006_webhooks.sql','utf8'));
    expect(db.prepare('SELECT webhook_published_at FROM events').get()).toMatchObject({webhook_published_at:1});
    expect(db.prepare('SELECT state,last_error_code FROM webhook_deliveries').get()).toMatchObject({state:'cancelled',last_error_code:'legacy_snapshot_unavailable'});
    expect(db.prepare('SELECT state,approved_version,approved_sha256 FROM drafts').get()).toMatchObject({state:'approved',approved_version:1,approved_sha256:hash});
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{db.close();}
});
