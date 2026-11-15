-- Capture new result transitions only; upgrading never backfills old completed/abnormal batches.
CREATE TABLE async_export_retry_batch_notifications (
 id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',(random()&3)+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))),
 mailbox_id TEXT NOT NULL,batch_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('completed','failed','needs_reconciliation')),
 reason TEXT NOT NULL CHECK(reason IN('completed','execution_failed','expired','unknown_results')),
 source_version INTEGER NOT NULL CHECK(source_version>0),
 endpoint_snapshot_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(endpoint_snapshot_json) AND json_type(endpoint_snapshot_json)='array' AND json_array_length(endpoint_snapshot_json)<=10),
 batch_state TEXT NOT NULL CHECK(batch_state IN('preview','queued','running','completed','expired','cancelled')),
 total_items INTEGER NOT NULL CHECK(total_items BETWEEN 0 AND 1000),eligible_items INTEGER NOT NULL CHECK(eligible_items BETWEEN 0 AND total_items),
 processed_items INTEGER NOT NULL CHECK(processed_items BETWEEN 0 AND total_items),
 requeued_items INTEGER NOT NULL CHECK(requeued_items>=0),skipped_items INTEGER NOT NULL CHECK(skipped_items>=0),
 failed_items INTEGER NOT NULL CHECK(failed_items>=0),unknown_items INTEGER NOT NULL CHECK(unknown_items>=0),
 occurred_at INTEGER NOT NULL CHECK(occurred_at>=0),created_at INTEGER NOT NULL CHECK(created_at>=occurred_at),
 acknowledged_at INTEGER CHECK(acknowledged_at IS NULL OR acknowledged_at>=created_at),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 event_id TEXT UNIQUE,projected_at INTEGER CHECK(projected_at IS NULL OR projected_at>=created_at),
 notification_decision TEXT CHECK(notification_decision IS NULL OR notification_decision IN('allowed','disabled','quiet_hours','repeat_limited','no_subscribers')),
 policy_version INTEGER CHECK(policy_version IS NULL OR policy_version>=0),decided_at INTEGER CHECK(decided_at IS NULL OR decided_at>=0),claim_token TEXT,
 FOREIGN KEY(mailbox_id,batch_id) REFERENCES async_export_notification_retry_batches(mailbox_id,id),
 FOREIGN KEY(mailbox_id,event_id) REFERENCES events(mailbox_id,id),
 UNIQUE(batch_id,kind,source_version),
 CHECK(processed_items=requeued_items+skipped_items+failed_items+unknown_items),
 CHECK((kind='completed' AND reason='completed' AND batch_state='completed' AND processed_items=total_items AND unknown_items=0)
   OR(kind='failed' AND reason='execution_failed' AND failed_items>0)
   OR(kind='failed' AND reason='expired' AND batch_state='expired')
   OR(kind='needs_reconciliation' AND reason='unknown_results' AND unknown_items>0)),
 CHECK((event_id IS NULL)=(projected_at IS NULL)),
 CHECK((notification_decision IS NULL AND policy_version IS NULL AND decided_at IS NULL AND claim_token IS NULL)
   OR(notification_decision IS NOT NULL AND policy_version IS NOT NULL AND decided_at IS NOT NULL AND claim_token IS NOT NULL AND length(claim_token)>0)),
 CHECK(notification_decision IS NULL OR event_id IS NOT NULL)
) STRICT;
CREATE INDEX retry_batch_notifications_mailbox ON async_export_retry_batch_notifications(mailbox_id,created_at DESC,id DESC);
CREATE INDEX retry_batch_notifications_unread ON async_export_retry_batch_notifications(mailbox_id,acknowledged_at,created_at DESC,id DESC);
CREATE INDEX retry_batch_notifications_project ON async_export_retry_batch_notifications(projected_at,created_at,id);
CREATE TRIGGER retry_batch_notification_identity BEFORE UPDATE ON async_export_retry_batch_notifications
 WHEN NEW.id IS NOT OLD.id OR NEW.mailbox_id IS NOT OLD.mailbox_id OR NEW.batch_id IS NOT OLD.batch_id
 OR NEW.kind IS NOT OLD.kind OR NEW.reason IS NOT OLD.reason OR NEW.source_version IS NOT OLD.source_version OR NEW.batch_state IS NOT OLD.batch_state OR NEW.endpoint_snapshot_json IS NOT OLD.endpoint_snapshot_json
 OR NEW.total_items IS NOT OLD.total_items OR NEW.eligible_items IS NOT OLD.eligible_items OR NEW.processed_items IS NOT OLD.processed_items
 OR NEW.requeued_items IS NOT OLD.requeued_items OR NEW.skipped_items IS NOT OLD.skipped_items OR NEW.failed_items IS NOT OLD.failed_items OR NEW.unknown_items IS NOT OLD.unknown_items
 OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.created_at IS NOT OLD.created_at
 OR NOT((NEW.acknowledged_at IS OLD.acknowledged_at AND NEW.version=OLD.version)
   OR(OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL AND NEW.version=OLD.version+1))
 OR(OLD.event_id IS NOT NULL AND(NEW.event_id IS NOT OLD.event_id OR NEW.projected_at IS NOT OLD.projected_at))
 OR(OLD.notification_decision IS NOT NULL AND(NEW.notification_decision IS NOT OLD.notification_decision OR NEW.policy_version IS NOT OLD.policy_version
   OR NEW.decided_at IS NOT OLD.decided_at OR NEW.claim_token IS NOT OLD.claim_token))
 BEGIN SELECT RAISE(ABORT,'Retry batch notification facts/receipts are immutable'); END;
