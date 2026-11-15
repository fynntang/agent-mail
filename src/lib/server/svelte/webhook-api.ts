import type {RequestHandler} from '@sveltejs/kit';
import {createWebhookEndpoint,getWebhookDelivery,listMailEvents,listWebhookDeliveries,listWebhookEndpoints,retryWebhookDelivery,rotateWebhookSecret,updateWebhookEndpoint} from '../core/webhooks';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';
type Operation='endpoints.list'|'endpoints.create'|'endpoint.update'|'endpoint.rotate'|'deliveries.list'|'delivery.get'|'delivery.retry'|'events.list';
export function webhookApi(operation:Operation,owner:boolean):RequestHandler {
  return api(async({locals,params,request,url})=>{
    const ctx=ownerContext(locals);
    if(owner&&ctx.actor?.kind!=='owner')throw new ServiceError('owner_required',403);
    if(!owner&&ctx.actor?.kind!=='token')throw new ServiceError('unauthorized',401);
    const box=owner?params.id!:ctx.actor?.kind==='token'?ctx.actor.mailboxId:'';
    const allowed=operation==='deliveries.list'?['endpointId','limit','cursor']:operation==='events.list'?['limit','cursor']:[];
    const query:Record<string,string>={};
    for(const [key,value] of url.searchParams){if(!allowed.includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);query[key]=value;}
    switch(operation){
      case 'endpoints.list':return Response.json(await listWebhookEndpoints(ctx,box));
      case 'endpoints.create':return Response.json(await createWebhookEndpoint(ctx,box,await jsonInput(request)),{status:201});
      case 'endpoint.update':return Response.json(await updateWebhookEndpoint(ctx,box,params.endpointId!,await jsonInput(request)));
      case 'endpoint.rotate':return Response.json(await rotateWebhookSecret(ctx,box,params.endpointId!,await jsonInput(request)));
      case 'deliveries.list':return Response.json(await listWebhookDeliveries(ctx,box,query));
      case 'delivery.get':return Response.json(await getWebhookDelivery(ctx,box,params.deliveryId!));
      case 'delivery.retry':return Response.json(await retryWebhookDelivery(ctx,box,params.deliveryId!,await jsonInput(request)));
      case 'events.list':return Response.json(await listMailEvents(ctx,box,query));
    }
  });
}
