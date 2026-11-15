import type {AlertNotificationPolicy} from '../../types/alert-notification-policy';
import {alertNotificationQuiet} from './alert-notification-admission';
import type {RuntimeEnv} from './types';
import type {WebhookEventRow} from './webhooks';

export const RETRY_BATCH_NOTIFICATION_TYPES=['alert_notification.retry_batch.completed','alert_notification.retry_batch.failed','alert_notification.retry_batch.needs_reconciliation'] as const;
export const isRetryBatchNotification=(type:string):boolean=>(RETRY_BATCH_NOTIFICATION_TYPES as readonly string[]).includes(type);
// Admission trusts the durable snapshot, never caller-provided IDs or just the event's declared type.
const receipt=`n.event_id=e.id AND n.mailbox_id=e.mailbox_id AND e.source='app'
  AND e.source_event_id='retry-batch-notification:v1:'||n.id
  AND e.type='alert_notification.retry_batch.'||n.kind
  AND json_extract(e.payload_json,'$.notificationId')=n.id AND json_extract(e.payload_json,'$.batchId')=n.batch_id
  AND json_extract(e.payload_json,'$.kind')=n.kind AND json_extract(e.payload_json,'$.reason')=n.reason
  AND json_extract(e.payload_json,'$.batchState')=n.batch_state AND json_extract(e.payload_json,'$.sourceVersion')=n.source_version
  AND json_extract(e.payload_json,'$.totalItems')=n.total_items AND json_extract(e.payload_json,'$.eligibleItems')=n.eligible_items
  AND json_extract(e.payload_json,'$.processedItems')=n.processed_items AND json_extract(e.payload_json,'$.requeuedItems')=n.requeued_items
  AND json_extract(e.payload_json,'$.skippedItems')=n.skipped_items AND json_extract(e.payload_json,'$.failedItems')=n.failed_items
  AND json_extract(e.payload_json,'$.unknownItems')=n.unknown_items AND json_extract(e.payload_json,'$.occurredAt')=n.occurred_at
  AND e.occurred_at=n.occurred_at AND e.created_at=n.created_at`;
export const retryBatchAdmissionAllowed=`EXISTS(SELECT 1 FROM async_export_retry_batch_notifications n WHERE ${receipt} AND n.notification_decision='allowed')
  AND COALESCE((SELECT enabled FROM alert_notification_policies WHERE mailbox_id=e.mailbox_id),1)=1`;
export const retryBatchAdmissionRecorded=`(NOT EXISTS(SELECT 1 FROM async_export_retry_batch_notifications n WHERE ${receipt})
  OR EXISTS(SELECT 1 FROM async_export_retry_batch_notifications n WHERE ${receipt} AND n.notification_decision IS NOT NULL))`;

/** Share the existing policy and storage, with a namespace distinct from export and suppression notices. */
export function retryBatchNotificationAdmission(env:RuntimeEnv,event:WebhookEventRow,payload:string,policy:AlertNotificationPolicy,at:number,eligibleEndpoint:string):D1PreparedStatement[]{
  const data=JSON.parse(payload).data as {notificationId:string;kind:string;reason:string},token=crypto.randomUUID();
  const fingerprint=JSON.stringify(['retry_batch',data.kind,data.reason]);
  return [
    env.DB.prepare(`UPDATE async_export_retry_batch_notifications AS n SET notification_decision=CASE
        WHEN ?=0 THEN 'disabled' WHEN ?=1 THEN 'quiet_hours'
        WHEN NOT EXISTS(SELECT 1 FROM events e JOIN webhook_endpoints w ON ${eligibleEndpoint} WHERE e.id=n.event_id) THEN 'no_subscribers'
        WHEN ?>0 AND EXISTS(SELECT 1 FROM async_export_notification_state s WHERE s.mailbox_id=n.mailbox_id AND s.fingerprint=? AND s.last_notified_at>?)
          THEN 'repeat_limited' ELSE 'allowed' END,policy_version=?,decided_at=?,claim_token=?
      WHERE n.id=? AND n.mailbox_id=? AND n.event_id=? AND n.notification_decision IS NULL
        AND EXISTS(SELECT 1 FROM events e WHERE ${receipt} AND e.webhook_published_at IS NULL)
        AND EXISTS(SELECT 1 FROM mailboxes m WHERE m.id=n.mailbox_id AND m.status='active')
        AND COALESCE((SELECT version FROM alert_notification_policies WHERE mailbox_id=n.mailbox_id),0)=?`)
      .bind(policy.enabled?1:0,alertNotificationQuiet(policy,at)?1:0,policy.repeatIntervalSeconds,fingerprint,at-policy.repeatIntervalSeconds*1000,
        policy.version,at,token,data.notificationId,event.mailbox_id,event.id,policy.version),
    env.DB.prepare(`INSERT INTO async_export_notification_state(mailbox_id,fingerprint,last_notified_at)
      SELECT mailbox_id,?,? FROM async_export_retry_batch_notifications WHERE id=? AND mailbox_id=? AND event_id=? AND claim_token=? AND notification_decision='allowed'
      ON CONFLICT(mailbox_id,fingerprint) DO UPDATE SET last_notified_at=MAX(async_export_notification_state.last_notified_at,excluded.last_notified_at)`)
      .bind(fingerprint,at,data.notificationId,event.mailbox_id,event.id,token)
  ];
}
