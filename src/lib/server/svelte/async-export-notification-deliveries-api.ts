import type {RequestHandler} from '@sveltejs/kit';
import {listAsyncExportNotificationDeliveryResults,getAsyncExportNotificationDelivery} from '../core/async-export-notification-deliveries';
import {retryAsyncExportNotificationDelivery} from '../core/async-export-notification-retry';
import {requireOwner} from '../core/owner';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

export function asyncExportNotificationDeliveriesApi(operation:'results'|'delivery'|'retry'):RequestHandler{
  return api(async({locals,params,url,request})=>{
    const ctx=ownerContext(locals);requireOwner(ctx.actor);const query:Record<string,string>={};
    for(const [key,value] of url.searchParams){if(operation!=='results'||!['limit','cursor'].includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);query[key]=value;}
    if(query.limit!==undefined&&(!/^[1-9]\d{0,2}$/.test(query.limit)||Number(query.limit)>100)
      ||query.cursor!==undefined&&(!query.cursor||query.cursor.length>1024))throw new ServiceError('invalid_query',400);
    if(operation==='results')return Response.json(await listAsyncExportNotificationDeliveryResults(ctx,params.id!,params.jobId!,query));
    if(operation==='delivery')return Response.json(await getAsyncExportNotificationDelivery(ctx,params.id!,params.jobId!,params.deliveryId!));
    return Response.json(await retryAsyncExportNotificationDelivery(ctx,params.id!,params.jobId!,params.deliveryId!,await jsonInput(request)));
  });
}
