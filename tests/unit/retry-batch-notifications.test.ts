import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {getRetryBatchNotification,listRetryBatchNotifications,acknowledgeRetryBatchNotification,retryBatchNotice,projectRetryBatchNotifications,type RetryBatchNotificationRow} from '../../src/lib/server/core/retry-batch-notifications';
import type {RuntimeEnv} from '../../src/lib/server/core/types';
import {stableId} from '../../src/lib/server/core/crypto';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:{DB:'batch-notices'},r2Buckets:{MAIL_BLOBS:'batch-notices'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(sql=>db.prepare(sql)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',OWNER_EMAIL:'owner@example.com'} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;vi.spyOn(Date,'now').mockImplementation(()=>at);
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const count=(table='async_export_retry_batch_notifications')=>env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>('n');
const notices=(id:string)=>env.DB.prepare('SELECT * FROM async_export_retry_batch_notifications WHERE batch_id=? ORDER BY created_at,id').bind(id).all<RetryBatchNotificationRow>();
const safe=(value:unknown)=>expect(JSON.stringify(value)).not.toMatch(/PRIVATE_NOTICE|lease_token|claim_token|request_hash|payload_json|signing_secret|endpoint_snapshot_json|https:\/\//);
async function fixture({total=2,committed=true}={}){
  const box=await createMailbox(ctx,{name:'Batch notices',localPart:`notices-${crypto.randomUUID()}`}),id=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO async_export_notification_retry_batches(id,mailbox_id,preview_request_id,request_hash,from_ms,to_ms,filter_reason,created_at,updated_at,expires_at,preview_expires_at,total_items,eligible_items)
    VALUES(?,?,?, ?,0,1,'all',?,?,?,?,?,?)`).bind(id,box.id,crypto.randomUUID(),'a'.repeat(64),at,at,at+86400000,at+600000,total,total).run();
  if(committed)await env.DB.prepare("UPDATE async_export_notification_retry_batches SET state='queued',commit_request_id=?,commit_expected_version=1,committed_at=?,updated_at=updated_at+1,version=version+1 WHERE id=?").bind(crypto.randomUUID(),at,id).run();
  return {box,id};
}
async function advance(id:string,{state='running',requeued=0,skipped=0,failed=0,unknown=0,cancelled=false}:{state?:string;requeued?:number;skipped?:number;failed?:number;unknown?:number;cancelled?:boolean}={}){
  at++;
  await env.DB.prepare(`UPDATE async_export_notification_retry_batches SET state=?,processed_items=?,requeued_items=?,skipped_items=?,failed_items=?,unknown_items=?,
    completed_at=CASE WHEN ? IN('completed','expired') OR ?=1 THEN ? ELSE completed_at END,cancelled_at=CASE WHEN ?=1 THEN ? ELSE cancelled_at END,version=version+1,updated_at=MAX(updated_at+1,?) WHERE id=?`)
    .bind(state,requeued+skipped+failed+unknown,requeued,skipped,failed,unknown,state,cancelled?1:0,at,cancelled?1:0,at,at,id).run();
}

it('captures completion atomically once, keeps frozen counts and projects exactly one stable event without transport',async()=>{
  const f=await fixture();expect(await count()).toBe(0);await advance(f.id,{state:'completed',requeued:1,skipped:1});
  const receipt=(await notices(f.id)).results[0];expect(receipt).toMatchObject({kind:'completed',reason:'completed',batch_state:'completed',total_items:2,requeued_items:1,skipped_items:1,unknown_items:0,source_version:3});
  expect(receipt.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await advance(f.id,{state:'completed',requeued:1,skipped:1});expect(await count()).toBe(1);
  const http=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('PRIVATE_NOTICE_HTTP'));
  expect(await projectRetryBatchNotifications(env)).toEqual({retryBatchNotificationsProjected:1});expect(await projectRetryBatchNotifications(env)).toEqual({retryBatchNotificationsProjected:0});
  expect(await count('events')).toBe(1);expect(http).not.toHaveBeenCalled();expect((await env.MAIL_BLOBS.list()).objects).toHaveLength(0);
  const event=await env.DB.prepare('SELECT * FROM events').first<{source:string;source_event_id:string;type:string;payload_json:string;created_at:number;occurred_at:number}>();
  expect(event).toMatchObject({source:'app',source_event_id:`retry-batch-notification:v1:${receipt.id}`,type:'alert_notification.retry_batch.completed',created_at:receipt.created_at,occurred_at:receipt.occurred_at});
  expect(JSON.parse(event!.payload_json)).toMatchObject({notificationId:receipt.id,batchId:f.id,kind:'completed',sourceVersion:3,requeuedItems:1,skippedItems:1});
  expect(await retryBatchNotice(ctx)).toEqual({count:1,attentionCount:0,mailboxId:f.box.id});safe(await getRetryBatchNotification(ctx,f.box.id,receipt.id));
});

it('records the first failure episode and a later completion with final failures without claiming Webhook success',async()=>{
  const f=await fixture();await advance(f.id,{failed:1});await advance(f.id,{failed:2});expect(await count()).toBe(1);
  await advance(f.id,{state:'completed',failed:2});const rows=(await notices(f.id)).results;
  expect(rows.map(row=>row.kind)).toEqual(['failed','completed']);expect(rows[0].failed_items).toBe(1);expect(rows[1].failed_items).toBe(2);
  const list=await listRetryBatchNotifications(ctx,f.box.id);expect(list.summary).toEqual({unread:2,attention:1,completed:1,failed:1,needsReconciliation:0});
  expect(list.notifications.find(value=>value.kind==='failed')).toMatchObject({currentAttention:true,currentBatch:{failedItems:2,state:'completed'}});safe(list);
  expect(list.notifications.find(value=>value.kind==='completed')?.currentAttention).toBe(false);
});

it('opens a fresh unknown episode only after the previous one resolves, retaining historical snapshots and acknowledgements',async()=>{
  const f=await fixture();await advance(f.id,{unknown:1});const first=(await notices(f.id)).results[0];
  await acknowledgeRetryBatchNotification(ctx,f.box.id,first.id,{expectedVersion:1});
  await advance(f.id,{skipped:1});expect((await getRetryBatchNotification(ctx,f.box.id,first.id)).notification).toMatchObject({unknownItems:1,currentAttention:false,currentBatch:{unknownItems:0}});
  expect(await retryBatchNotice(ctx)).toBeNull();await advance(f.id,{skipped:1,unknown:1});await advance(f.id,{skipped:1,unknown:1});
  const rows=(await notices(f.id)).results;expect(rows).toHaveLength(2);expect(rows[0].source_version).not.toBe(rows[1].source_version);expect(rows[0].id).not.toBe(rows[1].id);
  expect(await retryBatchNotice(ctx)).toEqual({count:1,attentionCount:1,mailboxId:f.box.id});
  expect((await listRetryBatchNotifications(ctx,f.box.id,{status:'all'})).summary.needsReconciliation).toBe(2);
});

it('does not notify normal cancellation or preview expiration but alerts on unknown results in a cancelled confirmed batch',async()=>{
  const normal=await fixture(),preview=await fixture({committed:false}),unknown=await fixture();
  await advance(normal.id,{skipped:2,cancelled:true});await advance(preview.id,{state:'expired'});expect(await count()).toBe(0);
  await advance(unknown.id,{skipped:1,unknown:1,cancelled:true});const notice=(await notices(unknown.id)).results[0];
  expect(notice).toMatchObject({kind:'needs_reconciliation',batch_state:'cancelled',unknown_items:1});
  await advance(unknown.id,{skipped:2});expect(await count()).toBe(1);expect((await getRetryBatchNotification(ctx,unknown.box.id,notice.id)).notification.currentAttention).toBe(false);
});

it('captures committed expiry as an exception once while retaining unknown and earlier failure facts',async()=>{
  const f=await fixture();await advance(f.id,{unknown:1});await advance(f.id,{state:'expired',unknown:1});await advance(f.id,{state:'expired',unknown:1});
  const rows=(await notices(f.id)).results;expect(rows.map(row=>row.kind)).toEqual(['needs_reconciliation','failed']);expect(rows[1].reason).toBe('expired');
  expect((await listRetryBatchNotifications(ctx,f.box.id,{kind:'failed'})).notifications[0].currentAttention).toBe(true);
});

it('rolls back captured facts when the enclosing result transaction fails',async()=>{
  const f=await fixture();await expect(env.DB.batch([
    env.DB.prepare("UPDATE async_export_notification_retry_batches SET state='completed',processed_items=2,requeued_items=2,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=? RETURNING id").bind(at,f.id),
    env.DB.prepare("UPDATE async_export_notification_retry_batches SET total_items=3,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(f.id)
  ])).rejects.toThrow();expect(await count()).toBe(0);expect(await env.DB.prepare('SELECT state FROM async_export_notification_retry_batches WHERE id=?').bind(f.id).first('state')).toBe('queued');
});

it('retains immutable facts, rejects cross-mailbox references, and keeps acknowledgement CAS independent of policy and secrets',async()=>{
  const f=await fixture(),other=await fixture();await advance(f.id,{state:'completed',requeued:2});const receipt=(await notices(f.id)).results[0];
  await expect(env.DB.prepare('UPDATE async_export_retry_batch_notifications SET requeued_items=0 WHERE id=?').bind(receipt.id).run()).rejects.toThrow();
  await expect(env.DB.prepare('DELETE FROM async_export_retry_batch_notifications WHERE id=?').bind(receipt.id).run()).rejects.toThrow();
  await expect(env.DB.prepare('UPDATE async_export_retry_batch_notifications SET mailbox_id=? WHERE id=?').bind(other.box.id,receipt.id).run()).rejects.toThrow();
  await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(f.box.id).run();
  const responses=await Promise.allSettled([acknowledgeRetryBatchNotification(ctx,f.box.id,receipt.id,{expectedVersion:1}),acknowledgeRetryBatchNotification(ctx,f.box.id,receipt.id,{expectedVersion:1})]);
  expect(responses.filter(value=>value.status==='fulfilled')).toHaveLength(1);expect(responses.find(value=>value.status==='rejected')).toMatchObject({reason:{code:'retry_batch_notification_changed'}});
  expect(await retryBatchNotice(ctx)).toBeNull();expect(await env.DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='retry_batch_notification.acknowledged'").first('n')).toBe(1);
  await expect(acknowledgeRetryBatchNotification(ctx,f.box.id,receipt.id,{expectedVersion:2})).rejects.toMatchObject({code:'retry_batch_notification_changed'});
});

it('binds pagination to mailbox, status, kind and page size, and keeps all reads side-effect free',async()=>{
  const f=await fixture();await advance(f.id,{unknown:1});await advance(f.id,{failed:1,unknown:1});await advance(f.id,{state:'completed',failed:1,skipped:1});
  const other=await fixture(),before=await count('audit_events'),http=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('PRIVATE_NOTICE_HTTP'));
  const page=await listRetryBatchNotifications(ctx,f.box.id,{status:'all',limit:1});expect(page.notifications).toHaveLength(1);expect(page.nextCursor).toBeTruthy();
  const next=await listRetryBatchNotifications(ctx,f.box.id,{status:'all',limit:1,cursor:page.nextCursor});expect(next.notifications[0].id).not.toBe(page.notifications[0].id);
  for(const query of [{status:'unread',limit:1},{status:'all',limit:2},{status:'all',kind:'failed',limit:1}])await expect(listRetryBatchNotifications(ctx,f.box.id,{...query,cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(listRetryBatchNotifications(ctx,other.box.id,{status:'all',limit:1,cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  for(const query of [{status:'bad'},{kind:'private'},{limit:0},{limit:101},{cursor:'invalid'},{extra:1}])await expect(listRetryBatchNotifications(ctx,f.box.id,query)).rejects.toMatchObject({status:400});
  await expect(getRetryBatchNotification(ctx,other.box.id,page.notifications[0].id)).rejects.toMatchObject({status:404});
  await retryBatchNotice(ctx);expect(await count('audit_events')).toBe(before);expect(await count('events')).toBe(0);expect(http).not.toHaveBeenCalled();expect((await env.MAIL_BLOBS.list()).objects).toHaveLength(0);safe(page);safe(next);
});

it('denies anonymous and Agent contexts before any reads or projection, and hides retired mailboxes',async()=>{
  const f=await fixture();await advance(f.id,{state:'completed',requeued:2});const receipt=(await notices(f.id)).results[0];
  for(const actor of [null,{kind:'token' as const,mailboxId:f.box.id,tokenId:crypto.randomUUID(),canRead:true}]){
    const denied={...ctx,actor};for(const call of [()=>listRetryBatchNotifications(denied,f.box.id),()=>getRetryBatchNotification(denied,f.box.id,receipt.id),()=>acknowledgeRetryBatchNotification(denied,f.box.id,receipt.id,{expectedVersion:1}),()=>retryBatchNotice(denied)])await expect(call()).rejects.toMatchObject({status:actor?403:401});
  }
  await env.DB.prepare("UPDATE mailboxes SET status='deleted' WHERE id=?").bind(f.box.id).run();expect(await retryBatchNotice(ctx)).toBeNull();
  await expect(listRetryBatchNotifications(ctx,f.box.id)).rejects.toMatchObject({status:404});expect(await projectRetryBatchNotifications(env)).toEqual({retryBatchNotificationsProjected:0});
});

it('bounds projection to twenty and safely reconciles a lost acknowledgement from the committed event transaction',async()=>{
  const f=await fixture();await advance(f.id,{state:'completed',requeued:2});const source=(await notices(f.id)).results[0];
  const columns=['id','mailbox_id','batch_id','kind','reason','source_version','batch_state','total_items','eligible_items','processed_items','requeued_items','skipped_items','failed_items','unknown_items','occurred_at','created_at'];
  await env.DB.batch(Array.from({length:20},(_,i)=>env.DB.prepare(`INSERT INTO async_export_retry_batch_notifications(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(column=>column==='id'?crypto.randomUUID():column==='source_version'?source.source_version+i+100:source[column as keyof RetryBatchNotificationRow]))));
  let calls=0;const wrapped=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const applied=await target.batch(statements);if(++calls===1)throw Error('PRIVATE_NOTICE_ACK');return applied;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await expect(projectRetryBatchNotifications({...env,DB:wrapped})).rejects.toThrow('PRIVATE_NOTICE_ACK');expect(await count('events')).toBe(1);
  expect(await projectRetryBatchNotifications(env)).toEqual({retryBatchNotificationsProjected:20});expect(await projectRetryBatchNotifications(env)).toEqual({retryBatchNotificationsProjected:0});expect(await count('events')).toBe(21);
},30_000);

