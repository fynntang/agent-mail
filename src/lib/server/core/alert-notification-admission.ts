import type {AlertNotificationPolicy} from '../../types/alert-notification-policy';
import {alertNotificationPolicyDto,isAlertNotificationQuiet,type AlertNotificationPolicyRow} from './alert-notification-policy';
import type {RuntimeEnv} from './types';
import type {WebhookEventRow} from './webhooks';

export const isAlertNotification=(type:string):boolean=>type==='cloudflare.suppression.alert.created'||type==='cloudflare.suppression.alert.resolved';
export async function loadAlertNotificationPolicy(env:RuntimeEnv,box:string):Promise<AlertNotificationPolicy>{
  return alertNotificationPolicyDto(await env.DB.prepare('SELECT * FROM alert_notification_policies WHERE mailbox_id=?').bind(box).first<AlertNotificationPolicyRow>());
}
export function alertNotificationQuiet(policy:AlertNotificationPolicy,at:number):boolean{
  try{return isAlertNotificationQuiet(policy,at);}catch{return true;}
}
// The receipt is one mailbox event, shared by all endpoints. Live switches also fence partial fan-out.
export const alertAdmissionAllowed=`EXISTS(SELECT 1 FROM alert_notification_decisions n WHERE n.event_id=e.id AND n.mailbox_id=e.mailbox_id AND n.decision='allowed')
  AND COALESCE((SELECT enabled FROM alert_notification_policies WHERE mailbox_id=e.mailbox_id),1)=1
  AND(e.type<>'cloudflare.suppression.alert.resolved' OR COALESCE((SELECT recovery_enabled FROM alert_notification_policies WHERE mailbox_id=e.mailbox_id),1)=1)`;
export const alertAdmissionRecorded="EXISTS(SELECT 1 FROM alert_notification_decisions n WHERE n.event_id=e.id AND n.mailbox_id=e.mailbox_id)";

/** These statements run beside fan-out and publication in the same transaction, in source insertion order. */
export function alertNotificationAdmission(env:RuntimeEnv,event:WebhookEventRow,payload:string,policy:AlertNotificationPolicy,at:number,eligibleEndpoint:string):D1PreparedStatement[]{
  const data=JSON.parse(payload).data as {alertId:string;outcome:string;errorCode?:string},resolved=event.type==='cloudflare.suppression.alert.resolved';
  const token=crypto.randomUUID(),fingerprint=JSON.stringify([data.outcome,data.errorCode??null]);
  const insert=env.DB.prepare(`INSERT INTO alert_notification_decisions(event_id,mailbox_id,alert_id,decision,policy_version,decided_at,claim_token)
    SELECT e.id,e.mailbox_id,?,CASE WHEN ?=0 THEN 'disabled' WHEN ?=1 AND ?=0 THEN 'recovery_disabled'
      WHEN ?=1 THEN 'quiet_hours' WHEN NOT EXISTS(SELECT 1 FROM webhook_endpoints w WHERE ${eligibleEndpoint}) THEN 'no_subscribers'
      WHEN ?=0 AND ?>0 AND EXISTS(SELECT 1 FROM alert_notification_state s WHERE s.mailbox_id=e.mailbox_id AND s.alert_id=?
        AND s.fingerprint=? AND s.last_notified_at>?) THEN 'repeat_limited' ELSE 'allowed' END,?,?,?
    FROM events e WHERE e.id=? AND e.mailbox_id=? AND e.webhook_published_at IS NULL
      AND EXISTS(SELECT 1 FROM mailboxes m WHERE m.id=e.mailbox_id AND m.status='active')
      AND COALESCE((SELECT version FROM alert_notification_policies WHERE mailbox_id=e.mailbox_id),0)=?
    ON CONFLICT(event_id) DO NOTHING`).bind(data.alertId,policy.enabled?1:0,resolved?1:0,policy.recoveryEnabled?1:0,
      alertNotificationQuiet(policy,at)?1:0,resolved?1:0,policy.repeatIntervalSeconds,data.alertId,fingerprint,at-policy.repeatIntervalSeconds*1000,
      policy.version,at,token,event.id,event.mailbox_id,policy.version);
  // Suppressed recoveries still reset the episode; retries of a frozen delivery never consume another admission.
  const state=resolved?env.DB.prepare(`UPDATE alert_notification_state SET last_notified_at=NULL WHERE mailbox_id=? AND alert_id=?
    AND EXISTS(SELECT 1 FROM alert_notification_decisions WHERE event_id=? AND claim_token=?)`).bind(event.mailbox_id,data.alertId,event.id,token):
    env.DB.prepare(`INSERT INTO alert_notification_state(mailbox_id,alert_id,fingerprint,last_notified_at)
      SELECT mailbox_id,alert_id,?,? FROM alert_notification_decisions WHERE event_id=? AND claim_token=? AND decision='allowed'
      ON CONFLICT(mailbox_id,alert_id) DO UPDATE SET fingerprint=excluded.fingerprint,last_notified_at=excluded.last_notified_at`).bind(fingerprint,at,event.id,token);
  return [insert,state];
}
