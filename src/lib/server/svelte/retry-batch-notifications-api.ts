import type {RequestHandler} from '@sveltejs/kit';
import {listRetryBatchNotifications,getRetryBatchNotification,acknowledgeRetryBatchNotification} from '../core/retry-batch-notifications';
import {requireOwner} from '../core/owner';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

export function retryBatchNotificationsApi(operation:'list'|'get'|'acknowledge'):RequestHandler{
  return api(async({locals,params,url,request})=>{
    const ctx=ownerContext(locals);requireOwner(ctx.actor);const query:Record<string,string>={};
    for(const [key,value] of url.searchParams){if(operation!=='list'||!['status','kind','limit','cursor'].includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);query[key]=value;}
    if(query.limit!==undefined&&(!/^[1-9]\d{0,2}$/.test(query.limit)||Number(query.limit)>100)||query.cursor!==undefined&&(!query.cursor||query.cursor.length>1024))throw new ServiceError('invalid_query',400);
    if(operation==='list')return Response.json(await listRetryBatchNotifications(ctx,params.id!,query));
    if(operation==='get')return Response.json(await getRetryBatchNotification(ctx,params.id!,params.notificationId!));
    return Response.json(await acknowledgeRetryBatchNotification(ctx,params.id!,params.notificationId!,await jsonInput(request)));
  });
}
