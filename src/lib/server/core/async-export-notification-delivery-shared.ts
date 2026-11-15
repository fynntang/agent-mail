import type {AsyncExportNotificationRow} from './async-export-notifications';
import {webhookPayload,type WebhookEventRow} from './webhooks';

/** A retry preserves the original admitted terminal snapshot; a plausible job ID alone is insufficient. */
export function asyncExportNotificationFrozenPayloadValid(notice:AsyncExportNotificationRow,event:WebhookEventRow|null,payload:string):boolean{
  if(!event||event.source!=='app'||event.id!==notice.event_id||event.mailbox_id!==notice.mailbox_id
    ||event.type!==`alert_notification.export.${notice.outcome}`||event.occurred_at!==notice.completed_at||event.created_at!==notice.created_at)return false;
  try{const data=JSON.parse(event.payload_json);if(data.jobId!==notice.job_id||data.format!==notice.format||data.state!==notice.outcome||data.totalDecisions!==notice.total_decisions
    ||data.processedDecisions!==notice.processed_decisions||data.processedDeliveries!==notice.processed_deliveries||data.bodyBytes!==notice.body_bytes
    ||data.completedAt!==notice.completed_at||data.expiresAt!==notice.expires_at||(data.errorCode??null)!==notice.error_code)return false;
    return webhookPayload(event)===payload;
  }catch{return false;}
}
