import {listAttachments} from '#lib/server/core/attachments.ts';
import {api} from '#lib/server/svelte/api.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals,params})=>Response.json(await listAttachments(ownerContext(locals),params.id!,params.messageId!)));
