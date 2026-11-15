import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {saveDraft,approveDraft,requestSend} from '../../src/lib/server/core/outbound';
import {runSendJobs} from '../../src/lib/server/core/outbound-jobs';
import {ingestDeliveryEvent,runDeliveryEventJobs,deliveryEventsConfigured} from '../../src/lib/server/core/delivery-events';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,schema:string[],at:number;
const account='a'.repeat(32),zone='b'.repeat(32),subscription='c'.repeat(32);
beforeAll(async()=>{
  schema=[];for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())
    schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));
});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'delivery-events'},r2Buckets:{MAIL_BLOBS:'delivery-events'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',EMAIL:{send:async()=>({messageId:crypto.randomUUID()})},
    EMAIL_EVENT_ACCOUNT_ID:account,EMAIL_EVENT_ZONE_ID:zone,EMAIL_EVENT_SUBSCRIPTION_ID:subscription,EMAIL_EVENT_DOMAIN:'agent.example.com',EMAIL_EVENT_QUEUE:'email-receipts'} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now()+1000;
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);
type Kind='delivered'|'deferred'|'bounced'|'failed'|'rejected'|'complained';
const mailbox=()=>createMailbox(ctx,{name:'Delivery',localPart:`delivery-${crypto.randomUUID()}`});
function envelope(kind:Kind,sender:string,messageId:string,recipient='recipient@example.net',time=at,eventId=crypto.randomUUID()) {
  return {type:`cf.email.sending.message.${kind}`,source:{type:'email.sending',zoneId:zone,domain:'agent.example.com'},
    payload:{eventId,messageId,sender,recipient,subject:'PRIVATE_SUBJECT_NEVER_STORED',terminal:kind!=='deferred',delivery:{status:kind,smtpResponse:'PRIVATE_SMTP_NEVER_STORED'}},
    metadata:{accountId:account,eventSubscriptionId:subscription,eventSchemaVersion:1,eventTimestamp:new Date(time).toISOString()}};
}
async function queued(to=['recipient@example.net']) {
  const box=await mailbox(),draft=await saveDraft(ctx,box.id,{to,subject:'Delivery progress',text:'Body'});
  await approveDraft(ctx,box.id,draft.id,{expectedVersion:draft.version,contentSha256:draft.contentSha256});
  const result=await requestSend(ctx,box.id,draft.id,{expectedVersion:draft.version},crypto.randomUUID());
  return {box,outboundId:result.outboundId!};
}
async function accepted(to=['recipient@example.net']) {
  const result=await queued(to),providerId=`provider-${crypto.randomUUID()}`;
  const sender=vi.fn(async()=>({messageId:providerId} as EmailSendResult));await runSendJobs(env,{sender});expect(sender).toHaveBeenCalledTimes(1);
  return {...result,providerId};
}
const recipient=(outbound:string,address='recipient@example.net')=>env.DB.prepare('SELECT * FROM outbound_recipients WHERE outbound_id=? AND address=?').bind(outbound,address).first<Record<string,unknown>>();
const status=(outbound:string)=>env.DB.prepare('SELECT status FROM outbound_messages WHERE id=?').bind(outbound).first('status');
const inbox=()=>env.DB.prepare('SELECT * FROM email_delivery_events ORDER BY received_at,id').all<Record<string,unknown>>();
const providerEvents=()=>env.DB.prepare("SELECT * FROM events WHERE source='cloudflare'").all<Record<string,unknown>>();

it('applies all six provider events per recipient, aggregates partial delivery, and never persists subject/SMTP or changes quota',async()=>{
  const to=['a@example.net','b@example.net','c@example.net','d@example.net','e@example.net'],out=await accepted(to);
  const before=await env.DB.prepare('SELECT reserved_units,used_units FROM daily_send_counters WHERE mailbox_id=?').bind(out.box.id).first();
  for(const [kind,address] of [['delivered',to[0]],['deferred',to[1]],['bounced',to[2]],['failed',to[3]],['rejected',to[4]],['complained',to[0]]] as [Kind,string][])
    expect((await ingestDeliveryEvent(env,envelope(kind,out.box.address,out.providerId,address,at++),at)).outcome).toBe('applied');
  expect(await status(out.outboundId)).toBe('partial');
  expect(await recipient(out.outboundId,to[0])).toMatchObject({status:'delivered',delivery_event_type:'delivered',diagnostic_redacted:'delivery_delivered'});
  expect((await recipient(out.outboundId,to[0]))!.complained_at).not.toBeNull();
  expect(await recipient(out.outboundId,to[4])).toMatchObject({status:'failed',delivery_event_type:'rejected',diagnostic_redacted:'delivery_rejected'});
  expect((await providerEvents()).results.map(row=>row.type).sort()).toEqual(['outbound.bounced','outbound.complained','outbound.deferred','outbound.delivered','outbound.failed','outbound.rejected']);
  const serialized=JSON.stringify((await inbox()).results)+JSON.stringify((await providerEvents()).results);
  expect(serialized).not.toContain('PRIVATE_SUBJECT');expect(serialized).not.toContain('PRIVATE_SMTP');
  expect(await env.DB.prepare('SELECT reserved_units,used_units FROM daily_send_counters WHERE mailbox_id=?').bind(out.box.id).first()).toEqual(before);
});

