import type {AsyncExportNotificationDecision} from './async-export-notifications';
import type {AsyncExportRetryBatchState} from './async-export-notification-retry-batches';

export type RetryBatchNotificationKind='completed'|'failed'|'needs_reconciliation';
export type RetryBatchNotificationReason='completed'|'execution_failed'|'expired'|'unknown_results';
export interface RetryBatchNotificationCounts {
  totalItems:number;eligibleItems:number;processedItems:number;requeuedItems:number;skippedItems:number;failedItems:number;unknownItems:number;
}
export interface RetryBatchNotification extends RetryBatchNotificationCounts {
  id:string;mailboxId:string;batchId:string;kind:RetryBatchNotificationKind;reason:RetryBatchNotificationReason;
  batchState:AsyncExportRetryBatchState;sourceVersion:number;occurredAt:number;createdAt:number;acknowledgedAt:number|null;version:number;
  notificationDecision:AsyncExportNotificationDecision|null;policyVersion:number|null;decidedAt:number|null;
  currentAttention:boolean;currentBatch:RetryBatchNotificationCounts&{state:AsyncExportRetryBatchState;version:number};
}
export interface RetryBatchNotificationList {
  notifications:RetryBatchNotification[];nextCursor:string|null;
  summary:{unread:number;attention:number;completed:number;failed:number;needsReconciliation:number};
}
