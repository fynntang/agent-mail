import type {MailFolder,ReadFilter,MessageQuery,MessageSummary,MessagePage,MessageDetail,MessageAddress,HtmlBodyStatus,OwnerMessageHtml} from '../../types/mail';
import {requireRead} from './auth';
import {listAttachments} from './attachments';
import {sha256} from './crypto';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {readBounded} from './storage';
import {ServiceError} from './types';
import {sanitizeMailHtml} from './mail-html';
import {fetchMailImages} from './mail-images';
import {loadCidImages} from './mail-cid-images';

type MailContext=OwnerContext;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const folders:MailFolder[]=['all','inbox','sent','archive','trash','spam'];
const reads:ReadFilter[]=['all','read','unread'];
const MAX_BODY_BYTES=16*1024*1024;
const MAX_HTML_BYTES=512*1024;

interface Position {v:1|2;box:string;folder:MailFolder;read:ReadFilter;limit:number;direction:'before'|'after';time:number;id:string;q?:string}

function searchQuery(value:unknown):string|undefined {
  if(value===undefined) return undefined;
  if(typeof value!=='string'||!value.trim()||value.trim().length>200||/[\x00-\x1f\x7f]/.test(value)) throw new ServiceError('invalid_query',400);
  return value.trim();
}

export function messageQuery(params:URLSearchParams,defaultFolder:MailFolder='all'):MessageQuery {
  for(const key of ['limit','folder','read','cursor','q']) {
    if(params.getAll(key).length>1) throw new ServiceError('invalid_query',400);
  }
  const value=params.get('limit')??'20';
  const limit=/^[1-9]\d{0,2}$/.test(value)?Number(value):NaN;
  const folder=(params.get('folder')??defaultFolder) as MailFolder;
  const read=(params.get('read')??'all') as ReadFilter;
  if(!Number.isInteger(limit)||limit<1||limit>100||!folders.includes(folder)||!reads.includes(read)) throw new ServiceError('invalid_query',400);
  const cursor=params.get('cursor')??undefined;
  if(cursor!==undefined && (!cursor || cursor.length>2048)) throw new ServiceError('invalid_cursor',400);
  const q=searchQuery(params.get('q')??undefined);
  return {limit,folder,read,...(cursor?{cursor}:{}),...(q?{q}:{})};
}

function encode(position:Position):string {
  const bytes=new TextEncoder().encode(JSON.stringify(position));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}

function decode(cursor:string,mailboxId:string,query:MessageQuery):Position {
  try {
    if(cursor.length>2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes=Uint8Array.from(atob(cursor.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));
    const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));
    if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error();
    const p=value as Position;
    if(Object.keys(p).length!==(query.q?9:8) || p.v!==(query.q?2:1) || p.q!==query.q || p.box!==mailboxId || p.folder!==query.folder || p.read!==query.read || p.limit!==query.limit
      || !['before','after'].includes(p.direction) || !Number.isSafeInteger(p.time) || p.time<0 || typeof p.id!=='string' || !uuid.test(p.id)) throw new Error();
    // Cursors are positions, never credentials. Scope is independently checked on every request.
    return p;
  }catch {throw new ServiceError('invalid_cursor',400);}
}

async function authorizeMailbox(ctx:MailContext,mailboxId:string):Promise<void> {
  if(!uuid.test(mailboxId)) throw new ServiceError('not_found',404);
  if(ctx.actor?.kind==='owner') {await getMailbox(ctx,mailboxId);return;}
  const actor=requireRead(ctx.actor);
  if(actor.mailboxId!==mailboxId) throw new ServiceError('not_found',404);
  if(!await ctx.env.DB.prepare("SELECT id FROM mailboxes WHERE id=? AND status='active'").bind(mailboxId).first()) throw new ServiceError('not_found',404);
}

const columns=`m.id,m.subject,m.preview,m.direction,m.folder,m.is_read,m.parse_state,m.size_bytes,m.received_at,
  sender.address from_address,sender.display_name from_name`;
