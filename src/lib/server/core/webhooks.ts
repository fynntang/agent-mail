import type {MailEvent,WebhookEndpoint,WebhookDelivery,WebhookAttempt,WebhookEventType} from '../../types/webhooks';
import {requireRead} from './auth';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {objectInput} from './outbound-content';
import {decryptWebhookSecret,encryptWebhookSecret,newWebhookSecret,validateWebhookUrl,webhookConfigured} from './webhook-crypto';
import {ServiceError} from './types';
import {safeAlertErrorCode} from './cloudflare-suppression-alerts';
import {ASYNC_ALERT_NOTIFICATION_EXPORT_ERRORS} from './async-alert-notification-exports';
import {isRetryBatchNotification,RETRY_BATCH_NOTIFICATION_TYPES} from './retry-batch-notification-admission';

export const WEBHOOK_EVENT_TYPES:WebhookEventType[]=['message.received','outbound.accepted','outbound.failed','outbound.unknown',
  'outbound.delivered','outbound.deferred','outbound.bounced','outbound.rejected','outbound.complained',
  'cloudflare.suppression.alert.created','cloudflare.suppression.alert.resolved','alert_notification.export.succeeded','alert_notification.export.failed',...RETRY_BATCH_NOTIFICATION_TYPES];
const OWNER_EVENT_TYPES=['cloudflare.suppression.alert.created','cloudflare.suppression.alert.resolved','alert_notification.export.succeeded','alert_notification.export.failed',...RETRY_BATCH_NOTIFICATION_TYPES];
const ownerEventSql=OWNER_EVENT_TYPES.map(type=>`'${type}'`).join(',');
const mailEventTypes=WEBHOOK_EVENT_TYPES.filter(type=>!OWNER_EVENT_TYPES.includes(type));
const ownerEvent=(type:string)=>OWNER_EVENT_TYPES.includes(type);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface WebhookEventRow {id:string;mailbox_id:string;source:string;type:string;payload_json:string;occurred_at:number;created_at:number;webhook_published_at?:number|null}
interface EndpointRow {id:string;mailbox_id:string;url:string;event_types_json:string;signing_secret_ciphertext:string;secret_version:number;status:WebhookEndpoint['status'];created_at:number;updated_at:number}
interface DeliveryRow {id:string;mailbox_id:string;endpoint_id:string;event_id:string;payload_json:string;state:WebhookDelivery['state'];attempts:number;attempt_budget:number;available_at:number;last_http_status:number|null;last_error_code:string|null;signed_secret_version:number;created_at:number;updated_at:number;completed_at:number|null;signing_secret_ciphertext:string}

