import {requireRead} from '#lib/server/core/auth.ts';
import {readAttachment,attachmentDownloadResponse} from '#lib/server/core/attachments.ts';
import {api} from '#lib/server/svelte/api.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals,params})=>{
  const actor=requireRead(locals.actor);
  return attachmentDownloadResponse(await readAttachment(ownerContext(locals),actor.mailboxId,params.messageId!,params.attachmentId!));
});
