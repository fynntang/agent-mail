import type {RequestHandler} from '@sveltejs/kit';
import {exportAlertNotificationDecisions} from '../core/alert-notification-export';
import {formatAlertNotificationExport} from '../core/alert-notification-export-format';
import {getMailbox,requireOwner} from '../core/owner';
import {ServiceError} from '../core/types';
import {api} from './api';
import {ownerContext} from './owner';

export const alertNotificationExportApi:RequestHandler=api(async({locals,params,url})=>{
  const ctx=ownerContext(locals);requireOwner(ctx.actor);await getMailbox(ctx,params.id!);
  const query:Record<string,string>={};
  for(const [key,value] of url.searchParams){
    if(!['format','decision','eventType','from','to'].includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);query[key]=value;
  }
  if(!['csv','json'].includes(query.format)||query.from!==undefined&&!/^(0|[1-9]\d{0,15})$/.test(query.from)
    ||query.to!==undefined&&!/^(0|[1-9]\d{0,15})$/.test(query.to))throw new ServiceError('invalid_query',400);
  const {format,...filters}=query;
  const data=await exportAlertNotificationDecisions(ctx,params.id!,filters),body=formatAlertNotificationExport(data,format as 'csv'|'json');
  const filename=`alert-notification-decisions-${data.mailboxId}-${data.window.from}-${data.window.to}.${format}`;
  return new Response(body,{headers:{'Content-Type':format==='csv'?'text/csv; charset=utf-8':'application/json; charset=utf-8',
    'Content-Disposition':`attachment; filename="${filename}"`,'Content-Length':String(body.byteLength),'Cache-Control':'private, no-store',
    'X-Content-Type-Options':'nosniff'}});
});
