import type {AsyncExportNotification} from './async-export-notifications';
import type {WebhookAttempt,WebhookDelivery} from './webhooks';

export type AsyncExportNotificationPublication='pending_projection'|'pending_publication'|'published';
export type AsyncExportDeliveryRetryBlockReason='not_dead'|'not_admitted'|'mailbox_inactive'|'endpoint_inactive'|'budget_exhausted'|
  'notifications_disabled'|'quiet_hours'|'not_configured'|'payload_unavailable'|'signing_key_unavailable'|'invalid_target';
export interface AsyncExportTrackedDelivery extends WebhookDelivery {retry:{available:boolean;reason:AsyncExportDeliveryRetryBlockReason|null}}
export interface AsyncExportManualRetry {
  id:string;clientRequestId:string|null;requestedAt:number;expectedUpdatedAt:number|null;previousAttemptBudget:number|null;attemptBudget:number|null;
}
export interface AsyncExportNotificationDeliverySummary {
  total:number;pending:number;running:number;succeeded:number;dead:number;cancelled:number;attempts:number;quietDeferred:number;
}
export interface AsyncExportNotificationDeliveryResults {
  notification:AsyncExportNotification;publication:AsyncExportNotificationPublication;deliverySummary:AsyncExportNotificationDeliverySummary;
  deliveries:AsyncExportTrackedDelivery[];nextCursor:string|null;
}
export interface AsyncExportNotificationDeliveryDetail {
  notification:AsyncExportNotification;publication:AsyncExportNotificationPublication;delivery:AsyncExportTrackedDelivery;
  attempts:WebhookAttempt[];manualRetries:AsyncExportManualRetry[];currentPolicy:{enabled:boolean;quiet:boolean;version:number};
}
export interface AsyncExportNotificationDeliveryRetryResult {delivery:WebhookDelivery;manualRetry:AsyncExportManualRetry;replayed:boolean}
