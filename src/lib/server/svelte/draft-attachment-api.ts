import {getDraft} from '../core/outbound';
import {addDraftAttachment,removeDraftAttachment,readDraftAttachment,beginDraftAttachmentUpload,appendDraftAttachmentChunk,completeDraftAttachmentUpload} from '../core/draft-attachments';
import {attachmentDownloadResponse} from '../core/attachments';
import {requireOwner} from '../core/owner';
import {readBounded} from '../core/storage';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

type Action='list'|'upload'|'remove'|'download'|'begin'|'append'|'complete';
const MAX_UPLOAD_BYTES=5*1024*1024;
export function draftAttachmentApi(action:Action,owner:boolean) {
  return api(async({locals,params,request})=>{
    const ctx=ownerContext(locals);
    let box:string;
    if(owner){requireOwner(ctx.actor);box=params.id!;}
    else {
      if(ctx.actor?.kind!=='token')throw new ServiceError('unauthorized',401);
      if(ctx.actor.canDraft!==true)throw new ServiceError('insufficient_scope',403);
      box=ctx.actor.mailboxId;
    }
    const draftId=params.draftId!;
    if(action==='list') {
      const draft=await getDraft(ctx,box,draftId);
      return Response.json({draftId,version:draft.version,attachments:draft.content.attachments??[]});
    }
    if(action==='upload') {
      if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/octet-stream')throw new ServiceError('binary_required',415);
      const version=request.headers.get('x-draft-version')??'',name=request.headers.get('x-attachment-filename');
      if(!/^[1-9]\d{0,15}$/.test(version)||!Number.isSafeInteger(Number(version))||!name||name.length>4096)throw new ServiceError('invalid_input',400);
      let filename:string;
      try{filename=decodeURIComponent(name);}catch{throw new ServiceError('invalid_filename',400);}
      const length=request.headers.get('content-length');
      if(length&&/^\d+$/.test(length)&&Number(length)>MAX_UPLOAD_BYTES)throw new ServiceError('attachment_too_large',413);
      let bytes:Uint8Array;
      try{bytes=request.body?await readBounded(request.body,MAX_UPLOAD_BYTES):new Uint8Array();}
      catch{throw new ServiceError('attachment_too_large',413);}
      const draft=await addDraftAttachment(ctx,box,draftId,{expectedVersion:Number(version),filename,
        contentType:request.headers.get('x-attachment-content-type')??'application/octet-stream'},bytes);
      return Response.json({draft},{status:201});
    }
    if(action==='download')return attachmentDownloadResponse(await readDraftAttachment(ctx,box,draftId,params.attachmentId!));
    if(action==='remove')return Response.json({draft:await removeDraftAttachment(ctx,box,draftId,params.attachmentId!,await jsonInput(request))});
    if(action==='begin')return Response.json(await beginDraftAttachmentUpload(ctx,box,draftId,await jsonInput(request)),{status:201});
    if(action==='append')return Response.json(await appendDraftAttachmentChunk(ctx,box,draftId,params.uploadId!,await jsonInput(request,100*1024)));
    const input=await jsonInput(request);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new ServiceError('invalid_input',400);
    return Response.json(await completeDraftAttachmentUpload(ctx,box,draftId,params.uploadId!));
  });
}
