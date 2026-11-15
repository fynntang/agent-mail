import {sha256,stableId} from './crypto';
import {auditStatement,checkSendContent,readObject,sql,type BoxPolicy} from './outbound';
import {normalizedContent,providerMessage,replyHeader,validateInlineImages,type DraftContent} from './outbound-content';
import {loadDraftAttachmentBytes} from './draft-attachments';
import {assertRecipientsNotSuppressed} from './recipient-suppressions';
import {cloudflareSendGuard} from './cloudflare-suppression-policy';
import {deliveryEventsConfigured,reconcileMessageDeliveryEvents} from './delivery-events';
import type {OwnerContext} from './owner';
import {ServiceError,type RuntimeEnv} from './types';

interface Job {id:string;mailbox_id:string;dedupe_key:string;payload_json:string;lease_token:string;lease_until:number;attempts:number;max_attempts:number}
interface Outbound {id:string;mailbox_id:string;draft_id:string;sender_address_id:string;requested_by_token_id:string|null;frozen_object_id:string;reservation_id:string;request_sha256:string;status:string}
interface Frozen {v:1|2|3;from:string;content:DraftContent;version:number;rawObjectId:string;bodyObjectId:string}
const leaseMs=120_000;
const rejectionCodes=new Set(['E_VALIDATION_ERROR','E_FIELD_MISSING','E_TOO_MANY_RECIPIENTS','E_SENDER_NOT_VERIFIED','E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED','E_ACCOUNT_SUSPENDED','E_SENDER_DOMAIN_NOT_AVAILABLE','E_CONTENT_TOO_LARGE','E_RATE_LIMIT_EXCEEDED','E_DAILY_LIMIT_EXCEEDED',
  'E_HEADER_INVALID','E_HEADER_NOT_ALLOWED','E_TOO_MANY_ATTACHMENTS']);

