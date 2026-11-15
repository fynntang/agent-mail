import { getMailbox, retireMailbox, updateMailbox } from '#lib/server/core/owner.ts';
import { api } from '#lib/server/svelte/api.ts';
import { jsonInput, ownerContext } from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals,params})=>Response.json({mailbox:await getMailbox(ownerContext(locals),params.id!)}));
export const PATCH=api(async({locals,params,request})=>Response.json({mailbox:await updateMailbox(ownerContext(locals),params.id!,await jsonInput(request))}));
export const DELETE=api(async({locals,params,request})=>{
  await retireMailbox(ownerContext(locals),params.id!,await jsonInput(request));
  return new Response(null,{status:204});
});
