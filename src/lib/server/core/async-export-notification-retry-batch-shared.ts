import type {RuntimeEnv} from './types';

type ControlGuard={mailboxId:string;expectedVersion:number;auditId:string};
type LeaseGuard={mailboxId:string;deliveryId:string;leaseToken:string;itemVersion:number};
/** Derive progress from immutable item results in the same transaction as each mutation. */
export function exportRetryBatchSyncStatement(env:RuntimeEnv,batchId:string,at:number,guard?:ControlGuard|LeaseGuard):D1PreparedStatement{
  const control=guard&&'auditId' in guard?guard:null,lease=guard&&'leaseToken' in guard?guard:null;
  return env.DB.prepare(`WITH counts AS(SELECT
      COALESCE(SUM(state IN('requeued','skipped','failed','unknown')),0) processed,
      COALESCE(SUM(state='requeued'),0) requeued,COALESCE(SUM(state='skipped'),0) skipped,
      COALESCE(SUM(state='failed'),0) failed,COALESCE(SUM(state='unknown'),0) unknown
      FROM async_export_notification_retry_items WHERE batch_id=?)
    UPDATE async_export_notification_retry_batches SET
      (processed_items,requeued_items,skipped_items,failed_items,unknown_items)=(SELECT processed,requeued,skipped,failed,unknown FROM counts),
      state=CASE WHEN cancelled_at IS NOT NULL THEN state WHEN state='expired' THEN 'expired' WHEN(SELECT processed=total_items AND unknown=0 FROM counts) THEN 'completed' ELSE 'running' END,
      completed_at=CASE WHEN cancelled_at IS NOT NULL THEN COALESCE(completed_at,cancelled_at) WHEN state='expired' THEN COALESCE(completed_at,?) WHEN(SELECT processed=total_items AND unknown=0 FROM counts) THEN COALESCE(completed_at,?) ELSE completed_at END,
      version=version+1,updated_at=MAX(updated_at+1,?)
    WHERE id=? AND((state IN('queued','running','expired') AND committed_at IS NOT NULL) OR cancelled_at IS NOT NULL)
      ${control?`AND mailbox_id=? AND version=? AND EXISTS(SELECT 1 FROM audit_events a WHERE a.id=? AND a.mailbox_id=async_export_notification_retry_batches.mailbox_id AND a.resource_id=async_export_notification_retry_batches.id)`:''}
      ${lease?`AND mailbox_id=? AND cancelled_at IS NULL AND EXISTS(SELECT 1 FROM async_export_notification_retry_items i WHERE i.batch_id=async_export_notification_retry_batches.id AND i.mailbox_id=async_export_notification_retry_batches.mailbox_id AND i.delivery_id=? AND i.state='running' AND i.lease_token=? AND i.version=?)`:''} RETURNING id`)
    .bind(batchId,at,at,at,batchId,...(control?[control.mailboxId,control.expectedVersion,control.auditId]:[]),...(lease?[lease.mailboxId,lease.deliveryId,lease.leaseToken,lease.itemVersion]:[]));
}