it('deduplicates concurrent outbox projectors and never overwrites a mismatched stable event',async()=>{
  const f=await fixture();await advance(f.id,{state:'completed',requeued:2});
  const counts=await Promise.all([projectRetryBatchNotifications(env),projectRetryBatchNotifications(env)]);expect(counts.reduce((sum,value)=>sum+value.retryBatchNotificationsProjected,0)).toBe(1);expect(await count('events')).toBe(1);
  const second=await fixture();await advance(second.id,{unknown:1});const receipt=(await notices(second.id)).results[0],source=`retry-batch-notification:v1:${receipt.id}`,eventId=await stableId(source);
  await env.DB.prepare("INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at) VALUES(?,?,'app',?,'alert_notification.retry_batch.needs_reconciliation','{}',?,?)")
    .bind(eventId,second.box.id,source,receipt.occurred_at,receipt.created_at).run();
  expect(await projectRetryBatchNotifications(env)).toEqual({retryBatchNotificationsProjected:0});expect((await notices(second.id)).results[0].event_id).toBeNull();
  expect(await env.DB.prepare('SELECT payload_json FROM events WHERE id=?').bind(eventId).first('payload_json')).toBe('{}');
});

it('rolls acknowledgement and its audit back together on a database mutation failure',async()=>{
  const f=await fixture();await advance(f.id,{state:'completed',requeued:2});const receipt=(await notices(f.id)).results[0];
  await env.DB.prepare("CREATE TRIGGER test_ack_failure BEFORE UPDATE OF acknowledged_at ON async_export_retry_batch_notifications BEGIN SELECT RAISE(ABORT,'PRIVATE_NOTICE_ACK_FAILURE'); END").run();
  await expect(acknowledgeRetryBatchNotification(ctx,f.box.id,receipt.id,{expectedVersion:1})).rejects.toThrow('PRIVATE_NOTICE_ACK_FAILURE');
  expect((await getRetryBatchNotification(ctx,f.box.id,receipt.id)).notification).toMatchObject({version:1,acknowledgedAt:null});
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='retry_batch_notification.acknowledged'").first('n')).toBe(0);
});

