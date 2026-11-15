import type { MailboxSummary, MailboxToken } from '../../types/owner';
import { sha256, stableId } from './crypto';
import { externalAddress } from './outbound-content';
import { normalizeRecipient } from './storage';
import { ServiceError, type Actor, type RuntimeEnv } from './types';

export interface OwnerContext {
  env: RuntimeEnv;
  actor: Actor | null;
  requestId: string;
}

export function requireOwner(actor: Actor | null): Extract<Actor,{kind:'owner'}> {
  if (!actor) throw new ServiceError('unauthorized',401);
  if (actor.kind!=='owner') throw new ServiceError('owner_required',403);
  return actor;
}

function objectInput(input: unknown, allowed: string[]): Record<string,unknown> {
  if (!input || typeof input!=='object' || Array.isArray(input)
    || Object.keys(input).some(key=>!allowed.includes(key))) throw new ServiceError('invalid_input',400);
  return input as Record<string,unknown>;
}

function nameInput(value: unknown): string {
  if (typeof value!=='string' || !value.trim() || value.trim().length>80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ServiceError('invalid_name',400);
  }
  return value.trim();
}

function resourceId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new ServiceError('not_found',404);
  }
}

function sizeInput(value: unknown): number {
  if (typeof value!=='number' || !Number.isSafeInteger(value) || value<1024 || value>10*1024*1024) {
    throw new ServiceError('invalid_message_size',400);
  }
  return value;
}

const mailboxSelect = `SELECT m.id,m.name,m.status,m.max_message_bytes,m.daily_recipient_limit,m.allowed_recipients_json,m.created_at,m.updated_at,a.address,
  (SELECT count(*) FROM mailbox_tokens t WHERE t.mailbox_id=m.id AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at>?)) active_token_count
  FROM mailboxes m JOIN mailbox_addresses a ON a.mailbox_id=m.id AND a.is_primary=1`;

interface MailboxRow {
  id:string; name:string; address:string; status:MailboxSummary['status']; max_message_bytes:number;
  daily_recipient_limit:number; allowed_recipients_json:string;
  created_at:number; updated_at:number; active_token_count:number;
}

function mailboxDto(row: MailboxRow): MailboxSummary {
  return {id:row.id,name:row.name,address:row.address,status:row.status,maxMessageBytes:row.max_message_bytes,
    dailyRecipientLimit:row.daily_recipient_limit,allowedRecipients:JSON.parse(row.allowed_recipients_json) as string[],
    createdAt:row.created_at,updatedAt:row.updated_at,activeTokenCount:row.active_token_count};
}

