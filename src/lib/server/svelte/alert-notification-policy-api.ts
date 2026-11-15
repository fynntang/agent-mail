import type {RequestHandler} from '@sveltejs/kit';
import {getAlertNotificationPolicy,updateAlertNotificationPolicy} from '../core/alert-notification-policy';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

export function alertNotificationPolicyApi(operation:'get'|'update'):RequestHandler{
  return api(async({locals,params,url,request})=>{
    if(url.search)throw new ServiceError('invalid_query',400);
    const ctx=ownerContext(locals);
    return Response.json(operation==='get'?await getAlertNotificationPolicy(ctx,params.id!):
      await updateAlertNotificationPolicy(ctx,params.id!,await jsonInput(request)));
  });
}
