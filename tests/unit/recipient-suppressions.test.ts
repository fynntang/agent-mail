import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,beforeEach,afterEach,it,expect} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,issueToken,revokeToken,type OwnerContext} from '../../src/lib/server/core/owner';
import {saveDraft,approveDraft,requestSend,putObject} from '../../src/lib/server/core/outbound';
import {runSendJobs} from '../../src/lib/server/core/outbound-jobs';
import {ingestDeliveryEvent} from '../../src/lib/server/core/delivery-events';
import {assertRecipientsNotSuppressed,listRecipientSuppressions,releaseRecipientSuppression,checkRecipientSuppressions} from '../../src/lib/server/core/recipient-suppressions';
import {sha256} from '../../src/lib/server/core/crypto';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,ctx:OwnerContext,migrations:Map<string,string[]>,at:number;
const account='a'.repeat(32),zone='b'.repeat(32),subscription='c'.repeat(32);
beforeAll(async()=>{
  migrations=new Map();for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())migrations.set(name,unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));
});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'suppression-core'},r2Buckets:{MAIL_BLOBS:'suppression-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch([...migrations.values()].flat().map(query=>db.prepare(query)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',EMAIL:{send:async()=>({messageId:crypto.randomUUID()})},EMAIL_EVENT_ACCOUNT_ID:account,EMAIL_EVENT_ZONE_ID:zone,
    EMAIL_EVENT_SUBSCRIPTION_ID:subscription,EMAIL_EVENT_DOMAIN:'agent.example.com',EMAIL_EVENT_QUEUE:'email-receipts'} as unknown as RuntimeEnv;
  ctx={env,actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};at=Date.now();
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);
const mailbox=()=>createMailbox(ctx,{name:'Suppression',localPart:`suppression-${crypto.randomUUID()}`});
async function accepted(to=['recipient@example.net'],box?:Awaited<ReturnType<typeof mailbox>>) {
  box??=await mailbox();const draft=await saveDraft(ctx,box.id,{to,subject:'Risk evidence',text:'Body'});
  await approveDraft(ctx,box.id,draft.id,{expectedVersion:draft.version,contentSha256:draft.contentSha256});
  const result=await requestSend(ctx,box.id,draft.id,{expectedVersion:draft.version},crypto.randomUUID()),providerId=`provider-${crypto.randomUUID()}`;
  await runSendJobs(env,{sender:async()=>({messageId:providerId} as EmailSendResult)});return {box,id:result.outboundId!,providerId};
}
function body(out:Awaited<ReturnType<typeof accepted>>,kind:'bounced'|'complained'|'delivered',address='recipient@example.net',time=at,bounceType?:'hard'|'soft') {
  return {type:`cf.email.sending.message.${kind}`,source:{type:'email.sending',zoneId:zone,domain:'agent.example.com'},payload:{eventId:crypto.randomUUID(),messageId:out.providerId,sender:out.box.address,recipient:address,
    terminal:true,delivery:{status:kind},...(bounceType?{bounce:{type:bounceType}}:{})},metadata:{accountId:account,eventSubscriptionId:subscription,eventSchemaVersion:1,eventTimestamp:new Date(time).toISOString()}};
}
const rows=(box:string,status:'active'|'released'|'all'='active')=>listRecipientSuppressions(ctx,box,{status});

it('automatically suppresses only explicit hard bounces and complaints, scoped to the correlated mailbox',async()=>{
  const out=await accepted(['hard@example.net','soft@example.net','missing@example.net','complaint@example.net']);
  await ingestDeliveryEvent(env,body(out,'bounced','hard@example.net',at,'hard'),at);
  await ingestDeliveryEvent(env,body(out,'bounced','soft@example.net',at,'soft'),at);
  await ingestDeliveryEvent(env,body(out,'bounced','missing@example.net',at),at);
  await ingestDeliveryEvent(env,body(out,'complained','complaint@example.net',at),at);
  expect((await rows(out.box.id)).suppressions.map(item=>[item.address,item.reason]).sort()).toEqual([['complaint@example.net','complaint'],['hard@example.net','hard_bounce']]);
  await expect(assertRecipientsNotSuppressed(env,out.box.id,['other@example.net','hard@example.net'])).rejects.toMatchObject({code:'recipient_suppressed',status:409});
  await assertRecipientsNotSuppressed(env,out.box.id,['soft@example.net','missing@example.net']);
  const other=await mailbox();await assertRecipientsNotSuppressed(env,other.id,['hard@example.net']);
  const bad=body(out,'bounced','foreign@example.net',at,'hard');expect((await ingestDeliveryEvent(env,bad,at)).outcome).toBe('ignored');expect((await rows(out.box.id)).suppressions).toHaveLength(2);
});