function audit(ctx: OwnerContext,action:string,resourceId:string,mailboxId:string,now:number,
  metadata:Record<string,unknown>={},guard?:{sql:string;args:(string|number)[]},id:string=crypto.randomUUID()): D1PreparedStatement {
  return ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at)
    SELECT ?,?,'owner',?,?,'success',?,?,? ${guard ? `WHERE ${guard.sql}`:''} ON CONFLICT(id) DO NOTHING`)
    .bind(id,mailboxId,action,resourceId,ctx.requestId,JSON.stringify(metadata),now,...(guard?.args??[]));
}

export async function listMailboxes(ctx: OwnerContext): Promise<MailboxSummary[]> {
  requireOwner(ctx.actor);
  const {results}=await ctx.env.DB.prepare(`${mailboxSelect} WHERE m.status<>'deleted' ORDER BY m.created_at,m.id`).bind(Date.now()).all<MailboxRow>();
  return results.map(mailboxDto);
}

export async function getMailbox(ctx: OwnerContext,id:string): Promise<MailboxSummary> {
  requireOwner(ctx.actor); resourceId(id);
  const row=await ctx.env.DB.prepare(`${mailboxSelect} WHERE m.id=? AND m.status<>'deleted'`).bind(Date.now(),id).first<MailboxRow>();
  if(!row) throw new ServiceError('not_found',404);
  return mailboxDto(row);
}

export async function createMailbox(ctx: OwnerContext,input:unknown): Promise<MailboxSummary> {
  requireOwner(ctx.actor);
  const data=objectInput(input,['name','localPart','maxMessageBytes']);
  const name=nameInput(data.name);
  const domain=ctx.env.MAIL_DOMAIN?.toLowerCase();
  if(!domain || domain.length>253 || !domain.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !domain.includes('.')) {
    throw new ServiceError('mail_domain_not_configured',503);
  }
  if(typeof data.localPart!=='string') throw new ServiceError('invalid_address',400);
  const address=normalizeRecipient(`${data.localPart.trim()}@${domain}`,domain);
  if(!address) throw new ServiceError('invalid_address',400);
  const size=data.maxMessageBytes===undefined ? 10*1024*1024:sizeInput(data.maxMessageBytes);
  const used=await ctx.env.DB.prepare('SELECT id FROM mailbox_addresses WHERE address=?').bind(address).first();
  if(used) throw new ServiceError('address_unavailable',409);
  const id=crypto.randomUUID(),now=Date.now();
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('INSERT INTO mailboxes(id,name,max_message_bytes,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id,name,size,now,now),
      ctx.env.DB.prepare('INSERT INTO mailbox_addresses(id,mailbox_id,address,is_primary,created_at) VALUES(?,?,?,1,?)')
        .bind(crypto.randomUUID(),id,address,now),
      audit(ctx,'mailbox.created',id,id,now,{address})
    ]);
  } catch(error) {
    // A concurrent create can win after the preflight read. Only classify this specific constraint.
    if(error instanceof Error && error.message.includes('UNIQUE constraint failed: mailbox_addresses.address')) {
      throw new ServiceError('address_unavailable',409);
    }
    throw error;
  }
  return getMailbox(ctx,id);
}

export async function updateMailbox(ctx: OwnerContext,id:string,input:unknown): Promise<MailboxSummary> {
  const current=await getMailbox(ctx,id);
  const data=objectInput(input,['name','status','maxMessageBytes','dailyRecipientLimit','allowedRecipients','expectedUpdatedAt']);
  if(data.expectedUpdatedAt!==current.updatedAt) throw new ServiceError('mailbox_changed',409);
  const name=data.name===undefined ? current.name:nameInput(data.name);
  const status=data.status===undefined ? current.status:data.status;
  if(status!=='active' && status!=='paused') throw new ServiceError('invalid_status',400);
  const size=data.maxMessageBytes===undefined ? current.maxMessageBytes:sizeInput(data.maxMessageBytes);
  const dailyRecipientLimit=data.dailyRecipientLimit===undefined ? current.dailyRecipientLimit:data.dailyRecipientLimit;
  if(typeof dailyRecipientLimit!=='number' || !Number.isSafeInteger(dailyRecipientLimit) || dailyRecipientLimit<0 || dailyRecipientLimit>1000) {
    throw new ServiceError('invalid_daily_recipient_limit',400);
  }
  let allowedRecipients=current.allowedRecipients;
  if(data.allowedRecipients!==undefined) {
    if(!Array.isArray(data.allowedRecipients) || data.allowedRecipients.length>100) throw new ServiceError('invalid_allowed_recipients',400);
    allowedRecipients=[...new Set(data.allowedRecipients.map(externalAddress))];
  }
  const now=Math.max(Date.now(),current.updatedAt+1);
  const mutationId=crypto.randomUUID();
  const guard={sql:'EXISTS(SELECT 1 FROM audit_events WHERE id=?)',args:[mutationId]};
  const results=await ctx.env.DB.batch([
    // This unique operation record claims the old version inside the same transaction.
    // A timestamp alone cannot prove ownership when two mutations choose the same millisecond.
    audit(ctx,'mailbox.updated',id,id,now,{status,dailyRecipientLimit,allowedRecipientCount:allowedRecipients.length},
      {sql:"EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND updated_at=? AND status IN('active','paused'))",args:[id,current.updatedAt]},mutationId),
    ctx.env.DB.prepare(`UPDATE mailboxes SET name=?,status=?,max_message_bytes=?,daily_recipient_limit=?,allowed_recipients_json=?,updated_at=?
      WHERE id=? AND updated_at=? AND status IN('active','paused') AND ${guard.sql}`)
      .bind(name,status,size,dailyRecipientLimit,JSON.stringify(allowedRecipients),now,id,current.updatedAt,...guard.args)
  ]);
  if(results[1].meta.changes!==1) throw new ServiceError('mailbox_changed',409);
  return getMailbox(ctx,id);
}

interface TokenRow {
  id:string; mailbox_id:string; name:string; can_read:number; can_read_attachments:number; can_draft:number; can_send:number;
  requires_approval:number;
  created_at:number; expires_at:number|null; revoked_at:number|null;
}
const tokenColumns='id,mailbox_id,name,can_read,can_read_attachments,can_draft,can_send,requires_approval,created_at,expires_at,revoked_at';
function tokenDto(row:TokenRow):MailboxToken {
  return {id:row.id,mailboxId:row.mailbox_id,name:row.name,createdAt:row.created_at,expiresAt:row.expires_at,revokedAt:row.revoked_at,
    requiresApproval:row.requires_approval===1,
    scopes:[...(row.can_read?['mail:read']:[]),...(row.can_read_attachments?['attachments:read']:[]),...(row.can_draft?['mail:draft']:[]),...(row.can_send?['mail:send']:[])],
    state:row.revoked_at!==null?'revoked':row.expires_at!==null&&row.expires_at<=Date.now()?'expired':'active'};
}

export async function listTokens(ctx:OwnerContext,mailboxId:string):Promise<MailboxToken[]> {
  await getMailbox(ctx,mailboxId);
  const {results}=await ctx.env.DB.prepare(`SELECT ${tokenColumns} FROM mailbox_tokens WHERE mailbox_id=? ORDER BY created_at DESC,id DESC`)
    .bind(mailboxId).all<TokenRow>();
  return results.map(tokenDto);
}

export async function issueToken(ctx:OwnerContext,mailboxId:string,input:unknown):Promise<{token:MailboxToken;secret:string}> {
  const mailbox=await getMailbox(ctx,mailboxId);
  if(mailbox.status!=='active') throw new ServiceError('mailbox_inactive',409);
  const data=objectInput(input,['name','scopes','expiresAt','requiresApproval']);
  const name=nameInput(data.name);
  const supportedScopes=['mail:read','attachments:read','mail:draft','mail:send'];
  if(!Array.isArray(data.scopes) || data.scopes.length<1 || data.scopes.length>supportedScopes.length
    || data.scopes.some(scope=>typeof scope!=='string' || !supportedScopes.includes(scope))
    || new Set(data.scopes).size!==data.scopes.length) throw new ServiceError('unsupported_scopes',400);
  const scopes=supportedScopes.filter(scope=>(data.scopes as string[]).includes(scope));
  const canRead=scopes.includes('mail:read')?1:0,canAttachments=scopes.includes('attachments:read')?1:0,canDraft=scopes.includes('mail:draft')?1:0,canSend=scopes.includes('mail:send')?1:0;
  if(canSend && !canDraft||canAttachments&&!canRead) throw new ServiceError('unsupported_scopes',400);
  const requiresApproval=data.requiresApproval===undefined ? true:data.requiresApproval;
  if(typeof requiresApproval!=='boolean' || (!requiresApproval && !canSend)) throw new ServiceError('invalid_approval_policy',400);
  const now=Date.now(),expiresAt=data.expiresAt??null;
  if(expiresAt!==null && (typeof expiresAt!=='number' || !Number.isSafeInteger(expiresAt) || expiresAt<=now || expiresAt>now+366*86_400_000)) {
    throw new ServiceError('invalid_expiry',400);
  }
  const id=crypto.randomUUID();
  const random=crypto.getRandomValues(new Uint8Array(32));
  const encoded=btoa(String.fromCharCode(...random)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  const secret=`am_${id}_${encoded}`;
  const results=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO mailbox_tokens(id,mailbox_id,name,secret_sha256,can_read,can_read_attachments,can_draft,can_send,requires_approval,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status='active')`)
      .bind(id,mailboxId,name,await sha256(secret),canRead,canAttachments,canDraft,canSend,requiresApproval?1:0,expiresAt,now,mailboxId),
    audit(ctx,'token.issued',id,mailboxId,now,{scopes,requiresApproval},{sql:'EXISTS(SELECT 1 FROM mailbox_tokens WHERE id=? AND mailbox_id=?)',args:[id,mailboxId]})
  ]);
  if(results[0].meta.changes!==1) throw new ServiceError('mailbox_inactive',409);
  return {secret,token:tokenDto({id,mailbox_id:mailboxId,name,can_read:canRead,can_read_attachments:canAttachments,can_draft:canDraft,can_send:canSend,
    requires_approval:requiresApproval?1:0,created_at:now,expires_at:expiresAt as number|null,revoked_at:null})};
}

