import type {RequestHandler} from '@sveltejs/kit';
import {acknowledgeCloudflareSuppressionAlert,getCloudflareSuppressionAlert,listCloudflareSuppressionAlerts,projectCloudflareSuppressionAlerts} from '../core/cloudflare-suppression-alerts';
import {getMailbox,requireOwner} from '../core/owner';
import {ServiceError,type RuntimeEnv} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

/** Source operations remain authoritative even if notification projection needs the next scheduled pass. */
export async function refreshSuppressionAlerts(env:RuntimeEnv):Promise<void>{
  try{await projectCloudflareSuppressionAlerts(env);}
  catch{console.error(JSON.stringify({event:'suppression_alert_projection_failed'}));}
}

export function cloudflareSuppressionAlertsApi(operation:'list'|'get'|'acknowledge'):RequestHandler{
  return api(async({locals,params,url,request})=>{
    const ctx=ownerContext(locals);requireOwner(ctx.actor);await getMailbox(ctx,params.id!);
    const query:Record<string,string>={};
    for(const [key,value] of url.searchParams){
      if(operation!=='list'||!['kind','status','limit','cursor'].includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);
      query[key]=value;
    }
    if(query.limit!==undefined&&(!/^[1-9]\d{0,2}$/.test(query.limit)||Number(query.limit)>100)
      ||query.cursor!==undefined&&(!query.cursor||query.cursor.length>1024))throw new ServiceError('invalid_query',400);
    await refreshSuppressionAlerts(ctx.env);
    if(operation==='list')return Response.json(await listCloudflareSuppressionAlerts(ctx,params.id!,query));
    if(operation==='get')return Response.json(await getCloudflareSuppressionAlert(ctx,params.id!,params.alertId!));
    return Response.json(await acknowledgeCloudflareSuppressionAlert(ctx,params.id!,params.alertId!,await jsonInput(request)));
  });
}
