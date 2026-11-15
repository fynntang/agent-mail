import {readAttachment,attachmentDownloadResponse} from '#lib/server/core/attachments.ts';
import {api} from '#lib/server/svelte/api.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals,params})=>attachmentDownloadResponse(await readAttachment(ownerContext(locals),params.id!,params.messageId!,params.attachmentId!)));
