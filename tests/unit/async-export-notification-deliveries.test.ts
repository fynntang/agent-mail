import {readFile,readdir} from 'node:fs/promises';
import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {createAsyncAlertNotificationExport} from '../../src/lib/server/core/async-alert-notification-exports';
import {projectAsyncExportNotifications} from '../../src/lib/server/core/async-export-notifications';
import {listAsyncExportNotificationDeliveryResults,getAsyncExportNotificationDelivery} from '../../src/lib/server/core/async-export-notification-deliveries';
import {asyncExportNotificationFrozenPayloadValid} from '../../src/lib/server/core/async-export-notification-delivery-shared';
import type {AsyncExportNotificationRow} from '../../src/lib/server/core/async-export-notifications';
import type {WebhookEventRow} from '../../src/lib/server/core/webhooks';
import {createWebhookEndpoint} from '../../src/lib/server/core/webhooks';
import {runWebhookJobs} from '../../src/lib/server/core/webhook-jobs';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,schema:string[],at:number;
beforeAll(async()=>{schema=[];for(const name of(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',d1Databases:{DB:'export-tracking'},r2Buckets:{MAIL_BLOBS:'export-tracking'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com',
    WEBHOOK_KEYRING:JSON.stringify({activeKid:'k1',keys:{k1:'A'.repeat(43)}})} as unknown as RuntimeEnv,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const box=()=>createMailbox(ctx,{name:'Tracking',localPart:`track-${crypto.randomUUID()}`});
async function terminal(mailbox:string){
  const job=(await createAsyncAlertNotificationExport(ctx,mailbox,{clientRequestId:crypto.randomUUID(),format:'json'})).job;
  await ctx.env.DB.prepare("UPDATE async_alert_notification_exports SET state='running',lease_token='fixture',lease_until=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at+120000,job.id).run();
  await ctx.env.DB.prepare("UPDATE async_alert_notification_exports SET state='succeeded',lease_token=NULL,lease_until=NULL,completed_at=?,version=version+1,updated_at=updated_at+1 WHERE id=?").bind(at,job.id).run();return job;
}
async function fixture(endpoints=3){
  const mailbox=await box();for(let i=0;i<endpoints;i++)await createWebhookEndpoint(ctx,mailbox.id,{url:`https://hooks.example.net/PRIVATE_TARGET_${i}`,eventTypes:['alert_notification.export.succeeded']});
  const job=await terminal(mailbox.id);await projectAsyncExportNotifications(ctx.env,{now:()=>at+100});
  const fetcher=async()=>new Response(null,{status:400});for(let i=0;i<Math.ceil(endpoints/2);i++)await runWebhookJobs(ctx.env,{now:()=>at+200,fetcher});
  return {mailbox,job};
}
function safe(value:unknown){expect(JSON.stringify(value)).not.toMatch(/PRIVATE_TARGET|claim_token|lease_token|signing_secret|url_snapshot|payload_json|WEBHOOK_KEYRING|object_key/);}

it('returns the captured decision with empty delivery totals before projection and publication',async()=>{
  const mailbox=await box(),job=await terminal(mailbox.id);
  const initial=await listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,job.id);expect(initial).toMatchObject({publication:'pending_projection',notification:{notificationDecision:null},deliverySummary:{total:0,attempts:0}});expect(initial.deliveries).toEqual([]);
  await projectAsyncExportNotifications(ctx.env,{now:()=>at+100});expect((await listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,job.id)).publication).toBe('pending_publication');
  await runWebhookJobs(ctx.env,{now:()=>at+200,fetcher:async()=>{throw Error('No subscriber should be called');}});
  const final=await listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,job.id);expect(final).toMatchObject({publication:'published',notification:{notificationDecision:'no_subscribers'},deliverySummary:{total:0}});safe(final);
});

it('paginates only the exact notification event while keeping complete delivery counters in the same snapshot',async()=>{
  const {mailbox,job}=await fixture(),page=await listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,job.id,{limit:2});
  expect(page).toMatchObject({publication:'published',notification:{notificationDecision:'allowed'},deliverySummary:{total:3,dead:3,attempts:3}});expect(page.deliveries).toHaveLength(2);expect(page.nextCursor).not.toBeNull();
  const next=await listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,job.id,{limit:2,cursor:page.nextCursor});expect(next.deliveries).toHaveLength(1);expect(next.nextCursor).toBeNull();expect(new Set([...page.deliveries,...next.deliveries].map(row=>row.id)).size).toBe(3);
  expect(page.deliveries.every(row=>row.retry.available)).toBe(true);safe(page);
  const other=await terminal(mailbox.id);await expect(listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,other.id,{limit:2,cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,job.id,{limit:1,cursor:page.nextCursor})).rejects.toMatchObject({code:'invalid_cursor'});
  await expect(getAsyncExportNotificationDelivery(ctx,mailbox.id,other.id,page.deliveries[0].id)).rejects.toMatchObject({status:404});
});

