import {readFile,readdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import {encryptWebhookSecret,newWebhookSecret} from '../../src/lib/server/core/webhook-crypto';
import {createWebhookEndpoint,updateWebhookEndpoint} from '../../src/lib/server/core/webhooks';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,schema:string[],at:number;
const key1=Buffer.alloc(32,1).toString('base64url'),key2=Buffer.alloc(32,2).toString('base64url');
beforeAll(async()=>{
  schema=[];for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())
    schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));
});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'webhook-jobs'},r2Buckets:{MAIL_BLOBS:'webhook-jobs'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',
    WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:key1}})} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Webhook',localPart:`hook-${crypto.randomUUID()}`});
async function endpoint(mailboxId:string,{url='https://hooks.example.net/notify',createdAt=at-100,status='active',version=1,secret=newWebhookSecret()}={}) {
  const id=crypto.randomUUID(),cipher=await encryptWebhookSecret(env,mailboxId,id,version,secret);
  await env.DB.prepare(`INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,secret_version,status,created_at,updated_at)
    VALUES(?,?,?, ?,?,?,?,?,?)`).bind(id,mailboxId,url,JSON.stringify(['message.received','outbound.accepted','outbound.failed','outbound.unknown']),cipher,version,status,createdAt,createdAt).run();
  return {id,secret,version,cipher};
}
async function event(mailboxId:string,{type='message.received',createdAt=at,source='app',payload={messageId:crypto.randomUUID()}}={}) {
  const id=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(id,mailboxId,source,crypto.randomUUID(),type,JSON.stringify(payload),createdAt,createdAt).run();
  return {id,payload};
}
const run=(fetcher:typeof fetch,extra:Record<string,unknown>={})=>runWebhookJobs(env,{fetcher,now:()=>at,...extra});
const deliveries=()=>env.DB.prepare('SELECT * FROM webhook_deliveries ORDER BY id').all<Record<string,unknown>>();
async function oneDelivery() {return (await deliveries()).results[0];}
const attempts=()=>env.DB.prepare('SELECT * FROM webhook_delivery_attempts ORDER BY delivery_id,attempt_no').all<Record<string,unknown>>();
function signature(secret:string,init:RequestInit):string {
  const headers=new Headers(init.headers),timestamp=headers.get('X-Agent-Mail-Signature')!.match(/^t=(\d+),v1=/)![1];
  return `t=${timestamp},v1=${createHmac('sha256',secret).update(`${timestamp}.${headers.get('X-Agent-Mail-Delivery')}.${init.body}`).digest('hex')}`;
}

it('atomically fans out once under concurrent cron calls and sends bounded metadata with independently verified HMAC',async()=>{
  const mailbox=await box(),a=await endpoint(mailbox.id),b=await endpoint(mailbox.id),sent=await event(mailbox.id);
  let cancelled=0;
  const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
    const headers=new Headers(init!.headers),body=JSON.parse(String(init!.body));
    expect(headers.get('X-Agent-Mail-Signature')).toBe(signature(a.secret,init!));
    expect(body).toEqual({v:1,id:sent.id,type:'message.received',mailboxId:mailbox.id,occurredAt:at,data:sent.payload});
    expect(init).toMatchObject({method:'POST',redirect:'manual',cache:'no-store'});
    for(const name of ['Cookie','Authorization','Origin','Referer','X-Real-IP','CF-Connecting-IP'])expect(headers.has(name)).toBe(false);
    expect([...headers.keys()].sort()).toEqual(['content-type','x-agent-mail-attempt','x-agent-mail-delivery','x-agent-mail-event','x-agent-mail-secret-version','x-agent-mail-signature']);
    return new Response(new ReadableStream({cancel(){cancelled++;}}),{status:200});
  });
  // Give both destinations the same known secret so verification is independent of delivery ID mapping.
  const cipher=await encryptWebhookSecret(env,mailbox.id,b.id,1,a.secret);
  await env.DB.prepare('UPDATE webhook_endpoints SET signing_secret_ciphertext=? WHERE id=?').bind(cipher,b.id).run();
  const results=await Promise.all([run(fetcher),run(fetcher)]);
  expect(results.reduce((sum,value)=>sum+value.webhookPublished,0)).toBe(1);expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await deliveries()).results).toHaveLength(2);expect((await attempts()).results.map(row=>row.outcome)).toEqual(['succeeded','succeeded']);expect(cancelled).toBe(2);
  await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await env.DB.prepare('SELECT webhook_published_at FROM events WHERE id=?').bind(sent.id).first('webhook_published_at')).toBe(at);
});