it('deduplicates concurrent identical events and rejects changed canonical content under the same provider event ID',async()=>{
  const out=await accepted(),body=envelope('delivered',out.box.address,out.providerId);
  const outcomes=await Promise.all(Array.from({length:6},()=>ingestDeliveryEvent(env,body,at)));
  expect(outcomes.filter(value=>value.outcome==='applied')).toHaveLength(1);expect(outcomes.filter(value=>value.outcome==='duplicate')).toHaveLength(5);
  expect((await inbox()).results).toHaveLength(1);expect((await providerEvents()).results).toHaveLength(1);
  const changed=envelope('bounced',out.box.address,out.providerId,'recipient@example.net',at,body.payload.eventId);
  expect(await ingestDeliveryEvent(env,changed,at)).toEqual({outcome:'conflict'});expect(await status(out.outboundId)).toBe('delivered');
  body.payload.subject='Other ignored private subject';expect((await ingestDeliveryEvent(env,body,at)).outcome).toBe('duplicate');
});

it('fences concurrent/out-of-order state changes and never lets deferred or stale receipts regress a terminal delivery',async()=>{
  const out=await accepted();
  await Promise.all([ingestDeliveryEvent(env,envelope('deferred',out.box.address,out.providerId,'recipient@example.net',at),at+200),
    ingestDeliveryEvent(env,envelope('delivered',out.box.address,out.providerId,'recipient@example.net',at+100),at+200)]);
  expect(await status(out.outboundId)).toBe('delivered');
  expect((await ingestDeliveryEvent(env,envelope('deferred',out.box.address,out.providerId,'recipient@example.net',at+200),at+200)).outcome).toBe('ignored');
  expect((await ingestDeliveryEvent(env,envelope('bounced',out.box.address,out.providerId,'recipient@example.net',at-1),at+200)).outcome).toBe('ignored');
  expect(await recipient(out.outboundId)).toMatchObject({status:'delivered',last_delivery_event_at:at+100});
});

it('keeps complaints orthogonal so an earlier delivery event can arrive after a later complaint',async()=>{
  const out=await accepted(),complaint=envelope('complained',out.box.address,out.providerId,'recipient@example.net',at+200);
  await ingestDeliveryEvent(env,complaint,at+300);
  expect(await status(out.outboundId)).toBe('accepted');expect(await recipient(out.outboundId)).toMatchObject({status:'accepted',complained_at:at+200,last_delivery_event_at:null,diagnostic_redacted:null});
  await ingestDeliveryEvent(env,envelope('delivered',out.box.address,out.providerId,'recipient@example.net',at+100),at+300);
  expect(await status(out.outboundId)).toBe('delivered');expect(await recipient(out.outboundId)).toMatchObject({complained_at:at+200,last_provider_event_at:at+200,last_provider_event_id:complaint.payload.eventId,last_delivery_event_at:at+100});
});

it('durably accepts a receipt before the native send ACK then reconciles without resending or reserving quota again',async()=>{
  const out=await queued(),providerId=`early-${crypto.randomUUID()}`;let firstOutcome='';
  const sender=vi.fn(async()=>{firstOutcome=(await ingestDeliveryEvent(env,envelope('delivered',out.box.address,providerId),at)).outcome;return {messageId:providerId} as EmailSendResult;});
  await runSendJobs(env,{sender});expect(firstOutcome).toBe('pending');expect(await status(out.outboundId)).toBe('delivered');
  expect(await runDeliveryEventJobs(env,at+60_001)).toMatchObject({deliveryEventsApplied:0});expect(await status(out.outboundId)).toBe('delivered');
  await runSendJobs(env,{sender});expect(sender).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare('SELECT reserved_units,used_units FROM daily_send_counters WHERE mailbox_id=?').bind(out.box.id).first()).toEqual({reserved_units:0,used_units:1});
});