it('returns bounded attempt and manual retry histories, including safe legacy audit metadata',async()=>{
  const {mailbox,job}=await fixture(1),page=await listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,job.id),delivery=page.deliveries[0],client=crypto.randomUUID();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at) VALUES(?,?,'owner','webhook.delivery_retried',?,'success','PRIVATE_REQUEST',?,?)")
      .bind(crypto.randomUUID(),mailbox.id,delivery.id,JSON.stringify({clientRequestId:client,expectedUpdatedAt:delivery.updatedAt,previousAttemptBudget:8,attemptBudget:16,PRIVATE:'NEVER_RETURN'}),at+201),
    ctx.env.DB.prepare("INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at) VALUES(?,?,'owner','webhook.delivery_retried',?,'success','PRIVATE_REQUEST',?)")
      .bind(crypto.randomUUID(),mailbox.id,delivery.id,at+202)
  ]);
  const detail=await getAsyncExportNotificationDelivery(ctx,mailbox.id,job.id,delivery.id);expect(detail.attempts).toHaveLength(1);expect(detail.attempts[0]).toMatchObject({attemptNo:1,outcome:'dead',httpStatus:400,errorCode:'http_rejected'});
  expect(detail.manualRetries).toHaveLength(2);expect(detail.manualRetries[0]).toMatchObject({clientRequestId:null,expectedUpdatedAt:null,previousAttemptBudget:null,attemptBudget:null});
  expect(detail.manualRetries[1]).toMatchObject({clientRequestId:client,previousAttemptBudget:8,attemptBudget:16});safe(detail);expect(JSON.stringify(detail)).not.toContain('PRIVATE');
});

it('is read-only without decrypting secrets, touching R2 or fetching; absent key configuration only changes retry availability',async()=>{
  const {mailbox,job}=await fixture(1),before=await ctx.env.DB.prepare('SELECT(SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM events) events,(SELECT sum(attempts) FROM webhook_deliveries) attempts').first();
  const decrypt=vi.spyOn(crypto.subtle,'decrypt').mockImplementation(async()=>{throw Error('Read must not decrypt');});
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('Read must not fetch');});
  const restricted={...ctx,env:{...ctx.env,WEBHOOK_KEYRING:undefined,MAIL_BLOBS:new Proxy(ctx.env.MAIL_BLOBS,{get(){throw Error('Read must not use R2');}})}};
  const page=await listAsyncExportNotificationDeliveryResults(restricted,mailbox.id,job.id);expect(page.deliveries[0].retry).toEqual({available:false,reason:'not_configured'});
  const detail=await getAsyncExportNotificationDelivery(restricted,mailbox.id,job.id,page.deliveries[0].id);safe(detail);expect(decrypt).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
  expect(await ctx.env.DB.prepare('SELECT(SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM events) events,(SELECT sum(attempts) FROM webhook_deliveries) attempts').first()).toEqual(before);
});

