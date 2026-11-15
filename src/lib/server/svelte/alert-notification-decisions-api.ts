import type {RequestHandler} from '@sveltejs/kit';
import {getAlertNotificationDecision,listAlertNotificationDecisions} from '../core/alert-notification-decisions';
import {getMailbox,requireOwner} from '../core/owner';
import {ServiceError} from '../core/types';
import {api} from './api';
import {ownerContext} from './owner';

export function alertNotificationDecisionsApi(operation:'list'|'get'):RequestHandler{
  return api(async({locals,params,url})=>{
    const ctx=ownerContext(locals);requireOwner(ctx.actor);await getMailbox(ctx,params.id!);
    const query:Record<string,string>={};
    for(const [key,value] of url.searchParams){
      if(operation!=='list'||!['decision','eventType','from','to','limit','cursor'].includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);
      query[key]=value;
    }
    if(query.limit!==undefined&&(!/^[1-9]\d{0,2}$/.test(query.limit)||Number(query.limit)>100)
      ||query.from!==undefined&&!/^(0|[1-9]\d{0,15})$/.test(query.from)
      ||query.to!==undefined&&!/^(0|[1-9]\d{0,15})$/.test(query.to)
      ||query.cursor!==undefined&&(!query.cursor||query.cursor.length>2048))throw new ServiceError('invalid_query',400);
    return Response.json(operation==='list'?await listAlertNotificationDecisions(ctx,params.id!,query):
      await getAlertNotificationDecision(ctx,params.id!,params.eventId!));
  });
}
