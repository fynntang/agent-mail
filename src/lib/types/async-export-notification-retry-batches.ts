import type {AsyncExportDeliveryRetryBlockReason} from './async-export-notification-deliveries';

export const ASYNC_EXPORT_BATCH_FAILURE_REASONS=['lease_expired','lease_lost','invalid_target','payload_unavailable','signing_key_unavailable','mailbox_inactive','endpoint_inactive',
  'http_retry','http_rejected','delivery_timeout','network_error','alert_notifications_disabled','alert_recovery_disabled','alert_quiet_hours','legacy_snapshot_unavailable'] as const;
export type AsyncExportBatchFailureReason='all'|'other'|typeof ASYNC_EXPORT_BATCH_FAILURE_REASONS[number];
export type AsyncExportRetryBatchState='preview'|'queued'|'running'|'completed'|'expired'|'cancelled';
export type AsyncExportRetryBatchItemState='pending'|'running'|'requeued'|'skipped'|'failed'|'unknown';
export type AsyncExportRetryBatchItemReason=AsyncExportDeliveryRetryBlockReason|'changed'|'batch_expired'|'batch_cancelled'|'not_submitted'|'result_unknown'|'retry_failed'|'preview_blocked'|'not_found'|'receipt_conflict';
export interface AsyncExportRetryBatch {
  id:string;mailboxId:string;window:{from:number;to:number};filters:{reason:AsyncExportBatchFailureReason};state:AsyncExportRetryBatchState;version:number;
  totalItems:number;eligibleItems:number;processedItems:number;requeuedItems:number;skippedItems:number;failedItems:number;unknownItems:number;
  createdAt:number;updatedAt:number;expiresAt:number;previewExpiresAt:number;committedAt:number|null;completedAt:number|null;cancelledAt:number|null;canCommit:boolean;canCancel:boolean;
}
export interface AsyncExportRetryBatchItem {
  deliveryId:string;jobId:string;expectedUpdatedAt:number;failureReason:Exclude<AsyncExportBatchFailureReason,'all'>;failedAt:number;
  previewEligible:boolean;previewReason:AsyncExportDeliveryRetryBlockReason|null;state:AsyncExportRetryBatchItemState;reason:AsyncExportRetryBatchItemReason|null;
  manualRetryId:string|null;createdAt:number;updatedAt:number;completedAt:number|null;version:number;
}
export interface AsyncExportRetryBatchList {batches:AsyncExportRetryBatch[];nextCursor:string|null}
export interface AsyncExportRetryBatchDetail {batch:AsyncExportRetryBatch;items:AsyncExportRetryBatchItem[];nextCursor:string|null}
export interface AsyncExportRetryBatchPreview extends AsyncExportRetryBatchDetail {replayed:boolean}
export interface AsyncExportRetryBatchCommit {batch:AsyncExportRetryBatch;replayed:boolean}
export interface AsyncExportRetryBatchControlOperation {
  id:string;action:'preview'|'commit'|'cancel'|'reconcile';clientRequestId:string|null;expectedVersion:number|null;occurredAt:number;
  summary:{stopped?:number;unknown?:number;retained?:number;requeued?:number;notSubmitted?:number;unresolved?:number};
  items?:{deliveryId:string;outcome:'receipt_found'|'not_submitted'|'receipt_conflict';beforeState:AsyncExportRetryBatchItemState;afterState:AsyncExportRetryBatchItemState}[];
}
export interface AsyncExportRetryBatchControlResult {batch:AsyncExportRetryBatch;replayed:boolean;operation:AsyncExportRetryBatchControlOperation}
export interface AsyncExportRetryBatchOperationList {operations:AsyncExportRetryBatchControlOperation[];nextCursor:string|null}

export type AsyncExportNotificationRetryBatch=AsyncExportRetryBatch;
export type AsyncExportNotificationRetryBatchItem=AsyncExportRetryBatchItem;
