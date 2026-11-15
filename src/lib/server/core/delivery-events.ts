import {sha256} from './crypto';
import {externalAddress} from './outbound-content';
import {ServiceError,type RuntimeEnv} from './types';
import {suppressionEvidenceStatements} from './recipient-suppressions';

const kinds=['delivered','deferred','bounced','failed','rejected','complained'] as const;
type Kind=typeof kinds[number];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cfId=/^[0-9a-f]{32}$/i,encoder=new TextEncoder();
const TTL=7*86400_000,MAX_PENDING=1000,MAX_RECONCILES=64;
interface Config {account:string;zone:string;subscription:string;domain:string;queue:string}
interface Normalized {account_id:string;event_id:string;zone_id:string;subscription_id:string;domain:string;provider_message_id:string;sender:string;recipient:string;event_type:Kind;event_at:number;terminal:number;bounce_type:'hard'|'soft'|null}
interface Receipt extends Normalized {id:string;canonical_sha256:string;state:'pending'|'applied'|'ignored';received_at:number;expires_at:number;next_attempt_at:number;reconcile_attempts:number;evidence_version:number;suppression_applied_at:number|null}
interface Recipient {
  id:string;mailbox_id:string;outbound_id:string;status:string;last_provider_event_at:number|null;last_provider_event_id:string|null;
  delivery_event_type:Exclude<Kind,'complained'>|null;complained_at:number|null;last_delivery_event_at:number|null;last_delivery_event_id:string|null;
  diagnostic_redacted:string|null;
}
export interface DeliveryEventResult {outcome:'applied'|'duplicate'|'pending'|'ignored'|'conflict';outboundId?:string}
const sql=(env:RuntimeEnv,query:string,...args:(string|number|null)[])=>env.DB.prepare(query).bind(...args);
function configuration(env:RuntimeEnv):Config {
  const {EMAIL_EVENT_ACCOUNT_ID:account,EMAIL_EVENT_ZONE_ID:zone,EMAIL_EVENT_SUBSCRIPTION_ID:subscription,EMAIL_EVENT_DOMAIN:domain,EMAIL_EVENT_QUEUE:queue}=env;
  try {
    if(!account||!zone||!subscription||!domain||!queue||!cfId.test(account)||!cfId.test(zone)||!cfId.test(subscription)
      ||queue.length>128||!/^[A-Za-z0-9_-]+$/.test(queue)||externalAddress(`check@${domain}`).split('@')[1]!==domain.toLowerCase())throw new Error();
    return {account:account.toLowerCase(),zone:zone.toLowerCase(),subscription:subscription.toLowerCase(),domain:domain.toLowerCase(),queue};
  }catch{throw new ServiceError('delivery_events_not_configured',503);}
}
export function deliveryEventsConfigured(env:RuntimeEnv):boolean {try{configuration(env);return true;}catch{return false;}}
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ServiceError('invalid_delivery_event',400);
  return value as Record<string,unknown>;
}
function normalize(env:RuntimeEnv,body:unknown,now:number):Normalized {
  const config=configuration(env);
  try {
    if(encoder.encode(JSON.stringify(body)).byteLength>64*1024)throw new Error();
    const input=object(body),source=object(input.source),payload=object(input.payload),metadata=object(input.metadata),delivery=object(payload.delivery);
    const kind=typeof input.type==='string'?input.type.replace(/^cf\.email\.sending\.message\./,''):'';
    if(input.type!==`cf.email.sending.message.${kind}`||!kinds.includes(kind as Kind)||delivery.status!==kind||payload.terminal!==(kind!=='deferred')
      ||source.type!=='email.sending'||metadata.eventSchemaVersion!==1||typeof payload.eventId!=='string'||!uuid.test(payload.eventId)
      ||typeof payload.messageId!=='string'||payload.messageId.length<1||payload.messageId.length>1024||!/^[\x21-\x7e]+$/.test(payload.messageId)
      ||typeof metadata.eventTimestamp!=='string'||metadata.eventTimestamp.length>64
      ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(metadata.eventTimestamp))throw new Error();
    const eventAt=Date.parse(metadata.eventTimestamp);
    if(!Number.isSafeInteger(eventAt)||eventAt<0||eventAt>now+300_000)throw new Error();
    const sender=externalAddress(payload.sender),recipient=externalAddress(payload.recipient);
    if(typeof metadata.accountId!=='string'||metadata.accountId.toLowerCase()!==config.account
      ||typeof source.zoneId!=='string'||source.zoneId.toLowerCase()!==config.zone
      ||typeof source.domain!=='string'||source.domain.toLowerCase()!==config.domain
      ||typeof metadata.eventSubscriptionId!=='string'||metadata.eventSubscriptionId.toLowerCase()!==config.subscription
      ||sender.split('@')[1]!==config.domain)throw new ServiceError('delivery_event_source_mismatch',403);
    const bounce=payload.bounce&&typeof payload.bounce==='object'&&!Array.isArray(payload.bounce)?payload.bounce as Record<string,unknown>:null;
    const bounceType=kind==='bounced'&&(bounce?.type==='hard'||bounce?.type==='soft')?bounce.type:null;
    return {account_id:config.account,event_id:payload.eventId.toLowerCase(),zone_id:config.zone,subscription_id:config.subscription,domain:config.domain,
      provider_message_id:payload.messageId,sender,recipient,event_type:kind as Kind,event_at:eventAt,terminal:payload.terminal?1:0,bounce_type:bounceType};
  }catch(error){if(error instanceof ServiceError&&error.status===403)throw error;throw new ServiceError('invalid_delivery_event',400);}
}
async function receipt(env:RuntimeEnv,id:string):Promise<Receipt> {return (await sql(env,'SELECT * FROM email_delivery_events WHERE id=?',id).first<Receipt>())!;}
async function ignore(env:RuntimeEnv,row:Receipt,now:number,reason:string):Promise<DeliveryEventResult> {
  await sql(env,"UPDATE email_delivery_events SET state='ignored',applied_at=?,ignore_reason=? WHERE id=? AND state='pending'",now,reason,row.id).run();
  return {outcome:'ignored'};
}
const terminal=(status:string)=>['delivered','bounced','failed'].includes(status);
const rank=(kind:string|null)=>kind==='bounced'?4:kind==='failed'||kind==='rejected'?3:kind==='delivered'?2:kind==='deferred'?1:0;
function nextState(row:Receipt,current:Recipient):Omit<Recipient,'id'|'mailbox_id'|'outbound_id'>|null {
  const result={status:current.status,last_provider_event_at:current.last_provider_event_at,last_provider_event_id:current.last_provider_event_id,
    delivery_event_type:current.delivery_event_type,complained_at:current.complained_at,last_delivery_event_at:current.last_delivery_event_at,last_delivery_event_id:current.last_delivery_event_id,
    diagnostic_redacted:current.diagnostic_redacted};
  if(row.event_type==='complained') {
    if(current.complained_at!==null&&row.event_at<=current.complained_at)return null;
    result.complained_at=row.event_at; // Feedback is orthogonal: it does not infer or replace delivery.
  }else {
    if(row.event_type==='deferred'&&terminal(current.status))return null;
    const previous=current.last_delivery_event_at;
    if(previous!==null&&(row.event_at<previous||row.event_at===previous&&(rank(row.event_type)<rank(current.delivery_event_type)
      ||rank(row.event_type)===rank(current.delivery_event_type)&&row.event_id<=(current.last_delivery_event_id??''))))return null;
    result.status=row.event_type==='rejected'?'failed':row.event_type;
    result.delivery_event_type=row.event_type;result.last_delivery_event_at=row.event_at;result.last_delivery_event_id=row.event_id;
    result.diagnostic_redacted=`delivery_${row.event_type}`;
  }
  if(current.last_provider_event_at===null||row.event_at>current.last_provider_event_at||row.event_at===current.last_provider_event_at&&row.event_id>(current.last_provider_event_id??'')){
    result.last_provider_event_at=row.event_at;result.last_provider_event_id=row.event_id;
  }
  return result;
}
function recipientSnapshot(current:Recipient):{query:string;args:(string|number|null)[]} {
  return {query:'r.id=? AND r.mailbox_id=? AND r.outbound_id=? AND r.status=? AND r.last_provider_event_at IS ? AND r.last_provider_event_id IS ? AND r.delivery_event_type IS ? AND r.complained_at IS ? AND r.last_delivery_event_at IS ? AND r.last_delivery_event_id IS ?',
    args:[current.id,current.mailbox_id,current.outbound_id,current.status,current.last_provider_event_at,current.last_provider_event_id,current.delivery_event_type,current.complained_at,current.last_delivery_event_at,current.last_delivery_event_id]};
}
async function apply(env:RuntimeEnv,initial:Receipt,now:number):Promise<DeliveryEventResult> {
  let row=initial;
  for(let collision=0;collision<3;collision++) {
    if(row.state!=='pending')return {outcome:row.state==='applied'?'duplicate':'ignored'};
    if(row.expires_at<=now||row.reconcile_attempts>=MAX_RECONCILES)return ignore(env,row,now,'unmatched_expired');
    const config=configuration(env);
    if(row.account_id!==config.account||row.zone_id!==config.zone||row.subscription_id!==config.subscription||row.domain!==config.domain)return ignore(env,row,now,'source_changed');
    const outbound=await sql(env,`SELECT o.id,o.mailbox_id,o.status,a.address sender FROM outbound_messages o JOIN mailbox_addresses a ON a.id=o.sender_address_id AND a.mailbox_id=o.mailbox_id
      WHERE o.provider='cloudflare' AND o.provider_message_id=?`,row.provider_message_id).first<{id:string;mailbox_id:string;status:string;sender:string}>();
    if(!outbound) {
      const attempts=row.reconcile_attempts+1;
      await sql(env,`UPDATE email_delivery_events SET next_attempt_at=?,reconcile_attempts=? WHERE id=? AND state='pending' AND reconcile_attempts=?`,
        now+Math.min(3_600_000,60_000*2**Math.min(attempts-1,6)),attempts,row.id,row.reconcile_attempts).run();
      return {outcome:'pending'};
    }
    if(outbound.sender!==row.sender)return ignore(env,row,now,'sender_mismatch');
    if(['queued','submitting','cancelled'].includes(outbound.status))return ignore(env,row,now,'submission_not_accepted');
    const current=await sql(env,'SELECT * FROM outbound_recipients WHERE mailbox_id=? AND outbound_id=? AND address=?',outbound.mailbox_id,outbound.id,row.recipient).first<Recipient>();
    if(!current)return ignore(env,row,now,'recipient_mismatch');
    const next=nextState(row,current),snapshot=recipientSnapshot(current);
    if(!next) {
      const ignored=await env.DB.batch([sql(env,`UPDATE email_delivery_events SET state='ignored',applied_at=?,ignore_reason='stale_event',mailbox_id=?,outbound_id=?
        WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM outbound_recipients r WHERE ${snapshot.query})`,now,outbound.mailbox_id,outbound.id,row.id,...snapshot.args),
        ...suppressionEvidenceStatements(env,row.id,now)]);
      if(ignored[0].meta.changes===1)return {outcome:'ignored',outboundId:outbound.id};
    }else {
      const eventId=crypto.randomUUID(),owned='EXISTS(SELECT 1 FROM events WHERE id=?)';
      const proof=`EXISTS(SELECT 1 FROM email_delivery_events WHERE id=? AND state='pending') AND EXISTS(SELECT 1 FROM outbound_recipients r WHERE ${snapshot.query})
        AND EXISTS(SELECT 1 FROM outbound_messages o JOIN mailbox_addresses a ON a.id=o.sender_address_id AND a.mailbox_id=o.mailbox_id WHERE o.id=? AND o.mailbox_id=? AND o.provider='cloudflare' AND o.provider_message_id=? AND a.address=?)`;
      const results=await env.DB.batch([
        sql(env,`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at)
          SELECT ?,?,'cloudflare',?,?,?,?,? WHERE ${proof} ON CONFLICT(mailbox_id,source,source_event_id) DO NOTHING`,
          eventId,outbound.mailbox_id,`${row.account_id}:${row.event_id}`,`outbound.${row.event_type}`,JSON.stringify({outboundId:outbound.id}),row.event_at,now,row.id,...snapshot.args,outbound.id,outbound.mailbox_id,row.provider_message_id,row.sender),
        sql(env,`UPDATE outbound_recipients SET status=?,last_provider_event_at=?,last_provider_event_id=?,delivery_event_type=?,complained_at=?,last_delivery_event_at=?,last_delivery_event_id=?,diagnostic_redacted=?
          WHERE id=? AND mailbox_id=? AND outbound_id=? AND ${owned}`,next.status,next.last_provider_event_at,next.last_provider_event_id,next.delivery_event_type,next.complained_at,next.last_delivery_event_at,next.last_delivery_event_id,
          next.diagnostic_redacted,current.id,current.mailbox_id,current.outbound_id,eventId),
        sql(env,`UPDATE outbound_messages SET status=CASE
          WHEN ?='complained' THEN status
          WHEN NOT EXISTS(SELECT 1 FROM outbound_recipients WHERE outbound_id=? AND status<>'delivered') THEN 'delivered'
          WHEN NOT EXISTS(SELECT 1 FROM outbound_recipients WHERE outbound_id=? AND status NOT IN('bounced','failed')) THEN CASE
            WHEN NOT EXISTS(SELECT 1 FROM outbound_recipients WHERE outbound_id=? AND status<>'bounced') THEN 'bounced' ELSE 'failed' END
          WHEN EXISTS(SELECT 1 FROM outbound_recipients WHERE outbound_id=? AND status IN('delivered','bounced','failed')) THEN 'partial'
          ELSE 'accepted' END,updated_at=MAX(updated_at,?) WHERE id=? AND mailbox_id=? AND ${owned}`,
          row.event_type,outbound.id,outbound.id,outbound.id,outbound.id,now,outbound.id,outbound.mailbox_id,eventId),
        sql(env,`UPDATE email_delivery_events SET state='applied',mailbox_id=?,outbound_id=?,applied_at=? WHERE id=? AND state='pending' AND ${owned}`,
          outbound.mailbox_id,outbound.id,now,row.id,eventId),
        ...suppressionEvidenceStatements(env,row.id,now)
      ]);
      if(results[3].meta.changes===1)return {outcome:'applied',outboundId:outbound.id};
    }
    row=await receipt(env,row.id);
  }
  return {outcome:'pending'};
}

