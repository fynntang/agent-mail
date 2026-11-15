import type {AttachmentList,AttachmentSummary} from '../../types/mail';
import {requireRead} from './auth';
import {safeAttachmentFilename,safeAttachmentContentType,safeAttachmentContentId} from './attachment-metadata';
import {sha256} from './crypto';
import {getMailbox,type OwnerContext} from './owner';
import {readBounded} from './storage';
import {ServiceError} from './types';

export const MAX_ATTACHMENT_BYTES=10*1024*1024;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface MessageState {parse_state:'pending'|'ready'|'failed';attachments_state:'not_extracted'|'ready'}
interface Row {
  id:string;message_id:string;filename:string|null;disposition:AttachmentSummary['disposition'];content_id:string|null;
  scan_status:AttachmentSummary['scanStatus'];object_key:string|null;size_bytes:number|null;sha256:string|null;content_type:string|null;
  object_state:string|null;purpose:string|null;
}

function downloadPermission(ctx:OwnerContext):boolean {
  return ctx.actor?.kind==='owner'||ctx.actor?.kind==='token'&&ctx.actor.canRead&&ctx.actor.canReadAttachments===true;
}
async function authorizeMessage(ctx:OwnerContext,mailboxId:string,messageId:string):Promise<MessageState> {
  if(!uuid.test(mailboxId)||!uuid.test(messageId))throw new ServiceError('not_found',404);
  if(ctx.actor?.kind==='owner')await getMailbox(ctx,mailboxId);
  else {
    const actor=requireRead(ctx.actor);
    if(actor.mailboxId!==mailboxId)throw new ServiceError('not_found',404);
    if(!await ctx.env.DB.prepare("SELECT id FROM mailboxes WHERE id=? AND status='active'").bind(mailboxId).first())throw new ServiceError('not_found',404);
  }
  const row=await ctx.env.DB.prepare('SELECT parse_state,attachments_state FROM messages WHERE mailbox_id=? AND id=? AND deleted_at IS NULL')
    .bind(mailboxId,messageId).first<MessageState>();
  if(!row)throw new ServiceError('not_found',404);
  return row;
}
const select=`SELECT a.id,a.message_id,a.filename,a.disposition,a.content_id,a.scan_status,
  o.object_key,o.size_bytes,o.sha256,o.content_type,o.state object_state,o.purpose
  FROM attachments a LEFT JOIN objects o ON o.mailbox_id=a.mailbox_id AND o.id=a.object_id`;
function ready(row:Row):boolean {
  return row.object_state==='ready'&&row.purpose==='attachment'&&typeof row.object_key==='string'
    &&typeof row.size_bytes==='number'&&Number.isSafeInteger(row.size_bytes)&&row.size_bytes>=0&&row.size_bytes<=MAX_ATTACHMENT_BYTES
    &&typeof row.sha256==='string'&&/^[0-9a-f]{64}$/.test(row.sha256);
}
function summary(row:Row,canDownload:boolean):AttachmentSummary {
  return {id:row.id,messageId:row.message_id,filename:safeAttachmentFilename(row.filename),
    sizeBytes:row.size_bytes??0,contentType:safeAttachmentContentType(row.content_type??'application/octet-stream'),
    disposition:row.disposition,contentId:safeAttachmentContentId(row.content_id??undefined),scanStatus:row.scan_status,
    downloadable:canDownload&&ready(row)&&['unscanned','clean'].includes(row.scan_status)};
}

/** Metadata requires mail:read. No blob reads, signed URLs, scan claims, or read-state writes. */
export async function listAttachments(ctx:OwnerContext,mailboxId:string,messageId:string):Promise<AttachmentList> {
  const message=await authorizeMessage(ctx,mailboxId,messageId),canDownload=downloadPermission(ctx);
  const status=message.parse_state!=='ready'?message.parse_state:message.attachments_state;
  if(status!=='ready')return {status,canDownload,attachments:[]};
  const {results}=await ctx.env.DB.prepare(`${select} WHERE a.mailbox_id=? AND a.message_id=? ORDER BY CAST(a.part_id AS INTEGER),a.id LIMIT 51`)
    .bind(mailboxId,messageId).all<Row>();
  if(results.length>50)throw new ServiceError('attachment_index_unavailable',503);
  return {status,canDownload,attachments:results.map(row=>summary(row,canDownload))};
}

/** Authorize by mailbox+message+attachment, then verify bounded bytes before releasing any content. */
export async function readAttachment(ctx:OwnerContext,mailboxId:string,messageId:string,attachmentId:string,
  options:{maxBytes?:number}={}):Promise<{attachment:AttachmentSummary;bytes:Uint8Array}> {
  const message=await authorizeMessage(ctx,mailboxId,messageId);
  if(!downloadPermission(ctx))throw new ServiceError('insufficient_scope',403);
  if(!uuid.test(attachmentId)||message.parse_state!=='ready'||message.attachments_state!=='ready')throw new ServiceError('not_found',404);
  const row=await ctx.env.DB.prepare(`${select} WHERE a.mailbox_id=? AND a.message_id=? AND a.id=?`)
    .bind(mailboxId,messageId,attachmentId).first<Row>();
  if(!row)throw new ServiceError('not_found',404);
  if(!['unscanned','clean'].includes(row.scan_status))throw new ServiceError('attachment_blocked',403);
  if(!ready(row))throw new ServiceError('attachment_unavailable',503);
  const maxBytes=options.maxBytes??MAX_ATTACHMENT_BYTES;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_ATTACHMENT_BYTES)throw new ServiceError('invalid_input',400);
  if(row.size_bytes!>maxBytes)throw new ServiceError('attachment_unavailable',503);
  let bytes:Uint8Array;
  try {
    const stored=await ctx.env.MAIL_BLOBS.get(row.object_key!);
    if(!stored)throw new Error('missing');
    bytes=await readBounded(stored.body,maxBytes);
    if(bytes.byteLength!==row.size_bytes||await sha256(bytes)!==row.sha256)throw new Error('integrity');
  }catch{throw new ServiceError('attachment_unavailable',503);}
  // A paused/retired mailbox must not yield bytes even if its state changed during the read.
  await authorizeMessage(ctx,mailboxId,messageId);
  return {attachment:summary(row,true),bytes};
}

/** Attachment names and MIME headers are data, never response-header or executable content. */
export function attachmentDownloadResponse({attachment,bytes}:{attachment:Pick<AttachmentSummary,'filename'>;bytes:Uint8Array}):Response {
  const filename=safeAttachmentFilename(attachment.filename);
  const ascii=filename.replace(/[^\x20-\x7e]|["\\]/g,'_');
  const encoded=encodeURIComponent(filename).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(bytes.slice().buffer as ArrayBuffer,{headers:{
    'Content-Type':'application/octet-stream',
    'Content-Length':String(bytes.byteLength),
    'Content-Disposition':`attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"sandbox allow-downloads; default-src 'none'; frame-ancestors 'none'",'X-Frame-Options':'DENY'
  }});
}
