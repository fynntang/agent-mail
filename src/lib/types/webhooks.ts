export type WebhookEventType='message.received'|'outbound.accepted'|'outbound.failed'|'outbound.unknown'|
  'outbound.delivered'|'outbound.deferred'|'outbound.bounced'|'outbound.rejected'|'outbound.complained'|
  'cloudflare.suppression.alert.created'|'cloudflare.suppression.alert.resolved'|
  'alert_notification.export.succeeded'|'alert_notification.export.failed'|
  'alert_notification.retry_batch.completed'|'alert_notification.retry_batch.failed'|'alert_notification.retry_batch.needs_reconciliation';
export interface MailEvent {id:string;mailboxId:string;type:WebhookEventType;occurredAt:number;data:{messageId?:string;outboundId?:string;status?:string;
  alertId?:string;kind?:'sync'|'release'|'completed'|'failed'|'needs_reconciliation';outcome?:'failed'|'unknown'|'resolved';errorCode?:string;
  jobId?:string;format?:'csv'|'json';state?:'succeeded'|'failed';totalDecisions?:number;processedDecisions?:number;processedDeliveries?:number;
  bodyBytes?:number;completedAt?:number;expiresAt?:number;
  notificationId?:string;batchId?:string;reason?:'completed'|'execution_failed'|'expired'|'unknown_results';
  batchState?:'preview'|'queued'|'running'|'completed'|'expired'|'cancelled';sourceVersion?:number;
  totalItems?:number;eligibleItems?:number;processedItems?:number;requeuedItems?:number;skippedItems?:number;failedItems?:number;unknownItems?:number;occurredAt?:number}}
export interface WebhookEndpoint {
  id:string;mailboxId:string;url:string|null;eventTypes:WebhookEventType[];status:'active'|'paused'|'disabled';
  secretVersion:number;createdAt:number;updatedAt:number;
}
export interface WebhookDelivery {
  id:string;mailboxId:string;endpointId:string;eventId:string;eventType:WebhookEventType|'unknown';state:'pending'|'running'|'succeeded'|'dead'|'cancelled';
  attempts:number;attemptBudget:number;availableAt:number;lastHttpStatus:number|null;lastErrorCode:string|null;
  secretVersion:number;createdAt:number;updatedAt:number;completedAt:number|null;
}
export interface WebhookAttempt {id:string;attemptNo:number;outcome:'started'|'succeeded'|'retry'|'dead'|'expired'|'cancelled';httpStatus:number|null;errorCode:string|null;startedAt:number;finishedAt:number|null}
