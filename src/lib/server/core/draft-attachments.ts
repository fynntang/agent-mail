import type {DraftAttachmentRef,DraftDTO} from '../../types/outbound';
import {safeAttachmentFilename,safeAttachmentContentType} from './attachment-metadata';
import {sha256,stableId} from './crypto';
import {authorizeDrafts,getDraft,guardActor,replaceDraftAttachments,sql} from './outbound';
import {objectInput} from './outbound-content';
import type {OwnerContext} from './owner';
import {readBounded} from './storage';
import {ServiceError,type RuntimeEnv} from './types';

export const DRAFT_ATTACHMENT_MAX_BYTES=5*1024*1024;
export const DRAFT_ATTACHMENT_MAX_FILES=32;
export const DRAFT_ATTACHMENT_CHUNK_BYTES=64*1024;
export const DRAFT_ATTACHMENT_MAX_PARTS=128;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const editable=['editing','awaiting_approval','approved'];
type UploadInput={expectedVersion:number;filename:string;contentType:string;totalBytes?:number};
interface AttachmentRow {
  id:string;mailbox_id:string;draft_id:string;object_id:string;filename:string;content_type:string;size_bytes:number;sha256:string;scan_status:string;
  object_key:string;object_state:string;object_purpose:string;object_size:number;object_sha256:string;object_content_type:string;
}
interface UploadRow {
  id:string;mailbox_id:string;draft_id:string;created_by_token_id:string|null;expected_version:number;
  filename:string;content_type:string;total_bytes:number;received_bytes:number;state:'open'|'completed';attachment_id:string|null;created_at:number;expires_at:number;
}
interface PartRow {offset_bytes:number;size_bytes:number;object_key:string;sha256:string}
export interface DraftAttachmentUpload {
  id:string;draftId:string;expectedVersion:number;filename:string;contentType:string;totalBytes:number;receivedBytes:number;
  state:'open'|'completed';expiresAt:number;attachmentId:string|null;
}
function uploadDto(row:UploadRow):DraftAttachmentUpload {
  return {id:row.id,draftId:row.draft_id,expectedVersion:row.expected_version,filename:row.filename,contentType:row.content_type,
    totalBytes:row.total_bytes,receivedBytes:row.received_bytes,state:row.state,expiresAt:row.expires_at,attachmentId:row.attachment_id};
}
function version(value:unknown):asserts value is number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new ServiceError('invalid_input',400);
}
function uploadInput(value:unknown,session=false):UploadInput {
  const data=objectInput(value,['expectedVersion','filename','contentType',...(session?['totalBytes']:[])]);
  version(data.expectedVersion);
  if(typeof data.filename!=='string'||!data.filename.trim()||data.filename.length>1024
    ||typeof data.contentType!=='string'||data.contentType.length>127)throw new ServiceError('invalid_attachment_metadata',400);
  if(session&&(typeof data.totalBytes!=='number'||!Number.isSafeInteger(data.totalBytes)||data.totalBytes<0||data.totalBytes>DRAFT_ATTACHMENT_MAX_BYTES))throw new ServiceError('attachment_too_large',413);
  return {expectedVersion:data.expectedVersion,filename:safeAttachmentFilename(data.filename),contentType:safeAttachmentContentType(data.contentType),
    ...(session?{totalBytes:data.totalBytes as number}:{})};
}
async function draft(ctx:OwnerContext,box:string,id:string,write=false):Promise<DraftDTO> {
  await authorizeDrafts(ctx,box,write);
  if(ctx.actor?.kind==='token'&&ctx.actor.canDraft!==true)throw new ServiceError('insufficient_scope',403);
  return getDraft(ctx,box,id) as Promise<DraftDTO>;
}
function writable(current:DraftDTO,expectedVersion:number):void {
  if(current.version!==expectedVersion||!editable.includes(current.state))throw new ServiceError('draft_changed',409);
}
function capacity(refs:DraftAttachmentRef[],bytes:number):void {
  if(refs.length>=DRAFT_ATTACHMENT_MAX_FILES)throw new ServiceError('too_many_attachments',413);
  if(bytes>DRAFT_ATTACHMENT_MAX_BYTES||refs.reduce((sum,item)=>sum+item.sizeBytes,0)+bytes>DRAFT_ATTACHMENT_MAX_BYTES)throw new ServiceError('attachments_too_large',413);
}
const attachmentSelect=`SELECT a.*,o.object_key,o.state object_state,o.purpose object_purpose,o.size_bytes object_size,o.sha256 object_sha256,o.content_type object_content_type
  FROM draft_attachments a JOIN objects o ON o.mailbox_id=a.mailbox_id AND o.id=a.object_id`;
