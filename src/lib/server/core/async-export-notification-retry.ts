import type {AlertNotificationPolicy} from '../../types/alert-notification-policy';
import type {AsyncExportDeliveryRetryBlockReason,AsyncExportManualRetry,AsyncExportNotificationDeliveryRetryResult} from '../../types/async-export-notification-deliveries';
import type {WebhookDelivery} from '../../types/webhooks';
import {alertNotificationQuiet,loadAlertNotificationPolicy} from './alert-notification-admission';
import {isAsyncExportNotification} from './async-export-notification-admission';
import {asyncExportNotificationFrozenPayloadValid} from './async-export-notification-delivery-shared';
import type {AsyncExportNotificationRow} from './async-export-notifications';
import {stableId} from './crypto';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {objectInput} from './outbound-content';
import {ServiceError,type RuntimeEnv} from './types';
import {decryptWebhookSecret,validateWebhookUrl,webhookConfigured} from './webhook-crypto';
import type {WebhookEventRow} from './webhooks';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const deliveryErrors=new Set(['lease_expired','lease_lost','invalid_target','payload_unavailable','signing_key_unavailable','mailbox_inactive','endpoint_inactive',
  'http_retry','http_rejected','delivery_timeout','network_error','alert_notifications_disabled','alert_recovery_disabled','alert_quiet_hours','legacy_snapshot_unavailable']);