export function webhookEventDto(row:WebhookEventRow):MailEvent|null {
  if(!['app','cloudflare'].includes(row.source)||!WEBHOOK_EVENT_TYPES.includes(row.type as WebhookEventType)
    ||row.source==='cloudflare'&&['message.received','outbound.accepted','outbound.unknown'].includes(row.type)||!uuid.test(row.id)||!uuid.test(row.mailbox_id)
    ||!Number.isSafeInteger(row.occurred_at)||row.occurred_at<0||row.payload_json.length>8192)return null;
  try{
    const payload=JSON.parse(row.payload_json);
    if(isRetryBatchNotification(row.type)){
      const kind=row.type.slice('alert_notification.retry_batch.'.length),bounded=(value:unknown,max=1000)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=max;
      if(row.source!=='app'||typeof payload?.notificationId!=='string'||!uuid.test(payload.notificationId)||typeof payload.batchId!=='string'||!uuid.test(payload.batchId)
        ||payload.kind!==kind||!['preview','queued','running','completed','expired','cancelled'].includes(payload.batchState)
        ||!Number.isSafeInteger(payload.sourceVersion)||payload.sourceVersion<1
        ||!bounded(payload.totalItems)||!bounded(payload.eligibleItems,payload.totalItems)||!bounded(payload.processedItems,payload.totalItems)
        ||!bounded(payload.requeuedItems)||!bounded(payload.skippedItems)||!bounded(payload.failedItems)||!bounded(payload.unknownItems)
        ||payload.processedItems!==payload.requeuedItems+payload.skippedItems+payload.failedItems+payload.unknownItems
        ||!bounded(payload.occurredAt,Number.MAX_SAFE_INTEGER)||payload.occurredAt!==row.occurred_at||row.created_at!==row.occurred_at
        ||kind==='completed'&&(payload.reason!=='completed'||payload.batchState!=='completed'||payload.processedItems!==payload.totalItems||payload.unknownItems!==0)
        ||kind==='failed'&&(!['execution_failed','expired'].includes(payload.reason)||payload.reason==='execution_failed'&&payload.failedItems===0||payload.reason==='expired'&&payload.batchState!=='expired')
        ||kind==='needs_reconciliation'&&(payload.reason!=='unknown_results'||payload.unknownItems===0))return null;
      return {id:row.id,mailboxId:row.mailbox_id,type:row.type as WebhookEventType,occurredAt:row.occurred_at,data:{notificationId:payload.notificationId,batchId:payload.batchId,kind:payload.kind,reason:payload.reason,
        batchState:payload.batchState,sourceVersion:payload.sourceVersion,totalItems:payload.totalItems,eligibleItems:payload.eligibleItems,processedItems:payload.processedItems,
        requeuedItems:payload.requeuedItems,skippedItems:payload.skippedItems,failedItems:payload.failedItems,unknownItems:payload.unknownItems,occurredAt:payload.occurredAt}};
    }
    if(row.type==='alert_notification.export.succeeded'||row.type==='alert_notification.export.failed'){
      const state=row.type.endsWith('.succeeded')?'succeeded':'failed',bounded=(value:unknown,max:number)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=max;
      if(row.source!=='app'||typeof payload?.jobId!=='string'||!uuid.test(payload.jobId)||!['csv','json'].includes(payload.format)||payload.state!==state
        ||!bounded(payload.totalDecisions,100000)||!bounded(payload.processedDecisions,payload.totalDecisions)||!bounded(payload.processedDeliveries,1000000)
        ||!bounded(payload.bodyBytes,256*1024*1024)||!bounded(payload.completedAt,Number.MAX_SAFE_INTEGER)||!bounded(payload.expiresAt,Number.MAX_SAFE_INTEGER)
        ||payload.expiresAt<=payload.completedAt||payload.completedAt!==row.occurred_at||state==='succeeded'&&payload.processedDecisions!==payload.totalDecisions)return null;
      const errorCode=typeof payload.errorCode==='string'&&(ASYNC_ALERT_NOTIFICATION_EXPORT_ERRORS as readonly string[]).includes(payload.errorCode)?payload.errorCode:null;
      return {id:row.id,mailboxId:row.mailbox_id,type:row.type,occurredAt:row.occurred_at,data:{jobId:payload.jobId,format:payload.format,state,
        totalDecisions:payload.totalDecisions,processedDecisions:payload.processedDecisions,processedDeliveries:payload.processedDeliveries,
        bodyBytes:payload.bodyBytes,completedAt:payload.completedAt,expiresAt:payload.expiresAt,...(state==='failed'&&errorCode?{errorCode}:{})}};
    }
    if(ownerEvent(row.type)){
      const resolved=row.type==='cloudflare.suppression.alert.resolved';
      if(row.source!=='app'||typeof payload?.alertId!=='string'||!uuid.test(payload.alertId)
        ||!['sync','release'].includes(payload.kind)||payload.status!==(resolved?'resolved':'open')
        ||!(resolved?payload.outcome==='resolved':['failed','unknown'].includes(payload.outcome)))return null;
      const errorCode=safeAlertErrorCode(payload.errorCode);
      return {id:row.id,mailboxId:row.mailbox_id,type:row.type as WebhookEventType,occurredAt:row.occurred_at,
        data:{alertId:payload.alertId,kind:payload.kind,status:payload.status,outcome:payload.outcome,...(!resolved&&errorCode?{errorCode}:{})}};
    }
    const id=row.type==='message.received'?payload.messageId:payload.outboundId;
    if(typeof id!=='string'||!uuid.test(id))return null;
    return {id:row.id,mailboxId:row.mailbox_id,type:row.type as WebhookEventType,occurredAt:row.occurred_at,
      data:row.type==='message.received'?{messageId:id}:{outboundId:id,status:row.type.slice(9)}};
  }catch{return null;}
}
export function webhookPayload(row:WebhookEventRow):string|null {
  const event=webhookEventDto(row);return event?JSON.stringify({v:1,...event}):null;
}
async function authorize(ctx:OwnerContext,box:string,write=false):Promise<void>{
  if(!uuid.test(box))throw new ServiceError('not_found',404);
  if(ctx.actor?.kind==='owner'){
    const mailbox=await getMailbox(ctx,box);if(write&&mailbox.status!=='active')throw new ServiceError('mailbox_inactive',409);return;
  }
  const actor=requireRead(ctx.actor);
  if(actor.mailboxId!==box)throw new ServiceError('not_found',404);
  const row=await ctx.env.DB.prepare(`SELECT t.can_read,t.revoked_at,t.expires_at,m.status FROM mailbox_tokens t JOIN mailboxes m ON m.id=t.mailbox_id WHERE t.id=? AND t.mailbox_id=?`)
    .bind(actor.tokenId,box).first<{can_read:number;revoked_at:number|null;expires_at:number|null;status:string}>();
  if(!row||row.revoked_at!==null||row.expires_at!==null&&row.expires_at<=Date.now()||row.status!=='active')throw new ServiceError('unauthorized',401);
  if(row.can_read!==1)throw new ServiceError('insufficient_scope',403);
  if(write)throw new ServiceError('owner_required',403);
}
function endpointDto(row:EndpointRow,owner:boolean):WebhookEndpoint{
  const types:WebhookEventType[]=JSON.parse(row.event_types_json);
  return {id:row.id,mailboxId:row.mailbox_id,url:owner?row.url:null,eventTypes:owner?types:types.filter(type=>!ownerEvent(type)),status:row.status,
    secretVersion:row.secret_version,createdAt:row.created_at,updatedAt:row.updated_at};
}
function deliveryDto(row:DeliveryRow):WebhookDelivery{
  const parsed=JSON.parse(row.payload_json);
  return {id:row.id,mailboxId:row.mailbox_id,endpointId:row.endpoint_id,eventId:row.event_id,eventType:WEBHOOK_EVENT_TYPES.includes(parsed.type)?parsed.type:'unknown',
    state:row.state,attempts:row.attempts,attemptBudget:row.attempt_budget,availableAt:row.available_at,lastHttpStatus:row.last_http_status,
    lastErrorCode:row.last_error_code,secretVersion:row.signed_secret_version,createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at};
}
function eventTypes(value:unknown):WebhookEventType[]{
  if(!Array.isArray(value)||value.length<1||value.length>WEBHOOK_EVENT_TYPES.length||new Set(value).size!==value.length
    ||value.some(type=>!WEBHOOK_EVENT_TYPES.includes(type as WebhookEventType)))throw new ServiceError('invalid_event_types',400);
  return WEBHOOK_EVENT_TYPES.filter(type=>value.includes(type));
}
function expected(value:unknown):asserts value is number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new ServiceError('invalid_input',400);}
function configured(ctx:OwnerContext):void{if(!webhookConfigured(ctx.env))throw new ServiceError('webhooks_not_configured',503);}
async function endpoint(ctx:OwnerContext,box:string,id:string):Promise<EndpointRow>{
  if(!uuid.test(id))throw new ServiceError('not_found',404);
  const row=await ctx.env.DB.prepare('SELECT * FROM webhook_endpoints WHERE mailbox_id=? AND id=?').bind(box,id).first<EndpointRow>();
  if(!row)throw new ServiceError('not_found',404);return row;
}
function audit(ctx:OwnerContext,box:string,action:string,id:string,mutation:string,guard:string,args:(string|number)[]):D1PreparedStatement{
  return ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at)
    SELECT ?,?,'owner',?,?,'success',?,? WHERE ${guard}`).bind(mutation,box,action,id,ctx.requestId,Date.now(),...args);
}
export async function listWebhookEndpoints(ctx:OwnerContext,box:string){
  await authorize(ctx,box);
  const {results}=await ctx.env.DB.prepare('SELECT * FROM webhook_endpoints WHERE mailbox_id=? ORDER BY created_at DESC,id DESC LIMIT 100').bind(box).all<EndpointRow>();
  return {endpoints:results.map(row=>endpointDto(row,ctx.actor?.kind==='owner')),configured:webhookConfigured(ctx.env),eventTypes:ctx.actor?.kind==='owner'?WEBHOOK_EVENT_TYPES:mailEventTypes};
}
export async function createWebhookEndpoint(ctx:OwnerContext,box:string,input:unknown){
  requireOwner(ctx.actor);await authorize(ctx,box,true);configured(ctx);
  const data=objectInput(input,['url','eventTypes']),url=validateWebhookUrl(ctx.env,data.url),types=eventTypes(data.eventTypes);
  const id=crypto.randomUUID(),secret=newWebhookSecret(),cipher=await encryptWebhookSecret(ctx.env,box,id,1,secret),now=Date.now(),mutation=crypto.randomUUID();
  const result=await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO webhook_endpoints(id,mailbox_id,url,event_types_json,signing_secret_ciphertext,created_at,updated_at,event_after_rowid)
      SELECT ?,?,?,?,?,?,?,COALESCE((SELECT MAX(rowid) FROM events WHERE mailbox_id=?),0) WHERE EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status='active')
      AND (SELECT count(*) FROM webhook_endpoints WHERE mailbox_id=? AND status<>'disabled')<10
      AND (SELECT count(*) FROM webhook_endpoints WHERE mailbox_id=?)<100`).bind(id,box,url,JSON.stringify(types),cipher,now,now,box,box,box,box),
    audit(ctx,box,'webhook.created',id,mutation,'EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=? AND mailbox_id=?)',[id,box])
  ]);
  if(result[0].meta.changes!==1)throw new ServiceError('webhook_endpoint_limit',409);
  return {endpoint:endpointDto(await endpoint(ctx,box,id),true),secret};
}
export async function updateWebhookEndpoint(ctx:OwnerContext,box:string,id:string,input:unknown){
  requireOwner(ctx.actor);await authorize(ctx,box);
  const data=objectInput(input,['expectedUpdatedAt','eventTypes','status']);expected(data.expectedUpdatedAt);
  const old=await endpoint(ctx,box,id);
  if(old.updated_at!==data.expectedUpdatedAt)throw new ServiceError('webhook_changed',409);
  if(data.status!==undefined&&!['active','paused','disabled'].includes(data.status as string)||old.status==='disabled')throw new ServiceError('webhook_disabled',409);
  const status=(data.status??old.status) as WebhookEndpoint['status'],types=data.eventTypes===undefined?JSON.parse(old.event_types_json):eventTypes(data.eventTypes);
  if(status==='active'){await authorize(ctx,box,true);configured(ctx);}
  const now=Math.max(Date.now(),old.updated_at+1),mutation=crypto.randomUUID(),owned='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  const batch=[audit(ctx,box,'webhook.updated',id,mutation,
    `EXISTS(SELECT 1 FROM webhook_endpoints w JOIN mailboxes m ON m.id=w.mailbox_id WHERE w.id=? AND w.mailbox_id=? AND w.updated_at=? AND w.status<>'disabled' AND m.status IN('active','paused')${status==='active'?" AND m.status='active'":''})`,[id,box,old.updated_at]),
    ctx.env.DB.prepare(`UPDATE webhook_endpoints SET status=?,event_types_json=?,updated_at=?,event_after_rowid=CASE WHEN ? THEN
      COALESCE((SELECT MAX(rowid) FROM events WHERE mailbox_id=?),0) ELSE event_after_rowid END WHERE mailbox_id=? AND id=? AND ${owned}`)
      .bind(status,JSON.stringify(types),now,data.eventTypes!==undefined||old.status!=='active'&&status==='active'?1:0,box,box,id,mutation)];
  if(status!=='active')batch.push(
    ctx.env.DB.prepare(`UPDATE webhook_delivery_attempts SET outcome='cancelled',error_code='endpoint_inactive',finished_at=MAX(started_at,?) WHERE mailbox_id=? AND outcome='started'
      AND delivery_id IN(SELECT id FROM webhook_deliveries WHERE endpoint_id=? AND mailbox_id=? AND state='running') AND ${owned}`).bind(now,box,id,box,mutation),
    ctx.env.DB.prepare(`UPDATE webhook_deliveries SET state='cancelled',lease_token=NULL,lease_until=NULL,last_error_code='endpoint_inactive',completed_at=?,updated_at=MAX(updated_at,?)
      WHERE mailbox_id=? AND endpoint_id=? AND state IN('pending','running') AND ${owned}`).bind(now,now,box,id,mutation));
  const result=await ctx.env.DB.batch(batch);if(result[1].meta.changes!==1)throw new ServiceError('webhook_changed',409);
  return {endpoint:endpointDto(await endpoint(ctx,box,id),true)};
}
export async function rotateWebhookSecret(ctx:OwnerContext,box:string,id:string,input:unknown){
  requireOwner(ctx.actor);await authorize(ctx,box,true);configured(ctx);
  const data=objectInput(input,['expectedUpdatedAt']);expected(data.expectedUpdatedAt);const old=await endpoint(ctx,box,id);
  if(old.status==='disabled')throw new ServiceError('webhook_disabled',409);
  if(old.updated_at!==data.expectedUpdatedAt)throw new ServiceError('webhook_changed',409);
  const version=old.secret_version+1,secret=newWebhookSecret(),cipher=await encryptWebhookSecret(ctx.env,box,id,version,secret),mutation=crypto.randomUUID(),now=Math.max(Date.now(),old.updated_at+1);
  const results=await ctx.env.DB.batch([
    audit(ctx,box,'webhook.secret_rotated',id,mutation,"EXISTS(SELECT 1 FROM webhook_endpoints w JOIN mailboxes m ON m.id=w.mailbox_id WHERE w.id=? AND w.mailbox_id=? AND w.updated_at=? AND w.status<>'disabled' AND m.status='active')",[id,box,old.updated_at]),
    ctx.env.DB.prepare(`UPDATE webhook_endpoints SET signing_secret_ciphertext=?,secret_version=?,updated_at=? WHERE id=? AND mailbox_id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`).bind(cipher,version,now,id,box,mutation)
  ]);
  if(results[1].meta.changes!==1)throw new ServiceError('webhook_changed',409);
  return {endpoint:endpointDto(await endpoint(ctx,box,id),true),secret};
}
type PageQuery={limit?:unknown;cursor?:unknown;endpointId?:unknown};
function page(query:PageQuery,box:string,kind:string):{limit:number;after:{time:number;id:string}|null;filter:string|null}{
  const limit=query.limit===undefined?20:Number(query.limit),filter=query.endpointId??null;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||filter!==null&&(typeof filter!=='string'||!uuid.test(filter)))throw new ServiceError('invalid_query',400);
  let after:null|{time:number;id:string}=null;
  if(query.cursor!==undefined){
    try{
      if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw new Error();
      const data=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));
      if(data.v!==1||data.box!==box||data.kind!==kind||data.filter!==filter||!Number.isSafeInteger(data.time)||data.time<0||typeof data.id!=='string'||!uuid.test(data.id))throw new Error();
      after={time:data.time,id:data.id};
    }catch{throw new ServiceError('invalid_cursor',400);}
  }
  return {limit,after,filter:filter as string|null};
}
function cursor(box:string,kind:string,filter:string|null,row:{created_at:number;id:string}):string{
  return btoa(JSON.stringify({v:1,box,kind,filter,time:row.created_at,id:row.id})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export async function listMailEvents(ctx:OwnerContext,box:string,query:PageQuery={}){
  await authorize(ctx,box);const p=page(query,box,'events'),types=ctx.actor?.kind==='owner'?WEBHOOK_EVENT_TYPES:mailEventTypes,args:(string|number)[]=[box,...types];
  if(p.after)args.push(p.after.time,p.after.time,p.after.id);args.push(p.limit+1);
  const {results}=await ctx.env.DB.prepare(`SELECT * FROM events WHERE mailbox_id=? AND source IN('app','cloudflare') AND type IN(${types.map(()=>'?').join(',')})
    ${p.after?'AND (created_at<? OR (created_at=? AND id<?))':''} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(...args).all<WebhookEventRow>();
  const rows=results.slice(0,p.limit);return {events:rows.flatMap(row=>{const dto=webhookEventDto(row);return dto?[dto]:[];}),nextCursor:results.length>p.limit?cursor(box,'events',null,rows.at(-1)!):null};
}
export async function listWebhookDeliveries(ctx:OwnerContext,box:string,query:PageQuery={}){
  await authorize(ctx,box);const p=page(query,box,'deliveries'),args:(string|number)[]=[box];
  if(p.filter){await endpoint(ctx,box,p.filter);args.push(p.filter);}if(p.after)args.push(p.after.time,p.after.time,p.after.id);args.push(p.limit+1);
  const {results}=await ctx.env.DB.prepare(`SELECT d.* FROM webhook_deliveries d WHERE d.mailbox_id=? ${p.filter?'AND d.endpoint_id=?':''}
    ${ctx.actor?.kind==='owner'?'':`AND COALESCE(json_extract(d.payload_json,'$.type'),'') NOT IN(${ownerEventSql})
      AND NOT EXISTS(SELECT 1 FROM events e WHERE e.id=d.event_id AND e.mailbox_id=d.mailbox_id AND e.type IN(${ownerEventSql}))`}
    ${p.after?'AND (d.created_at<? OR (d.created_at=? AND d.id<?))':''} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`).bind(...args).all<DeliveryRow>();
  const rows=results.slice(0,p.limit);return {deliveries:rows.map(deliveryDto),nextCursor:results.length>p.limit?cursor(box,'deliveries',p.filter,rows.at(-1)!):null};
}
async function delivery(ctx:OwnerContext,box:string,id:string):Promise<DeliveryRow>{
  if(!uuid.test(id))throw new ServiceError('not_found',404);
  const row=await ctx.env.DB.prepare('SELECT * FROM webhook_deliveries WHERE mailbox_id=? AND id=?').bind(box,id).first<DeliveryRow>();
  if(!row)throw new ServiceError('not_found',404);return row;
}
export async function getWebhookDelivery(ctx:OwnerContext,box:string,id:string){
  await authorize(ctx,box);const row=await delivery(ctx,box,id);
  if(ctx.actor?.kind!=='owner'){
    const actual=await ctx.env.DB.prepare('SELECT type FROM events WHERE mailbox_id=? AND id=?').bind(box,row.event_id).first<string>('type');
    if(ownerEvent(JSON.parse(row.payload_json).type)||actual&&ownerEvent(actual))throw new ServiceError('not_found',404);
  }
  const {results}=await ctx.env.DB.prepare(`SELECT id,attempt_no attemptNo,outcome,http_status httpStatus,error_code errorCode,started_at startedAt,finished_at finishedAt FROM webhook_delivery_attempts
    WHERE mailbox_id=? AND delivery_id=? ORDER BY attempt_no DESC LIMIT 80`).bind(box,id).all<WebhookAttempt>();
  return {delivery:deliveryDto(row),attempts:results};
}
export async function retryWebhookDelivery(ctx:OwnerContext,box:string,id:string,input:unknown){
  requireOwner(ctx.actor);await authorize(ctx,box);
  const row=await delivery(ctx,box,id);
  const receipt=await ctx.env.DB.prepare('SELECT job_id FROM async_export_notifications WHERE mailbox_id=? AND event_id=?').bind(box,row.event_id).first<{job_id:string}>();
  let declaredType:unknown;try{declaredType=JSON.parse(row.payload_json)?.type;}catch{/* Invalid snapshots cannot opt out of export receipt authorization. */}
  const batchReceipt=await ctx.env.DB.prepare(`SELECT e.type,n.id notification_id FROM events e LEFT JOIN async_export_retry_batch_notifications n ON n.mailbox_id=e.mailbox_id AND n.event_id=e.id
    WHERE e.mailbox_id=? AND e.id=?`).bind(box,row.event_id).first<{type:string;notification_id:string|null}>();
  // Batch notices use the existing automatic transport budget. A generic manual retry must not bypass their immutable admission.
  if(batchReceipt?.notification_id||isRetryBatchNotification(batchReceipt?.type??'')||isRetryBatchNotification(String(declaredType)))throw new ServiceError('webhook_retry_unavailable',409);
  if(receipt||['alert_notification.export.succeeded','alert_notification.export.failed'].includes(String(declaredType))){
    if(!receipt)throw new ServiceError('not_found',404);
    const {retryAsyncExportNotificationDelivery}=await import('./async-export-notification-retry');
    return retryAsyncExportNotificationDelivery(ctx,box,receipt.job_id,id,input);
  }
  await authorize(ctx,box,true);configured(ctx);objectInput(input,[]);
  const target=await endpoint(ctx,box,row.endpoint_id);
  if(row.state!=='dead'||target.status!=='active'||row.attempt_budget>=80)throw new ServiceError('webhook_retry_unavailable',409);
  await decryptWebhookSecret(ctx.env,box,row.endpoint_id,row.signed_secret_version,row.signing_secret_ciphertext);
  const now=Math.max(Date.now(),row.updated_at+1),mutation=crypto.randomUUID();
  const results=await ctx.env.DB.batch([
    audit(ctx,box,'webhook.delivery_retried',id,mutation,`EXISTS(SELECT 1 FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id=d.endpoint_id AND w.mailbox_id=d.mailbox_id
      JOIN mailboxes m ON m.id=d.mailbox_id WHERE d.id=? AND d.mailbox_id=? AND d.state='dead' AND d.updated_at=? AND d.attempt_budget<80 AND w.status='active' AND m.status='active')`,[id,box,row.updated_at]),
    ctx.env.DB.prepare(`UPDATE webhook_deliveries SET state='pending',attempt_budget=MIN(80,attempt_budget+8),available_at=?,last_error_code=NULL,completed_at=NULL,updated_at=?
      WHERE id=? AND mailbox_id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`).bind(now,now,id,box,mutation)
  ]);
  if(results[1].meta.changes!==1)throw new ServiceError('webhook_changed',409);return {delivery:deliveryDto(await delivery(ctx,box,id))};
}
