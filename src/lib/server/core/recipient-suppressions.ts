import type {RecipientSuppression,RecipientSuppressionReason,RecipientSuppressionCheck} from '../../types/suppressions';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {externalAddress,objectInput} from './outbound-content';
import {ServiceError,type RuntimeEnv} from './types';
import {knownCloudflareSuppressedAddresses} from './cloudflare-suppression-policy';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface Row {id:string;mailbox_id:string;address:string;status:'active'|'released';reason:RecipientSuppressionReason;version:number;last_event_at:number;last_event_id:string;created_at:number;updated_at:number;released_at:number|null}
const sql=(env:RuntimeEnv,query:string,...args:(string|number|null)[])=>env.DB.prepare(query).bind(...args);
function addresses(value:unknown,empty=false):string[] {
  if(!Array.isArray(value)||value.length>50||!empty&&value.length<1)throw new ServiceError('invalid_recipients',400);
  return [...new Set(value.map(externalAddress))];
}
function dto(row:Row):RecipientSuppression {
  return {id:row.id,mailboxId:row.mailbox_id,address:row.address,status:row.status,reason:row.reason,version:row.version,
    lastEventAt:row.last_event_at,lastEventId:row.last_event_id,createdAt:row.created_at,updatedAt:row.updated_at,releasedAt:row.released_at};
}
async function ownerMailbox(ctx:OwnerContext,box:string):Promise<void> {
  requireOwner(ctx.actor);const mailbox=await getMailbox(ctx,box);
  if(!['active','paused'].includes(mailbox.status))throw new ServiceError('not_found',404);
}
/** No recipient detail is placed in the rejection, so Bcc and unrelated recipients stay private. */
export async function assertRecipientsNotSuppressed(env:RuntimeEnv,box:string,value:unknown):Promise<void> {
  const requested=addresses(value,true);if(!requested.length)return;
  if(await sql(env,`SELECT id FROM recipient_suppressions WHERE mailbox_id=? AND status='active' AND address IN(${requested.map(()=>'?').join(',')}) LIMIT 1`,box,...requested).first())
    throw new ServiceError('recipient_suppressed',409);
  if((await knownCloudflareSuppressedAddresses(env,box,requested)).size)throw new ServiceError('cloudflare_recipient_suppressed',409);
}
export async function listRecipientSuppressions(ctx:OwnerContext,box:string,query:{status?:unknown;limit?:unknown;cursor?:unknown}={}) {
  await ownerMailbox(ctx,box);objectInput(query,['status','limit','cursor']);
  const status=query.status??'active',limit=query.limit===undefined?20:Number(query.limit);
  if(!['active','released','all'].includes(status as string)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_query',400);
  let after:{time:number;id:string}|null=null;
  if(query.cursor!==undefined) {
    try {
      if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw new Error();
      const parsed=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));
      if(!parsed||Object.keys(parsed).length!==6||parsed.v!==1||parsed.box!==box||parsed.status!==status||parsed.limit!==limit
        ||!Number.isSafeInteger(parsed.time)||parsed.time<0||typeof parsed.id!=='string'||!uuid.test(parsed.id))throw new Error();
      after={time:parsed.time,id:parsed.id};
    }catch{throw new ServiceError('invalid_cursor',400);}
  }
  const args:(string|number)[]=[box];if(status!=='all')args.push(status as string);if(after)args.push(after.time,after.time,after.id);args.push(limit+1);
  const {results}=await sql(ctx.env,`SELECT * FROM recipient_suppressions WHERE mailbox_id=? ${status!=='all'?'AND status=?':''}
    ${after?'AND (updated_at<? OR(updated_at=? AND id<?))':''} ORDER BY updated_at DESC,id DESC LIMIT ?`,...args).all<Row>();
  const rows=results.slice(0,limit),last=rows.at(-1);
  const nextCursor=results.length>limit&&last?btoa(JSON.stringify({v:1,box,status,limit,time:last.updated_at,id:last.id})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null;
  return {suppressions:rows.map(dto),nextCursor};
}
export async function releaseRecipientSuppression(ctx:OwnerContext,box:string,id:string,input:unknown):Promise<{suppression:RecipientSuppression}> {
  await ownerMailbox(ctx,box);if(!uuid.test(id))throw new ServiceError('not_found',404);
  const data=objectInput(input,['expectedVersion']);
  if(typeof data.expectedVersion!=='number'||!Number.isSafeInteger(data.expectedVersion)||data.expectedVersion<1)throw new ServiceError('invalid_input',400);
  const row=await sql(ctx.env,'SELECT * FROM recipient_suppressions WHERE id=? AND mailbox_id=?',id,box).first<Row>();
  if(!row)throw new ServiceError('not_found',404);
  if(row.status!=='active'||row.version!==data.expectedVersion)throw new ServiceError('suppression_changed',409);
  const now=Math.max(Date.now(),row.updated_at+1),claim=crypto.randomUUID();
  const results=await ctx.env.DB.batch([
    sql(ctx.env,`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at)
      SELECT ?,?,'owner','recipient_suppression.released',?,'success',?,? WHERE EXISTS(SELECT 1 FROM recipient_suppressions s JOIN mailboxes m ON m.id=s.mailbox_id
      WHERE s.id=? AND s.mailbox_id=? AND s.status='active' AND s.version=? AND m.status IN('active','paused'))`,claim,box,id,ctx.requestId,now,id,box,data.expectedVersion),
    sql(ctx.env,`UPDATE recipient_suppressions SET status='released',version=version+1,updated_at=?,released_at=?,release_watermark=MAX(release_watermark,last_event_at,?)
      WHERE id=? AND mailbox_id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`,now,now,now,id,box,claim)
  ]);
  if(results[1].meta.changes!==1)throw new ServiceError('suppression_changed',409);
  return {suppression:dto((await sql(ctx.env,'SELECT * FROM recipient_suppressions WHERE id=? AND mailbox_id=?',id,box).first<Row>())!)};
}
/** A scoped lookup accepts only explicitly named addresses; it never enumerates other recipients. */
export async function checkRecipientSuppressions(ctx:OwnerContext,box:string,value:unknown):Promise<{recipients:RecipientSuppressionCheck[]}> {
  const actor=ctx.actor;if(!actor)throw new ServiceError('unauthorized',401);
  if(!uuid.test(box))throw new ServiceError('not_found',404);
  if(actor.kind==='owner')await ownerMailbox(ctx,box);
  else {
    if(actor.mailboxId!==box)throw new ServiceError('not_found',404);
    if(actor.canSend!==true)throw new ServiceError('insufficient_scope',403);
    const now=Date.now(),allowed=await sql(ctx.env,`SELECT t.id FROM mailbox_tokens t JOIN mailboxes m ON m.id=t.mailbox_id WHERE t.id=? AND t.mailbox_id=? AND t.can_send=1
      AND t.revoked_at IS NULL AND(t.expires_at IS NULL OR t.expires_at>?) AND m.status='active'`,actor.tokenId,box,now).first();
    if(!allowed)throw new ServiceError('insufficient_scope',403);
    if(actor.oauthGrantId||actor.oauthAccessTokenId) {
      if(!actor.oauthGrantId||!actor.oauthAccessTokenId||!await sql(ctx.env,`SELECT a.id FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id
        WHERE a.id=? AND g.id=? AND g.mailbox_id=? AND g.mailbox_token_id=? AND a.revoked_at IS NULL AND a.expires_at>? AND g.revoked_at IS NULL AND g.expires_at>?
        AND instr(' '||a.scope||' ',' mail:send ')>0 AND instr(' '||g.scope||' ',' mail:send ')>0`,actor.oauthAccessTokenId??'',actor.oauthGrantId??'',box,actor.tokenId,now,now).first())
        throw new ServiceError('insufficient_scope',403);
    }
  }
  const requested=addresses(value),{results}=await sql(ctx.env,`SELECT address,reason FROM recipient_suppressions WHERE mailbox_id=? AND status='active' AND address IN(${requested.map(()=>'?').join(',')})`,box,...requested)
    .all<{address:string;reason:RecipientSuppressionReason}>();
  const active=new Map(results.map(row=>[row.address,row.reason]));
  const provider=await knownCloudflareSuppressedAddresses(ctx.env,box,requested);
  return {recipients:requested.map(address=>({address,suppressed:active.has(address)||provider.has(address),reason:active.get(address)??(provider.has(address)?'provider_suppression':null)}))};
}

