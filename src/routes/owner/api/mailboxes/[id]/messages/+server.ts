import {listMessages,messageQuery} from '#lib/server/core/mail.ts';
import {api} from '#lib/server/svelte/api.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals,params,url})=>Response.json(await listMessages(ownerContext(locals),params.id!,messageQuery(url.searchParams))));