it('marks zero-subscriber and unsafe events without historical backfill, while paused mailboxes consume no publication or attempts',async()=>{
  const mailbox=await box(),old=await event(mailbox.id),unsafe=await event(mailbox.id,{type:'private.internal'}),fetcher=vi.fn(async()=>new Response(null,{status:204}));
  expect((await run(fetcher)).webhookPublished).toBe(2);expect(fetcher).not.toHaveBeenCalled();
  await endpoint(mailbox.id,{createdAt:at+1});at+=2;await run(fetcher);expect((await deliveries()).results).toHaveLength(0);
  await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(mailbox.id).run();
  const paused=await event(mailbox.id);await run(fetcher);expect(fetcher).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT webhook_published_at FROM events WHERE id=?').bind(paused.id).first('webhook_published_at')).toBeNull();
  await env.DB.prepare("UPDATE mailboxes SET status='active' WHERE id=?").bind(mailbox.id).run();
  await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(1);expect((await attempts()).results).toHaveLength(1);
  expect((await deliveries()).results[0].event_id).not.toBe(old.id);expect((await deliveries()).results[0].event_id).not.toBe(unsafe.id);
});

it('does not mark an event published until an eligible same-ms endpoint omitted from preselection is captured',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);const sent=await event(mailbox.id),fetcher=vi.fn(async()=>new Response(null,{status:204}));
  let inserted=false;
  const db=new Proxy(env.DB,{get(target,key){
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{
      if(!inserted){inserted=true;await endpoint(mailbox.id,{createdAt:at});}
      return target.batch(statements);
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  expect((await runWebhookJobs({...env,DB:db},{fetcher,now:()=>at})).webhookPublished).toBe(0);
  expect(await env.DB.prepare('SELECT webhook_published_at FROM events WHERE id=?').bind(sent.id).first('webhook_published_at')).toBeNull();
  expect((await run(fetcher)).webhookPublished).toBe(1);expect(fetcher).toHaveBeenCalledTimes(2);expect((await deliveries()).results).toHaveLength(2);
});

it('bounds a publication pass to twenty events and dispatches only two attempts while retaining the remaining work',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);await endpoint(mailbox.id);
  for(let index=0;index<21;index++)await event(mailbox.id);
  const fetcher=vi.fn(async()=>new Response(null,{status:204}));
  expect(await run(fetcher)).toMatchObject({webhookPublished:20,webhookProcessed:2,webhookSucceeded:2});
  expect((await deliveries()).results).toHaveLength(40);expect((await attempts()).results).toHaveLength(2);
  expect(await run(fetcher)).toMatchObject({webhookPublished:1,webhookProcessed:2,webhookSucceeded:2});
  expect((await deliveries()).results).toHaveLength(42);expect(fetcher).toHaveBeenCalledTimes(4);
});