it('records hard-bounce safety evidence even when the delivery status event is stale',async()=>{
  const out=await accepted();await ingestDeliveryEvent(env,body(out,'delivered','recipient@example.net',at+10_000),at+10_000);
  expect((await ingestDeliveryEvent(env,body(out,'bounced','recipient@example.net',at,'hard'),at)).outcome).toBe('ignored');
  expect((await rows(out.box.id)).suppressions[0].reason).toBe('hard_bounce');
  expect(await env.DB.prepare('SELECT status FROM outbound_recipients WHERE outbound_id=?').bind(out.id).first('status')).toBe('delivered');
  expect(await env.DB.prepare("SELECT suppression_applied_at FROM email_delivery_events WHERE event_type='bounced'").first('suppression_applied_at')).toBe(at);
});

it('releases by Owner CAS, never reactivates old/replayed evidence, and permits genuinely later evidence without downgrading a complaint',async()=>{
  const out=await accepted(),original=body(out,'complained','recipient@example.net',at-1000);
  await ingestDeliveryEvent(env,original,at);let suppression=(await rows(out.box.id)).suppressions[0];
  const released=(await releaseRecipientSuppression(ctx,out.box.id,suppression.id,{expectedVersion:suppression.version})).suppression;
  expect(released).toMatchObject({status:'released',version:suppression.version+1});await assertRecipientsNotSuppressed(env,out.box.id,['recipient@example.net']);
  await expect(releaseRecipientSuppression(ctx,out.box.id,suppression.id,{expectedVersion:suppression.version})).rejects.toMatchObject({code:'suppression_changed'});
  expect((await ingestDeliveryEvent(env,original,at)).outcome).toBe('duplicate');
  await ingestDeliveryEvent(env,body(out,'bounced','recipient@example.net',released.releasedAt!-1,'hard'),released.releasedAt!);
  expect((await rows(out.box.id)).suppressions).toHaveLength(0);
  await ingestDeliveryEvent(env,body(out,'bounced','recipient@example.net',released.releasedAt!+1,'hard'),released.releasedAt!+1);
  suppression=(await rows(out.box.id)).suppressions[0];expect(suppression).toMatchObject({status:'active',reason:'complaint',releasedAt:null});expect(suppression.version).toBe(released.version+1);
});

it('reactivates a released address on new safety evidence even when the provider delivery ordering still ignores that event',async()=>{
  const out=await accepted();await ingestDeliveryEvent(env,body(out,'delivered','recipient@example.net',at+10_000),at);
  await ingestDeliveryEvent(env,body(out,'bounced','recipient@example.net',at-1000,'hard'),at);
  const suppression=(await rows(out.box.id)).suppressions[0],released=(await releaseRecipientSuppression(ctx,out.box.id,suppression.id,{expectedVersion:suppression.version})).suppression;
  expect((await ingestDeliveryEvent(env,body(out,'bounced','recipient@example.net',released.releasedAt!+1,'hard'),released.releasedAt!+1)).outcome).toBe('ignored');
  expect((await rows(out.box.id)).suppressions[0].status).toBe('active');expect(await env.DB.prepare('SELECT status FROM outbound_recipients WHERE outbound_id=?').bind(out.id).first('status')).toBe('delivered');
});

