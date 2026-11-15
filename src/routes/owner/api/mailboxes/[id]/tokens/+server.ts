import { issueToken, listTokens } from '#lib/server/core/owner.ts';
import { api } from '#lib/server/svelte/api.ts';
import { jsonInput, ownerContext } from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals,params})=>Response.json({tokens:await listTokens(ownerContext(locals),params.id!)}));
export const POST=api(async({locals,params,request})=>Response.json(await issueToken(ownerContext(locals),params.id!,await jsonInput(request)),{status:201}));