export interface AsyncExportNotificationRetryEligibilityInput{
  mailboxStatus:string;endpointStatus:string;notificationDecision:string|null;deliveryState:string;attemptBudget:number;
  payloadValid:boolean;secretAvailable:boolean;targetValid:boolean;
}
/** A read-only capability hint. POST repeats the checks and decrypts the frozen key before committing. */
export function asyncExportNotificationRetryEligibility(env:RuntimeEnv,input:AsyncExportNotificationRetryEligibilityInput,policy:AlertNotificationPolicy,at:number):{available:boolean;reason:AsyncExportDeliveryRetryBlockReason|null}{
  let reason:AsyncExportDeliveryRetryBlockReason|null=null;
  if(input.notificationDecision!=='allowed')reason='not_admitted';
  else if(input.deliveryState!=='dead')reason='not_dead';
  else if(input.mailboxStatus!=='active')reason='mailbox_inactive';
  else if(input.endpointStatus!=='active')reason='endpoint_inactive';
  else if(input.attemptBudget>=80)reason='budget_exhausted';
  else if(!policy.enabled)reason='notifications_disabled';
  else if(alertNotificationQuiet(policy,at))reason='quiet_hours';
  else if(!webhookConfigured(env))reason='not_configured';
  else if(!input.payloadValid)reason='payload_unavailable';
  else if(!input.targetValid)reason='invalid_target';
  else if(!input.secretAvailable)reason='signing_key_unavailable';
  return {available:reason===null,reason};
}
export function asyncExportNotificationTargetValid(env:RuntimeEnv,url:string):boolean{try{validateWebhookUrl(env,url);return true;}catch{return false;}}
/** Check only public envelope structure and a present wrapping-key ID. No AES operation occurs on GET. */
export function asyncExportNotificationSecretAvailable(env:RuntimeEnv,ciphertext:string):boolean{
  try{
    if(!webhookConfigured(env)||ciphertext.length>1024)return false;
    const ring=JSON.parse(env.WEBHOOK_KEYRING!),value=JSON.parse(ciphertext);
    return Boolean(value&&value.v===1&&Object.keys(value).sort().join(',')==='data,iv,kid,v'&&typeof value.kid==='string'&&Object.hasOwn(ring.keys,value.kid)
      &&typeof value.iv==='string'&&/^[A-Za-z0-9_-]{16}$/.test(value.iv)&&typeof value.data==='string'&&/^[A-Za-z0-9_-]+$/.test(value.data)&&value.data.length>=22&&value.data.length<=256);
  }catch{return false;}
}
export interface AsyncExportRetryDeliveryRow{
  id:string;mailbox_id:string;endpoint_id:string;event_id:string;state:WebhookDelivery['state'];attempts:number;attempt_budget:number;available_at:number;
  signed_secret_version:number;signing_secret_ciphertext:string;url_snapshot:string;payload_json:string;last_http_status:number|null;last_error_code:string|null;
  created_at:number;updated_at:number;completed_at:number|null;mailbox_status:string;endpoint_status:string;notification_decision:string|null;job_id:string;
}
export function asyncExportRetryDeliveryDto(row:AsyncExportRetryDeliveryRow):WebhookDelivery{
  const type=JSON.parse(row.payload_json)?.type;
  return {id:row.id,mailboxId:row.mailbox_id,endpointId:row.endpoint_id,eventId:row.event_id,eventType:isAsyncExportNotification(type)?type:'unknown',
    state:row.state,attempts:row.attempts,attemptBudget:row.attempt_budget,availableAt:row.available_at,lastHttpStatus:row.last_http_status,
    lastErrorCode:row.last_error_code&&deliveryErrors.has(row.last_error_code)?row.last_error_code:null,secretVersion:row.signed_secret_version,
    createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at};
}
interface RetryAuditRow{id:string;mailbox_id:string;action:string;resource_id:string;metadata_json:string;occurred_at:number}
async function delivery(ctx:OwnerContext,box:string,job:string,id:string):Promise<AsyncExportRetryDeliveryRow>{
  const row=await ctx.env.DB.prepare(`SELECT d.*,m.status mailbox_status,w.status endpoint_status,n.notification_decision,n.job_id
    FROM async_export_notifications n JOIN webhook_deliveries d ON d.mailbox_id=n.mailbox_id AND d.event_id=n.event_id
    JOIN webhook_endpoints w ON w.id=d.endpoint_id AND w.mailbox_id=d.mailbox_id JOIN mailboxes m ON m.id=d.mailbox_id
    WHERE n.job_id=? AND n.mailbox_id=? AND d.id=?`).bind(job,box,id).first<AsyncExportRetryDeliveryRow>();
  if(!row)throw new ServiceError('not_found',404);return row;
}
function receipt(row:RetryAuditRow|null,box:string,job:string,id:string,clientRequestId:string,expectedUpdatedAt:number):AsyncExportManualRetry|null{
  if(!row)return null;
  try{
    const data=JSON.parse(row.metadata_json);
    if(row.mailbox_id!==box||row.resource_id!==id||row.action!=='webhook.delivery_retried'||data.jobId!==job||data.clientRequestId!==clientRequestId
      ||data.expectedUpdatedAt!==expectedUpdatedAt||!Number.isSafeInteger(data.previousAttemptBudget)||data.previousAttemptBudget<8||data.previousAttemptBudget>=80
      ||data.attemptBudget!==Math.min(80,data.previousAttemptBudget+8))throw Error();
    return {id:row.id,clientRequestId,requestedAt:row.occurred_at,expectedUpdatedAt,previousAttemptBudget:data.previousAttemptBudget,attemptBudget:data.attemptBudget};
  }catch{throw new ServiceError('export_notification_retry_conflict',409);}
}
/** Internal reconciliation reads only the immutable scoped receipt, including after mailbox retirement or batch expiry. */
export async function findAsyncExportNotificationRetryReceipt(env:RuntimeEnv,box:string,jobId:string,id:string,clientRequestId:string,expectedUpdatedAt:number):Promise<AsyncExportManualRetry|null>{
  const auditId=await stableId(`async-export-notification-retry:v1:${box}:${clientRequestId}`);
  const audit=await env.DB.prepare('SELECT id,mailbox_id,action,resource_id,metadata_json,occurred_at FROM audit_events WHERE id=?').bind(auditId).first<RetryAuditRow>();
  return receipt(audit,box,jobId,id,clientRequestId,expectedUpdatedAt);
}
export interface AsyncExportNotificationRetryInternalOptions {
  /** Only the trusted scheduled executor supplies this fence, never an API request body. */
  batchGuard?:{batchId:string;leaseToken:string;itemVersion:number};
}
export async function retryAsyncExportNotificationDelivery(ctx:OwnerContext,box:string,jobId:string,id:string,input:unknown,options:AsyncExportNotificationRetryInternalOptions={}):Promise<AsyncExportNotificationDeliveryRetryResult>{
  requireOwner(ctx.actor);const mailbox=await getMailbox(ctx,box);
  if(!['active','paused'].includes(mailbox.status)||!uuid.test(jobId)||!uuid.test(id))throw new ServiceError('not_found',404);
  const data=objectInput(input,['clientRequestId','expectedUpdatedAt']);
  if(typeof data.clientRequestId!=='string'||!uuid.test(data.clientRequestId)||typeof data.expectedUpdatedAt!=='number'||!Number.isSafeInteger(data.expectedUpdatedAt)||data.expectedUpdatedAt<0)throw new ServiceError('invalid_input',400);
  const clientRequestId=data.clientRequestId,expectedUpdatedAt=data.expectedUpdatedAt,auditId=await stableId(`async-export-notification-retry:v1:${box}:${clientRequestId}`);
  const audit=()=>ctx.env.DB.prepare('SELECT id,mailbox_id,action,resource_id,metadata_json,occurred_at FROM audit_events WHERE id=?').bind(auditId).first<RetryAuditRow>();
  let current=await delivery(ctx,box,jobId,id);
  const previous=receipt(await audit(),box,jobId,id,clientRequestId,expectedUpdatedAt);
  if(previous)return {delivery:asyncExportRetryDeliveryDto(current),manualRetry:previous,replayed:true};
  if(current.updated_at!==expectedUpdatedAt)throw new ServiceError('export_notification_retry_changed',409);
  const event=await ctx.env.DB.prepare('SELECT * FROM events WHERE mailbox_id=? AND id=?').bind(box,current.event_id).first<WebhookEventRow>();
  const notice=await ctx.env.DB.prepare('SELECT * FROM async_export_notifications WHERE mailbox_id=? AND job_id=?').bind(box,jobId).first<AsyncExportNotificationRow>();
  const payloadValid=Boolean(notice&&asyncExportNotificationFrozenPayloadValid(notice,event,current.payload_json)&&new TextEncoder().encode(current.payload_json).byteLength<=8192);
  const policy=await loadAlertNotificationPolicy(ctx.env,box);
  let capability=asyncExportNotificationRetryEligibility(ctx.env,{mailboxStatus:mailbox.status,endpointStatus:current.endpoint_status,notificationDecision:current.notification_decision,
    deliveryState:current.state,attemptBudget:current.attempt_budget,payloadValid,secretAvailable:asyncExportNotificationSecretAvailable(ctx.env,current.signing_secret_ciphertext),
    targetValid:asyncExportNotificationTargetValid(ctx.env,current.url_snapshot)},policy,Date.now());
  if(!capability.available)throw new ServiceError('export_notification_retry_unavailable',409);
  try{await decryptWebhookSecret(ctx.env,box,current.endpoint_id,current.signed_secret_version,current.signing_secret_ciphertext);}catch{throw new ServiceError('export_notification_retry_unavailable',409);}
  const now=Math.max(Date.now(),current.updated_at+1);
  // A quiet boundary may have changed while loading/decrypting; transport also rechecks live policy.
  capability=asyncExportNotificationRetryEligibility(ctx.env,{mailboxStatus:current.mailbox_status,endpointStatus:current.endpoint_status,notificationDecision:current.notification_decision,
    deliveryState:current.state,attemptBudget:current.attempt_budget,payloadValid,secretAvailable:true,targetValid:true},policy,now);
  if(!capability.available)throw new ServiceError('export_notification_retry_unavailable',409);
  const budget=Math.min(80,current.attempt_budget+8),metadata=JSON.stringify({jobId,clientRequestId,expectedUpdatedAt,previousAttemptBudget:current.attempt_budget,attemptBudget:budget});
  const guard=`d.id=? AND d.mailbox_id=? AND d.state='dead' AND d.updated_at=? AND d.attempt_budget=?
    AND EXISTS(SELECT 1 FROM async_export_notifications n WHERE n.mailbox_id=d.mailbox_id AND n.job_id=? AND n.event_id=d.event_id AND n.notification_decision='allowed')
    AND EXISTS(SELECT 1 FROM webhook_endpoints w JOIN mailboxes m ON m.id=w.mailbox_id WHERE w.id=d.endpoint_id AND w.mailbox_id=d.mailbox_id AND w.status='active' AND m.status='active')
    AND COALESCE((SELECT version FROM alert_notification_policies WHERE mailbox_id=d.mailbox_id),0)=?
    AND COALESCE((SELECT enabled FROM alert_notification_policies WHERE mailbox_id=d.mailbox_id),1)=1
    ${options.batchGuard?`AND EXISTS(SELECT 1 FROM async_export_notification_retry_items i JOIN async_export_notification_retry_batches b ON b.id=i.batch_id AND b.mailbox_id=i.mailbox_id
      WHERE i.batch_id=? AND i.mailbox_id=d.mailbox_id AND i.delivery_id=d.id AND i.job_id=? AND i.expected_updated_at=d.updated_at
        AND i.client_request_id=? AND i.state='running' AND i.lease_token=? AND i.version=?
        AND i.lease_until>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER)) AND b.state IN('queued','running') AND b.committed_at IS NOT NULL AND b.cancelled_at IS NULL
        AND b.expires_at>MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER)))`:''}`;
  const args:(string|number)[]=[id,box,expectedUpdatedAt,current.attempt_budget,jobId,policy.version,
    ...(options.batchGuard?[options.batchGuard.batchId,jobId,clientRequestId,options.batchGuard.leaseToken,options.batchGuard.itemVersion,now,now]:[])];
  // Admit against the real database clock once. Both statements execute in one transaction:
  // repeating a moving clock after the append-only audit could leave a receipt without its queue update.
  const mutationGuard=guard.replaceAll("MAX(?,CAST(unixepoch('subsec')*1000 AS INTEGER))",'?');
  let changed=false;
  try{
    const result=await ctx.env.DB.batch([
      ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,metadata_json,occurred_at)
        SELECT ?,?,'owner','webhook.delivery_retried',?,'success',?,?,? WHERE EXISTS(SELECT 1 FROM webhook_deliveries d WHERE ${guard})
        ON CONFLICT(id) DO NOTHING`).bind(auditId,box,id,ctx.requestId,metadata,now,...args),
      ctx.env.DB.prepare(`UPDATE webhook_deliveries AS d SET state='pending',attempt_budget=?,available_at=?,lease_token=NULL,lease_until=NULL,
        last_error_code=NULL,completed_at=NULL,updated_at=? WHERE ${mutationGuard}
        AND EXISTS(SELECT 1 FROM audit_events a WHERE a.id=? AND a.mailbox_id=d.mailbox_id AND a.resource_id=d.id AND a.metadata_json=?) RETURNING id`)
        .bind(budget,now,now,...args,auditId,metadata)
    ]);changed=result[1].results.length===1;
  }catch(error){
    // Lost D1 ACK is reconciled with the immutable receipt; it must never grant another budget.
    const committed=receipt(await audit(),box,jobId,id,clientRequestId,expectedUpdatedAt);
    if(!committed)throw error;current=await delivery(ctx,box,jobId,id);return {delivery:asyncExportRetryDeliveryDto(current),manualRetry:committed,replayed:true};
  }
  const committed=receipt(await audit(),box,jobId,id,clientRequestId,expectedUpdatedAt);
  if(!committed)throw new ServiceError('export_notification_retry_changed',409);
  current=await delivery(ctx,box,jobId,id);return {delivery:asyncExportRetryDeliveryDto(current),manualRetry:committed,replayed:!changed};
}