it('keeps release and evidence races fenced: a successful release cannot be undone by pre-release evidence',async()=>{
  const out=await accepted();await ingestDeliveryEvent(env,body(out,'bounced','recipient@example.net',at-10_000,'hard'),at-5000);
  const suppression=(await rows(out.box.id)).suppressions[0];
  const results=await Promise.allSettled([releaseRecipientSuppression(ctx,out.box.id,suppression.id,{expectedVersion:suppression.version}),ingestDeliveryEvent(env,body(out,'bounced','recipient@example.net',at-1000,'hard'),at)]);
  if(results[0].status==='fulfilled')expect((await rows(out.box.id)).suppressions).toHaveLength(0);
  else {expect(results[0].reason).toMatchObject({code:'suppression_changed'});const current=(await rows(out.box.id)).suppressions[0];await releaseRecipientSuppression(ctx,out.box.id,current.id,{expectedVersion:current.version});}
  expect((await rows(out.box.id)).suppressions).toHaveLength(0);
});

it('paginates Owner lists with scoped cursors and allows release while paused but rejects retired mailboxes',async()=>{
  const out=await accepted(['a@example.net','b@example.net','c@example.net']);for(const address of ['a@example.net','b@example.net','c@example.net'])await ingestDeliveryEvent(env,body(out,'bounced',address,at,'hard'),at);
  const first=await listRecipientSuppressions(ctx,out.box.id,{limit:1}),second=await listRecipientSuppressions(ctx,out.box.id,{limit:1,cursor:first.nextCursor!});
  expect(first.suppressions[0].id).not.toBe(second.suppressions[0].id);const other=await mailbox();
  await expect(listRecipientSuppressions(ctx,other.id,{limit:1,cursor:first.nextCursor!})).rejects.toMatchObject({code:'invalid_cursor'});
  await env.DB.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").bind(out.box.id).run();
  await releaseRecipientSuppression(ctx,out.box.id,first.suppressions[0].id,{expectedVersion:first.suppressions[0].version});expect((await rows(out.box.id,'released')).suppressions).toHaveLength(1);
  await env.DB.prepare("UPDATE mailboxes SET status='deleting' WHERE id=?").bind(out.box.id).run();await expect(rows(out.box.id)).rejects.toMatchObject({status:404});
});

it('checks only requested addresses with live send scope, redacts evidence, and denies enumeration/Owner mutations to tokens',async()=>{
  const out=await accepted();await ingestDeliveryEvent(env,body(out,'complained'),at);
  const issued=await issueToken(ctx,out.box.id,{name:'Send check',scopes:['mail:draft','mail:send']}),actor={kind:'token' as const,mailboxId:out.box.id,tokenId:issued.token.id,canRead:false,canSend:true};
  const agent={...ctx,actor};expect(await checkRecipientSuppressions(agent,out.box.id,['recipient@EXAMPLE.NET','other@example.net'])).toEqual({recipients:[{address:'recipient@example.net',suppressed:true,reason:'complaint'},{address:'other@example.net',suppressed:false,reason:null}]});
  await expect(listRecipientSuppressions(agent,out.box.id)).rejects.toMatchObject({code:'owner_required'});
  const suppression=(await rows(out.box.id)).suppressions[0];await expect(releaseRecipientSuppression(agent,out.box.id,suppression.id,{expectedVersion:suppression.version})).rejects.toMatchObject({code:'owner_required'});
  await expect(checkRecipientSuppressions({...agent,actor:{...actor,canSend:false}},out.box.id,['recipient@example.net'])).rejects.toMatchObject({code:'insufficient_scope'});
  await revokeToken(ctx,out.box.id,issued.token.id);await expect(checkRecipientSuppressions(agent,out.box.id,['recipient@example.net'])).rejects.toMatchObject({code:'insufficient_scope'});
});