CREATE TRIGGER retry_batch_notification_retained BEFORE DELETE ON async_export_retry_batch_notifications
 BEGIN SELECT RAISE(ABORT,'Retry batch notification history is retained'); END;
CREATE TRIGGER retry_batch_result_notification AFTER UPDATE OF state,failed_items,unknown_items ON async_export_notification_retry_batches
 BEGIN
  INSERT INTO async_export_retry_batch_notifications(mailbox_id,batch_id,kind,reason,source_version,batch_state,total_items,eligible_items,processed_items,requeued_items,skipped_items,failed_items,unknown_items,occurred_at,created_at,endpoint_snapshot_json)
  SELECT NEW.mailbox_id,NEW.id,'completed','completed',NEW.version,'completed',NEW.total_items,NEW.eligible_items,NEW.processed_items,NEW.requeued_items,NEW.skipped_items,NEW.failed_items,NEW.unknown_items,NEW.updated_at,NEW.updated_at,
   (SELECT json_group_array(json_object('id',w.id,'version',w.secret_version,'updatedAt',w.updated_at)) FROM(SELECT id,secret_version,updated_at FROM webhook_endpoints WHERE mailbox_id=NEW.mailbox_id AND status='active' AND EXISTS(SELECT 1 FROM json_each(event_types_json) WHERE value='alert_notification.retry_batch.completed') ORDER BY id LIMIT 10) w)
   WHERE NEW.cancelled_at IS NULL AND NEW.committed_at IS NOT NULL AND OLD.state<>'completed' AND NEW.state='completed';
  INSERT INTO async_export_retry_batch_notifications(mailbox_id,batch_id,kind,reason,source_version,batch_state,total_items,eligible_items,processed_items,requeued_items,skipped_items,failed_items,unknown_items,occurred_at,created_at,endpoint_snapshot_json)
  SELECT NEW.mailbox_id,NEW.id,'failed',CASE WHEN NEW.cancelled_at IS NULL AND NEW.state='expired' AND OLD.state<>'expired' THEN 'expired' ELSE 'execution_failed' END,NEW.version,
   CASE WHEN NEW.cancelled_at IS NOT NULL THEN 'cancelled' ELSE NEW.state END,NEW.total_items,NEW.eligible_items,NEW.processed_items,NEW.requeued_items,NEW.skipped_items,NEW.failed_items,NEW.unknown_items,NEW.updated_at,NEW.updated_at,
   (SELECT json_group_array(json_object('id',w.id,'version',w.secret_version,'updatedAt',w.updated_at)) FROM(SELECT id,secret_version,updated_at FROM webhook_endpoints WHERE mailbox_id=NEW.mailbox_id AND status='active' AND EXISTS(SELECT 1 FROM json_each(event_types_json) WHERE value='alert_notification.retry_batch.failed') ORDER BY id LIMIT 10) w)
   WHERE NEW.committed_at IS NOT NULL AND((OLD.failed_items=0 AND NEW.failed_items>0)
    OR(NEW.cancelled_at IS NULL AND OLD.state<>'expired' AND NEW.state='expired'));
  INSERT INTO async_export_retry_batch_notifications(mailbox_id,batch_id,kind,reason,source_version,batch_state,total_items,eligible_items,processed_items,requeued_items,skipped_items,failed_items,unknown_items,occurred_at,created_at,endpoint_snapshot_json)
  SELECT NEW.mailbox_id,NEW.id,'needs_reconciliation','unknown_results',NEW.version,CASE WHEN NEW.cancelled_at IS NOT NULL THEN 'cancelled' ELSE NEW.state END,
   NEW.total_items,NEW.eligible_items,NEW.processed_items,NEW.requeued_items,NEW.skipped_items,NEW.failed_items,NEW.unknown_items,NEW.updated_at,NEW.updated_at,
   (SELECT json_group_array(json_object('id',w.id,'version',w.secret_version,'updatedAt',w.updated_at)) FROM(SELECT id,secret_version,updated_at FROM webhook_endpoints WHERE mailbox_id=NEW.mailbox_id AND status='active' AND EXISTS(SELECT 1 FROM json_each(event_types_json) WHERE value='alert_notification.retry_batch.needs_reconciliation') ORDER BY id LIMIT 10) w)
   WHERE NEW.committed_at IS NOT NULL AND OLD.unknown_items=0 AND NEW.unknown_items>0;
 END;