const from=`FROM messages m LEFT JOIN message_addresses sender ON sender.mailbox_id=m.mailbox_id
  AND sender.message_id=m.id AND sender.kind='from' AND sender.ordinal=0`;
interface Row extends Omit<MessageSummary,'from'> {from_address:string|null;from_name:string|null}
function dto(row:Row):MessageSummary {
  return {id:row.id,subject:row.subject,preview:row.preview,direction:row.direction,folder:row.folder,is_read:row.is_read,
    parse_state:row.parse_state,size_bytes:row.size_bytes,received_at:row.received_at,
    from:row.from_address?{address:row.from_address,name:row.from_name}:null};
}

export async function listMessages(ctx:MailContext,mailboxId:string,query:MessageQuery):Promise<MessagePage> {
  await authorizeMailbox(ctx,mailboxId);
  // Validate direct service callers as strictly as HTTP callers.
  if(!Number.isInteger(query.limit)||query.limit<1||query.limit>100||!folders.includes(query.folder)||!reads.includes(query.read)) throw new ServiceError('invalid_query',400);
  query={...query,q:searchQuery(query.q)};
  const position=query.cursor===undefined?null:decode(query.cursor,mailboxId,query);
  const conditions=['m.mailbox_id=?','m.deleted_at IS NULL'];
  const baseArgs:(string|number)[]=[mailboxId];
  if(query.folder!=='all') {conditions.push('m.folder=?');baseArgs.push(query.folder);}
  if(query.read!=='all') {conditions.push('m.is_read=?');baseArgs.push(query.read==='read'?1:0);}
  if(query.q) {
    // Search metadata only, with literal wildcard escaping. The mailbox predicate remains mandatory.
    const pattern=`%${query.q.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')}%`;
    conditions.push(`(m.subject LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM message_addresses ma
      WHERE ma.mailbox_id=m.mailbox_id AND ma.message_id=m.id AND ma.address LIKE ? ESCAPE '\\'))`);
    baseArgs.push(pattern,pattern);
  }
  const base=conditions.join(' AND ');
  const args=[...baseArgs];
  let range='';
  if(position) {
    const compare=position.direction==='before'?'<':'>';
    range=` AND (m.received_at${compare}? OR (m.received_at=? AND m.id${compare}?))`;
    args.push(position.time,position.time,position.id);
  }
  const order=position?.direction==='after'?'ASC':'DESC';
  const {results}=await ctx.env.DB.prepare(`SELECT ${columns} ${from} WHERE ${base}${range}
    ORDER BY m.received_at ${order},m.id ${order} LIMIT ?`).bind(...args,query.limit+1).all<Row>();
  const rows=results.slice(0,query.limit);
  if(order==='ASC') rows.reverse();
  let nextCursor:string|null=null,previousCursor:string|null=null;
  if(rows.length) {
    const first=rows[0],last=rows.at(-1)!;
    const [above,below]=await ctx.env.DB.batch([
      ctx.env.DB.prepare(`SELECT m.id FROM messages m WHERE ${base} AND (m.received_at>? OR (m.received_at=? AND m.id>?)) LIMIT 1`)
        .bind(...baseArgs,first.received_at,first.received_at,first.id),
      ctx.env.DB.prepare(`SELECT m.id FROM messages m WHERE ${base} AND (m.received_at<? OR (m.received_at=? AND m.id<?)) LIMIT 1`)
        .bind(...baseArgs,last.received_at,last.received_at,last.id)
    ]);
    const cursor=(row:Row,direction:Position['direction'])=>encode({v:query.q?2:1,box:mailboxId,folder:query.folder,read:query.read,limit:query.limit,direction,time:row.received_at,id:row.id,...(query.q?{q:query.q}:{})});
    if(above.results.length) previousCursor=cursor(first,'after');
    if(below.results.length) nextCursor=cursor(last,'before');
  }
  return {messages:rows.map(dto),limit:query.limit,filters:{folder:query.folder,read:query.read,...(query.q?{q:query.q}:{})},nextCursor,previousCursor};
}