it('backfills only trusted legacy complaints and preserves 0007 hashes without inferring hardness or reactivating released legacy evidence',async()=>{
  const old=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("old");}}',compatibilityDate:'2026-11-10',d1Databases:{DB:'suppression-upgrade'},r2Buckets:{MAIL_BLOBS:'suppression-upgrade'},log:new Log(LogLevel.ERROR)}));
  try {
    const db=await old.getD1Database('DB');await db.batch([...migrations.entries()].filter(([name])=>name<'0008').flatMap(([,queries])=>queries).map(query=>db.prepare(query)));
    const oldEnv={...env,DB:db,MAIL_BLOBS:await old.getR2Bucket('MAIL_BLOBS')} as unknown as RuntimeEnv,owner={...ctx,env:oldEnv};
    const box=await createMailbox(owner,{name:'Legacy',localPart:`legacy-${crypto.randomUUID()}`}),draft=await saveDraft(owner,box.id,{to:['complaint@example.net','bounce@example.net'],subject:'Legacy',text:'Body'});
    const frozen=await putObject(oldEnv,box.id,'outbound','{}'),id=crypto.randomUUID(),counter=crypto.randomUUID(),reservation=crypto.randomUUID(),providerId=`legacy-${crypto.randomUUID()}`;
    await db.batch([
      db.prepare('INSERT INTO daily_send_counters(id,mailbox_id,day_utc,limit_snapshot) VALUES(?,?,?,10)').bind(counter,box.id,new Date().toISOString().slice(0,10)),
      db.prepare('INSERT INTO send_reservations(id,mailbox_id,counter_id,operation_id,units,created_at) VALUES(?,?,?,?,2,?)').bind(reservation,box.id,counter,id,at),
      db.prepare(`INSERT INTO outbound_messages(id,mailbox_id,sender_address_id,draft_id,frozen_object_id,reservation_id,request_sha256,status,provider_message_id,created_at,updated_at)
        SELECT ?,?,a.id,?,?,?,?,'accepted',?,?,? FROM mailbox_addresses a WHERE a.mailbox_id=? AND a.is_primary=1`).bind(id,box.id,draft.id,frozen.id,reservation,draft.contentSha256,providerId,at,at,box.id),
      ...['complaint@example.net','bounce@example.net'].map(address=>db.prepare("INSERT INTO outbound_recipients(id,mailbox_id,outbound_id,kind,address,status) VALUES(?,?,?,'to',?,'delivered')").bind(crypto.randomUUID(),box.id,id,address))
    ]);
    const out={box,id,providerId},complaint=body(out,'complained','complaint@example.net',at),bounce=body(out,'bounced','bounce@example.net',at,'hard');
    for(const event of [complaint,bounce]){
      const kind=event.payload.delivery.status,value={account_id:account,event_id:event.payload.eventId,zone_id:zone,subscription_id:subscription,domain:'agent.example.com',provider_message_id:providerId,sender:box.address,recipient:event.payload.recipient,event_type:kind,event_at:at,terminal:1};
      await db.prepare(`INSERT INTO email_delivery_events(id,account_id,event_id,zone_id,subscription_id,domain,provider_message_id,sender,recipient,event_type,event_at,terminal,canonical_sha256,state,mailbox_id,outbound_id,received_at,expires_at,next_attempt_at,applied_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'applied',?,?,?,?,?,?)`).bind(crypto.randomUUID(),account,value.event_id,zone,subscription,value.domain,providerId,box.address,value.recipient,kind,at,1,await sha256(JSON.stringify(value)),box.id,id,at,at+7*86400_000,at,at).run();
    }
    await db.batch(migrations.get('0008_recipient_suppressions.sql')!.map(query=>db.prepare(query)));
    const listed=await listRecipientSuppressions(owner,box.id);expect(listed.suppressions.map(row=>row.address)).toEqual(['complaint@example.net']);
    await releaseRecipientSuppression(owner,box.id,listed.suppressions[0].id,{expectedVersion:1});
    expect((await ingestDeliveryEvent(oldEnv,complaint,at)).outcome).toBe('duplicate');expect((await ingestDeliveryEvent(oldEnv,bounce,at)).outcome).toBe('duplicate');
    expect((await listRecipientSuppressions(owner,box.id)).suppressions).toHaveLength(0);
    expect(await db.prepare("SELECT bounce_type,evidence_version FROM email_delivery_events WHERE event_type='bounced'").first()).toEqual({bounce_type:null,evidence_version:0});
  }finally{await old.dispose();}
});
