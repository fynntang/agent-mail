import type {AsyncExportDeliveryRetryBlockReason} from './async-export-notification-deliveries';

export const RETRY_BATCH_NOTIFICATION_FAILURE_REASONS=['lease_expired','lease_lost','invalid_target','payload_unavailable','signing_key_unavailable','mailbox_inactive','endpoint_inactive',
  'http_retry','http_rejected','delivery_timeout','network_error','alert_notifications_disabled','alert_recovery_disabled','alert_quiet_hours','legacy_snapshot_unavailable'] as const;
export type RetryBatchNotificationFailureReason='all'|'other'|typeof RETRY_BATCH_NOTIFICATION_FAILURE_REASONS[number];
export type RetryBatchNotificationRetryBatchState='preview'|'queued'|'running'|'completed'|'expired'|'cancelled';
export type RetryBatchNotificationRetryBatchItemState='pending'|'running'|'requeued'|'skipped'|'failed'|'unknown';
export type RetryBatchNotificationRetryBatchItemReason=AsyncExportDeliveryRetryBlockReason|'changed'|'batch_expired'|'batch_cancelled'|'not_submitted'|'result_unknown'|'retry_failed'|'preview_blocked'|'not_found'|'receipt_conflict';
export interface RetryBatchNotificationRetryBatch {
  id:string;mailboxId:string;window:{from:number;to:number};filters:{reason:RetryBatchNotificationFailureReason};state:RetryBatchNotificationRetryBatchState;version:number;
  totalItems:number;eligibleItems:number;processedItems:number;requeuedItems:number;skippedItems:number;failedItems:number;unknownItems:number;
  createdAt:number;updatedAt:number;expiresAt:number;previewExpiresAt:number;committedAt:number|null;completedAt:number|null;cancelledAt:number|null;canCommit:boolean;canCancel:boolean;
}
export interface RetryBatchNotificationRetryBatchItem {
  deliveryId:string;notificationId:string;sourceBatchId:string;expectedUpdatedAt:number;failureReason:Exclude<RetryBatchNotificationFailureReason,'all'>;failedAt:number;
  previewEligible:boolean;previewReason:AsyncExportDeliveryRetryBlockReason|null;state:RetryBatchNotificationRetryBatchItemState;reason:RetryBatchNotificationRetryBatchItemReason|null;
  manualRetryId:string|null;createdAt:number;updatedAt:number;completedAt:number|null;version:number;
}
export interface RetryBatchNotificationRetryBatchList {batches:RetryBatchNotificationRetryBatch[];nextCursor:string|null}
export interface RetryBatchNotificationRetryBatchDetail {batch:RetryBatchNotificationRetryBatch;items:RetryBatchNotificationRetryBatchItem[];nextCursor:string|null}
export interface RetryBatchNotificationRetryBatchPreview extends RetryBatchNotificationRetryBatchDetail {replayed:boolean}
export interface RetryBatchNotificationRetryBatchCommit {batch:RetryBatchNotificationRetryBatch;replayed:boolean}

export interface RetryBatchNotificationRetryBatchControlOperation {
  id:string;action:'preview'|'commit'|'cancel'|'reconcile';clientRequestId:string|null;expectedVersion:number|null;occurredAt:number;
  summary:{stopped?:number;unknown?:number;retained?:number;requeued?:number;notSubmitted?:number;unresolved?:number};
  items?:{deliveryId:string;outcome:'receipt_found'|'not_submitted'|'receipt_conflict';beforeState:RetryBatchNotificationRetryBatchItemState;afterState:RetryBatchNotificationRetryBatchItemState}[];
}
export interface RetryBatchNotificationRetryBatchControlResult {batch:RetryBatchNotificationRetryBatch;replayed:boolean;operation:RetryBatchNotificationRetryBatchControlOperation}
export interface RetryBatchNotificationRetryBatchOperationList {operations:RetryBatchNotificationRetryBatchControlOperation[];nextCursor:string|null}
