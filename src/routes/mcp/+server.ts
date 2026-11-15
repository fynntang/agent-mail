import {handleMcp} from '#lib/server/mcp/server.ts';
import {api} from '#lib/server/svelte/api.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';

// Bearer authentication, mailbox status and Origin are checked by hooks on every request, including discovery.
export const POST=api(async({request,locals})=>handleMcp(request,ownerContext(locals)));
export const GET=api(async({request,locals})=>handleMcp(request,ownerContext(locals)));
export const DELETE=GET;
export const OPTIONS=GET;