it('backs off retryable failures, honors bounded Retry-After, exhausts eight attempts, and preserves monotonic manual replay history',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);await event(mailbox.id);
  const fetcher=vi.fn(async()=>new Response('private response',{status:500,headers:{'Retry-After':'3600'}}));
  await run(fetcher);let d=await oneDelivery();expect(d).toMatchObject({state:'pending',attempts:1,available_at:at+3_600_000,last_error_code:'http_retry'});
  await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(1);
  at=Number(d.available_at);fetcher.mockImplementation(async()=>new Response(null,{status:429,headers:{'Retry-After':'99999999'}}));
  await run(fetcher);d=await oneDelivery();expect(d.available_at).toBe(at+86_400_000);
  fetcher.mockImplementation(async()=>new Response(null,{status:503}));
  while(Number(d.attempts)<8){at=Number(d.available_at);await run(fetcher);d=await oneDelivery();}
  expect(d).toMatchObject({state:'dead',attempts:8,attempt_budget:8});expect((await attempts()).results.map(row=>row.attempt_no)).toEqual([1,2,3,4,5,6,7,8]);
  expect((await attempts()).results.at(-1)!.outcome).toBe('dead');
  await env.DB.prepare("UPDATE webhook_deliveries SET state='pending',attempt_budget=16,available_at=?,completed_at=NULL WHERE id=?").bind(at,String(d.id)).run();
  fetcher.mockImplementation(async()=>new Response(null,{status:204}));await run(fetcher);
  expect(await oneDelivery()).toMatchObject({state:'succeeded',attempts:9,attempt_budget:16});expect((await attempts()).results.at(-1)).toMatchObject({attempt_no:9,outcome:'succeeded'});
});

it('treats redirects and other permanent HTTP failures as dead without following Location or reading response content',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);await event(mailbox.id);await event(mailbox.id);
  let cancelled=0;
  const fetcher=vi.fn().mockImplementationOnce(async()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{status:302,headers:{Location:'https://127.0.0.1/private'}}))
    .mockResolvedValueOnce(new Response(null,{status:400}));
  const result=await run(fetcher);expect(result).toMatchObject({webhookProcessed:2,webhookDead:2});expect(fetcher).toHaveBeenCalledTimes(2);expect(cancelled).toBe(1);
  expect((await deliveries()).results.map(row=>row.state)).toEqual(['dead','dead']);await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(2);
});

it('bounds fetches that ignore abort and retries timeouts/network errors without storing upstream details',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);await event(mailbox.id);await event(mailbox.id);
  let signal:AbortSignal|undefined;
  const fetcher=vi.fn().mockImplementationOnce((_url:unknown,init:RequestInit)=>{signal=init.signal??undefined;return new Promise<Response>(()=>{});})
    .mockRejectedValueOnce(new Error('sensitive network URL and body'));
  await run(fetcher,{timeoutMs:5});expect(signal?.aborted).toBe(true);expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await deliveries()).results.map(row=>row.last_error_code).sort()).toEqual(['delivery_timeout','network_error']);
  expect(JSON.stringify((await attempts()).results)).not.toContain('sensitive');
});

it('retains the frozen signing key/version across rotation while new events use the rotated endpoint key',async()=>{
  const mailbox=await box(),ep=await endpoint(mailbox.id);await event(mailbox.id);
  const fetcher=vi.fn(async()=>new Response(null,{status:500}));await run(fetcher);
  const original=await oneDelivery();at++;
  const nextSecret=newWebhookSecret();env.WEBHOOK_KEYRING=JSON.stringify({activeKid:'k2',keys:{k1:key1,k2:key2}});
  const cipher=await encryptWebhookSecret(env,mailbox.id,ep.id,2,nextSecret);
  await env.DB.prepare('UPDATE webhook_endpoints SET secret_version=2,signing_secret_ciphertext=?,updated_at=? WHERE id=?').bind(cipher,at,ep.id).run();
  await event(mailbox.id);fetcher.mockImplementation(async()=>new Response(null,{status:204}));await run(fetcher);
  const newCall=fetcher.mock.calls.at(-1) as unknown as [string,RequestInit];expect(new Headers(newCall[1].headers).get('X-Agent-Mail-Secret-Version')).toBe('2');expect(new Headers(newCall[1].headers).get('X-Agent-Mail-Signature')).toBe(signature(nextSecret,newCall[1]));
  at=Number(original.available_at);await run(fetcher);
  const retry=fetcher.mock.calls.at(-1) as unknown as [string,RequestInit];expect(new Headers(retry[1].headers).get('X-Agent-Mail-Secret-Version')).toBe('1');expect(new Headers(retry[1].headers).get('X-Agent-Mail-Signature')).toBe(signature(ep.secret,retry[1]));
});

