import type {RequestHandler} from '@sveltejs/kit';
import {cancelRetryBatchNotificationRetryBatch,reconcileRetryBatchNotificationRetryBatch,listRetryBatchNotificationRetryBatchOperations} from '../core/retry-batch-notification-retry-controls';
import {requireOwner} from '../core/owner';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

export function retryBatchNotificationRetryControlsApi(operation:'cancel'|'reconcile'|'operations'):RequestHandler{
  return api(async({locals,params,url,request})=>{
    const ctx=ownerContext(locals);requireOwner(ctx.actor);const query:Record<string,string>={};
    for(const [key,value] of url.searchParams){if(operation!=='operations'||!['limit','cursor'].includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);query[key]=value;}
    if(query.limit!==undefined&&(!/^[1-9]\d{0,2}$/.test(query.limit)||Number(query.limit)>100)||query.cursor!==undefined&&(!query.cursor||query.cursor.length>1024))throw new ServiceError('invalid_query',400);
    if(operation==='operations')return Response.json(await listRetryBatchNotificationRetryBatchOperations(ctx,params.id!,params.batchId!,query));
    const input=await jsonInput(request);return Response.json(await(operation==='cancel'?cancelRetryBatchNotificationRetryBatch:reconcileRetryBatchNotificationRetryBatch)(ctx,params.id!,params.batchId!,input));
  });
}
