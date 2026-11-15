import {error} from '@sveltejs/kit';
import {getMailbox} from '#lib/server/core/owner.ts';
import {ServiceError} from '#lib/server/core/types.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';
import type {PageServerLoad} from './$types';

export const load:PageServerLoad=async({locals,params,url})=>{
  const replyMessageId=url.searchParams.get('reply');
  if(url.searchParams.getAll('reply').length>1||(replyMessageId!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(replyMessageId))) {
    error(400,{message:'回复邮件地址无效，请从阅读页面重新进入。'});
  }
  try {return {mailbox:await getMailbox(ownerContext(locals),params.id),replyMessageId};}
  catch(e){if(e instanceof ServiceError)error(e.status,{message:e.status===404?'邮箱不存在或已退役。':'无法读取邮箱。'});throw e;}
};
