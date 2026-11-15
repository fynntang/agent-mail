import type {RetryBatchNotification} from './retry-batch-notifications';
import type {WebhookAttempt,WebhookDelivery} from './webhooks';
import type {AsyncExportDeliveryRetryBlockReason,AsyncExportManualRetry,AsyncExportNotificationDeliverySummary,AsyncExportNotificationPublication} from './async-export-notification-deliveries';

export type RetryBatchNotificationPublication=AsyncExportNotificationPublication;
export type RetryBatchDeliveryRetryBlockReason=AsyncExportDeliveryRetryBlockReason;
export type RetryBatchManualRetry=AsyncExportManualRetry;
export type RetryBatchNotificationDeliverySummary=AsyncExportNotificationDeliverySummary;
export interface RetryBatchTrackedDelivery extends WebhookDelivery {retry:{available:boolean;reason:RetryBatchDeliveryRetryBlockReason|null}}
export interface RetryBatchNotificationDeliveryResults {
  notification:RetryBatchNotification;publication:RetryBatchNotificationPublication;deliverySummary:RetryBatchNotificationDeliverySummary;
  deliveries:RetryBatchTrackedDelivery[];nextCursor:string|null;
}
export interface RetryBatchNotificationDeliveryDetail {
  notification:RetryBatchNotification;publication:RetryBatchNotificationPublication;delivery:RetryBatchTrackedDelivery;
  attempts:WebhookAttempt[];manualRetries:RetryBatchManualRetry[];currentPolicy:{enabled:boolean;quiet:boolean;version:number};
}
export interface RetryBatchNotificationDeliveryRetryResult {delivery:WebhookDelivery;manualRetry:RetryBatchManualRetry;replayed:boolean}