function reference(row:AttachmentRow):DraftAttachmentRef {
  return {id:row.id,filename:row.filename,contentType:row.content_type,sizeBytes:row.size_bytes,sha256:row.sha256};
}
function matching(a:DraftAttachmentRef,b:DraftAttachmentRef):boolean {
  return a.id===b.id&&a.filename===b.filename&&a.contentType===b.contentType&&a.sizeBytes===b.sizeBytes&&a.sha256===b.sha256;
}
async function attachmentBytes(env:RuntimeEnv,row:AttachmentRow):Promise<Uint8Array> {
  if(!['unscanned','clean'].includes(row.scan_status))throw new ServiceError('attachment_blocked',403);
  if(row.object_state!=='ready'||row.object_purpose!=='attachment'||row.object_size!==row.size_bytes||row.object_sha256!==row.sha256
    ||row.object_content_type!==row.content_type||row.size_bytes<0||row.size_bytes>DRAFT_ATTACHMENT_MAX_BYTES)throw new ServiceError('attachment_unavailable',409);
  try {
    const object=await env.MAIL_BLOBS.get(row.object_key);
    if(!object)throw new Error();
    const bytes=await readBounded(object.body,DRAFT_ATTACHMENT_MAX_BYTES);
    if(bytes.byteLength!==row.size_bytes||await sha256(bytes)!==row.sha256)throw new Error();
    return bytes;
  }catch{throw new ServiceError('attachment_unavailable',409);}
}
/** Internal snapshot loader; references are checked against immutable same-draft rows before any bytes are released. */
export async function loadDraftAttachmentBytes(env:RuntimeEnv,box:string,draftId:string,refs:DraftAttachmentRef[]=[]):Promise<{attachment:DraftAttachmentRef;bytes:Uint8Array}[]> {
  if(!Array.isArray(refs)||refs.length>DRAFT_ATTACHMENT_MAX_FILES)throw new ServiceError('content_corrupt',409);
  let total=0;const seen=new Set<string>(),loaded:{attachment:DraftAttachmentRef;bytes:Uint8Array}[]=[];
  for(const ref of refs) {
    if(!ref||typeof ref.id!=='string'||!uuid.test(ref.id)||seen.has(ref.id)||!Number.isSafeInteger(ref.sizeBytes)||ref.sizeBytes<0)throw new ServiceError('content_corrupt',409);
    total+=ref.sizeBytes;if(total>DRAFT_ATTACHMENT_MAX_BYTES)throw new ServiceError('attachments_too_large',413);seen.add(ref.id);
    const row=await sql(env,`${attachmentSelect} WHERE a.mailbox_id=? AND a.draft_id=? AND a.id=?`,box,draftId,ref.id).first<AttachmentRow>();
    if(!row||!matching(reference(row),ref)||safeAttachmentFilename(ref.filename)!==ref.filename||safeAttachmentContentType(ref.contentType)!==ref.contentType)throw new ServiceError('content_corrupt',409);
    loaded.push({attachment:reference(row),bytes:await attachmentBytes(env,row)});
  }
  return loaded;
}

