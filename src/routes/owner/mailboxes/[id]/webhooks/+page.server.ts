import {error} from '@sveltejs/kit';
import {getMailbox} from '#lib/server/core/owner.ts';
import {ServiceError} from '#lib/server/core/types.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';
import type {PageServerLoad} from './$types';

export const load:PageServerLoad=async({locals,params})=>{
  try {return {mailbox:await getMailbox(ownerContext(locals),params.id)};}
  catch(e){if(e instanceof ServiceError)error(e.status,{message:e.status===404?'邮箱不存在或已退役。':'无法读取邮箱。'});throw e;}
};
