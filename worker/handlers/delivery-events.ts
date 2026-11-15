import {ingestDeliveryEvent,deliveryEventsConfigured} from '../../src/lib/server/core/delivery-events';
import {readBounded} from '../../src/lib/server/core/storage';
import {ServiceError,type RuntimeEnv} from '../../src/lib/server/core/types';

/** Native Queues invocations are authenticated by Cloudflare, not by an HTTP payload signature. */
export async function handleDeliveryQueue(batch:MessageBatch<unknown>,env:RuntimeEnv):Promise<void>{
  if(!deliveryEventsConfigured(env)||batch.queue!==env.EMAIL_EVENT_QUEUE){
    console.warn(JSON.stringify({event:'email_delivery_queue_rejected',code:'queue_configuration_mismatch'}));
    batch.retryAll({delaySeconds:60});return;
  }
  for(const message of batch.messages){
    try{
      const result=await ingestDeliveryEvent(env,message.body);
      if(result.outcome==='conflict')console.warn(JSON.stringify({event:'email_delivery_event_rejected',code:'event_id_conflict'}));
      message.ack();
    }catch(error){
      if(error instanceof ServiceError&&error.status>=400&&error.status<500){
        console.warn(JSON.stringify({event:'email_delivery_event_rejected',code:error.code}));message.ack();
      }else{
        console.warn(JSON.stringify({event:'email_delivery_event_retry',code:'storage_unavailable'}));message.retry({delaySeconds:60});
      }
    }
  }
}

const encoder=new TextEncoder();
export async function verifyDeliveryBridgeSignature(secret:string,timestamp:string,signature:string,body:Uint8Array,now=Date.now()):Promise<boolean>{
  if(!/^\d{10,11}$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300||!/^v1=[0-9a-f]{64}$/.test(signature))return false;
  const prefix=encoder.encode(`${timestamp}.`),signed=new Uint8Array(prefix.length+body.length);signed.set(prefix);signed.set(body,prefix.length);
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=Uint8Array.from(signature.slice(3).match(/../g)!,hex=>parseInt(hex,16));
  return crypto.subtle.verify('HMAC',key,bytes,signed);
}

/** Optional self-hosted forwarding protocol. This is NOT an official Cloudflare HTTP callback protocol. */
export async function handleDeliveryBridge(request:Request,env:RuntimeEnv):Promise<Response|null>{
  const url=new URL(request.url);
  if(url.pathname!=='/callbacks/cloudflare-email')return null;
  const response=(status:number,value:unknown,headers:Record<string,string>={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store',...headers}});
  const secret=env.EMAIL_EVENT_BRIDGE_SECRET,secretLength=secret?encoder.encode(secret).length:0;
  if(!deliveryEventsConfigured(env)||secretLength<32||secretLength>256)return response(404,{error:'not_found'});
  if(request.method!=='POST')return response(405,{error:'method_not_allowed'},{Allow:'POST'});
  if(url.search)return response(400,{error:'invalid_query'});
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return response(415,{error:'unsupported_media_type'});
  const declared=request.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>65_536))return response(413,{error:'message_too_large'});
  try{
    const body=request.body?await readBounded(request.body,65_536):new Uint8Array();
    if(!await verifyDeliveryBridgeSignature(secret!,request.headers.get('X-Agent-Mail-Timestamp')??'',request.headers.get('X-Agent-Mail-Signature')??'',body))return response(401,{error:'invalid_signature'});
    let event:unknown;
    try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(body));}catch{return response(400,{error:'invalid_event'});}
    const result=await ingestDeliveryEvent(env,event);
    if(result.outcome==='conflict')return response(409,{error:'event_id_conflict'});
    return response(200,{ok:true,outcome:result.outcome});
  }catch(error){
    if(error instanceof ServiceError)return response(error.status,{error:error.code});
    return response(503,{error:'temporarily_unavailable'});
  }
}
