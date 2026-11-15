import type {RequestHandler} from '@sveltejs/kit';
import {getCloudflareSuppressionHistory,listCloudflareSuppressionHistory,reconcileCloudflareSuppression,retryCloudflareSuppression} from '../core/cloudflare-suppressions';
import {requireOwner} from '../core/owner';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';
import {refreshSuppressionAlerts} from './cloudflare-suppression-alerts-api';

export function cloudflareSuppressionHistoryApi(operation:'list'|'get'|'reconcile'|'retry'):RequestHandler {
  return api(async({locals,params,url,request})=>{
    const ctx=ownerContext(locals);requireOwner(ctx.actor);
    const query:Record<string,string>={},allowed=operation==='list'?['kind','limit','cursor']:operation==='get'?['kind']:[];
    for(const [key,value] of url.searchParams){
      if(!allowed.includes(key)||Object.hasOwn(query,key))throw new ServiceError('invalid_query',400);query[key]=value;
    }
    if(operation==='list'||operation==='get'){
      if(query.kind!==undefined&&!['sync','release'].includes(query.kind)
        ||query.limit!==undefined&&(!/^[1-9]\d{0,2}$/.test(query.limit)||Number(query.limit)>100)
        ||query.cursor!==undefined&&(!query.cursor||query.cursor.length>1024))throw new ServiceError('invalid_query',400);
      const kind=(query.kind??'sync') as 'sync'|'release';
      return Response.json(operation==='list'?await listCloudflareSuppressionHistory(ctx,params.id!,{...query,kind}):
        await getCloudflareSuppressionHistory(ctx,params.id!,params.historyId!,{kind}));
    }
    const input=await jsonInput(request);
    try{
    if(operation==='reconcile')return Response.json(await reconcileCloudflareSuppression(ctx,params.id!,params.historyId!,input));
    const result=await retryCloudflareSuppression(ctx,params.id!,params.historyId!,input);
    const pending='remoteStatus' in result&&['unknown','in_progress'].includes(result.remoteStatus)||'state' in result&&result.state==='running';
    return Response.json(result,{status:pending?202:200});
    }finally{await refreshSuppressionAlerts(ctx.env);}
  });
}
