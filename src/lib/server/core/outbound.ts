import {sha256} from './crypto';
import {requireOwner,type OwnerContext} from './owner';
import {externalAddress,localSentCopy,normalizedContent,normalizedAttachmentRefs,validateInlineImages,objectInput,replyHeader,type DraftContent,type DraftAttachmentRef} from './outbound-content';
import {loadDraftAttachmentBytes} from './draft-attachments';
import {assertRecipientsNotSuppressed} from './recipient-suppressions';
import {cloudflareSendGuard} from './cloudflare-suppression-policy';
import type {DraftDTO,DraftState} from '../../types/outbound';
import {readBounded} from './storage';
import {ServiceError,type RuntimeEnv} from './types';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CONTENT_OBJECT_BYTES=256*1024;
/** JSON escaping and frozen metadata count too; every content object must remain readable. */
function serializedContent(value:unknown):string {
  const json=JSON.stringify(value);
  if(new TextEncoder().encode(json).byteLength>MAX_CONTENT_OBJECT_BYTES)throw new ServiceError('content_too_large',413);
  return json;
}
function canonicalContent(content:DraftContent):DraftContent {
  const result=normalizedContent({...content});
  result.replyMessageId=content.replyMessageId;result.inReplyTo=content.inReplyTo;
  return result;
}
export interface DraftRow {
  id:string;mailbox_id:string;content_object_id:string;created_by_token_id:string|null;version:number;state:string;content_sha256:string;
  approved_version:number|null;approved_sha256:string|null;approved_at:number|null;created_at:number;updated_at:number;
}
export interface BoxPolicy {id:string;status:string;address:string;address_id:string;daily_recipient_limit:number;max_message_bytes:number;allowed_recipients_json:string}
export function sql(env:RuntimeEnv,query:string,...args:(string|number|null)[]):D1PreparedStatement {return env.DB.prepare(query).bind(...args);}
export function guardActor(ctx:OwnerContext):{sql:string;args:(string|number)[]} {
  if(ctx.actor?.kind==='token'&&ctx.actor.canDraft!==true)return {sql:'0=1',args:[]};
  return ctx.actor?.kind==='token'?{sql:`EXISTS(SELECT 1 FROM mailbox_tokens t WHERE t.id=? AND t.mailbox_id=? AND t.can_draft=1
    AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?))`,args:[ctx.actor.tokenId,ctx.actor.mailboxId,Date.now()]}:{sql:'1=1',args:[]};
}
export async function authorizeDrafts(ctx:OwnerContext,mailboxId:string,write=false):Promise<BoxPolicy> {
  if(!uuid.test(mailboxId)) throw new ServiceError('not_found',404);
  if(!ctx.actor) throw new ServiceError('unauthorized',401);
  if(ctx.actor.kind==='token') {
    if(ctx.actor.mailboxId!==mailboxId) throw new ServiceError('not_found',404);
    if(ctx.actor.canDraft!==true)throw new ServiceError('insufficient_scope',403);
    const token=await sql(ctx.env,`SELECT can_draft FROM mailbox_tokens WHERE id=? AND mailbox_id=? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>?)`,ctx.actor.tokenId,mailboxId,Date.now()).first<{can_draft:number}>();
    if(token?.can_draft!==1) throw new ServiceError('insufficient_scope',403);
  }
  const box=await sql(ctx.env,`SELECT m.id,m.status,m.daily_recipient_limit,m.max_message_bytes,m.allowed_recipients_json,a.address,a.id address_id
    FROM mailboxes m JOIN mailbox_addresses a ON a.mailbox_id=m.id AND a.is_primary=1 WHERE m.id=? AND m.status IN('active','paused')`,mailboxId).first<BoxPolicy>();
  if(!box) throw new ServiceError('not_found',404);
  if((write||ctx.actor.kind==='token')&&box.status!=='active') throw new ServiceError('mailbox_inactive',409);
  return box;
}
export function auditStatement(ctx:OwnerContext,box:string,action:string,resource:string,guard:string,args:(string|number|null)[],id=crypto.randomUUID()):D1PreparedStatement {
  return sql(ctx.env,`INSERT INTO audit_events(id,mailbox_id,actor_kind,token_id,action,resource_id,outcome,request_id,metadata_json,occurred_at)
    SELECT ?,?,?,?,?,?,'success',?,'{}',? WHERE ${guard}`,id,box,ctx.actor?.kind??'system',ctx.actor?.kind==='token'?ctx.actor.tokenId:null,action,resource,ctx.requestId,Date.now(),...args);
}
export async function putObject(env:RuntimeEnv,box:string,purpose:'draft'|'outbound'|'raw_email'|'body',data:string,type='application/json') {
  const id=crypto.randomUUID(),key=`${box}/${purpose}/v1/${id}`,hash=await sha256(data),now=Date.now(),size=new TextEncoder().encode(data).length;
  await env.MAIL_BLOBS.put(key,data,{httpMetadata:{contentType:type}});
  await sql(env,`INSERT INTO objects(id,mailbox_id,object_key,purpose,state,size_bytes,sha256,content_type,created_at,ready_at)
    VALUES(?,?,?,?,'ready',?,?,?,?,?)`,id,box,key,purpose,size,hash,type,now,now).run();
  return {id,key,hash,size};
}
/** Only this request's private, newly prepared objects; FK checks and the command guard precede R2 deletion. */
async function cleanupPrepared(env:RuntimeEnv,box:string,blobs:{id:string;key:string}[],outboundId?:string) {
  if(!blobs.length) return;
  try {
    const results=await env.DB.batch(blobs.map(blob=>sql(env,`DELETE FROM objects WHERE id=? AND mailbox_id=?
      AND NOT EXISTS(SELECT 1 FROM drafts WHERE content_object_id=?)
      ${outboundId?'AND NOT EXISTS(SELECT 1 FROM outbound_messages WHERE id=?)':''}`,blob.id,box,blob.id,...(outboundId?[outboundId]:[]))));
    await Promise.all(results.map((result,index)=>result.meta.changes===1?env.MAIL_BLOBS.delete(blobs[index].key):Promise.resolve()));
  } catch { /* Never delete R2 if D1 could not prove these objects unreferenced. Crash recovery is separate. */ }
}
export async function readObject<T>(env:RuntimeEnv,box:string,id:string,purpose:string):Promise<T> {
  const row=await sql(env,`SELECT object_key,size_bytes,sha256 FROM objects WHERE id=? AND mailbox_id=? AND purpose=? AND state='ready'`,id,box,purpose)
    .first<{object_key:string;size_bytes:number;sha256:string}>();
  if(!row||row.size_bytes>MAX_CONTENT_OBJECT_BYTES) throw new ServiceError('content_unavailable',409);
  const value=await env.MAIL_BLOBS.get(row.object_key);
  if(!value) throw new ServiceError('content_unavailable',409);
  const bytes=await readBounded(value.body,MAX_CONTENT_OBJECT_BYTES);
  if(bytes.length!==row.size_bytes||await sha256(bytes)!==row.sha256) throw new ServiceError('content_corrupt',409);
  try{return JSON.parse(new TextDecoder().decode(bytes)) as T;}catch{throw new ServiceError('content_corrupt',409);}
}
export async function rowDraft(ctx:OwnerContext,box:string,id:string):Promise<DraftRow> {
  if(!uuid.test(id)) throw new ServiceError('not_found',404);
  const row=await sql(ctx.env,'SELECT * FROM drafts WHERE id=? AND mailbox_id=?',id,box).first<DraftRow>();
  if(!row||(ctx.actor?.kind==='token'&&row.created_by_token_id!==ctx.actor.tokenId)) throw new ServiceError('not_found',404);
  return row;
}
export async function draftDto(env:RuntimeEnv,row:DraftRow):Promise<DraftDTO> {
  const content=await readObject<DraftContent>(env,row.mailbox_id,row.content_object_id,'draft');
  if(await sha256(JSON.stringify(content))!==row.content_sha256) throw new ServiceError('content_corrupt',409);
  const token=row.created_by_token_id?await sql(env,'SELECT requires_approval FROM mailbox_tokens WHERE id=? AND mailbox_id=?',row.created_by_token_id,row.mailbox_id).first<{requires_approval:number}>():null;
  if(content.attachments!==undefined)normalizedAttachmentRefs(content.attachments);
  if(content.html!==undefined||content.inlineImages!==undefined){normalizedContent({...content});validateInlineImages(content);}
  return {id:row.id,mailboxId:row.mailbox_id,version:row.version,state:row.state as DraftState,contentSha256:row.content_sha256,
    createdByTokenId:row.created_by_token_id,requiresApproval:token?token.requires_approval===1:true,createdAt:row.created_at,updatedAt:row.updated_at,content};
}
export async function getDraft(ctx:OwnerContext,box:string,id:string) {await authorizeDrafts(ctx,box);return draftDto(ctx.env,await rowDraft(ctx,box,id));}
export async function listDrafts(ctx:OwnerContext,box:string) {
  await authorizeDrafts(ctx,box);
  const token=ctx.actor?.kind==='token'?ctx.actor.tokenId:null;
  const {results}=await sql(ctx.env,`SELECT * FROM drafts WHERE mailbox_id=? AND state<>'discarded' ${token?'AND created_by_token_id=?':''}
    ORDER BY updated_at DESC,id DESC LIMIT 50`,box,...(token?[token]:[])).all<DraftRow>();
  return Promise.all(results.map(row=>draftDto(ctx.env,row)));
}
async function contentInput(ctx:OwnerContext,box:string,input:Record<string,unknown>):Promise<DraftContent> {
  const content=normalizedContent(input),reply=input.replyMessageId??null;
  if(reply===null) return content;
  if(typeof reply!=='string'||!uuid.test(reply)) throw new ServiceError('invalid_reply',400);
  if(ctx.actor?.kind==='token') {
    if(!ctx.actor.canRead)throw new ServiceError('insufficient_scope',403);
    const canRead=await sql(ctx.env,'SELECT can_read FROM mailbox_tokens WHERE id=? AND mailbox_id=?',ctx.actor.tokenId,box).first<number>('can_read');
    if(canRead!==1) throw new ServiceError('insufficient_scope',403);
  }
  const source=await sql(ctx.env,'SELECT subject,rfc_message_id,direction FROM messages WHERE id=? AND mailbox_id=? AND deleted_at IS NULL',reply,box)
    .first<{subject:string|null;rfc_message_id:string|null;direction:string}>();
  if(!source) throw new ServiceError('not_found',404);
  if(!content.to.length&&!content.cc.length&&!content.bcc.length) {
    const address=await sql(ctx.env,`SELECT address FROM message_addresses WHERE message_id=? AND mailbox_id=? AND kind IN(${source.direction==='outbound'?"'to'":"'reply_to','from'"})
      ORDER BY CASE kind WHEN 'reply_to' THEN 0 ELSE 1 END,ordinal LIMIT 1`,reply,box).first<string>('address');
    if(address) content.to=[externalAddress(address)];
  }
  if(!content.subject) content.subject=source.subject?.match(/^re:/i)?source.subject:`Re: ${source.subject??''}`;
  if(content.subject.length>512) content.subject=content.subject.slice(0,512);
  content.replyMessageId=reply;content.inReplyTo=replyHeader(source.rfc_message_id);
  // Incoming subjects are untrusted too; defaults pass the same header validation as direct input.
  return {...normalizedContent({...content}),replyMessageId:reply,inReplyTo:content.inReplyTo};
}
export async function discardDraft(ctx:OwnerContext,box:string,id:string) {
  await authorizeDrafts(ctx,box,true);const current=await rowDraft(ctx,box,id);
  if(!['editing','awaiting_approval','approved'].includes(current.state)) throw new ServiceError('draft_changed',409);
  const guard=guardActor(ctx),claim=crypto.randomUUID();
  const results=await ctx.env.DB.batch([
    auditStatement(ctx,box,'draft.discarded',id,`EXISTS(SELECT 1 FROM drafts WHERE id=? AND mailbox_id=? AND version=? AND state IN('editing','awaiting_approval','approved'))
      AND EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status='active') AND ${guard.sql}`,[id,box,current.version,box,...guard.args],claim),
    sql(ctx.env,`UPDATE drafts SET state='discarded',approved_version=NULL,approved_sha256=NULL,approved_at=NULL,updated_at=? WHERE id=? AND mailbox_id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`,
      Math.max(Date.now(),current.updated_at+1),id,box,claim)
  ]);
  if(results[1].meta.changes!==1) throw new ServiceError('draft_changed',409);
}
export async function saveDraft(ctx:OwnerContext,box:string,input:unknown,id?:string) {
  await authorizeDrafts(ctx,box,true);
  const data=objectInput(input,['to','cc','bcc','subject','text','html','inlineImages','replyMessageId',...(id?['expectedVersion']:[])]);
  const current=id?await rowDraft(ctx,box,id):null;
  if(current&&(current.version!==data.expectedVersion||!['editing','awaiting_approval','approved'].includes(current.state))) throw new ServiceError('draft_changed',409);
  let content=await contentInput(ctx,box,data);
  if(current){
    const previous=await draftDto(ctx.env,current);
    if(previous.content.attachments!==undefined)content.attachments=previous.content.attachments;
    if(!Object.hasOwn(data,'html')&&previous.content.html!==undefined)content.html=previous.content.html;
    if(!Object.hasOwn(data,'inlineImages')&&previous.content.inlineImages!==undefined)content.inlineImages=previous.content.inlineImages;
  }
  if(content.html===null){
    if(Array.isArray(data.inlineImages)&&data.inlineImages.length)throw new ServiceError('invalid_inline_images',400);
    if(content.inlineImages!==undefined)content.inlineImages=[];
  }
  content=canonicalContent(content);
  validateInlineImages(content);
  const blob=await putObject(ctx.env,box,'draft',serializedContent(content));
  const draftId=id??crypto.randomUUID(),now=Date.now(),mutation=crypto.randomUUID(),actorGuard=guardActor(ctx);
  const guard=`EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status='active') AND ${actorGuard.sql}${current?" AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND mailbox_id=? AND version=? AND state IN('editing','awaiting_approval','approved'))":''}`;
  const args:(string|number)[]=[box,...actorGuard.args,...(current?[draftId,box,current.version]:[])];
  const owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  let results:D1Result[];
  try {results=await ctx.env.DB.batch([
    auditStatement(ctx,box,current?'draft.updated':'draft.created',draftId,guard,args,mutation),
    current?sql(ctx.env,`UPDATE drafts SET content_object_id=?,content_sha256=?,version=version+1,state='editing',approved_version=NULL,approved_sha256=NULL,approved_at=NULL,updated_at=? WHERE id=? AND mailbox_id=? AND ${owned}`,
      blob.id,blob.hash,Math.max(now,current.updated_at+1),draftId,box,mutation):
      sql(ctx.env,`INSERT INTO drafts(id,mailbox_id,content_object_id,created_by_token_id,content_sha256,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE ${owned}`,
        draftId,box,blob.id,ctx.actor?.kind==='token'?ctx.actor.tokenId:null,blob.hash,now,now,mutation)
  ]);}catch(error){await cleanupPrepared(ctx.env,box,[blob]);throw error;}
  if(results[1].meta.changes!==1) {await cleanupPrepared(ctx.env,box,[blob]);throw new ServiceError('draft_changed',409);}
  return getDraft(ctx,box,draftId);
}
/** Internal attachment publication path. Public draft JSON never accepts attachment references. */
export async function replaceDraftAttachments(ctx:OwnerContext,box:string,id:string,expectedVersion:number,refs:DraftAttachmentRef[]):Promise<DraftDTO> {
  await authorizeDrafts(ctx,box,true);
  const current=await rowDraft(ctx,box,id);
  if(current.version!==expectedVersion||!Number.isSafeInteger(expectedVersion)||!['editing','awaiting_approval','approved'].includes(current.state))throw new ServiceError('draft_changed',409);
  const attachments=normalizedAttachmentRefs(refs);
  const old=await draftDto(ctx.env,current),previous=old.content.attachments??[];
  // Existing immutable references may be removed even when another file is blocked or unavailable.
  // Only additions require bytes now; approval/submission independently verify the entire new manifest.
  await loadDraftAttachmentBytes(ctx.env,box,id,attachments.filter(ref=>!previous.some(item=>JSON.stringify(item)===JSON.stringify(ref))));
  let content:DraftContent={...old.content,attachments};
  if(content.inlineImages!==undefined)content.inlineImages=content.inlineImages.filter(image=>attachments.some(ref=>ref.id===image.attachmentId));
  content=canonicalContent(content);
  validateInlineImages(content);
  const blob=await putObject(ctx.env,box,'draft',serializedContent(content)),mutation=crypto.randomUUID(),guard=guardActor(ctx),now=Math.max(Date.now(),current.updated_at+1);
  try {
    const results=await ctx.env.DB.batch([
      auditStatement(ctx,box,'draft.attachments_updated',id,`EXISTS(SELECT 1 FROM drafts WHERE id=? AND mailbox_id=? AND version=? AND content_sha256=? AND state IN('editing','awaiting_approval','approved'))
        AND EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status='active') AND ${guard.sql}`,[id,box,current.version,current.content_sha256,box,...guard.args],mutation),
      sql(ctx.env,`UPDATE drafts SET content_object_id=?,content_sha256=?,version=version+1,state='editing',approved_version=NULL,approved_sha256=NULL,approved_at=NULL,updated_at=?
        WHERE id=? AND mailbox_id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`,blob.id,blob.hash,now,id,box,mutation)
    ]);
    if(results[1].meta.changes!==1)throw new ServiceError('draft_changed',409);
  }catch(error){await cleanupPrepared(ctx.env,box,[blob]);throw error;}
  return getDraft(ctx,box,id);
}
export async function approveDraft(ctx:OwnerContext,box:string,id:string,input:unknown) {
  requireOwner(ctx.actor);await authorizeDrafts(ctx,box,true);
  const data=objectInput(input,['expectedVersion','contentSha256']),row=await rowDraft(ctx,box,id);
  const draft=await draftDto(ctx.env,row); // Verify the actual immutable R2 preview, not just the row hash.
  const files=await loadDraftAttachmentBytes(ctx.env,box,id,draft.content.attachments??[]);
  validateInlineImages(draft.content,files,{complete:true});
  if(row.version!==data.expectedVersion||row.content_sha256!==data.contentSha256||!['editing','awaiting_approval','approved'].includes(row.state)) throw new ServiceError('draft_changed',409);
  const mutation=crypto.randomUUID(),now=Math.max(Date.now(),row.updated_at+1);
  const results=await ctx.env.DB.batch([
    auditStatement(ctx,box,'draft.approved',id,`EXISTS(SELECT 1 FROM drafts WHERE id=? AND mailbox_id=? AND version=? AND content_sha256=? AND state IN('editing','awaiting_approval','approved')) AND EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status='active')`,[id,box,row.version,row.content_sha256,box],mutation),
    sql(ctx.env,`UPDATE drafts SET state='approved',approved_version=version,approved_sha256=content_sha256,approved_at=?,updated_at=? WHERE id=? AND mailbox_id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`,now,now,id,box,mutation)
  ]);
  if(results[1].meta.changes!==1) throw new ServiceError('draft_changed',409);
  return getDraft(ctx,box,id);
}
export function checkSendContent(box:BoxPolicy,content:DraftContent):number {
  const all=[...content.to,...content.cc,...content.bcc];
  if(!all.length||!content.subject.trim()||!content.text.trim()) throw new ServiceError('incomplete_draft',400);
  const allowed=JSON.parse(box.allowed_recipients_json) as string[];
  if(allowed.length&&all.some(address=>!allowed.includes(address))) throw new ServiceError('recipient_not_allowed',403);
  if(all.length>box.daily_recipient_limit) throw new ServiceError('send_limit_exceeded',409);
  return all.length;
}
function tokenEligibility(row:DraftRow) {
  return row.created_by_token_id?{sql:`EXISTS(SELECT 1 FROM mailbox_tokens t WHERE t.id=? AND t.mailbox_id=? AND t.can_draft=1 AND t.can_send=1
    AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?) AND (t.requires_approval=0 OR (drafts.approved_version=drafts.version AND drafts.approved_sha256=drafts.content_sha256 AND drafts.approved_at IS NOT NULL)))`,
    args:[row.created_by_token_id,row.mailbox_id,Date.now()] as (string|number)[]}:{sql:'drafts.approved_version=drafts.version AND drafts.approved_sha256=drafts.content_sha256 AND drafts.approved_at IS NOT NULL',args:[]};
}
export interface SendResult {status:'approval_required'|'queued';draftId:string;outboundId?:string}
export async function requestSend(ctx:OwnerContext,boxId:string,id:string,input:unknown,key:string|null):Promise<SendResult> {
  const box=await authorizeDrafts(ctx,boxId,true),data=objectInput(input,['expectedVersion']);
  if(!Number.isSafeInteger(data.expectedVersion)||typeof data.expectedVersion!=='number') throw new ServiceError('invalid_input',400);
  if(!key||!/^[\x21-\x7e]{1,128}$/.test(key)) throw new ServiceError('idempotency_key_required',400);
  const row=await rowDraft(ctx,boxId,id),principal=ctx.actor?.kind==='token'?`token:${ctx.actor.tokenId}`:'owner';
  const requestHash=await sha256(JSON.stringify({id,version:data.expectedVersion,content:row.content_sha256}));
  const prior=()=>sql(ctx.env,`SELECT request_sha256,response_json FROM idempotency_keys WHERE mailbox_id=? AND principal_key=? AND operation='send' AND key=?`,boxId,principal,key)
    .first<{request_sha256:string;response_json:string}>();
  const previous=await prior();
  if(previous) {if(previous.request_sha256!==requestHash) throw new ServiceError('idempotency_conflict',409);return JSON.parse(previous.response_json) as SendResult;}
  if(row.version!==data.expectedVersion||!['editing','awaiting_approval','approved'].includes(row.state)) throw new ServiceError('draft_changed',409);
  const draft=await draftDto(ctx.env,row),units=checkSendContent(box,draft.content);
  const recipientAddresses=[...draft.content.to,...draft.content.cc,...draft.content.bcc];
  await assertRecipientsNotSuppressed(ctx.env,boxId,recipientAddresses);
  const attachmentFiles=await loadDraftAttachmentBytes(ctx.env,boxId,id,draft.content.attachments??[]);
  validateInlineImages(draft.content,attachmentFiles,{complete:true});
  if(row.created_by_token_id) {
    const token=await sql(ctx.env,`SELECT can_send,can_draft,revoked_at,expires_at FROM mailbox_tokens WHERE id=? AND mailbox_id=?`,row.created_by_token_id,boxId)
      .first<{can_send:number;can_draft:number;revoked_at:number|null;expires_at:number|null}>();
    if(!token||token.can_send!==1||token.can_draft!==1||token.revoked_at!==null||(token.expires_at!==null&&token.expires_at<=Date.now())) throw new ServiceError('insufficient_scope',403);
  }
  const needsApproval=draft.requiresApproval&&(row.approved_version!==row.version||row.approved_sha256!==row.content_sha256||row.approved_at===null);
  if(ctx.actor?.kind==='owner'&&needsApproval) throw new ServiceError('approval_required',409);
  const now=Date.now(),claim=crypto.randomUUID(),outboundId=crypto.randomUUID();
  const response:SendResult=needsApproval?{status:'approval_required',draftId:id}:{status:'queued',draftId:id,outboundId};
  const actorGuard=guardActor(ctx),eligible=tokenEligibility(row);
  const providerGuard=cloudflareSendGuard(ctx.env,boxId,recipientAddresses);
  const baseGuard=`EXISTS(SELECT 1 FROM drafts WHERE id=? AND mailbox_id=? AND version=? AND content_sha256=? AND state IN('editing','awaiting_approval','approved')
    ${needsApproval?'':`AND ${eligible.sql}`}) AND EXISTS(SELECT 1 FROM mailboxes m JOIN mailbox_addresses a ON a.mailbox_id=m.id WHERE m.id=? AND m.status='active' AND a.id=? AND a.status='active'
    AND m.daily_recipient_limit=? AND m.allowed_recipients_json=?) AND ${actorGuard.sql}
    AND NOT EXISTS(SELECT 1 FROM recipient_suppressions s WHERE s.mailbox_id=? AND s.status='active' AND s.address IN(SELECT value FROM json_each(?))) AND ${providerGuard.sql}`;
  const guardArgs:(string|number)[]=[id,boxId,row.version,row.content_sha256,...(needsApproval?[]:eligible.args),boxId,box.address_id,box.daily_recipient_limit,box.allowed_recipients_json,...actorGuard.args,boxId,JSON.stringify(recipientAddresses),...providerGuard.args];
  const owned='EXISTS(SELECT 1 FROM idempotency_keys WHERE id=?)';
  const batch:D1PreparedStatement[]=[sql(ctx.env,`INSERT INTO idempotency_keys(id,mailbox_id,principal_key,operation,key,request_sha256,state,resource_id,response_json,created_at,expires_at)
    SELECT ?,?,?,'send',?,?,'completed',?,?,?,? WHERE ${baseGuard} ON CONFLICT(mailbox_id,principal_key,operation,key) DO NOTHING`,
    claim,boxId,principal,key,requestHash,needsApproval?id:outboundId,JSON.stringify(response),now,now+30*86400_000,...guardArgs)];
  const prepared:{id:string;key:string}[]=[];
  const prepare=async(purpose:'outbound'|'raw_email'|'body',value:string,type?:string)=>{
    const blob=await putObject(ctx.env,boxId,purpose,value,type);prepared.push(blob);return blob;
  };
  try {
  if(needsApproval) {
    batch.push(sql(ctx.env,`UPDATE drafts SET state='awaiting_approval',updated_at=? WHERE id=? AND mailbox_id=? AND ${owned}`,Math.max(now,row.updated_at+1),id,boxId,claim));
  } else {
    if(!ctx.env.EMAIL) throw new ServiceError('sending_not_configured',503);
    const usage=await sql(ctx.env,'SELECT reserved_units+used_units AS units FROM daily_send_counters WHERE mailbox_id=? AND day_utc=?',boxId,new Date(now).toISOString().slice(0,10)).first<number>('units');
    if((usage??0)+units>box.daily_recipient_limit) throw new ServiceError('send_limit_exceeded',409);
    const mime=localSentCopy(outboundId,box.address,draft.content,now,attachmentFiles);
    if(new TextEncoder().encode(mime).length>Math.min(box.max_message_bytes,10*1024*1024))throw new ServiceError('message_too_large',413);
    const raw=await prepare('raw_email',mime,'message/rfc822');
    const body=await prepare('body',serializedContent({text:draft.content.text,html:draft.content.html??null,htmlExtracted:true,attachmentsExtracted:true}));
    const frozen=await prepare('outbound',serializedContent({v:draft.content.html!==undefined||draft.content.inlineImages!==undefined?3:2,
      from:box.address,content:draft.content,version:row.version,rawObjectId:raw.id,bodyObjectId:body.id}));
    const day=new Date(now).toISOString().slice(0,10),counter=crypto.randomUUID(),reservation=crypto.randomUUID();
    batch.push(sql(ctx.env,`INSERT INTO daily_send_counters(id,mailbox_id,day_utc,limit_snapshot) SELECT ?,?,?,? WHERE ${owned}
      ON CONFLICT(mailbox_id,day_utc) DO UPDATE SET limit_snapshot=excluded.limit_snapshot`,counter,boxId,day,box.daily_recipient_limit,claim),
    sql(ctx.env,`INSERT INTO send_reservations(id,mailbox_id,counter_id,operation_id,units,created_at) SELECT ?,?,id,?,?,? FROM daily_send_counters WHERE mailbox_id=? AND day_utc=? AND ${owned}`,
      reservation,boxId,outboundId,units,now,boxId,day,claim),
    sql(ctx.env,`INSERT INTO outbound_messages(id,mailbox_id,sender_address_id,draft_id,requested_by_token_id,frozen_object_id,reservation_id,request_sha256,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${owned}`,outboundId,boxId,box.address_id,id,row.created_by_token_id,frozen.id,reservation,await sha256(JSON.stringify(draft.content)),now,now,claim),
    ...(['to','cc','bcc'] as const).flatMap(kind=>draft.content[kind].map(address=>sql(ctx.env,`INSERT INTO outbound_recipients(id,mailbox_id,outbound_id,kind,address) SELECT ?,?,?,?,? WHERE ${owned}`,crypto.randomUUID(),boxId,outboundId,kind,address,claim))),
    sql(ctx.env,`INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,payload_json,available_at,created_at,max_attempts) SELECT ?,?,'send_email',?,?,?, ?,3 WHERE ${owned}`,
      crypto.randomUUID(),boxId,outboundId,JSON.stringify({outboundId}),now,now,claim),
    sql(ctx.env,`UPDATE drafts SET state='submitted',updated_at=? WHERE id=? AND mailbox_id=? AND ${owned}`,Math.max(now,row.updated_at+1),id,boxId,claim));
  }
  batch.push(auditStatement(ctx,boxId,needsApproval?'draft.approval_requested':'outbound.queued',needsApproval?id:outboundId,owned,[claim]));
  await ctx.env.DB.batch(batch);
  }catch(error) {
    await cleanupPrepared(ctx.env,boxId,prepared,outboundId);
    if(error instanceof Error&&error.message.includes('send limit exceeded')) throw new ServiceError('send_limit_exceeded',409);
    throw error;
  }
  const saved=await prior();
  // A concurrent winner may have a different private snapshot. Keep only the command actually committed.
  await cleanupPrepared(ctx.env,boxId,prepared,outboundId);
  if(!saved) {await assertRecipientsNotSuppressed(ctx.env,boxId,recipientAddresses);throw new ServiceError('draft_changed',409);}
  if(saved.request_sha256!==requestHash) throw new ServiceError('idempotency_conflict',409);
  return JSON.parse(saved.response_json) as SendResult;
}
export async function listOutbound(ctx:OwnerContext,box:string) {
  await authorizeDrafts(ctx,box);
  const token=ctx.actor?.kind==='token'?ctx.actor.tokenId:null;
  const {results}=await sql(ctx.env,`SELECT id,draft_id,status,provider_message_id,last_error_code,created_at FROM outbound_messages WHERE mailbox_id=?
    ${token?'AND requested_by_token_id=?':''} ORDER BY created_at DESC,id DESC LIMIT 50`,box,...(token?[token]:[])).all<{id:string;draft_id:string|null;status:string;provider_message_id:string|null;last_error_code:string|null;created_at:number}>();
  return Promise.all(results.map(async row=>{
    const recipients=(await sql(ctx.env,`SELECT kind,address,status,last_provider_event_at lastProviderEventAt,
      delivery_event_type deliveryEventType,complained_at complainedAt,diagnostic_redacted diagnosticCode
      FROM outbound_recipients WHERE mailbox_id=? AND outbound_id=? ORDER BY kind,address`,box,row.id)
      .all<{kind:string;address:string;status:string;lastProviderEventAt:number|null;deliveryEventType:string|null;complainedAt:number|null;diagnosticCode:string|null}>()).results;
    return {id:row.id,draftId:row.draft_id,status:row.status,providerMessageId:row.provider_message_id,lastErrorCode:row.last_error_code,createdAt:row.created_at,
      lastProviderEventAt:recipients.reduce<number|null>((latest,recipient)=>recipient.lastProviderEventAt===null?latest:Math.max(latest??0,recipient.lastProviderEventAt),null),recipients};
  }));
}
export async function cancelOutbound(ctx:OwnerContext,box:string,id:string) {
  requireOwner(ctx.actor);await authorizeDrafts(ctx,box);
  const mutation=crypto.randomUUID(),now=Date.now();
  const owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  const results=await ctx.env.DB.batch([
    auditStatement(ctx,box,'outbound.cancelled',id,"EXISTS(SELECT 1 FROM outbound_messages WHERE id=? AND mailbox_id=? AND status='queued')",[id,box],mutation),
    sql(ctx.env,`UPDATE outbound_messages SET status='cancelled',updated_at=? WHERE id=? AND mailbox_id=? AND ${owned}`,now,id,box,mutation),
    sql(ctx.env,`UPDATE send_reservations SET state='released',settled_at=? WHERE operation_id=? AND mailbox_id=? AND state='reserved' AND ${owned}`,now,id,box,mutation),
    sql(ctx.env,`UPDATE jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE mailbox_id=? AND kind='send_email' AND dedupe_key=? AND state IN('pending','running') AND ${owned}`,box,id,mutation)
  ]);
  if(results[1].meta.changes!==1) throw new ServiceError('send_not_cancellable',409);
}
