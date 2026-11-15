import type {RetryBatchNotificationRow} from './retry-batch-notifications';
import {webhookPayload,type WebhookEventRow} from './webhooks';

/** Match the original immutable notification fact; plausible notification/batch IDs are insufficient. */
export function retryBatchNotificationFrozenPayloadValid(notice:RetryBatchNotificationRow,event:(WebhookEventRow&{source_event_id?:string|null})|null,payload:string):boolean{
  if(new TextEncoder().encode(payload).byteLength>8192||!event||event.source!=='app'||event.source_event_id!==`retry-batch-notification:v1:${notice.id}`
    ||event.id!==notice.event_id||event.mailbox_id!==notice.mailbox_id||event.type!==`alert_notification.retry_batch.${notice.kind}`
    ||event.occurred_at!==notice.occurred_at||event.created_at!==notice.created_at)return false;
  try{
    const data=JSON.parse(event.payload_json);
    if(data.notificationId!==notice.id||data.batchId!==notice.batch_id||data.kind!==notice.kind||data.reason!==notice.reason
      ||data.batchState!==notice.batch_state||data.sourceVersion!==notice.source_version||data.totalItems!==notice.total_items
      ||data.eligibleItems!==notice.eligible_items||data.processedItems!==notice.processed_items||data.requeuedItems!==notice.requeued_items
      ||data.skippedItems!==notice.skipped_items||data.failedItems!==notice.failed_items||data.unknownItems!==notice.unknown_items
      ||data.occurredAt!==notice.occurred_at)return false;
    return webhookPayload(event)===payload;
  }catch{return false;}
}

/** Use the original captured key version; later endpoint rotation never changes an existing delivery. */
export function retryBatchNotificationDeliveryWasCaptured(notice:RetryBatchNotificationRow,endpointId:string,secretVersion:number):boolean{
  try{
    const captured:unknown=JSON.parse(notice.endpoint_snapshot_json);
    return Array.isArray(captured)&&captured.length<=10&&captured.some(item=>item&&typeof item==='object'
      &&item.id===endpointId&&item.version===secretVersion&&Number.isSafeInteger(item.updatedAt)&&item.updatedAt>=0);
  }catch{return false;}
}
