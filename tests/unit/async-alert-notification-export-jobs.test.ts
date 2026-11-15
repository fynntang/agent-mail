import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {cancelAsyncAlertNotificationExport,createAsyncAlertNotificationExport,type AsyncAlertNotificationExportRow} from '../../src/lib/server/core/async-alert-notification-exports';
import {asyncAlertNotificationExportPrefix,runAsyncAlertNotificationExportJobs} from '../../src/lib/server/core/async-alert-notification-export-jobs';
import {formatAsyncExportEnvelope} from '../../src/lib/server/core/async-alert-notification-export-format';
import {asyncAlertNotificationExportDto} from '../../src/lib/server/core/async-alert-notification-exports';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,schema:string[],at:number,sourceAt:number;
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',d1Databases:{DB:'async-export-jobs'},r2Buckets:{MAIL_BLOBS:'async-export-jobs'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;sourceAt=Date.now()-10_000;
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Async worker',localPart:`async-worker-${crypto.randomUUID()}`});
async function seed(box:string,count:number){
  const ids=Array.from({length:count},()=>crypto.randomUUID()),alert=crypto.randomUUID(),json=JSON.stringify(ids),payload=JSON.stringify({alertId:alert,kind:'sync',status:'open',outcome:'failed',errorCode:'cloudflare_api_unavailable',private:'PRIVATE_BODY'});
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) SELECT value,?,'app',value,'cloudflare.suppression.alert.created',?,?,? FROM json_each(?)`).bind(box,payload,sourceAt,sourceAt,json),
    env.DB.prepare(`INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token) SELECT value,?,?,'allowed',1,?,'PRIVATE_CLAIM' FROM json_each(?)`).bind(box,alert,sourceAt,json)
  ]);return ids.sort().reverse();
}
async function addDeliveries(box:string,ids:string[],endpoints=1){
  const endpointIds=Array.from({length:endpoints},()=>crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,created_at,updated_at) SELECT value,?,'https://PRIVATE.example.net/','[]','{}',?,? FROM json_each(?)`).bind(box,sourceAt,sourceAt,JSON.stringify(endpointIds)),
    env.DB.prepare(`INSERT INTO webhook_deliveries(id,mailbox_id,endpoint_id,event_id,state,attempts,available_at,signed_secret_version,signing_secret_ciphertext,url_snapshot,payload_json,created_at,updated_at)
      SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),?,p.value,e.value,'pending',1,?,1,'{}','https://PRIVATE.example.net/','{}',?,?
      FROM json_each(?) e CROSS JOIN json_each(?) p`).bind(box,sourceAt,sourceAt,sourceAt,JSON.stringify(ids),JSON.stringify(endpointIds))
  ]);
}
async function create(box:string,format:'json'|'csv'='json'){
  return(await createAsyncAlertNotificationExport(ctx,box,{clientRequestId:crypto.randomUUID(),format,from:sourceAt-100,to:sourceAt+100})).job;
}
const run=(overrides:Partial<RuntimeEnv>={},options:{maxBatches?:number;batchSize?:number}={})=>runAsyncAlertNotificationExportJobs({...env,...overrides},{now:()=>at,...options});
const row=(id:string)=>env.DB.prepare('SELECT * FROM async_alert_notification_exports WHERE id=?').bind(id).first<AsyncAlertNotificationExportRow>();
async function file(id:string):Promise<string>{
  const job=(await row(id))!,envelope=formatAsyncExportEnvelope(asyncAlertNotificationExportDto(job,at)),parts=[new TextDecoder().decode(envelope.prefix)];
  const chunks=(await env.DB.prepare('SELECT object_key FROM async_alert_notification_export_chunks WHERE job_id=? ORDER BY sequence').bind(id).all<{object_key:string}>()).results;
  for(const chunk of chunks){const object=await env.MAIL_BLOBS.get(chunk.object_key);expect(object).not.toBeNull();parts.push(await object!.text());}parts.push(new TextDecoder().decode(envelope.suffix));return parts.join('');
}

