import type {RequestHandler} from '@sveltejs/kit';
import {checkRecipientSuppressions,listRecipientSuppressions,releaseRecipientSuppression} from '../core/recipient-suppressions';
import {objectInput} from '../core/outbound-content';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

type Operation='list'|'release'|'check';
/** Owner manages the list; Agents can only check addresses explicitly supplied in this request. */
export function suppressionsApi(operation:Operation):RequestHandler {
  return api(async({locals,params,request,url})=>{
    const ctx=ownerContext(locals),owner=operation!=='check';
    if(owner&&ctx.actor?.kind!=='owner')throw new ServiceError('owner_required',403);
    if(!owner&&ctx.actor?.kind!=='token')throw new ServiceError('unauthorized',401);
    const mailboxId=owner?params.id!:ctx.actor?.kind==='token'?ctx.actor.mailboxId:'';
    const allowed=operation==='list'?['status','limit','cursor']:[],query:Record<string,string>={};
    for(const [key,value] of url.searchParams){
      if(!allowed.includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);
      query[key]=value;
    }
    if(operation==='list') {
      if(query.status!==undefined&&!['active','released','all'].includes(query.status)
        ||query.limit!==undefined&&(!/^[1-9]\d{0,2}$/.test(query.limit)||Number(query.limit)>100)
        ||query.cursor!==undefined&&(!query.cursor||query.cursor.length>1024))throw new ServiceError('invalid_query',400);
      return Response.json(await listRecipientSuppressions(ctx,mailboxId,{
        ...(query.status===undefined?{}:{status:query.status}),...(query.limit===undefined?{}:{limit:Number(query.limit)}),
        ...(query.cursor===undefined?{}:{cursor:query.cursor})
      }));
    }
    if(operation==='release')return Response.json(await releaseRecipientSuppression(ctx,mailboxId,params.suppressionId!,await jsonInput(request)));
    const input=objectInput(await jsonInput(request),['addresses']);
    return Response.json(await checkRecipientSuppressions(ctx,mailboxId,input.addresses));
  });
}