/** Accept only the documented native envelope after the ingress has verified its transport. */
export async function ingestDeliveryEvent(env:RuntimeEnv,body:unknown,now=Date.now()):Promise<DeliveryEventResult> {
  const value=normalize(env,body,now),hash=await sha256(JSON.stringify(value)),id=crypto.randomUUID();
  const inserted=await sql(env,`INSERT INTO email_delivery_events(id,account_id,event_id,zone_id,subscription_id,domain,provider_message_id,sender,recipient,event_type,event_at,terminal,
    canonical_sha256,state,received_at,expires_at,next_attempt_at,applied_at,ignore_reason,bounce_type,evidence_version)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN (SELECT count(*) FROM email_delivery_events WHERE account_id=? AND state='pending')>=${MAX_PENDING}
      AND NOT EXISTS(SELECT 1 FROM outbound_messages WHERE provider='cloudflare' AND provider_message_id=?) THEN 'ignored' ELSE 'pending' END,?,?,?,
      CASE WHEN (SELECT count(*) FROM email_delivery_events WHERE account_id=? AND state='pending')>=${MAX_PENDING}
      AND NOT EXISTS(SELECT 1 FROM outbound_messages WHERE provider='cloudflare' AND provider_message_id=?) THEN ? ELSE NULL END,
      CASE WHEN (SELECT count(*) FROM email_delivery_events WHERE account_id=? AND state='pending')>=${MAX_PENDING}
      AND NOT EXISTS(SELECT 1 FROM outbound_messages WHERE provider='cloudflare' AND provider_message_id=?) THEN 'pending_limit' ELSE NULL END,?,1
    ON CONFLICT(account_id,event_id) DO NOTHING`,id,value.account_id,value.event_id,value.zone_id,value.subscription_id,value.domain,value.provider_message_id,value.sender,value.recipient,value.event_type,value.event_at,value.terminal,
    hash,value.account_id,value.provider_message_id,now,now+TTL,now,value.account_id,value.provider_message_id,now,value.account_id,value.provider_message_id,value.bounce_type).run();
  if(inserted.meta.changes!==1) {
    const existing=await sql(env,'SELECT canonical_sha256,evidence_version FROM email_delivery_events WHERE account_id=? AND event_id=?',value.account_id,value.event_id).first<{canonical_sha256:string;evidence_version:number}>();
    // 0007 did not retain bounce hardness. Compare its original canonical hash without
    // upgrading that immutable historical evidence or reinterpreting it on a replay.
    const {bounce_type:_newEvidence,...legacy}=value;
    const expectedHash=existing?.evidence_version===0?await sha256(JSON.stringify(legacy)):hash;
    return {outcome:existing?.canonical_sha256===expectedHash?'duplicate':'conflict'};
  }
  return apply(env,await receipt(env,id),now);
}
export async function runDeliveryEventJobs(env:RuntimeEnv,now=Date.now()):Promise<{deliveryEventsApplied:number;deliveryEventsIgnored:number;deliveryEventsPending:number}> {
  const result={deliveryEventsApplied:0,deliveryEventsIgnored:0,deliveryEventsPending:0};
  if(!deliveryEventsConfigured(env))return result;
  const rows=await sql(env,"SELECT * FROM email_delivery_events WHERE state='pending' AND (next_attempt_at<=? OR expires_at<=?) ORDER BY next_attempt_at,id LIMIT 20",now,now).all<Receipt>();
  for(const row of rows.results){const outcome=await apply(env,row,now);if(outcome.outcome==='applied')result.deliveryEventsApplied++;else if(outcome.outcome==='ignored')result.deliveryEventsIgnored++;else if(outcome.outcome==='pending')result.deliveryEventsPending++;}
  return result;
}

/** Drain early receipts immediately after an ACK, before considering another queued send. */
export async function reconcileMessageDeliveryEvents(env:RuntimeEnv,providerId:string,now=Date.now()):Promise<boolean> {
  if(!deliveryEventsConfigured(env))return true;
  const rows=await sql(env,"SELECT * FROM email_delivery_events WHERE provider_message_id=? AND state='pending' ORDER BY event_at,id LIMIT 50",providerId).all<Receipt>();
  for(const row of rows.results)await apply(env,row,now);
  return !await sql(env,"SELECT id FROM email_delivery_events WHERE provider_message_id=? AND state='pending' LIMIT 1",providerId).first();
}