it('exports beyond the synchronous decision limit across bounded progress checkpoints and excludes later backfilled records',async()=>{
  const mailbox=await box(),ids=await seed(mailbox.id,1001);await addDeliveries(mailbox.id,[ids[0]]);const job=await create(mailbox.id);
  const first=await run({}, {maxBatches:1});expect(first.asyncExportsProcessed).toBe(1);expect(await row(job.id)).toMatchObject({state:'queued',processed_decisions:50,chunk_count:1,total_decisions:1001});
  const late=await seed(mailbox.id,1);await env.DB.prepare("UPDATE webhook_deliveries SET state='succeeded' WHERE mailbox_id=?").bind(mailbox.id).run();
  await run();await run();const completed=(await row(job.id))!;expect(completed).toMatchObject({state:'succeeded',processed_decisions:1001,processed_deliveries:1,chunk_count:21});
  const output=JSON.parse(await file(job.id));expect(output.decisions).toHaveLength(1001);expect(output.decisions.some((item:{eventId:string})=>item.eventId===late[0])).toBe(false);
  expect(output.summary).toMatchObject({total:1001,delivery:{total:1,pending:1,succeeded:0}});expect(output.processing.deliverySnapshot).toBe('per_batch');expect(JSON.stringify(output)).not.toContain('PRIVATE');
});

it('exports more than5000 nested Webhook results without truncating event or endpoint totals',async()=>{
  const mailbox=await box(),ids=await seed(mailbox.id,501);await addDeliveries(mailbox.id,ids,10);const job=await create(mailbox.id);
  await run();expect(await row(job.id)).toMatchObject({state:'queued',processed_decisions:500,processed_deliveries:5000});await run();
  const output=JSON.parse(await file(job.id));expect(output.decisions).toHaveLength(501);expect(output.summary.delivery.total).toBe(5010);
  expect(output.decisions.reduce((sum:number,item:{deliveries:unknown[]})=>sum+item.deliveries.length,0)).toBe(5010);expect(output.summary.allowed).toBe(501);
});

it('concurrent invocations claim one lease and publish one immutable fragment',async()=>{
  const mailbox=await box();await seed(mailbox.id,70);const job=await create(mailbox.id);let release!:()=>void,entered!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;}),writing=new Promise<void>(resolve=>{entered=resolve;});
  const bucket=new Proxy(env.MAIL_BLOBS,{get(target,key){if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{const object=await target.put(...args);entered();await wait;return object;};return Reflect.get(target,key,target);}});
  const first=run({MAIL_BLOBS:bucket},{maxBatches:1});await writing;const second=await run({}, {maxBatches:1});expect(second.asyncExportsProcessed).toBe(0);release();await first;
  expect(await row(job.id)).toMatchObject({state:'queued',processed_decisions:50,chunk_count:1});expect(await env.DB.prepare('SELECT COUNT(*) n FROM async_alert_notification_export_chunks WHERE job_id=?').bind(job.id).first('n')).toBe(1);
});

it('Owner cancellation during a storage write prevents stale publication and recurring cleanup collects late orphan bytes',async()=>{
  const mailbox=await box();await seed(mailbox.id,5);const job=await create(mailbox.id);let cancelled=false;
  const bucket=new Proxy(env.MAIL_BLOBS,{get(target,key){if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{
    const current=(await row(job.id))!;await cancelAsyncAlertNotificationExport(ctx,mailbox.id,job.id,{expectedVersion:current.version});cancelled=true;return target.put(...args);
  };return Reflect.get(target,key,target);}});
  await run({MAIL_BLOBS:bucket},{maxBatches:1});expect(cancelled).toBe(true);expect(await row(job.id)).toMatchObject({state:'cancelled',processed_decisions:0,chunk_count:0});
  const prefix=asyncAlertNotificationExportPrefix(mailbox.id,job.id);expect((await env.MAIL_BLOBS.list({prefix})).objects).toHaveLength(0);
  await env.MAIL_BLOBS.put(`${prefix}late/1.part`,'late bytes');at+=3_600_001;await run();expect((await env.MAIL_BLOBS.list({prefix})).objects).toHaveLength(0);expect(await row(job.id)).not.toBeNull();
});