it('requires the configured native source and bounded valid payload, and leaves the unconfigured baseline idle',async()=>{
  const out=await accepted(),body=envelope('delivered',out.box.address,out.providerId);
  expect(deliveryEventsConfigured(env)).toBe(true);
  for(const changed of [{...body,source:{...body.source,domain:'other.example.com'}},{...body,metadata:{...body.metadata,accountId:'d'.repeat(32)}},{...body,metadata:{...body.metadata,eventSubscriptionId:'d'.repeat(32)}}])
    await expect(ingestDeliveryEvent(env,changed,at)).rejects.toMatchObject({status:403});
  for(const changed of [{...body,payload:{...body.payload,terminal:false}},{...body,metadata:{...body.metadata,eventSchemaVersion:2}},{...body,metadata:{...body.metadata,eventTimestamp:new Date(at+300_001).toISOString()}},{...body,payload:{...body.payload,messageId:'header\r\ninjection'}}])
    await expect(ingestDeliveryEvent(env,changed,at)).rejects.toMatchObject({status:400});
  expect((await inbox()).results).toHaveLength(0);
  const disabled={...env,EMAIL_EVENT_QUEUE:undefined};expect(deliveryEventsConfigured(disabled)).toBe(false);
  await expect(ingestDeliveryEvent(disabled,body,at)).rejects.toMatchObject({status:503});
  const blockedDb=new Proxy(env.DB,{get(target,key){if(key==='prepare')throw new Error('DB must remain idle');return Reflect.get(target,key);}});
  expect(await runDeliveryEventJobs({...disabled,DB:blockedDb})).toEqual({deliveryEventsApplied:0,deliveryEventsIgnored:0,deliveryEventsPending:0});
});

it('correlates only exact provider ID, sender and recipient and quarantines revoked-source or expired unmatched receipts',async()=>{
  const out=await accepted(),other=await mailbox();
  expect((await ingestDeliveryEvent(env,envelope('delivered',other.address,out.providerId),at)).outcome).toBe('ignored');
  expect((await ingestDeliveryEvent(env,envelope('delivered',out.box.address,out.providerId,'other@example.net'),at)).outcome).toBe('ignored');
  expect(await status(out.outboundId)).toBe('accepted');expect((await providerEvents()).results).toHaveLength(0);
  await ingestDeliveryEvent(env,envelope('delivered',out.box.address,'not-yet-known'),at);
  env.EMAIL_EVENT_SUBSCRIPTION_ID='d'.repeat(32);expect((await runDeliveryEventJobs(env,at+60_001)).deliveryEventsIgnored).toBe(1);
  expect((await inbox()).results.some(row=>row.ignore_reason==='source_changed')).toBe(true);
  env.EMAIL_EVENT_SUBSCRIPTION_ID=subscription;await ingestDeliveryEvent(env,envelope('delivered',out.box.address,'unknown-expired'),at);
  expect((await runDeliveryEventJobs(env,at+7*86400_000+1)).deliveryEventsIgnored).toBe(1);
  expect((await inbox()).results.some(row=>row.ignore_reason==='unmatched_expired')).toBe(true);
});

it('aggregates all-recipient bounces and rejections using the existing outbound state vocabulary',async()=>{
  const bounced=await accepted(['a@example.net','b@example.net']);
  for(const address of ['a@example.net','b@example.net'])await ingestDeliveryEvent(env,envelope('bounced',bounced.box.address,bounced.providerId,address),at);
  expect(await status(bounced.outboundId)).toBe('bounced');
  const failed=await accepted(['a@example.net','b@example.net']);
  for(const address of ['a@example.net','b@example.net'])await ingestDeliveryEvent(env,envelope('rejected',failed.box.address,failed.providerId,address),at);
  expect(await status(failed.outboundId)).toBe('failed');
});

it('bounds pending work fairly to twenty receipts per run and caps unknown pending rows without blocking a known delivery',async()=>{
  const box=await mailbox();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
    INSERT INTO email_delivery_events(id,account_id,event_id,zone_id,subscription_id,domain,provider_message_id,sender,recipient,event_type,event_at,terminal,canonical_sha256,received_at,expires_at,next_attempt_at)
    SELECT 'fixture-'||x,?,'00000000-0000-0000-0000-'||printf('%012d',x),?,?,?,'unknown-'||x,?,'recipient@example.net','delivered',?,1,?,?,?,? FROM n`)
    .bind(account,zone,subscription,'agent.example.com',box.address,at,'0'.repeat(64),at,at+7*86400_000,at).run();
  expect(await runDeliveryEventJobs(env,at)).toEqual({deliveryEventsApplied:0,deliveryEventsIgnored:0,deliveryEventsPending:20});
  expect(await env.DB.prepare('SELECT count(*) n FROM email_delivery_events WHERE reconcile_attempts=1').first('n')).toBe(20);
  expect((await ingestDeliveryEvent(env,envelope('delivered',box.address,'over-pending-cap'),at)).outcome).toBe('ignored');
  expect((await inbox()).results.some(row=>row.ignore_reason==='pending_limit')).toBe(true);
  const out=await accepted();expect((await ingestDeliveryEvent(env,envelope('delivered',out.box.address,out.providerId),at)).outcome).toBe('applied');expect(await status(out.outboundId)).toBe('delivered');
});