/** Internal statements share the receipt transaction; no raw event replay can bypass its consumed marker. */
export function suppressionEvidenceStatements(env:RuntimeEnv,receiptId:string,now:number):D1PreparedStatement[] {
  const evidence=`e.id=? AND e.suppression_applied_at IS NULL AND(e.event_type='complained' OR(e.event_type='bounced' AND e.evidence_version=1 AND e.bounce_type='hard'))
    AND(e.state='applied' OR(e.state='ignored' AND e.ignore_reason='stale_event'))
    AND EXISTS(SELECT 1 FROM outbound_messages o JOIN mailbox_addresses a ON a.id=o.sender_address_id AND a.mailbox_id=o.mailbox_id
      JOIN outbound_recipients r ON r.mailbox_id=o.mailbox_id AND r.outbound_id=o.id WHERE o.id=e.outbound_id AND o.mailbox_id=e.mailbox_id
      AND o.provider='cloudflare' AND o.provider_message_id=e.provider_message_id AND a.address=e.sender AND r.address=e.recipient)`;
  return [
    sql(env,`INSERT INTO recipient_suppressions(id,mailbox_id,address,reason,last_event_at,last_event_id,created_at,updated_at)
      SELECT ?,e.mailbox_id,e.recipient,CASE WHEN e.event_type='complained' THEN 'complaint' ELSE 'hard_bounce' END,e.event_at,e.account_id||':'||e.event_id,?,?
      FROM email_delivery_events e WHERE ${evidence}
      ON CONFLICT(mailbox_id,address) DO UPDATE SET status='active',reason=CASE WHEN recipient_suppressions.reason='complaint' OR excluded.reason='complaint' THEN 'complaint' ELSE 'hard_bounce' END,
      version=recipient_suppressions.version+1,released_at=NULL,last_event_at=MAX(recipient_suppressions.last_event_at,excluded.last_event_at),
      last_event_id=CASE WHEN excluded.last_event_at>recipient_suppressions.last_event_at OR(excluded.last_event_at=recipient_suppressions.last_event_at AND excluded.last_event_id>recipient_suppressions.last_event_id)
        THEN excluded.last_event_id ELSE recipient_suppressions.last_event_id END,updated_at=MAX(recipient_suppressions.updated_at+1,excluded.updated_at)
      WHERE excluded.last_event_at>recipient_suppressions.release_watermark AND(recipient_suppressions.status='released' OR excluded.last_event_at>recipient_suppressions.last_event_at
        OR(excluded.last_event_at=recipient_suppressions.last_event_at AND excluded.last_event_id>recipient_suppressions.last_event_id)
        OR(excluded.reason='complaint' AND recipient_suppressions.reason<>'complaint'))`,crypto.randomUUID(),now,now,receiptId),
    sql(env,`UPDATE email_delivery_events AS e SET suppression_applied_at=? WHERE ${evidence}`,now,receiptId)
  ];
}
