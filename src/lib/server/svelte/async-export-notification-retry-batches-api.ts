import type {RequestHandler} from '@sveltejs/kit';
import {previewAsyncExportNotificationRetryBatch,commitAsyncExportNotificationRetryBatch,listAsyncExportNotificationRetryBatches,getAsyncExportNotificationRetryBatch} from '../core/async-export-notification-retry-batches';
import {requireOwner} from '../core/owner';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

export function asyncExportNotificationRetryBatchesApi(operation:'preview'|'commit'|'list'|'get'):RequestHandler{
  return api(async({locals,params,url,request})=>{
    const ctx=ownerContext(locals);requireOwner(ctx.actor);const query:Record<string,string>={};
    for(const [key,value] of url.searchParams){if(!['list','get'].includes(operation)||!['limit','cursor'].includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);query[key]=value;}
    if(query.limit!==undefined&&(!/^[1-9]\d{0,2}$/.test(query.limit)||Number(query.limit)>100)||query.cursor!==undefined&&(!query.cursor||query.cursor.length>1024))throw new ServiceError('invalid_query',400);
    if(operation==='list')return Response.json(await listAsyncExportNotificationRetryBatches(ctx,params.id!,query));
    if(operation==='get')return Response.json(await getAsyncExportNotificationRetryBatch(ctx,params.id!,params.batchId!,query));
    if(operation==='preview')return Response.json(await previewAsyncExportNotificationRetryBatch(ctx,params.id!,await jsonInput(request)),{status:201});
    return Response.json(await commitAsyncExportNotificationRetryBatch(ctx,params.id!,params.batchId!,await jsonInput(request)),{status:202});
  });
}