it('allows paused and expired task evidence without enabling retry and protects Owner and mailbox scope',async()=>{
  const {mailbox,job}=await fixture(1),other=await box(),page=await listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,job.id);
  await ctx.env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(mailbox.id).run();await ctx.env.DB.prepare("UPDATE async_alert_notification_exports SET state='expired',version=version+1,updated_at=updated_at+1 WHERE id=?").bind(job.id).run();
  const result=await getAsyncExportNotificationDelivery(ctx,mailbox.id,job.id,page.deliveries[0].id);expect(result.delivery.retry).toEqual({available:false,reason:'mailbox_inactive'});
  await expect(listAsyncExportNotificationDeliveryResults(ctx,other.id,job.id)).rejects.toMatchObject({status:404});
  for(const actor of [null,{kind:'token' as const,mailboxId:mailbox.id,tokenId:crypto.randomUUID(),canRead:true}])await expect(listAsyncExportNotificationDeliveryResults({...ctx,actor},mailbox.id,job.id)).rejects.toMatchObject({status:actor?403:401});
});

it('reports current policy and prevents a plausible frozen payload from substituting another job snapshot',async()=>{
  const {mailbox,job}=await fixture(1),page=await listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,job.id),delivery=page.deliveries[0];
  const raw=await ctx.env.DB.prepare('SELECT payload_json FROM webhook_deliveries WHERE id=?').bind(delivery.id).first<string>('payload_json');
  const notice=(await ctx.env.DB.prepare('SELECT * FROM async_export_notifications WHERE job_id=?').bind(job.id).first<AsyncExportNotificationRow>())!;
  const event=(await ctx.env.DB.prepare('SELECT * FROM events WHERE id=?').bind(delivery.eventId).first<WebhookEventRow>())!;
  expect(asyncExportNotificationFrozenPayloadValid(notice,event,raw!)).toBe(true);
  expect(asyncExportNotificationFrozenPayloadValid({...notice,job_id:crypto.randomUUID()},event,raw!)).toBe(false);
  expect(asyncExportNotificationFrozenPayloadValid(notice,event,raw!.replace(job.id,crypto.randomUUID()))).toBe(false);
  expect(asyncExportNotificationFrozenPayloadValid(notice,{...event,payload_json:event.payload_json.replace(job.id,crypto.randomUUID())},raw!)).toBe(false);
  const detail=await getAsyncExportNotificationDelivery(ctx,mailbox.id,job.id,delivery.id);expect(detail.currentPolicy).toEqual({enabled:true,quiet:false,version:0});
});

it('shows live disable and quiet reasons without reevaluating the immutable original admission decision',async()=>{
  const {mailbox,job}=await fixture(1),page=await listAsyncExportNotificationDeliveryResults(ctx,mailbox.id,job.id),id=page.deliveries[0].id;
  await ctx.env.DB.prepare('INSERT INTO alert_notification_policies(mailbox_id,enabled,updated_at) VALUES(?,0,?)').bind(mailbox.id,at).run();
  const disabled=await getAsyncExportNotificationDelivery(ctx,mailbox.id,job.id,id);expect(disabled).toMatchObject({notification:{notificationDecision:'allowed'},delivery:{retry:{available:false,reason:'notifications_disabled'}},currentPolicy:{enabled:false,quiet:false,version:1}});
  const date=new Date(),minute=date.getUTCHours()*60+date.getUTCMinutes();
  await ctx.env.DB.prepare("UPDATE alert_notification_policies SET enabled=1,quiet_enabled=1,quiet_start_minute=?,quiet_end_minute=?,time_zone='UTC',version=version+1,updated_at=updated_at+1 WHERE mailbox_id=?")
    .bind((minute+1435)%1440,(minute+5)%1440,mailbox.id).run();
  const quiet=await getAsyncExportNotificationDelivery(ctx,mailbox.id,job.id,id);expect(quiet.delivery.retry).toEqual({available:false,reason:'quiet_hours'});expect(quiet.currentPolicy).toEqual({enabled:true,quiet:true,version:2});
});
