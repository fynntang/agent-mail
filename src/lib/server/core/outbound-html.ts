import {getDraft} from './outbound';
import {loadDraftAttachmentBytes} from './draft-attachments';
import {validateInlineImages} from './outbound-content';
import {sanitizeMailHtml,type SanitizedMailHtml} from './mail-html';
import {rasterImageDataUri} from './mail-images';
import {requireOwner,type OwnerContext} from './owner';
import {ServiceError} from './types';

/** Read-only saved-version preview. Raw draft HTML is never placed in the console DOM. */
export async function previewDraftHtml(ctx:OwnerContext,box:string,id:string,expectedVersion:number,contentSha256:string):Promise<SanitizedMailHtml> {
  requireOwner(ctx.actor);
  const draft=await getDraft(ctx,box,id);
  const matching=(value:typeof draft)=>value.version===expectedVersion&&value.contentSha256===contentSha256;
  if(!matching(draft))throw new ServiceError('draft_changed',409);
  if(!draft.content.html)throw new ServiceError('html_not_present',409);
  validateInlineImages(draft.content);
  const blockedOrigins=[ctx.env.CONSOLE_ORIGIN,ctx.env.API_ORIGIN],raw=draft.content.html;
  const candidates=sanitizeMailHtml(raw,{blockedOrigins}),sources=new Map<string,string>();
  let total=0;
  for(const binding of draft.content.inlineImages??[]){
    if(!candidates.inlineImageIds.includes(binding.contentId))continue;
    const ref=draft.content.attachments?.find(part=>part.id===binding.attachmentId);
    if(!ref||ref.sizeBytes<1||ref.sizeBytes>1024*1024||total+ref.sizeBytes>4*1024*1024)continue;
    try{
      const [file]=await loadDraftAttachmentBytes(ctx.env,box,id,[ref]);
      total+=file.bytes.byteLength;
      const uri=rasterImageDataUri(file.bytes,ref.contentType);
      if(uri)sources.set(binding.contentId,uri);
    }catch{/* An unavailable or blocked file remains a placeholder, without revealing storage details. */}
  }
  if(!matching(await getDraft(ctx,box,id)))throw new ServiceError('draft_changed',409);
  return sanitizeMailHtml(raw,{blockedOrigins,cidImageSources:sources});
}