export async function revokeToken(ctx:OwnerContext,mailboxId:string,tokenId:string):Promise<MailboxToken> {
  await getMailbox(ctx,mailboxId); resourceId(tokenId);
  const row=await ctx.env.DB.prepare(`SELECT ${tokenColumns} FROM mailbox_tokens WHERE id=? AND mailbox_id=?`).bind(tokenId,mailboxId).first<TokenRow>();
  if(!row) throw new ServiceError('not_found',404);
  if(row.revoked_at===null) {
    const now=Date.now();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE mailbox_tokens SET revoked_at=? WHERE id=? AND mailbox_id=? AND revoked_at IS NULL').bind(now,tokenId,mailboxId),
      audit(ctx,'token.revoked',tokenId,mailboxId,now,{},
        {sql:'EXISTS(SELECT 1 FROM mailbox_tokens WHERE id=? AND mailbox_id=? AND revoked_at IS NOT NULL)',args:[tokenId,mailboxId]},await stableId(`token-revoked:${tokenId}`))
    ]);
  }
  return tokenDto((await ctx.env.DB.prepare(`SELECT ${tokenColumns} FROM mailbox_tokens WHERE id=? AND mailbox_id=?`).bind(tokenId,mailboxId).first<TokenRow>())!);
}

/** Retain address tombstones and mail; retire credentials and pending parsing atomically. */
export async function retireMailbox(ctx:OwnerContext,id:string,input:unknown):Promise<void> {
  const current=await getMailbox(ctx,id);
  const data=objectInput(input,['confirmAddress','expectedUpdatedAt']);
  if(data.confirmAddress!==current.address) throw new ServiceError('address_confirmation_required',400);
  if(data.expectedUpdatedAt!==current.updatedAt) throw new ServiceError('mailbox_changed',409);
  const pendingSend=()=>ctx.env.DB.prepare(`SELECT id FROM outbound_messages
    WHERE mailbox_id=? AND status IN('queued','submitting','unknown') LIMIT 1`).bind(id).first();
  if(await pendingSend()) throw new ServiceError('pending_sends',409);
  const now=Math.max(Date.now(),current.updatedAt+1);
  const mutationId=crypto.randomUUID();
  const guard={sql:'EXISTS(SELECT 1 FROM audit_events WHERE id=?)',args:[mutationId]};
  const results=await ctx.env.DB.batch([
    audit(ctx,'mailbox.retired',id,id,now,{},
      {sql:`EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND updated_at=? AND status IN('active','paused'))
        AND NOT EXISTS(SELECT 1 FROM outbound_messages WHERE mailbox_id=? AND status IN('queued','submitting','unknown'))`,
        args:[id,current.updatedAt,id]},mutationId),
    ctx.env.DB.prepare(`UPDATE mailboxes SET status='deleted',deleted_at=?,updated_at=? WHERE id=? AND updated_at=? AND status IN('active','paused')
      AND NOT EXISTS(SELECT 1 FROM outbound_messages WHERE mailbox_id=? AND status IN('queued','submitting','unknown')) AND ${guard.sql}`)
      .bind(now,now,id,current.updatedAt,id,...guard.args),
    ctx.env.DB.prepare(`UPDATE mailbox_addresses SET status='retired',retired_at=? WHERE mailbox_id=? AND status<>'retired' AND ${guard.sql}`).bind(now,id,...guard.args),
    ctx.env.DB.prepare(`UPDATE mailbox_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE mailbox_id=? AND ${guard.sql}`).bind(now,id,...guard.args),
    ctx.env.DB.prepare(`UPDATE jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE mailbox_id=? AND kind='parse_email' AND state IN('pending','running') AND ${guard.sql}`).bind(id,...guard.args)
  ]);
  if(results[1].meta.changes!==1) {
    if(await pendingSend()) throw new ServiceError('pending_sends',409);
    throw new ServiceError('mailbox_changed',409);
  }
}