it('keeps original projection and policy-decision receipts immutable independently of acknowledgement',async()=>{
  const f=await fixture();await advance(f.id,{state:'completed',requeued:2});const receipt=(await notices(f.id)).results[0];await projectRetryBatchNotifications(env);
  await env.DB.prepare("UPDATE async_export_retry_batch_notifications SET notification_decision='quiet_hours',policy_version=3,decided_at=?,claim_token='PRIVATE_NOTICE_CLAIM' WHERE id=?").bind(at,receipt.id).run();
  await acknowledgeRetryBatchNotification(ctx,f.box.id,receipt.id,{expectedVersion:1});
  await expect(env.DB.prepare("UPDATE async_export_retry_batch_notifications SET notification_decision='allowed' WHERE id=?").bind(receipt.id).run()).rejects.toThrow();
  await expect(env.DB.prepare('UPDATE async_export_retry_batch_notifications SET projected_at=projected_at+1 WHERE id=?').bind(receipt.id).run()).rejects.toThrow();
  await expect(env.DB.prepare('UPDATE async_export_retry_batch_notifications SET acknowledged_at=NULL WHERE id=?').bind(receipt.id).run()).rejects.toThrow();
  const dto=(await getRetryBatchNotification(ctx,f.box.id,receipt.id)).notification;expect(dto).toMatchObject({version:2,notificationDecision:'quiet_hours',policyVersion:3});safe(dto);
});

