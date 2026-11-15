import type {Attachment} from 'postal-mime';
import {sha256,stableId} from './crypto';
import {readBounded} from './storage';
import {ServiceError,type RuntimeEnv} from './types';
import {safeAttachmentFilename,safeAttachmentContentType} from './attachment-metadata';
import {normalizeMailContentId} from './mail-cid';

export const MAX_ATTACHMENTS=50;
export const MAX_ATTACHMENT_BYTES=10*1024*1024;
export interface PreparedAttachment {
  id:string;objectId:string;partId:string;key:string;bytes:Uint8Array;sha256:string;
  filename:string;contentType:string;disposition:'attachment'|'inline';contentId:string|null;
}

/** Validate every part before writing any derived objects. Indexes never use filenames as identities. */
export async function prepareAttachments(parts:Attachment[],mailboxId:string,receiptId:string):Promise<PreparedAttachment[]> {
  if(parts.length>MAX_ATTACHMENTS)throw new ServiceError('too_many_attachments',413);
  let total=0;
  const attachments:PreparedAttachment[]=[];
  for(const [index,part] of parts.entries()){
    const bytes=part.content instanceof ArrayBuffer?new Uint8Array(part.content):part.content instanceof Uint8Array?part.content:null;
    if(!bytes)throw new ServiceError('invalid_attachment_encoding');
    total+=bytes.byteLength;
    if(bytes.byteLength>MAX_ATTACHMENT_BYTES||total>MAX_ATTACHMENT_BYTES)throw new ServiceError('attachments_too_large',413);
    const partId=String(index+1);
    attachments.push({id:await stableId(`attachment:v1:${mailboxId}:${receiptId}:${partId}`),
      objectId:await stableId(`attachment-object:v1:${mailboxId}:${receiptId}:${partId}`),partId,
      key:`${mailboxId}/attachment/v1/${receiptId}/${partId}`,bytes,sha256:await sha256(bytes),
      filename:safeAttachmentFilename(part.filename,`attachment-${partId}.bin`),contentType:safeAttachmentContentType(part.mimeType),
      disposition:part.disposition==='inline'||part.related?'inline':'attachment',
      // CID identity must not be repaired by stripping controls or truncating into another ID.
      contentId:normalizeMailContentId(part.contentId)===null?null:part.contentId!});
  }
  return attachments;
}

/** Immutable conditional writes allow a new lease to reuse bytes from a failed publication. */
export async function storeAttachments(env:RuntimeEnv,mailboxId:string,receiptId:string,attachments:PreparedAttachment[]):Promise<void>{
  for(const part of attachments){
    const metadata={sha256:part.sha256,receiptId,mailboxId,purpose:'attachment',format:'v1',partId:part.partId};
    const stored=await env.MAIL_BLOBS.put(part.key,part.bytes as Uint8Array<ArrayBuffer>,{
      onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream'},customMetadata:metadata
    });
    if(!stored){
      const existing=await env.MAIL_BLOBS.get(part.key);
      try{
        if(!existing||Object.entries(metadata).some(([key,value])=>existing.customMetadata?.[key]!==value))throw new Error();
        const bytes=await readBounded(existing.body,MAX_ATTACHMENT_BYTES);
        if(bytes.byteLength!==part.bytes.byteLength||await sha256(bytes)!==part.sha256)throw new Error();
      }catch{
        if(existing&&!existing.bodyUsed)await existing.body.cancel();
        throw new ServiceError('attachment_object_conflict');
      }
    }
  }
}
