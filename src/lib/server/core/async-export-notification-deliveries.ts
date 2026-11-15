import type {AsyncExportNotificationDeliveryResults,AsyncExportNotificationDeliveryDetail,AsyncExportTrackedDelivery,AsyncExportManualRetry,AsyncExportNotificationPublication} from '../../types/async-export-notification-deliveries';
import type {WebhookAttempt,WebhookDelivery} from '../../types/webhooks';
import {asyncExportNotificationDto,type AsyncExportNotificationRow} from './async-export-notifications';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {objectInput} from './outbound-content';
import {alertNotificationPolicyDto,type AlertNotificationPolicyRow} from './alert-notification-policy';
import {alertNotificationQuiet} from './alert-notification-admission';
import type {WebhookEventRow} from './webhooks';
import {asyncExportNotificationFrozenPayloadValid} from './async-export-notification-delivery-shared';
import {asyncExportNotificationRetryEligibility,asyncExportNotificationSecretAvailable,asyncExportNotificationTargetValid} from './async-export-notification-retry';
import {ServiceError} from './types';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safeErrors=new Set(['lease_expired','lease_lost','invalid_target','payload_unavailable','signing_key_unavailable','mailbox_inactive','endpoint_inactive',
  'http_retry','http_rejected','delivery_timeout','network_error','alert_notifications_disabled','alert_recovery_disabled','alert_quiet_hours','legacy_snapshot_unavailable']);
const safeError=(value:string|null)=>value&&safeErrors.has(value)?value:null;
interface SnapshotRow extends AsyncExportNotificationRow {
  mailbox_status:string;event_row_id:string|null;event_source:string|null;event_type:string|null;event_payload:string|null;
  event_occurred_at:number|null;event_created_at:number|null;webhook_published_at:number|null;
  policy_mailbox:string|null;policy_enabled:number|null;policy_recovery_enabled:number|null;policy_repeat_interval_seconds:number|null;
  policy_quiet_enabled:number|null;policy_quiet_start_minute:number|null;policy_quiet_end_minute:number|null;policy_time_zone:string|null;policy_version_now:number|null;policy_updated_at:number|null;
}
interface DeliveryRow {
  id:string;mailbox_id:string;endpoint_id:string;event_id:string;state:WebhookDelivery['state'];attempts:number;attempt_budget:number;available_at:number;
  last_http_status:number|null;last_error_code:string|null;signed_secret_version:number;created_at:number;updated_at:number;completed_at:number|null;
  payload_json:string;signing_secret_ciphertext:string;url_snapshot:string;endpoint_status:string;
}
interface AuditRow{id:string;occurred_at:number;metadata_json:string}
const snapshotSql=`SELECT n.*,m.status mailbox_status,e.id event_row_id,e.source event_source,e.type event_type,e.payload_json event_payload,
 e.occurred_at event_occurred_at,e.created_at event_created_at,e.webhook_published_at,
 p.mailbox_id policy_mailbox,p.enabled policy_enabled,p.recovery_enabled policy_recovery_enabled,p.repeat_interval_seconds policy_repeat_interval_seconds,
 p.quiet_enabled policy_quiet_enabled,p.quiet_start_minute policy_quiet_start_minute,p.quiet_end_minute policy_quiet_end_minute,p.time_zone policy_time_zone,
 p.version policy_version_now,p.updated_at policy_updated_at
 FROM async_export_notifications n JOIN mailboxes m ON m.id=n.mailbox_id
 LEFT JOIN events e ON e.id=n.event_id AND e.mailbox_id=n.mailbox_id LEFT JOIN alert_notification_policies p ON p.mailbox_id=n.mailbox_id
 WHERE n.mailbox_id=? AND n.job_id=? AND m.status IN('active','paused')`;
const deliveryFrom=`FROM webhook_deliveries d JOIN async_export_notifications n ON n.mailbox_id=d.mailbox_id AND n.event_id=d.event_id
 JOIN mailboxes m ON m.id=n.mailbox_id LEFT JOIN webhook_endpoints w ON w.id=d.endpoint_id AND w.mailbox_id=d.mailbox_id
 WHERE n.mailbox_id=? AND n.job_id=? AND m.status IN('active','paused')`;
const deliverySelect=`SELECT d.id,d.mailbox_id,d.endpoint_id,d.event_id,d.state,d.attempts,d.attempt_budget,d.available_at,d.last_http_status,d.last_error_code,
 d.signed_secret_version,d.created_at,d.updated_at,d.completed_at,d.payload_json,d.signing_secret_ciphertext,d.url_snapshot,COALESCE(w.status,'disabled') endpoint_status `;