it('captures only active matching endpoint configuration versions inside all three fact transactions and keeps this fence private',async()=>{
  const f=await fixture(),other=await fixture(),endpoint=crypto.randomUUID(),topics=['alert_notification.retry_batch.completed','alert_notification.retry_batch.failed','alert_notification.retry_batch.needs_reconciliation'],endpointAt=at;
  for(const [id,box,status,types] of [[endpoint,f.box.id,'active',topics],[crypto.randomUUID(),f.box.id,'paused',topics],[crypto.randomUUID(),f.box.id,'active',['message.received']],[crypto.randomUUID(),other.box.id,'active',topics]] as const)
    await env.DB.prepare("INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,secret_version,status,created_at,updated_at) VALUES(?,?,'https://PRIVATE_NOTICE.example/endpoint',?,'{}',7,?,?,?)")
      .bind(id,box,JSON.stringify(types),status,endpointAt,endpointAt).run();
  await advance(f.id,{failed:1,unknown:1});await advance(f.id,{state:'completed',failed:1,skipped:1});
  const rows=(await notices(f.id)).results;expect(new Set(rows.map(row=>row.kind))).toEqual(new Set(['completed','failed','needs_reconciliation']));
  for(const receipt of rows){expect(JSON.parse(receipt.endpoint_snapshot_json)).toEqual([{id:endpoint,version:7,updatedAt:endpointAt}]);
    await expect(env.DB.prepare("UPDATE async_export_retry_batch_notifications SET endpoint_snapshot_json='[]' WHERE id=?").bind(receipt.id).run()).rejects.toThrow();
    safe(await getRetryBatchNotification(ctx,f.box.id,receipt.id));}
  await projectRetryBatchNotifications(env);const events=(await env.DB.prepare('SELECT payload_json FROM events').all<{payload_json:string}>()).results;
  for(const event of events){expect(event.payload_json).not.toContain(endpoint);expect(event.payload_json).not.toContain('endpoint_snapshot');}
});