function systemContext(env:RuntimeEnv,job:Job):OwnerContext {return {env,actor:null,requestId:job.id};}
function jobGuard(job:Job,expired=false) {
  return {query:`EXISTS(SELECT 1 FROM jobs WHERE id=? AND mailbox_id=? AND kind='send_email' AND state='running' AND lease_token=? AND lease_until${expired?'<=':'>'}?)`,
    args:[job.id,job.mailbox_id,job.lease_token,Date.now()] as (string|number)[]};
}
/** All outcomes are fenced by the same job lease and expected pre-call/post-call state. */
async function settle(env:RuntimeEnv,job:Job,outbound:Outbound,status:'accepted'|'failed'|'unknown',code:string|null,
  options:{providerId?:string;frozen?:Frozen;expired?:boolean;expected?:string}={}) {
  const now=Date.now(),claim=crypto.randomUUID(),guard=jobGuard(job,options.expired);
  const expected=options.expected??'submitting',owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  const statements=[auditStatement(systemContext(env,job),job.mailbox_id,`outbound.${status}`,outbound.id,
    `${guard.query} AND EXISTS(SELECT 1 FROM outbound_messages WHERE id=? AND mailbox_id=? AND status=?)`,[...guard.args,outbound.id,job.mailbox_id,expected],claim),
    sql(env,`UPDATE outbound_messages SET status=?,provider_message_id=?,accepted_at=?,last_error_code=?,updated_at=? WHERE id=? AND mailbox_id=? AND ${owned}`,
      status,options.providerId??null,status==='accepted'?now:null,code,now,outbound.id,job.mailbox_id,claim),
    sql(env,`UPDATE outbound_recipients SET status=?,diagnostic_redacted=? WHERE outbound_id=? AND mailbox_id=? AND ${owned}`,status,code,outbound.id,job.mailbox_id,claim),
    sql(env,`UPDATE send_reservations SET state=?,settled_at=? WHERE id=? AND mailbox_id=? AND state IN('reserved','reconciling') AND ${owned}`,
      status==='accepted'?'committed':status==='unknown'?'reconciling':'released',status==='unknown'?null:now,outbound.reservation_id,job.mailbox_id,claim),
    sql(env,`UPDATE send_attempts SET outcome=?,error_code=?,finished_at=? WHERE outbound_id=? AND mailbox_id=? AND lease_token=? AND outcome='started' AND ${owned}`,
      status==='failed'?'rejected':status,code,now,outbound.id,job.mailbox_id,job.lease_token,claim),
    sql(env,`INSERT INTO events(id,mailbox_id,source,source_event_id,type,payload_json,occurred_at,created_at)
      SELECT ?,?,'app',?,?,?, ?,? WHERE ${owned}`,crypto.randomUUID(),job.mailbox_id,`${outbound.id}:${status}`,`outbound.${status}`,JSON.stringify({outboundId:outbound.id}),now,now,claim),
    sql(env,`UPDATE jobs SET state=?,lease_token=NULL,lease_until=NULL,last_error_code=? WHERE id=? AND mailbox_id=? AND ${owned}`,
      status==='accepted'?'done':'dead',code,job.id,job.mailbox_id,claim)];
  if(status==='accepted'&&options.frozen) {
    const f=options.frozen,c=f.content;
    statements.push(sql(env,`INSERT INTO messages(id,mailbox_id,raw_object_id,body_object_id,rfc_message_id,in_reply_to,subject,preview,direction,folder,is_read,parse_state,attachments_state,size_bytes,received_at)
      SELECT ?,?,?,?,NULL,?,?,?,'outbound','sent',1,'ready','ready',o.size_bytes,? FROM objects o WHERE o.id=? AND o.mailbox_id=? AND o.purpose='raw_email' AND o.state='ready' AND ${owned}`,
      outbound.id,job.mailbox_id,f.rawObjectId,f.bodyObjectId,c.inReplyTo,c.subject,c.text.slice(0,512),now,f.rawObjectId,job.mailbox_id,claim));
    for(const [index,attachment] of (c.attachments??[]).entries()) {
      const inline=c.inlineImages?.find(image=>image.attachmentId===attachment.id);
      statements.push(sql(env,`INSERT INTO attachments(id,mailbox_id,message_id,object_id,part_id,filename,disposition,content_id,scan_status)
        SELECT ?,?,?,a.object_id,?,?,?,?,a.scan_status FROM (SELECT 1) AS source LEFT JOIN draft_attachments a
        ON a.id=? AND a.draft_id=? AND a.mailbox_id=? AND a.filename=? AND a.content_type=? AND a.size_bytes=? AND a.sha256=? WHERE ${owned}`,
        await stableId(`sent-attachment:v1:${outbound.id}:${attachment.id}`),job.mailbox_id,outbound.id,String(index+1),attachment.filename,
        inline?'inline':'attachment',inline?`<${inline.contentId}>`:null,
        attachment.id,outbound.draft_id,job.mailbox_id,attachment.filename,attachment.contentType,attachment.sizeBytes,attachment.sha256,claim));
    }
    // Bcc remains available to the Owner in send details, but is never in public headers or the Sent address list.
    for(const [kind,values] of [['from',[f.from]],['to',c.to],['cc',c.cc]] as const) values.forEach((address,ordinal)=>{
      statements.push(sql(env,`INSERT INTO message_addresses(id,mailbox_id,message_id,kind,ordinal,address) SELECT ?,?,?,?,?,? WHERE ${owned}`,
        crypto.randomUUID(),job.mailbox_id,outbound.id,kind,ordinal,address,claim));
    });
  }
  const result=await env.DB.batch(statements);
  return result[1].meta.changes===1;
}
async function preflight(env:RuntimeEnv,job:Job,outbound:Outbound):Promise<{frozen:Frozen;box:BoxPolicy;message:EmailMessageBuilder}> {
  if(!env.EMAIL) throw new ServiceError('sending_not_configured',503);
  const frozen=await readObject<Frozen>(env,job.mailbox_id,outbound.frozen_object_id,'outbound');
  const normalized=normalizedContent({...frozen.content});
  normalized.replyMessageId=frozen.content.replyMessageId;normalized.inReplyTo=replyHeader(frozen.content.inReplyTo);
  const hasHtmlFields=frozen.content.html!==undefined||frozen.content.inlineImages!==undefined;
  if(![1,2,3].includes(frozen.v)||(frozen.v===1&&(frozen.content.attachments?.length??0)>0)||(frozen.v<3&&hasHtmlFields)
    ||JSON.stringify(normalized)!==JSON.stringify(frozen.content)||await sha256(JSON.stringify(frozen.content))!==outbound.request_sha256) throw new ServiceError('content_corrupt',409);
  const box=await sql(env,`SELECT m.id,m.status,m.daily_recipient_limit,m.max_message_bytes,m.allowed_recipients_json,a.address,a.id address_id
    FROM mailboxes m JOIN mailbox_addresses a ON a.mailbox_id=m.id WHERE m.id=? AND a.id=? AND a.status='active' AND m.status='active'`,job.mailbox_id,outbound.sender_address_id).first<BoxPolicy>();
  if(!box||box.address!==frozen.from) throw new ServiceError('mailbox_inactive',409);
  checkSendContent(box,frozen.content);
  await assertRecipientsNotSuppressed(env,job.mailbox_id,[...frozen.content.to,...frozen.content.cc,...frozen.content.bcc]);
  const reservation=await sql(env,`SELECT c.day_utc,c.reserved_units,c.used_units FROM send_reservations r JOIN daily_send_counters c ON c.id=r.counter_id AND c.mailbox_id=r.mailbox_id
    WHERE r.id=? AND r.mailbox_id=? AND r.state='reserved'`,outbound.reservation_id,job.mailbox_id).first<{day_utc:string;reserved_units:number;used_units:number}>();
  if(!reservation||reservation.day_utc!==new Date().toISOString().slice(0,10)) throw new ServiceError('send_day_expired',409);
  if(reservation.used_units+reservation.reserved_units>box.daily_recipient_limit) throw new ServiceError('send_limit_exceeded',409);
  const body=await readObject<{text:string;html?:string|null;htmlExtracted?:boolean}>(env,job.mailbox_id,frozen.bodyObjectId,'body');
  const raw=await sql(env,"SELECT size_bytes FROM objects WHERE id=? AND mailbox_id=? AND purpose='raw_email' AND state='ready'",frozen.rawObjectId,job.mailbox_id).first<{size_bytes:number}>();
  if(!raw||raw.size_bytes>Math.min(box.max_message_bytes,10*1024*1024)||body.text!==frozen.content.text
    ||(frozen.v===3&&(body.html!==(frozen.content.html??null)||body.htmlExtracted!==true))) throw new ServiceError('content_corrupt',409);
  const files=await loadDraftAttachmentBytes(env,job.mailbox_id,outbound.draft_id,frozen.content.attachments??[]);
  validateInlineImages(frozen.content,files,{complete:true});
  // Materialize/encode before the irreversible submission boundary. A local failure cannot be unknown delivery.
  return {frozen,box,message:providerMessage(frozen.from,frozen.content,files)};
}
async function beginSubmission(env:RuntimeEnv,job:Job,outbound:Outbound,frozen:Frozen,box:BoxPolicy):Promise<boolean> {
  const guard=jobGuard(job),claim=crypto.randomUUID(),now=Date.now(),owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  const providerGuard=cloudflareSendGuard(env,job.mailbox_id,[...frozen.content.to,...frozen.content.cc,...frozen.content.bcc]);
  const eligibility=`EXISTS(SELECT 1 FROM drafts d WHERE d.id=? AND d.mailbox_id=? AND d.version=? AND d.content_sha256=? AND d.state='submitted'
    AND ((d.created_by_token_id IS NULL AND d.approved_version=d.version AND d.approved_sha256=d.content_sha256 AND d.approved_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM mailbox_tokens t WHERE t.id=d.created_by_token_id AND t.id=? AND t.mailbox_id=d.mailbox_id AND t.can_send=1 AND t.can_draft=1
      AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?) AND (t.requires_approval=0 OR (d.approved_version=d.version AND d.approved_sha256=d.content_sha256 AND d.approved_at IS NOT NULL)))))`;
  const results=await env.DB.batch([
    auditStatement(systemContext(env,job),job.mailbox_id,'outbound.submitting',outbound.id,`${guard.query}
      AND EXISTS(SELECT 1 FROM outbound_messages WHERE id=? AND mailbox_id=? AND status='queued') AND ${eligibility}
      AND EXISTS(SELECT 1 FROM mailboxes m JOIN mailbox_addresses a ON a.mailbox_id=m.id WHERE m.id=? AND m.status='active' AND a.id=? AND a.status='active'
      AND m.daily_recipient_limit=? AND m.allowed_recipients_json=? AND m.max_message_bytes=?)
      AND EXISTS(SELECT 1 FROM send_reservations r JOIN daily_send_counters c ON c.id=r.counter_id AND c.mailbox_id=r.mailbox_id
        WHERE r.id=? AND r.mailbox_id=? AND r.state='reserved' AND c.day_utc=? AND c.reserved_units+c.used_units<=?)
      AND NOT EXISTS(SELECT 1 FROM recipient_suppressions s JOIN outbound_recipients r ON r.mailbox_id=s.mailbox_id AND r.address=s.address
        WHERE r.outbound_id=? AND r.mailbox_id=? AND s.status='active') AND ${providerGuard.sql}`,
      [...guard.args,outbound.id,job.mailbox_id,outbound.draft_id,job.mailbox_id,frozen.version,outbound.request_sha256,outbound.requested_by_token_id,now,
        job.mailbox_id,outbound.sender_address_id,box.daily_recipient_limit,box.allowed_recipients_json,box.max_message_bytes,
        outbound.reservation_id,job.mailbox_id,new Date(now).toISOString().slice(0,10),box.daily_recipient_limit,outbound.id,job.mailbox_id,...providerGuard.args],claim),
    sql(env,`UPDATE outbound_messages SET status='submitting',updated_at=? WHERE id=? AND mailbox_id=? AND ${owned}`,now,outbound.id,job.mailbox_id,claim),
    sql(env,`INSERT INTO send_attempts(id,mailbox_id,outbound_id,attempt_no,lease_token,started_at) SELECT ?,?,?,?,?,? WHERE ${owned}`,
      crypto.randomUUID(),job.mailbox_id,outbound.id,job.attempts,job.lease_token,now,claim)
  ]);
  return results[1].meta.changes===1;
}
/** Injectable sender is for core tests only. The deployed handler always uses the native EMAIL binding. */
export async function runSendJobs(env:RuntimeEnv,options:{sender?:(message:EmailMessageBuilder)=>Promise<EmailSendResult>;timeoutMs?:number}={}) {
  let processed=0,unknown=0;
  // A bounded previous ACK drain may have left more evidence. Drain known risk before any new send.
  if(deliveryEventsConfigured(env)) {
    const risk=`FROM email_delivery_events e JOIN outbound_messages o ON o.provider='cloudflare' AND o.provider_message_id=e.provider_message_id
      WHERE e.state='pending' AND(e.event_type='complained' OR(e.event_type='bounced' AND e.evidence_version=1 AND e.bounce_type='hard'))`;
    const pending=await sql(env,`SELECT DISTINCT e.provider_message_id ${risk} LIMIT 2`).all<{provider_message_id:string}>();
    for(const row of pending.results)if(!await reconcileMessageDeliveryEvents(env,row.provider_message_id))return {sendProcessed:0,sendUnknown:0};
    if(await sql(env,`SELECT e.id ${risk} LIMIT 1`).first())return {sendProcessed:0,sendUnknown:0};
  }
  const expired=await sql(env,"SELECT * FROM jobs WHERE kind='send_email' AND state='running' AND lease_until<=? ORDER BY lease_until LIMIT 20",Date.now()).all<Job>();
  for(const job of expired.results) {
    const out=await sql(env,'SELECT * FROM outbound_messages WHERE id=? AND mailbox_id=?',job.dedupe_key,job.mailbox_id).first<Outbound>();
    if(out?.status==='submitting') {if(await settle(env,job,out,'unknown','lease_expired',{expired:true})) unknown++;}
    else if(out?.status==='queued'&&job.attempts<job.max_attempts) {
      const g=jobGuard(job,true);
      await sql(env,`UPDATE jobs SET state='pending',lease_token=NULL,lease_until=NULL WHERE id=? AND mailbox_id=? AND ${g.query}`,job.id,job.mailbox_id,...g.args).run();
    }else if(out?.status==='queued') await settle(env,job,out,'failed','attempts_exhausted',{expired:true,expected:'queued'});
    else await sql(env,"UPDATE jobs SET state='dead',lease_token=NULL,lease_until=NULL,last_error_code='invalid_send_job' WHERE id=? AND state='running' AND lease_token=? AND lease_until<=?",job.id,job.lease_token,Date.now()).run();
  }
  const pending=await sql(env,"SELECT id FROM jobs WHERE kind='send_email' AND state='pending' AND available_at<=? ORDER BY available_at,id LIMIT 2",Date.now()).all<{id:string}>();
  for(const candidate of pending.results) {
    const token=crypto.randomUUID(),now=Date.now();
    const claim=await sql(env,`UPDATE jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND kind='send_email' AND state='pending' AND available_at<=?`,token,now+leaseMs,candidate.id,now).run();
    if(claim.meta.changes!==1) continue;
    const job=(await sql(env,'SELECT * FROM jobs WHERE id=? AND lease_token=?',candidate.id,token).first<Job>())!;
    const out=await sql(env,'SELECT * FROM outbound_messages WHERE id=? AND mailbox_id=?',job.dedupe_key,job.mailbox_id).first<Outbound>();
    let payload:unknown;
    try{payload=JSON.parse(job.payload_json);}catch{payload=null;}
    if(!out||!payload||typeof payload!=='object'||(payload as {outboundId?:unknown}).outboundId!==out.id||out.status!=='queued') {
      if(out?.status==='queued') await settle(env,job,out,'failed','invalid_send_job',{expected:'queued'});
      else await sql(env,"UPDATE jobs SET state='dead',lease_token=NULL,lease_until=NULL,last_error_code='invalid_send_job' WHERE id=? AND lease_token=? AND state='running'",job.id,token).run();
      continue;
    }
    let frozen:Frozen,message:EmailMessageBuilder;
    try {
      const checked=await preflight(env,job,out);frozen=checked.frozen;message=checked.message;
      if(!await beginSubmission(env,job,out,frozen,checked.box)) {
        await assertRecipientsNotSuppressed(env,job.mailbox_id,[...frozen.content.to,...frozen.content.cc,...frozen.content.bcc]);
        await settle(env,job,out,'failed','send_authorization_changed',{expected:'queued'});continue;
      }
    }catch(error) {
      await settle(env,job,out,'failed',error instanceof ServiceError?error.code:'preflight_failed',{expected:'queued'});continue;
    }
    processed++;
    let acknowledgedMessageId:string|null=null;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const sender=options.sender??((message:EmailMessageBuilder)=>env.EMAIL!.send(message));
      const result=await Promise.race([sender(message),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('send_timeout')),options.timeoutMs??20_000);})]);
      if(!result||typeof result.messageId!=='string'||!result.messageId||result.messageId.length>1024) throw new Error('invalid_provider_result');
      // Recording an ACK does not re-check authorization: the external call has already happened.
      if(await settle(env,job,out,'accepted',null,{providerId:result.messageId,frozen}))acknowledgedMessageId=result.messageId;
    }catch(error) {
      const rawCode=error&&typeof error==='object'&&'code' in error?(error as {code:unknown}).code:null;
      const rejected=typeof rawCode==='string'&&rejectionCodes.has(rawCode);
      const status=rejected?'failed':'unknown';
      if(status==='unknown') unknown++;
      await settle(env,job,out,status,rejected?rawCode as string:'provider_result_unknown');
    }finally {if(timer!==undefined) clearTimeout(timer);}
    // Receipt reconciliation is after ACK persistence and outside the provider outcome boundary.
    if(acknowledgedMessageId) {
      try {if(!await reconcileMessageDeliveryEvents(env,acknowledgedMessageId))break;}
      catch {console.warn(JSON.stringify({event:'send_delivery_reconciliation_deferred',code:'delivery_storage_unavailable'}));break;}
    }
  }
  return {sendProcessed:processed,sendUnknown:unknown};
}