const summarySql=`SELECT COUNT(*) total,COALESCE(SUM(d.state='pending'),0) pending,COALESCE(SUM(d.state='running'),0) running,
 COALESCE(SUM(d.state='succeeded'),0) succeeded,COALESCE(SUM(d.state='dead'),0) dead,COALESCE(SUM(d.state='cancelled'),0) cancelled,
 COALESCE(SUM(d.attempts),0) attempts,COALESCE(SUM(d.state='pending' AND d.last_error_code='alert_quiet_hours'),0) quietDeferred `;
async function authorize(ctx:OwnerContext,box:string,job:string,delivery?:string):Promise<void>{
  requireOwner(ctx.actor);if(!uuid.test(job)||delivery!==undefined&&!uuid.test(delivery))throw new ServiceError('not_found',404);
  const mailbox=await getMailbox(ctx,box);if(!['active','paused'].includes(mailbox.status))throw new ServiceError('not_found',404);
}
function publication(row:SnapshotRow):AsyncExportNotificationPublication{return row.projected_at===null?'pending_projection':row.webhook_published_at===null?'pending_publication':'published';}
function policyOf(row:SnapshotRow){
  const policy:AlertNotificationPolicyRow|null=row.policy_mailbox===null?null:{mailbox_id:row.policy_mailbox,enabled:row.policy_enabled!,recovery_enabled:row.policy_recovery_enabled!,
    repeat_interval_seconds:row.policy_repeat_interval_seconds!,quiet_enabled:row.policy_quiet_enabled!,quiet_start_minute:row.policy_quiet_start_minute!,
    quiet_end_minute:row.policy_quiet_end_minute!,time_zone:row.policy_time_zone!,version:row.policy_version_now!,updated_at:row.policy_updated_at!};
  return alertNotificationPolicyDto(policy);
}
function eventOf(row:SnapshotRow):WebhookEventRow|null{return row.event_row_id===null?null:{id:row.event_row_id,mailbox_id:row.mailbox_id,source:row.event_source!,type:row.event_type!,payload_json:row.event_payload!,
  occurred_at:row.event_occurred_at!,created_at:row.event_created_at!,webhook_published_at:row.webhook_published_at};}
