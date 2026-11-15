import {error} from '@sveltejs/kit';
import {getMailbox} from '#lib/server/core/owner.ts';
import {getMessage,listMessages,messageQuery} from '#lib/server/core/mail.ts';
import {ServiceError} from '#lib/server/core/types.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';
import type {MessageDetail} from '#lib/types/mail.ts';
import type {PageServerLoad} from './$types';

export const load:PageServerLoad=async({locals,params,url})=>{
  const ctx=ownerContext(locals);
  try {
    const mailbox=await getMailbox(ctx,params.id);
    const list=await listMessages(ctx,params.id,messageQuery(url.searchParams,'inbox'));
    if(url.searchParams.getAll('message').length>1)throw new ServiceError('invalid_query',400);
    const selectedId=url.searchParams.get('message')??list.messages[0]?.id??null;
    let detail:MessageDetail|null=null,detailError:string|null=null;
    if(selectedId) {
      try {detail=await getMessage(ctx,params.id,selectedId);}
      catch(e){if(e instanceof ServiceError&&e.status===404)detailError='邮件不存在或已删除。';else throw e;}
    }
    return {mailbox,list,detail,detailError};
  }catch(e) {
    if(e instanceof ServiceError)error(e.status,{message:e.status===404?'邮箱不存在或已退役。':'分页或筛选条件无效，请返回邮箱首页。'});
    throw e;
  }
};
