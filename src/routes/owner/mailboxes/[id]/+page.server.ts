import { error } from '@sveltejs/kit';
import { getMailbox, listTokens } from '#lib/server/core/owner.ts';
import { ServiceError } from '#lib/server/core/types.ts';
import { ownerContext } from '#lib/server/svelte/owner.ts';
import type { PageServerLoad } from './$types';

export const load:PageServerLoad=async({locals,params})=>{
  const ctx=ownerContext(locals);
  try {return {mailbox:await getMailbox(ctx,params.id),tokens:await listTokens(ctx,params.id)};}
  catch(e) {if(e instanceof ServiceError)error(e.status,{message:e.code==='not_found'?'邮箱不存在或已退役。':'无法读取邮箱。'});throw e;}
};