it('upgrades without backfilling already completed, failed or unresolved batches',async()=>{
  const old=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("old")}}',d1Databases:{DB:'notice-upgrade'},log:new Log(LogLevel.ERROR)}));
  try{const db=await old.getD1Database('DB');for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)&&name<'0019_').sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(sql=>db.prepare(sql)));
    await db.prepare("INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('old','Legacy',?,?)").bind(at,at).run();
    await db.prepare(`INSERT INTO async_export_notification_retry_batches(id,mailbox_id,preview_request_id,request_hash,from_ms,to_ms,filter_reason,state,version,created_at,updated_at,expires_at,preview_expires_at,commit_request_id,commit_expected_version,committed_at,completed_at,total_items,eligible_items,processed_items,failed_items)
      VALUES('old-batch','old','old-preview',?,0,1,'all','completed',3,?,?,?,?, 'old-commit',1,?,?,1,1,1,1)`).bind('a'.repeat(64),at,at,at+86400000,at+600000,at,at).run();
    const before=await db.prepare('SELECT * FROM async_export_notification_retry_batches').first();await db.batch(unstable_splitSqlQuery(await readFile('migrations/0019_retry_batch_notifications.sql','utf8')).map(sql=>db.prepare(sql)));
    expect(await db.prepare('SELECT * FROM async_export_notification_retry_batches').first()).toEqual(before);expect(await db.prepare('SELECT COUNT(*) n FROM async_export_retry_batch_notifications').first('n')).toBe(0);
  }finally{await old.dispose();}
});