it('an expired Worker cannot overwrite a replacement checkpoint or remove its published object',async()=>{
  const mailbox=await box();await seed(mailbox.id,5);const job=await create(mailbox.id);let release!:()=>void,entered!:()=>void,oldKey='';
  const wait=new Promise<void>(resolve=>{release=resolve;}),writing=new Promise<void>(resolve=>{entered=resolve;});
  const bucket=new Proxy(env.MAIL_BLOBS,{get(target,key){if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{oldKey=args[0];const object=await target.put(...args);entered();await wait;return object;};return Reflect.get(target,key,target);}});
  const old=run({MAIL_BLOBS:bucket},{maxBatches:1});await writing;at+=120_001;await run({}, {maxBatches:1});release();await old;
  expect(await row(job.id)).toMatchObject({state:'succeeded',processed_decisions:5,chunk_count:1});const manifest=await env.DB.prepare('SELECT object_key FROM async_alert_notification_export_chunks WHERE job_id=?').bind(job.id).first<string>('object_key');
  expect(manifest).not.toBe(oldKey);expect(await env.MAIL_BLOBS.head(manifest!)).not.toBeNull();expect(await env.MAIL_BLOBS.head(oldKey)).toBeNull();
});

it('storage failures retry without advancing progress, and a lost database ACK never deletes a committed fragment',async()=>{
  const mailbox=await box();await seed(mailbox.id,3);const job=await create(mailbox.id);let failed=false;
  const bucket=new Proxy(env.MAIL_BLOBS,{get(target,key){if(key==='put')return async()=>{failed=true;throw new Error('PRIVATE_STORAGE_DIAGNOSTIC');};return Reflect.get(target,key,target);}});
  await run({MAIL_BLOBS:bucket},{maxBatches:1});expect(failed).toBe(true);expect(await row(job.id)).toMatchObject({state:'queued',processed_decisions:0,failures:1,error_code:'async_export_storage_unavailable'});
  at=(await row(job.id))!.available_at;let batches=0;
  const database=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(++batches===2)throw new Error('PRIVATE_LOST_ACK');return result;};return Reflect.get(target,key,target);}});
  await run({DB:database},{maxBatches:1});expect(await row(job.id)).toMatchObject({state:'succeeded',processed_decisions:3,failures:0,chunk_count:1});
  expect(JSON.parse(await file(job.id)).decisions).toHaveLength(3);expect((await env.MAIL_BLOBS.list({prefix:asyncAlertNotificationExportPrefix(mailbox.id,job.id)})).objects).toHaveLength(1);
});

it('expiry revokes finished files before bounded cleanup, retains manifests and never touches other R2 namespaces',async()=>{
  const mailbox=await box();await seed(mailbox.id,1);const job=await create(mailbox.id,'csv');await run();expect(await row(job.id)).toMatchObject({state:'succeeded'});
  const prefix=asyncAlertNotificationExportPrefix(mailbox.id,job.id);await Promise.all(Array.from({length:33},(_,index)=>env.MAIL_BLOBS.put(`${prefix}orphan/${index}.part`,'x')));await env.MAIL_BLOBS.put('mail/private-object','untouched');
  at=(await row(job.id))!.expires_at;await run();expect(await row(job.id)).toMatchObject({state:'expired'});expect((await env.MAIL_BLOBS.list({prefix})).objects).toHaveLength(2);
  at+=60_000;await run();expect((await env.MAIL_BLOBS.list({prefix})).objects).toHaveLength(0);expect(await env.DB.prepare('SELECT COUNT(*) n FROM async_alert_notification_export_chunks WHERE job_id=?').bind(job.id).first('n')).toBe(1);
  expect(await(env.MAIL_BLOBS.get('mail/private-object')).then(object=>object!.text())).toBe('untouched');
});

