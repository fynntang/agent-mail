import type {RequestHandler} from '@sveltejs/kit';
import {createAsyncAlertNotificationExport,listAsyncAlertNotificationExports,getAsyncAlertNotificationExport,cancelAsyncAlertNotificationExport} from '../core/async-alert-notification-exports';
import {downloadAsyncAlertNotificationExport} from '../core/async-alert-notification-export-download';
import {requireOwner} from '../core/owner';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

export function asyncAlertNotificationExportsApi(operation:'create'|'list'|'get'|'cancel'|'download'):RequestHandler{
  return api(async({locals,params,url,request})=>{
    const ctx=ownerContext(locals);requireOwner(ctx.actor);const query:Record<string,string>={};
    for(const [key,value] of url.searchParams){if(operation!=='list'||!['limit','cursor'].includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);query[key]=value;}
    if(query.limit!==undefined&&(!/^[1-9]\d{0,2}$/.test(query.limit)||Number(query.limit)>100)||query.cursor!==undefined&&(!query.cursor||query.cursor.length>1024))throw new ServiceError('invalid_query',400);
    if(operation==='list')return Response.json(await listAsyncAlertNotificationExports(ctx,params.id!,query));
    if(operation==='get')return Response.json(await getAsyncAlertNotificationExport(ctx,params.id!,params.jobId!));
    if(operation==='download')return downloadAsyncAlertNotificationExport(ctx,params.id!,params.jobId!,request.method==='HEAD');
    if(operation==='cancel')return Response.json(await cancelAsyncAlertNotificationExport(ctx,params.id!,params.jobId!,await jsonInput(request)));
    return Response.json(await createAsyncAlertNotificationExport(ctx,params.id!,await jsonInput(request)),{status:202});
  });
}
