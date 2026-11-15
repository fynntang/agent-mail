import type {RequestHandler} from '@sveltejs/kit';
import {listCloudflareSuppressions,releaseCloudflareSuppression,syncCloudflareSuppressions} from '../core/cloudflare-suppressions';
import {objectInput} from '../core/outbound-content';
import {requireOwner} from '../core/owner';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';
import {refreshSuppressionAlerts} from './cloudflare-suppression-alerts-api';

export function cloudflareSuppressionsApi(operation:'list'|'sync'|'release'):RequestHandler {
  return api(async({locals,params,url,request})=>{
    const ctx=ownerContext(locals);requireOwner(ctx.actor);
    const query:Record<string,string>={};
    for(const [key,value] of url.searchParams){
      if(operation!=='list'||!['limit','cursor'].includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);
      query[key]=value;
    }
    if(operation==='list'){
      if(query.limit!==undefined&&(!/^[1-9]\d{0,2}$/.test(query.limit)||Number(query.limit)>100)
        ||query.cursor!==undefined&&(!query.cursor||query.cursor.length>1024))throw new ServiceError('invalid_query',400);
      return Response.json(await listCloudflareSuppressions(ctx,params.id!,query));
    }
    const body=await jsonInput(request);
    try{
    if(operation==='sync'){
      objectInput(body,['clientRequestId']);const result=await syncCloudflareSuppressions(ctx,params.id!,{},body);
      return Response.json(result,{status:result.state==='running'?202:200});
    }
    const result=await releaseCloudflareSuppression(ctx,params.id!,params.remoteId!,body);
    return Response.json(result,{status:['unknown','in_progress'].includes(result.remoteStatus)?202:200});
    }finally{await refreshSuppressionAlerts(ctx.env);}
  });
}