it('fences expired leases so a late ACK cannot overwrite recovery or a subsequent successful attempt',async()=>{
  const mailbox=await box();await endpoint(mailbox.id);await event(mailbox.id);
  let release!:(value:Response)=>void,started!:()=>void;const waiting=new Promise<void>(resolve=>started=resolve);
  const slow=vi.fn(async()=>{started();return new Promise<Response>(resolve=>release=resolve);});
  const first=run(slow);await waiting;const initial=await oneDelivery();at+=120_001;
  const ok=vi.fn(async()=>new Response(null,{status:204}));await run(ok);expect(ok).not.toHaveBeenCalled();
  const recovered=await oneDelivery();expect(recovered).toMatchObject({state:'pending',attempts:1,last_error_code:'lease_expired'});
  release(new Response(null,{status:204}));await first;
  expect(await oneDelivery()).toMatchObject({state:'pending',attempts:1,available_at:recovered.available_at});expect((await attempts()).results[0].outcome).toBe('expired');
  at=Number(recovered.available_at);await run(ok);expect(ok).toHaveBeenCalledTimes(1);expect(await oneDelivery()).toMatchObject({state:'succeeded',attempts:2});
  expect((await attempts()).results.map(row=>row.outcome)).toEqual(['expired','succeeded']);expect(initial.lease_token).not.toBeNull();
});

it('does not submit invalid/private targets and bounds retries when the historical encryption key is missing',async()=>{
  const mailbox=await box();await endpoint(mailbox.id,{url:'https://127.0.0.1/private'});await event(mailbox.id);
  const fetcher=vi.fn(async()=>new Response(null,{status:204}));await run(fetcher);expect(fetcher).not.toHaveBeenCalled();expect(await oneDelivery()).toMatchObject({state:'dead',last_error_code:'invalid_target'});
  const other=await box();await endpoint(other.id);await event(other.id);env.WEBHOOK_KEYRING=JSON.stringify({activeKid:'k2',keys:{k2:key2}});
  await run(fetcher);
  let d=(await deliveries()).results.find(row=>row.mailbox_id===other.id)!;
  while(Number(d.attempts)<8){at=Number(d.available_at);await run(fetcher);d=(await deliveries()).results.find(row=>row.mailbox_id===other.id)!;}
  expect(fetcher).not.toHaveBeenCalled();expect(d).toMatchObject({state:'dead',attempts:8,last_error_code:'signing_key_unavailable'});
});

it('respects endpoint cancellation during an in-flight request and closes its lost attempt history',async()=>{
  const mailbox=await box(),ep=await endpoint(mailbox.id);await event(mailbox.id);
  const fetcher=vi.fn(async()=>{
    await env.DB.batch([
      env.DB.prepare("UPDATE webhook_endpoints SET status='paused' WHERE id=?").bind(ep.id),
      env.DB.prepare("UPDATE webhook_deliveries SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE endpoint_id=? AND state='running'").bind(ep.id)
    ]);
    return new Response(null,{status:204});
  });
  expect((await run(fetcher)).webhookSucceeded).toBe(0);expect(await oneDelivery()).toMatchObject({state:'cancelled',attempts:1});expect((await attempts()).results[0].outcome).toBe('expired');
  await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not backfill events created during an API-managed endpoint pause after it is resumed',async()=>{
  const mailbox=await box(),created=await createWebhookEndpoint(ctx,mailbox.id,{url:'https://hooks.example.net/notify',eventTypes:['message.received']});
  const paused=await updateWebhookEndpoint(ctx,mailbox.id,created.endpoint.id,{expectedUpdatedAt:created.endpoint.updatedAt,status:'paused'});
  const duringPause=await event(mailbox.id);
  await updateWebhookEndpoint(ctx,mailbox.id,created.endpoint.id,{expectedUpdatedAt:paused.endpoint.updatedAt,status:'active'});
  const fetcher=vi.fn(async()=>new Response(null,{status:204}));
  await run(fetcher);expect(fetcher).not.toHaveBeenCalled();expect((await deliveries()).results).toHaveLength(0);
  at++;const future=await event(mailbox.id);await run(fetcher);expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await oneDelivery()).event_id).toBe(future.id);expect((await oneDelivery()).event_id).not.toBe(duringPause.id);
});