it('empty selections finish without fragments, and corrupted checkpoint summaries fail instead of omitting records',async()=>{
  const mailbox=await box(),empty=await create(mailbox.id);await run();expect(await row(empty.id)).toMatchObject({state:'succeeded',processed_decisions:0,chunk_count:0,body_bytes:0});expect(JSON.parse(await file(empty.id)).decisions).toEqual([]);
  await seed(mailbox.id,60);const job=await create(mailbox.id);await run({}, {maxBatches:1});const current=(await row(job.id))!,summary=JSON.parse(current.summary_json);summary.total--;
  await env.DB.prepare('UPDATE async_alert_notification_exports SET summary_json=?,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(JSON.stringify(summary),job.id).run();await run();
  expect(await row(job.id)).toMatchObject({state:'failed',processed_decisions:50,error_code:'async_export_source_changed'});
});

it('terminal notification triggers preserve committed nonempty fragments and count each completed export only once',async()=>{
  const mailbox=await box(),empty=await create(mailbox.id),ids=await seed(mailbox.id,3),nonempty=await create(mailbox.id);
  const result=await run();expect(result).toMatchObject({asyncExportsProcessed:2,asyncExportsCompleted:2,asyncExportsFailed:0});
  expect(JSON.parse(await file(empty.id)).decisions).toEqual([]);const output=JSON.parse(await file(nonempty.id));
  expect(output.decisions.map((item:{eventId:string})=>item.eventId)).toEqual(ids);
  const manifest=(await env.DB.prepare('SELECT object_key FROM async_alert_notification_export_chunks WHERE job_id=?').bind(nonempty.id).all<{object_key:string}>()).results;
  expect(manifest).toHaveLength(1);expect(await env.MAIL_BLOBS.head(manifest[0].object_key)).not.toBeNull();
  expect((await env.DB.prepare('SELECT job_id,outcome FROM async_export_notifications ORDER BY job_id').all()).results).toHaveLength(2);
  expect(await run()).toMatchObject({asyncExportsProcessed:0,asyncExportsCompleted:0,asyncExportsFailed:0});
});

it('terminal notification trigger inserts do not inflate direct failure or exhausted-lease recovery counts',async()=>{
  const mailbox=await box();await seed(mailbox.id,60);const job=await create(mailbox.id);await run({}, {maxBatches:1});
  const summary=JSON.parse((await row(job.id))!.summary_json);summary.total--;
  await env.DB.prepare('UPDATE async_alert_notification_exports SET summary_json=?,version=version+1,updated_at=updated_at+1 WHERE id=?').bind(JSON.stringify(summary),job.id).run();
  expect(await run()).toMatchObject({asyncExportsFailed:1,asyncExportsCompleted:0,asyncExportsProcessed:0});
  expect(await env.DB.prepare('SELECT outcome FROM async_export_notifications WHERE job_id=?').bind(job.id).first('outcome')).toBe('failed');
  const interrupted=await create(mailbox.id);
  await env.DB.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='expired-fixture',lease_until=?,started_at=?,failures=4,version=version+1,updated_at=updated_at+1 WHERE id=?")
    .bind(at-1,at-100,interrupted.id).run();
  expect(await run()).toMatchObject({asyncExportsFailed:1,asyncExportsCompleted:0,asyncExportsProcessed:0});
  expect(await row(interrupted.id)).toMatchObject({state:'failed',error_code:'async_export_lease_expired'});
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM async_export_notifications WHERE outcome=\'failed\'').first('n')).toBe(2);
});
