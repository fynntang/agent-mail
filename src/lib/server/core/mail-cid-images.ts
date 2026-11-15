import {listAttachments,readAttachment} from './attachments';
import {normalizeMailContentId} from './mail-cid';
import {MAIL_IMAGE_MAX_BYTES,MAIL_IMAGE_MAX_COUNT,MAIL_IMAGE_TOTAL_BYTES,rasterImageDataUri} from './mail-images';
import {requireOwner,type OwnerContext} from './owner';
import {ServiceError} from './types';

const mimeTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
const authorizationFailure=(error:unknown)=>error instanceof ServiceError&&[401,403,404].includes(error.status);

/**
 * Resolve only this Owner's current message. A CID grants no new attachment authority.
 * Reuse attachment authorization/state/purpose/size/SHA and scan policy; there are no network
 * requests, public blob URLs, writes, or fallback searches in another message or mailbox.
 */
export async function loadCidImages(ctx:OwnerContext,mailboxId:string,messageId:string,ids:string[]):Promise<Map<string,string>> {
  requireOwner(ctx.actor);
  const images=new Map<string,string>(),requested=new Set<string>();
  for(const id of ids) {
    if(requested.size>=MAIL_IMAGE_MAX_COUNT)break;
    if(normalizeMailContentId(id)===id)requested.add(id);
  }
  // Even an empty request still performs scoped message authorization, like attachment listing.
  let listing:Awaited<ReturnType<typeof listAttachments>>;
  try {listing=await listAttachments(ctx,mailboxId,messageId);}
  catch(error){if(authorizationFailure(error))throw error;return images;}
  if(listing.status!=='ready'||!requested.size)return images;
  try {
    // Summary IDs are display-sanitized. Match the persisted raw IDs so controls/truncation
    // cannot turn a malformed ID into a valid reference or hide an ambiguous duplicate.
    const {results}=await ctx.env.DB.prepare('SELECT id,content_id FROM attachments WHERE mailbox_id=? AND message_id=? LIMIT 51')
      .bind(mailboxId,messageId).all<{id:string;content_id:string|null}>();
    if(results.length>50)return images;
    const byId=new Map<string,string|null>();
    for(const row of results) {
      const id=normalizeMailContentId(row.content_id);
      if(id)byId.set(id,byId.has(id)?null:row.id);
    }
    const summaries=new Map(listing.attachments.map(attachment=>[attachment.id,attachment]));
    let total=0;
    for(const id of requested) {
      const attachmentId=byId.get(id),attachment=attachmentId?summaries.get(attachmentId):undefined;
      if(!attachment||!attachment.downloadable||!mimeTypes.has(attachment.contentType)||!Number.isSafeInteger(attachment.sizeBytes)
        ||attachment.sizeBytes<1||attachment.sizeBytes>Math.min(MAIL_IMAGE_MAX_BYTES,MAIL_IMAGE_TOTAL_BYTES-total))continue;
      try {
        const verified=await readAttachment(ctx,mailboxId,messageId,attachment.id,{maxBytes:MAIL_IMAGE_MAX_BYTES});
        total+=verified.bytes.byteLength;
        if(total>MAIL_IMAGE_TOTAL_BYTES)break;
        const uri=rasterImageDataUri(verified.bytes,verified.attachment.contentType);
        if(uri)images.set(id,uri);
      }catch(error) {
        // Authorization changes propagate; an unavailable/blocked individual image stays a placeholder.
        if(error instanceof ServiceError&&['unauthorized','owner_required','insufficient_scope','not_found'].includes(error.code))throw error;
      }
    }
  }catch(error){if(authorizationFailure(error))throw error;}
  return images;
}
