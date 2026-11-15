import type {AlertNotificationPolicy} from '../../types/alert-notification-policy';
import {alertNotificationQuiet} from './alert-notification-admission';
import type {WebhookEventRow} from './webhooks';
import type {RuntimeEnv} from './types';

export const isAsyncExportNotification=(type:string):boolean=>type==='alert_notification.export.succeeded'||type==='alert_notification.export.failed';
// Bind a published event to its durable terminal receipt, rather than trusting a job ID in JSON.
const receipt=`n.event_id=e.id AND n.mailbox_id=e.mailbox_id AND e.source='app'
  AND e.type='alert_notification.export.'||n.outcome
  AND json_extract(e.payload_json,'$.jobId')=n.job_id AND json_extract(e.payload_json,'$.format')=n.format
  AND json_extract(e.payload_json,'$.state')=n.outcome
  AND json_extract(e.payload_json,'$.totalDecisions')=n.total_decisions
  AND json_extract(e.payload_json,'$.processedDecisions')=n.processed_decisions
  AND json_extract(e.payload_json,'$.processedDeliveries')=n.processed_deliveries
  AND json_extract(e.payload_json,'$.bodyBytes')=n.body_bytes
  AND json_extract(e.payload_json,'$.completedAt')=n.completed_at AND e.occurred_at=n.completed_at
  AND json_extract(e.payload_json,'$.expiresAt')=n.expires_at
  AND COALESCE(json_extract(e.payload_json,'$.errorCode'),'')=COALESCE(n.error_code,'')`;
export const asyncExportAdmissionAllowed=`EXISTS(SELECT 1 FROM async_export_notifications n WHERE ${receipt} AND n.notification_decision='allowed')
  AND COALESCE((SELECT enabled FROM alert_notification_policies WHERE mailbox_id=e.mailbox_id),1)=1`;
// Forged/mismatched events are marked handled without fan-out, avoiding a poison event blocking the queue.
export const asyncExportAdmissionRecorded=`(NOT EXISTS(SELECT 1 FROM async_export_notifications n WHERE ${receipt})
  OR EXISTS(SELECT 1 FROM async_export_notifications n WHERE ${receipt} AND n.notification_decision IS NOT NULL))`;

/** Export receipts and their repeat state stay separate from suppression alert decision exports. */
export function asyncExportNotificationAdmission(env:RuntimeEnv,event:WebhookEventRow,payload:string,policy:AlertNotificationPolicy,at:number,eligibleEndpoint:string):D1PreparedStatement[]{
  const data=JSON.parse(payload).data as {jobId:string;format:string;state:string;errorCode?:string};
  const token=crypto.randomUUID(),fingerprint=JSON.stringify([data.format,data.state,data.errorCode??null]);
  return [
    env.DB.prepare(`UPDATE async_export_notifications AS n SET notification_decision=CASE
        WHEN ?=0 THEN 'disabled' WHEN ?=1 THEN 'quiet_hours'
        WHEN NOT EXISTS(SELECT 1 FROM events e JOIN webhook_endpoints w ON ${eligibleEndpoint} WHERE e.id=n.event_id) THEN 'no_subscribers'
        WHEN ?>0 AND EXISTS(SELECT 1 FROM async_export_notification_state s WHERE s.mailbox_id=n.mailbox_id AND s.fingerprint=? AND s.last_notified_at>?)
          THEN 'repeat_limited' ELSE 'allowed' END,policy_version=?,decided_at=?,claim_token=?
      WHERE n.job_id=? AND n.mailbox_id=? AND n.event_id=? AND n.notification_decision IS NULL
        AND EXISTS(SELECT 1 FROM events e WHERE ${receipt} AND e.webhook_published_at IS NULL)
        AND EXISTS(SELECT 1 FROM mailboxes m WHERE m.id=n.mailbox_id AND m.status='active')
        AND COALESCE((SELECT version FROM alert_notification_policies WHERE mailbox_id=n.mailbox_id),0)=?`)
      .bind(policy.enabled?1:0,alertNotificationQuiet(policy,at)?1:0,policy.repeatIntervalSeconds,fingerprint,at-policy.repeatIntervalSeconds*1000,
        policy.version,at,token,data.jobId,event.mailbox_id,event.id,policy.version),
    env.DB.prepare(`INSERT INTO async_export_notification_state(mailbox_id,fingerprint,last_notified_at)
      SELECT mailbox_id,?,? FROM async_export_notifications WHERE job_id=? AND mailbox_id=? AND event_id=? AND claim_token=? AND notification_decision='allowed'
      ON CONFLICT(mailbox_id,fingerprint) DO UPDATE SET last_notified_at=MAX(async_export_notification_state.last_notified_at,excluded.last_notified_at)`)
      .bind(fingerprint,at,data.jobId,event.mailbox_id,event.id,token)
  ];
}