function tracked(ctx:OwnerContext,notice:SnapshotRow,row:DeliveryRow,at:number):AsyncExportTrackedDelivery{
  const policy=policyOf(notice);
  return {id:row.id,mailboxId:row.mailbox_id,endpointId:row.endpoint_id,eventId:row.event_id,eventType:`alert_notification.export.${notice.outcome}`,state:row.state,
    attempts:row.attempts,attemptBudget:row.attempt_budget,availableAt:row.available_at,lastHttpStatus:row.last_http_status,lastErrorCode:safeError(row.last_error_code),
    secretVersion:row.signed_secret_version,createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at,
    retry:asyncExportNotificationRetryEligibility(ctx.env,{mailboxStatus:notice.mailbox_status,endpointStatus:row.endpoint_status,notificationDecision:notice.notification_decision,
      deliveryState:row.state,attemptBudget:row.attempt_budget,payloadValid:asyncExportNotificationFrozenPayloadValid(notice,eventOf(notice),row.payload_json),secretAvailable:asyncExportNotificationSecretAvailable(ctx.env,row.signing_secret_ciphertext),
      targetValid:asyncExportNotificationTargetValid(ctx.env,row.url_snapshot)},policy,at)};
}
export function asyncExportManualRetryDto(row:AuditRow):AsyncExportManualRetry{
  let data:Record<string,unknown>={};try{const parsed=JSON.parse(row.metadata_json);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))data=parsed;}catch{/* Legacy audit metadata is optional. */}
  const number=(key:string,max=Number.MAX_SAFE_INTEGER)=>typeof data[key]==='number'&&Number.isSafeInteger(data[key])&&Number(data[key])>=0&&Number(data[key])<=max?Number(data[key]):null;
  return {id:row.id,clientRequestId:typeof data.clientRequestId==='string'&&uuid.test(data.clientRequestId)?data.clientRequestId:null,requestedAt:row.occurred_at,
    expectedUpdatedAt:number('expectedUpdatedAt'),previousAttemptBudget:number('previousAttemptBudget',80),attemptBudget:number('attemptBudget',80)};
}
type Query={limit?:unknown;cursor?:unknown};
export async function listAsyncExportNotificationDeliveryResults(ctx:OwnerContext,box:string,job:string,query:Query={}):Promise<AsyncExportNotificationDeliveryResults>{
  await authorize(ctx,box,job);objectInput(query,['limit','cursor']);const limit=query.limit===undefined?20:Number(query.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_query',400);
  let before:{time:number;id:string;event:string}|null=null;
  if(query.cursor!==undefined){try{if(typeof query.cursor!=='string'||query.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw Error();
    const cursor=JSON.parse(atob(query.cursor.replaceAll('-','+').replaceAll('_','/')));
    if(!cursor||Object.keys(cursor).length!==7||cursor.v!==1||cursor.box!==box||cursor.job!==job||cursor.limit!==limit||!uuid.test(cursor.event)
      ||!Number.isSafeInteger(cursor.time)||cursor.time<0||typeof cursor.id!=='string'||!uuid.test(cursor.id))throw Error();before={time:cursor.time,id:cursor.id,event:cursor.event};
  }catch{throw new ServiceError('invalid_cursor',400);}}
  const snapshot=await ctx.env.DB.batch([
    ctx.env.DB.prepare(snapshotSql).bind(box,job),ctx.env.DB.prepare(summarySql+deliveryFrom).bind(box,job),
    ctx.env.DB.prepare(deliverySelect+deliveryFrom+`${before?' AND(d.created_at<? OR(d.created_at=? AND d.id<?))':''} ORDER BY d.created_at DESC,d.id DESC LIMIT ?`)
      .bind(box,job,...(before?[before.time,before.time,before.id]:[]),limit+1)
  ]);
  const notice=snapshot[0].results[0] as unknown as SnapshotRow|undefined;if(!notice)throw new ServiceError('not_found',404);
  if(before&&before.event!==notice.event_id)throw new ServiceError('invalid_cursor',400);
  const rows=snapshot[2].results as unknown as DeliveryRow[],visible=rows.slice(0,limit),last=visible.at(-1),at=Date.now();
  const nextCursor=rows.length>limit&&last?btoa(JSON.stringify({v:1,box,job,event:notice.event_id,limit,time:last.created_at,id:last.id})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null;
  return {notification:asyncExportNotificationDto(notice),publication:publication(notice),deliverySummary:snapshot[1].results[0] as unknown as AsyncExportNotificationDeliveryResults['deliverySummary'],
    deliveries:visible.map(row=>tracked(ctx,notice,row,at)),nextCursor};
}
export async function getAsyncExportNotificationDelivery(ctx:OwnerContext,box:string,job:string,id:string):Promise<AsyncExportNotificationDeliveryDetail>{
  await authorize(ctx,box,job,id);
  const owned=`EXISTS(SELECT 1 FROM webhook_deliveries d JOIN async_export_notifications n ON n.event_id=d.event_id AND n.mailbox_id=d.mailbox_id
    JOIN mailboxes m ON m.id=n.mailbox_id WHERE d.id=? AND d.mailbox_id=? AND n.job_id=? AND m.status IN('active','paused'))`;
  const snapshot=await ctx.env.DB.batch([
    ctx.env.DB.prepare(snapshotSql).bind(box,job),ctx.env.DB.prepare(deliverySelect+deliveryFrom+' AND d.id=?').bind(box,job,id),
    ctx.env.DB.prepare(`SELECT id,attempt_no attemptNo,outcome,http_status httpStatus,error_code errorCode,started_at startedAt,finished_at finishedAt
      FROM webhook_delivery_attempts WHERE mailbox_id=? AND delivery_id=? AND ${owned} ORDER BY attempt_no DESC LIMIT 80`).bind(box,id,id,box,job),
    ctx.env.DB.prepare(`SELECT id,occurred_at,metadata_json FROM audit_events WHERE mailbox_id=? AND resource_id=? AND action='webhook.delivery_retried'
      AND ${owned} ORDER BY occurred_at DESC,id DESC LIMIT 10`).bind(box,id,id,box,job)
  ]);
  const notice=snapshot[0].results[0] as unknown as SnapshotRow|undefined,row=snapshot[1].results[0] as unknown as DeliveryRow|undefined;
  if(!notice||!row)throw new ServiceError('not_found',404);const at=Date.now(),policy=policyOf(notice);
  return {notification:asyncExportNotificationDto(notice),publication:publication(notice),delivery:tracked(ctx,notice,row,at),
    attempts:(snapshot[2].results as unknown as WebhookAttempt[]).map(row=>({...row,errorCode:safeError(row.errorCode)})),
    manualRetries:(snapshot[3].results as unknown as AuditRow[]).map(asyncExportManualRetryDto),currentPolicy:{enabled:policy.enabled,quiet:alertNotificationQuiet(policy,at),version:policy.version}};
}