async function messageRow(ctx:MailContext,mailboxId:string,messageId:string):Promise<Row&{body_object_id:string|null}> {
  if(!uuid.test(messageId)) throw new ServiceError('not_found',404);
  const row=await ctx.env.DB.prepare(`SELECT ${columns},m.body_object_id ${from} WHERE m.mailbox_id=? AND m.id=? AND m.deleted_at IS NULL`)
    .bind(mailboxId,messageId).first<Row&{body_object_id:string|null}>();
  if(!row) throw new ServiceError('not_found',404);
  return row;
}

interface StoredBody {text:string|null;html?:unknown;htmlExtracted?:unknown;htmlStatus?:unknown}
type BodyRead={status:'available';body:StoredBody}|{status:'pending'|'failed'|'unavailable';body:null};
async function readMessageBody(ctx:MailContext,mailboxId:string,row:Row&{body_object_id:string|null}):Promise<BodyRead> {
  if(row.parse_state!=='ready') return {status:row.parse_state==='failed'?'failed':'pending',body:null};
  if(!row.body_object_id) return {status:'unavailable',body:null};
  const object=await ctx.env.DB.prepare(`SELECT object_key,sha256,size_bytes FROM objects
    WHERE mailbox_id=? AND id=? AND purpose='body' AND state='ready'`)
    .bind(mailboxId,row.body_object_id).first<{object_key:string;sha256:string;size_bytes:number}>();
  if(!object||!Number.isSafeInteger(object.size_bytes)||object.size_bytes<0||object.size_bytes>MAX_BODY_BYTES) return {status:'unavailable',body:null};
  try {
    const stored=await ctx.env.MAIL_BLOBS.get(object.object_key);
    if(!stored) return {status:'unavailable',body:null};
    const bytes=await readBounded(stored.body,MAX_BODY_BYTES);
    if(bytes.byteLength!==object.size_bytes || await sha256(bytes)!==object.sha256) throw new Error('body_integrity');
    const body:unknown=JSON.parse(new TextDecoder().decode(bytes));
    if(!body||typeof body!=='object'||Array.isArray(body)||!('text' in body)||(body.text!==null&&typeof body.text!=='string')) throw new Error('body_format');
    return {status:'available',body:body as StoredBody};
  }catch {
    console.error(JSON.stringify({code:'body_unavailable',requestId:ctx.requestId}));
    return {status:'unavailable',body:null};
  }
}

function htmlStatus(body:StoredBody):HtmlBodyStatus {
  if(body.htmlExtracted!==true)return 'not_extracted';
  if(body.htmlStatus==='too_large')return 'too_large';
  if(body.htmlStatus==='unavailable')return 'unavailable';
  if(body.html===null)return 'not_present';
  if(typeof body.html!=='string')return 'unavailable';
  if(new TextEncoder().encode(body.html).byteLength>MAX_HTML_BYTES)return 'too_large';
  return body.html.trim()?'available':'not_present';
}
async function messageBody(ctx:MailContext,mailboxId:string,row:Row&{body_object_id:string|null}):Promise<MessageDetail['body']> {
  const result=await readMessageBody(ctx,mailboxId,row);
  if(result.status!=='available')return {status:result.status,text:null,htmlStatus:result.status};
  const text=result.body.text;
  return {status:text===null?'not_extracted':text.length?'ready':'empty',text,htmlStatus:htmlStatus(result.body)};
}