async function prepareAttachment(ctx:OwnerContext,box:string,draftId:string,metadata:UploadInput,bytes:Uint8Array,id:string=crypto.randomUUID()):Promise<DraftAttachmentRef> {
  if(bytes.byteLength>DRAFT_ATTACHMENT_MAX_BYTES)throw new ServiceError('attachment_too_large',413);
  const hash=await sha256(bytes),objectId=await stableId(`draft-attachment-object:v1:${box}:${draftId}:${id}`),key=`${box}/draft-attachment/v1/${draftId}/${id}`;
  const customMetadata={mailboxId:box,draftId,attachmentId:id,sha256:hash,purpose:'draft-attachment',format:'v1'};
  const stored=await ctx.env.MAIL_BLOBS.put(key,bytes as Uint8Array<ArrayBuffer>,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream'},customMetadata});
  if(!stored) {
    const previous=await ctx.env.MAIL_BLOBS.get(key);
    try {
      if(!previous||Object.entries(customMetadata).some(([name,value])=>previous.customMetadata?.[name]!==value))throw new Error();
      const data=await readBounded(previous.body,DRAFT_ATTACHMENT_MAX_BYTES);
      if(data.byteLength!==bytes.byteLength||await sha256(data)!==hash)throw new Error();
    }catch{if(previous&&!previous.bodyUsed)await previous.body.cancel();throw new ServiceError('attachment_object_conflict',409);}
  }
  const now=Date.now();
  await ctx.env.DB.batch([
    sql(ctx.env,`INSERT INTO objects(id,mailbox_id,object_key,purpose,state,size_bytes,sha256,content_type,created_at,ready_at)
      VALUES(?,?,?,'attachment','ready',?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,objectId,box,key,bytes.byteLength,hash,metadata.contentType,now,now),
    sql(ctx.env,`INSERT INTO draft_attachments(id,mailbox_id,draft_id,object_id,filename,content_type,size_bytes,sha256,created_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,id,box,draftId,objectId,metadata.filename,metadata.contentType,bytes.byteLength,hash,now)
  ]);
  const row=await sql(ctx.env,`${attachmentSelect} WHERE a.mailbox_id=? AND a.draft_id=? AND a.id=?`,box,draftId,id).first<AttachmentRow>();
  const expected={id,filename:metadata.filename,contentType:metadata.contentType,sizeBytes:bytes.byteLength,sha256:hash};
  if(!row||!matching(reference(row),expected)||row.object_id!==objectId)throw new ServiceError('attachment_object_conflict',409);
  return expected;
}

export async function addDraftAttachment(ctx:OwnerContext,box:string,draftId:string,input:unknown,bytes:Uint8Array):Promise<DraftDTO> {
  const metadata=uploadInput(input),current=await draft(ctx,box,draftId,true);writable(current,metadata.expectedVersion);
  if(!(bytes instanceof Uint8Array))throw new ServiceError('invalid_input',400);
  const refs=current.content.attachments??[];capacity(refs,bytes.byteLength);
  const ref=await prepareAttachment(ctx,box,draftId,metadata,bytes);
  // A failed/uncertain mutation never deletes bytes which another frozen revision might reference.
  return replaceDraftAttachments(ctx,box,draftId,current.version,[...refs,ref]) as Promise<DraftDTO>;
}
export async function removeDraftAttachment(ctx:OwnerContext,box:string,draftId:string,attachmentId:string,input:unknown):Promise<DraftDTO> {
  const data=objectInput(input,['expectedVersion']);version(data.expectedVersion);
  const current=await draft(ctx,box,draftId,true);writable(current,data.expectedVersion);
  const refs=current.content.attachments??[];
  if(!uuid.test(attachmentId)||!refs.some(ref=>ref.id===attachmentId))throw new ServiceError('not_found',404);
  return replaceDraftAttachments(ctx,box,draftId,current.version,refs.filter(ref=>ref.id!==attachmentId)) as Promise<DraftDTO>;
}
export async function readDraftAttachment(ctx:OwnerContext,box:string,draftId:string,attachmentId:string):Promise<{attachment:DraftAttachmentRef;bytes:Uint8Array}> {
  const current=await draft(ctx,box,draftId),ref=(current.content.attachments??[]).find(item=>item.id===attachmentId);
  if(!ref||current.state==='discarded')throw new ServiceError('not_found',404);
  return (await loadDraftAttachmentBytes(ctx.env,box,draftId,[ref]))[0];
}

async function uploadRow(ctx:OwnerContext,box:string,draftId:string,id:string):Promise<{row:UploadRow;current:DraftDTO}> {
  const current=await draft(ctx,box,draftId,true);
  if(!uuid.test(id))throw new ServiceError('not_found',404);
  const row=await sql(ctx.env,'SELECT * FROM draft_attachment_uploads WHERE id=? AND mailbox_id=? AND draft_id=?',id,box,draftId).first<UploadRow>();
  const principal=ctx.actor?.kind==='token'?ctx.actor.tokenId:null;
  if(!row||row.created_by_token_id!==principal)throw new ServiceError('not_found',404);
  if(row.state==='open'&&row.expires_at<=Date.now())throw new ServiceError('upload_expired',410);
  return {row,current};
}
export async function beginDraftAttachmentUpload(ctx:OwnerContext,box:string,draftId:string,input:unknown):Promise<{upload:DraftAttachmentUpload}> {
  const metadata=uploadInput(input,true),current=await draft(ctx,box,draftId,true);writable(current,metadata.expectedVersion);
  capacity(current.content.attachments??[],metadata.totalBytes!);
  const id=crypto.randomUUID(),now=Date.now(),guard=guardActor(ctx);
  const result=await sql(ctx.env,`INSERT INTO draft_attachment_uploads(id,mailbox_id,draft_id,created_by_token_id,expected_version,filename,content_type,total_bytes,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM drafts WHERE id=? AND mailbox_id=? AND version=? AND state IN('editing','awaiting_approval','approved'))
    AND EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status='active') AND ${guard.sql}
    AND (SELECT count(*) FROM draft_attachment_uploads WHERE draft_id=? AND mailbox_id=? AND state='open' AND expires_at>?)<8`,
    id,box,draftId,ctx.actor?.kind==='token'?ctx.actor.tokenId:null,current.version,metadata.filename,metadata.contentType,metadata.totalBytes!,now,now+3600_000,
    draftId,box,current.version,box,...guard.args,draftId,box,now).run();
  if(result.meta.changes!==1)throw new ServiceError('upload_unavailable',409);
  const row=await sql(ctx.env,'SELECT * FROM draft_attachment_uploads WHERE id=?',id).first<UploadRow>();
  return {upload:uploadDto(row!)};
}
function chunkInput(input:unknown):{offset:number;bytes:Uint8Array} {
  const data=objectInput(input,['offset','data']);
  if(typeof data.offset!=='number'||!Number.isSafeInteger(data.offset)||data.offset<0||typeof data.data!=='string'
    ||!data.data||data.data.length>Math.ceil(DRAFT_ATTACHMENT_CHUNK_BYTES/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.data))throw new ServiceError('invalid_upload_chunk',400);
  let binary:string;
  try{binary=atob(data.data);}catch{throw new ServiceError('invalid_upload_chunk',400);}
  if(btoa(binary)!==data.data||binary.length<1||binary.length>DRAFT_ATTACHMENT_CHUNK_BYTES)throw new ServiceError('invalid_upload_chunk',400);
  return {offset:data.offset,bytes:Uint8Array.from(binary,char=>char.charCodeAt(0))};
}
export async function appendDraftAttachmentChunk(ctx:OwnerContext,box:string,draftId:string,id:string,input:unknown):Promise<{upload:DraftAttachmentUpload}> {
  const {offset,bytes}=chunkInput(input),{row,current}=await uploadRow(ctx,box,draftId,id);
  if(row.state!=='open')throw new ServiceError('upload_completed',409);writable(current,row.expected_version);
  const hash=await sha256(bytes),end=offset+bytes.byteLength;
  if(offset>row.received_bytes||end>row.total_bytes)throw new ServiceError('invalid_upload_offset',409);
  if(offset<row.received_bytes) {
    const part=await sql(ctx.env,'SELECT * FROM draft_attachment_upload_parts WHERE upload_id=? AND mailbox_id=? AND offset_bytes=?',id,box,offset).first<PartRow>();
    if(!part||part.size_bytes!==bytes.byteLength||part.sha256!==hash)throw new ServiceError('upload_chunk_conflict',409);
    return {upload:uploadDto(row)};
  }
  const partCount=()=>sql(ctx.env,'SELECT count(*) n FROM draft_attachment_upload_parts WHERE upload_id=? AND mailbox_id=?',id,box).first<number>('n');
  if((await partCount())!>=DRAFT_ATTACHMENT_MAX_PARTS)throw new ServiceError('upload_too_many_parts',413);
  const key=`${box}/draft-upload/v1/${id}/${offset}`,metadata={mailboxId:box,uploadId:id,offset:String(offset),sha256:hash};
  const stored=await ctx.env.MAIL_BLOBS.put(key,bytes as Uint8Array<ArrayBuffer>,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream'},customMetadata:metadata});
  if(!stored) {
    const previous=await ctx.env.MAIL_BLOBS.get(key);
    try {
      if(!previous||Object.entries(metadata).some(([name,value])=>previous.customMetadata?.[name]!==value))throw new Error();
      const prior=await readBounded(previous.body,DRAFT_ATTACHMENT_CHUNK_BYTES);
      if(prior.byteLength!==bytes.byteLength||await sha256(prior)!==hash)throw new Error();
    }catch{if(previous&&!previous.bodyUsed)await previous.body.cancel();throw new ServiceError('upload_chunk_conflict',409);}
  }
  const guard=guardActor(ctx),now=Date.now();
  const owned=`EXISTS(SELECT 1 FROM draft_attachment_uploads u JOIN drafts d ON d.id=u.draft_id AND d.mailbox_id=u.mailbox_id
    JOIN mailboxes m ON m.id=u.mailbox_id WHERE u.id=? AND u.mailbox_id=? AND u.state='open' AND u.expires_at>? AND u.received_bytes=?
    AND d.version=u.expected_version AND d.state IN('editing','awaiting_approval','approved') AND m.status='active') AND ${guard.sql}`;
  await ctx.env.DB.batch([
    sql(ctx.env,`INSERT INTO draft_attachment_upload_parts(upload_id,mailbox_id,offset_bytes,size_bytes,object_key,sha256,created_at)
      SELECT ?,?,?,?,?,?,? WHERE ${owned}
      AND (SELECT count(*) FROM draft_attachment_upload_parts WHERE upload_id=? AND mailbox_id=?)<?
      ON CONFLICT(upload_id,offset_bytes) DO NOTHING`,id,box,offset,bytes.byteLength,key,hash,now,id,box,now,offset,...guard.args,id,box,DRAFT_ATTACHMENT_MAX_PARTS),
    sql(ctx.env,`UPDATE draft_attachment_uploads SET received_bytes=? WHERE id=? AND mailbox_id=? AND ${owned}
      AND EXISTS(SELECT 1 FROM draft_attachment_upload_parts WHERE upload_id=? AND mailbox_id=? AND offset_bytes=? AND size_bytes=? AND sha256=?)`,
      end,id,box,id,box,now,offset,...guard.args,id,box,offset,bytes.byteLength,hash)
  ]);
  const fresh=await uploadRow(ctx,box,draftId,id);
  const part=await sql(ctx.env,'SELECT * FROM draft_attachment_upload_parts WHERE upload_id=? AND mailbox_id=? AND offset_bytes=?',id,box,offset).first<PartRow>();
  if(fresh.row.received_bytes<end||!part||part.sha256!==hash||part.size_bytes!==bytes.byteLength) {
    if(!part&&(await partCount())!>=DRAFT_ATTACHMENT_MAX_PARTS)throw new ServiceError('upload_too_many_parts',413);
    throw new ServiceError('draft_changed',409);
  }
  return {upload:uploadDto(fresh.row)};
}
export async function completeDraftAttachmentUpload(ctx:OwnerContext,box:string,draftId:string,id:string):Promise<{draft:DraftDTO}> {
  const {row,current}=await uploadRow(ctx,box,draftId,id);
  if(row.state==='completed')return {draft:current};
  const finish=async(value:DraftDTO)=>{
    await sql(ctx.env,`UPDATE draft_attachment_uploads SET state='completed',attachment_id=? WHERE id=? AND mailbox_id=? AND state='open' AND received_bytes=total_bytes
      AND EXISTS(SELECT 1 FROM draft_attachments WHERE id=? AND mailbox_id=? AND draft_id=?)`,id,id,box,id,box,draftId).run();
    return {draft:value};
  };
  // Recover an interrupted journal update without attaching twice or restoring a subsequently removed file.
  if((current.content.attachments??[]).some(ref=>ref.id===id))return finish(current);
  writable(current,row.expected_version);
  if(row.received_bytes!==row.total_bytes)throw new ServiceError('upload_incomplete',409);
  const refs=current.content.attachments??[];capacity(refs,row.total_bytes);
  const {results}=await sql(ctx.env,'SELECT offset_bytes,size_bytes,object_key,sha256 FROM draft_attachment_upload_parts WHERE upload_id=? AND mailbox_id=? ORDER BY offset_bytes LIMIT 129',id,box).all<PartRow>();
  if(results.length>DRAFT_ATTACHMENT_MAX_PARTS)throw new ServiceError('upload_too_many_parts',413);
  const bytes=new Uint8Array(row.total_bytes);let offset=0;
  for(const part of results) {
    if(part.offset_bytes!==offset||part.size_bytes<1||offset+part.size_bytes>row.total_bytes)throw new ServiceError('upload_corrupt',409);
    try {
      const stored=await ctx.env.MAIL_BLOBS.get(part.object_key);if(!stored)throw new Error();
      const chunk=await readBounded(stored.body,DRAFT_ATTACHMENT_CHUNK_BYTES);
      if(chunk.byteLength!==part.size_bytes||await sha256(chunk)!==part.sha256)throw new Error();
      bytes.set(chunk,offset);offset+=chunk.byteLength;
    }catch{throw new ServiceError('upload_corrupt',409);}
  }
  if(offset!==row.total_bytes)throw new ServiceError('upload_incomplete',409);
  const metadata={expectedVersion:row.expected_version,filename:row.filename,contentType:row.content_type};
  const ref=await prepareAttachment(ctx,box,draftId,metadata,bytes,id);
  let updated:DraftDTO;
  try{updated=await replaceDraftAttachments(ctx,box,draftId,row.expected_version,[...refs,ref]) as DraftDTO;}
  catch(error) {
    const latest=await draft(ctx,box,draftId);
    if(!(latest.content.attachments??[]).some(item=>matching(item,ref)))throw error;
    updated=latest;
  }
  return finish(updated);
}
