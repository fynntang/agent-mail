import type {AlertNotificationPolicy,AlertNotificationPolicyInput} from '../../types/alert-notification-policy';
import {getMailbox,requireOwner,type OwnerContext} from './owner';
import {objectInput} from './outbound-content';
import {ServiceError} from './types';

export const ALERT_NOTIFICATION_REPEAT_MAX_SECONDS=604800;
export const DEFAULT_ALERT_NOTIFICATION_POLICY:Readonly<AlertNotificationPolicy>=Object.freeze({
  enabled:true,recoveryEnabled:true,repeatIntervalSeconds:0,quietEnabled:false,
  quietStartMinute:1320,quietEndMinute:480,timeZone:'UTC',version:0,updatedAt:0
});
export interface AlertNotificationPolicyRow {
  mailbox_id:string;enabled:number;recovery_enabled:number;repeat_interval_seconds:number;
  quiet_enabled:number;quiet_start_minute:number;quiet_end_minute:number;time_zone:string;version:number;updated_at:number;
}
export function alertNotificationPolicyDto(row:AlertNotificationPolicyRow|null):AlertNotificationPolicy {
  return row?{enabled:row.enabled===1,recoveryEnabled:row.recovery_enabled===1,repeatIntervalSeconds:row.repeat_interval_seconds,
    quietEnabled:row.quiet_enabled===1,quietStartMinute:row.quiet_start_minute,quietEndMinute:row.quiet_end_minute,
    timeZone:row.time_zone,version:row.version,updatedAt:row.updated_at}:{...DEFAULT_ALERT_NOTIFICATION_POLICY};
}
export function canonicalAlertTimeZone(value:unknown):string {
  if(typeof value!=='string'||value.length>64||!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value))throw new ServiceError('invalid_alert_notification_policy',400);
  try{return new Intl.DateTimeFormat('en-US',{timeZone:value}).resolvedOptions().timeZone;}
  catch{throw new ServiceError('invalid_alert_notification_policy',400);}
}
export function normalizedAlertNotificationPolicy(input:unknown):AlertNotificationPolicyInput {
  const data=objectInput(input,['enabled','recoveryEnabled','repeatIntervalSeconds','quietEnabled','quietStartMinute','quietEndMinute','timeZone','expectedVersion']);
  if(typeof data.enabled!=='boolean'||typeof data.recoveryEnabled!=='boolean'||typeof data.quietEnabled!=='boolean'
    ||typeof data.repeatIntervalSeconds!=='number'||!Number.isSafeInteger(data.repeatIntervalSeconds)||data.repeatIntervalSeconds<0||data.repeatIntervalSeconds>ALERT_NOTIFICATION_REPEAT_MAX_SECONDS
    ||typeof data.quietStartMinute!=='number'||!Number.isSafeInteger(data.quietStartMinute)||data.quietStartMinute<0||data.quietStartMinute>1439
    ||typeof data.quietEndMinute!=='number'||!Number.isSafeInteger(data.quietEndMinute)||data.quietEndMinute<0||data.quietEndMinute>1439
    ||data.quietEnabled&&data.quietStartMinute===data.quietEndMinute
    ||typeof data.expectedVersion!=='number'||!Number.isSafeInteger(data.expectedVersion)||data.expectedVersion<0)throw new ServiceError('invalid_alert_notification_policy',400);
  return {enabled:data.enabled,recoveryEnabled:data.recoveryEnabled,repeatIntervalSeconds:data.repeatIntervalSeconds,
    quietEnabled:data.quietEnabled,quietStartMinute:data.quietStartMinute,quietEndMinute:data.quietEndMinute,timeZone:canonicalAlertTimeZone(data.timeZone),expectedVersion:data.expectedVersion};
}
/** Half-open daily wall-clock window. Intl applies IANA daylight-saving rules at the supplied instant. */
export function isAlertNotificationQuiet(policy:Pick<AlertNotificationPolicy,'quietEnabled'|'quietStartMinute'|'quietEndMinute'|'timeZone'>,at:number):boolean {
  if(!policy.quietEnabled)return false;
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:policy.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);
  const minute=Number(parts.find(part=>part.type==='hour')!.value)*60+Number(parts.find(part=>part.type==='minute')!.value);
  return policy.quietStartMinute<policy.quietEndMinute?minute>=policy.quietStartMinute&&minute<policy.quietEndMinute:
    minute>=policy.quietStartMinute||minute<policy.quietEndMinute;
}
async function authorize(ctx:OwnerContext,box:string):Promise<void> {
  requireOwner(ctx.actor);const mailbox=await getMailbox(ctx,box);
  if(!['active','paused'].includes(mailbox.status))throw new ServiceError('not_found',404);
}
export async function getAlertNotificationPolicy(ctx:OwnerContext,box:string):Promise<{policy:AlertNotificationPolicy}> {
  await authorize(ctx,box);
  const row=await ctx.env.DB.prepare('SELECT * FROM alert_notification_policies WHERE mailbox_id=?').bind(box).first<AlertNotificationPolicyRow>();
  return {policy:alertNotificationPolicyDto(row)};
}
export async function updateAlertNotificationPolicy(ctx:OwnerContext,box:string,input:unknown):Promise<{policy:AlertNotificationPolicy}> {
  await authorize(ctx,box);const policy=normalizedAlertNotificationPolicy(input),current=(await getAlertNotificationPolicy(ctx,box)).policy;
  if(policy.expectedVersion!==current.version)throw new ServiceError('alert_notification_policy_changed',409);
  const mutation=crypto.randomUUID(),at=Math.max(Date.now(),current.updatedAt+1),guard='EXISTS(SELECT 1 FROM audit_events WHERE id=?)';
  const statements=[
    ctx.env.DB.prepare(`INSERT INTO audit_events(id,mailbox_id,actor_kind,action,resource_id,outcome,request_id,occurred_at)
      SELECT ?,?,'owner','alert_notification_policy.updated',?,'success',?,?
      WHERE EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND status IN('active','paused'))
      AND COALESCE((SELECT version FROM alert_notification_policies WHERE mailbox_id=?),0)=?`)
      .bind(mutation,box,box,ctx.requestId,at,box,box,policy.expectedVersion),
    ctx.env.DB.prepare(`INSERT INTO alert_notification_policies(mailbox_id,enabled,recovery_enabled,repeat_interval_seconds,quiet_enabled,quiet_start_minute,quiet_end_minute,time_zone,version,updated_at)
      SELECT ?,?,?,?,?,?,?,?,1,? WHERE ${guard} ON CONFLICT(mailbox_id) DO UPDATE SET enabled=excluded.enabled,recovery_enabled=excluded.recovery_enabled,
      repeat_interval_seconds=excluded.repeat_interval_seconds,quiet_enabled=excluded.quiet_enabled,quiet_start_minute=excluded.quiet_start_minute,
      quiet_end_minute=excluded.quiet_end_minute,time_zone=excluded.time_zone,version=alert_notification_policies.version+1,updated_at=excluded.updated_at`)
      .bind(box,policy.enabled?1:0,policy.recoveryEnabled?1:0,policy.repeatIntervalSeconds,policy.quietEnabled?1:0,policy.quietStartMinute,policy.quietEndMinute,policy.timeZone,at,mutation)
  ];
  const disabled=!policy.enabled?"json_extract(d.payload_json,'$.type') IN('cloudflare.suppression.alert.created','cloudflare.suppression.alert.resolved','alert_notification.export.succeeded','alert_notification.export.failed','alert_notification.retry_batch.completed','alert_notification.retry_batch.failed','alert_notification.retry_batch.needs_reconciliation')":
    !policy.recoveryEnabled?"json_extract(d.payload_json,'$.type')='cloudflare.suppression.alert.resolved'":null;
  if(disabled){
    const code=!policy.enabled?'alert_notifications_disabled':'alert_recovery_disabled';
    statements.push(
      ctx.env.DB.prepare(`UPDATE webhook_delivery_attempts SET outcome='cancelled',error_code=?,finished_at=MAX(started_at,?) WHERE mailbox_id=? AND outcome='started'
        AND EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d.id=webhook_delivery_attempts.delivery_id AND d.mailbox_id=webhook_delivery_attempts.mailbox_id
          AND d.state IN('pending','running') AND ${disabled}) AND ${guard}`).bind(code,at,box,mutation),
      ctx.env.DB.prepare(`UPDATE webhook_deliveries AS d SET state='cancelled',lease_token=NULL,lease_until=NULL,last_error_code=?,completed_at=?,updated_at=MAX(updated_at,?)
        WHERE mailbox_id=? AND state IN('pending','running') AND ${disabled} AND ${guard}`).bind(code,at,at,box,mutation)
    );
  }
  // Bring only quiet-window deferrals forward. Ordinary HTTP failure backoff remains unchanged.
  statements.push(ctx.env.DB.prepare(`UPDATE webhook_deliveries SET available_at=MIN(available_at,?),last_error_code=NULL,updated_at=MAX(updated_at,?)
    WHERE mailbox_id=? AND state='pending' AND last_error_code='alert_quiet_hours'
      AND json_extract(payload_json,'$.type') IN('cloudflare.suppression.alert.created','cloudflare.suppression.alert.resolved','alert_notification.export.succeeded','alert_notification.export.failed','alert_notification.retry_batch.completed','alert_notification.retry_batch.failed','alert_notification.retry_batch.needs_reconciliation') AND ${guard}`).bind(at,at,box,mutation));
  const batch=await ctx.env.DB.batch(statements);
  if(batch[1].meta.changes!==1)throw new ServiceError('alert_notification_policy_changed',409);
  return getAlertNotificationPolicy(ctx,box);
}