/** HTML never leaves this Owner-only path without sanitization. Only an explicit Owner POST permits image fetches. */
export async function getOwnerMessageHtml(ctx:MailContext,mailboxId:string,messageId:string,
  options:{allowRemoteImages?:boolean}={}):Promise<OwnerMessageHtml> {
  requireOwner(ctx.actor);
  if(options.allowRemoteImages!==undefined&&typeof options.allowRemoteImages!=='boolean')throw new ServiceError('invalid_input',400);
  await authorizeMailbox(ctx,mailboxId);
  const row=await messageRow(ctx,mailboxId,messageId),result=await readMessageBody(ctx,mailboxId,row);
  const empty=(status:HtmlBodyStatus):OwnerMessageHtml=>({status,html:null,blockedImages:0,remoteImages:0,loadedImages:0,inlineImages:0,loadedInlineImages:0,links:[]});
  if(result.status!=='available')return empty(result.status);
  const status=htmlStatus(result.body);
  if(status!=='available')return empty(status);
  try {
    const raw=result.body.html as string,blockedOrigins=[ctx.env.CONSOLE_ORIGIN,ctx.env.API_ORIGIN];
    let clean=sanitizeMailHtml(raw,{blockedOrigins});
    const cidImageSources=clean.inlineImageIds.length?await loadCidImages(ctx,mailboxId,messageId,clean.inlineImageIds):new Map<string,string>();
    if(cidImageSources.size)clean=sanitizeMailHtml(raw,{blockedOrigins,cidImageSources});
    const remoteImageBudget={count:8-clean.loadedInlineImages,bytes:4*1024*1024-clean.embeddedImageBytes};
    if(options.allowRemoteImages===true&&clean.remoteImageUrls.length&&remoteImageBudget.count>0&&remoteImageBudget.bytes>0){
      const imageSources=await fetchMailImages(clean.remoteImageUrls,blockedOrigins,{maxCount:remoteImageBudget.count,maxBytes:remoteImageBudget.bytes});
      clean=sanitizeMailHtml(raw,{allowRemoteImages:true,blockedOrigins,imageSources,cidImageSources,remoteImageBudget});
    }
    // Recheck ownership/deletion after blob reads or network latency before releasing the document.
    await authorizeMailbox(ctx,mailboxId);await messageRow(ctx,mailboxId,messageId);
    const {remoteImageUrls:_remote,inlineImageIds:_inline,embeddedImageBytes:_bytes,...safe}=clean;
    return {status:'available',...safe};
  }catch(error) {
    if(error instanceof ServiceError&&error.code==='html_too_large')return empty('too_large');
    console.error(JSON.stringify({code:'html_body_unavailable',requestId:ctx.requestId}));
    return empty('unavailable');
  }
}

export async function getMessage(ctx:MailContext,mailboxId:string,messageId:string):Promise<MessageDetail> {
  await authorizeMailbox(ctx,mailboxId);
  const row=await messageRow(ctx,mailboxId,messageId);
  const {results}=await ctx.env.DB.prepare(`SELECT kind,address,display_name name FROM message_addresses
    WHERE mailbox_id=? AND message_id=? ORDER BY kind,ordinal LIMIT 100`).bind(mailboxId,messageId).all<MessageAddress>();
  const [body,attachments]=await Promise.all([messageBody(ctx,mailboxId,row),listAttachments(ctx,mailboxId,messageId)]);
  return {message:dto(row),addresses:results,body,attachments,capabilities:{htmlRendering:ctx.actor?.kind==='owner',attachmentExtraction:true}};
}

export async function setMessageRead(ctx:MailContext,mailboxId:string,messageId:string,input:unknown):Promise<MessageSummary> {
  requireOwner(ctx.actor);
  await getMailbox(ctx,mailboxId);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!('isRead' in input)||typeof input.isRead!=='boolean') {
    throw new ServiceError('invalid_input',400);
  }
  await messageRow(ctx,mailboxId,messageId);
  const value=input.isRead?1:0,mutationId=crypto.randomUUID();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at)
      SELECT ?,?,'owner','message.read_state_changed',?,'success',?,?,? WHERE EXISTS(
        SELECT 1 FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE m.mailbox_id=? AND m.id=?
        AND m.deleted_at IS NULL AND m.is_read<>? AND b.status IN('active','paused'))`)
      .bind(mutationId,mailboxId,messageId,ctx.requestId,JSON.stringify({isRead:input.isRead}),Date.now(),mailboxId,messageId,value),
    ctx.env.DB.prepare(`UPDATE messages SET is_read=? WHERE mailbox_id=? AND id=? AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`).bind(value,mailboxId,messageId,mutationId)
  ]);
  await getMailbox(ctx,mailboxId);
  return dto(await messageRow(ctx,mailboxId,messageId));
}
