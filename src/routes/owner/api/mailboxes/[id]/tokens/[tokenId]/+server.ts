import { revokeToken } from '#lib/server/core/owner.ts';
import { api } from '#lib/server/svelte/api.ts';
import { ownerContext } from '#lib/server/svelte/owner.ts';

export const DELETE=api(async({locals,params})=>Response.json({token:await revokeToken(ownerContext(locals),params.id!,params.tokenId!)}));
