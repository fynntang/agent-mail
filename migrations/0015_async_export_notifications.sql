-- Terminal facts are captured in the same transaction as export completion/failure.
-- Existing terminal jobs are deliberately not backfilled into new notifications.
CREATE TABLE async_export_notifications (
 job_id TEXT PRIMARY KEY NOT NULL, mailbox_id TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN('succeeded','failed')),
 format TEXT NOT NULL CHECK(format IN('csv','json')),
 total_decisions INTEGER NOT NULL CHECK(total_decisions BETWEEN 0 AND 100000),
 processed_decisions INTEGER NOT NULL CHECK(processed_decisions BETWEEN 0 AND total_decisions),
 processed_deliveries INTEGER NOT NULL CHECK(processed_deliveries BETWEEN 0 AND 1000000),
 body_bytes INTEGER NOT NULL CHECK(body_bytes BETWEEN 0 AND 268435456),
 error_code TEXT CHECK(error_code IS NULL OR error_code IN('async_export_failed','async_export_storage_unavailable','async_export_limit_exceeded',
  'async_export_batch_too_large','async_export_lease_expired','async_export_checksum_mismatch','async_export_missing_chunk','async_export_expired','async_export_source_changed')),
 completed_at INTEGER NOT NULL CHECK(completed_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>=0),
 created_at INTEGER NOT NULL CHECK(created_at>=0), acknowledged_at INTEGER CHECK(acknowledged_at IS NULL OR acknowledged_at>=created_at),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 event_id TEXT UNIQUE, projected_at INTEGER CHECK(projected_at IS NULL OR projected_at>=created_at),
 notification_decision TEXT CHECK(notification_decision IS NULL OR notification_decision IN('allowed','disabled','quiet_hours','repeat_limited','no_subscribers')),
 policy_version INTEGER CHECK(policy_version IS NULL OR policy_version>=0),
 decided_at INTEGER CHECK(decided_at IS NULL OR decided_at>=0), claim_token TEXT,
 FOREIGN KEY(mailbox_id,job_id) REFERENCES async_alert_notification_exports(mailbox_id,id),
 FOREIGN KEY(mailbox_id,event_id) REFERENCES events(mailbox_id,id),
 CHECK((event_id IS NULL)=(projected_at IS NULL)),
 CHECK((notification_decision IS NULL AND policy_version IS NULL AND decided_at IS NULL AND claim_token IS NULL)
  OR(notification_decision IS NOT NULL AND policy_version IS NOT NULL AND decided_at IS NOT NULL AND claim_token IS NOT NULL AND length(claim_token)>0)),
 CHECK(notification_decision IS NULL OR event_id IS NOT NULL),
 CHECK(outcome<>'succeeded' OR(processed_decisions=total_decisions AND error_code IS NULL))
) STRICT;
CREATE INDEX async_export_notifications_mailbox ON async_export_notifications(mailbox_id,created_at DESC,job_id DESC);
CREATE INDEX async_export_notifications_unread ON async_export_notifications(mailbox_id,acknowledged_at,created_at DESC,job_id DESC);
CREATE INDEX async_export_notifications_project ON async_export_notifications(projected_at,created_at,job_id);
CREATE TRIGGER async_export_notification_identity BEFORE UPDATE ON async_export_notifications
 WHEN NEW.job_id IS NOT OLD.job_id OR NEW.mailbox_id IS NOT OLD.mailbox_id OR NEW.outcome IS NOT OLD.outcome OR NEW.format IS NOT OLD.format
 OR NEW.total_decisions IS NOT OLD.total_decisions OR NEW.processed_decisions IS NOT OLD.processed_decisions
 OR NEW.processed_deliveries IS NOT OLD.processed_deliveries OR NEW.body_bytes IS NOT OLD.body_bytes OR NEW.error_code IS NOT OLD.error_code
 OR NEW.completed_at IS NOT OLD.completed_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
 OR NOT((NEW.acknowledged_at IS OLD.acknowledged_at AND NEW.version=OLD.version)
   OR(OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL AND NEW.version=OLD.version+1))
 OR(OLD.event_id IS NOT NULL AND(NEW.event_id IS NOT OLD.event_id OR NEW.projected_at IS NOT OLD.projected_at))
 OR(OLD.notification_decision IS NOT NULL AND(NEW.notification_decision IS NOT OLD.notification_decision OR NEW.policy_version IS NOT OLD.policy_version
   OR NEW.decided_at IS NOT OLD.decided_at OR NEW.claim_token IS NOT OLD.claim_token))
 BEGIN SELECT RAISE(ABORT,'Async export notification facts/receipts are immutable'); END;
CREATE TRIGGER async_export_notification_retained BEFORE DELETE ON async_export_notifications
 BEGIN SELECT RAISE(ABORT,'Async export notification is retained'); END;
CREATE TABLE async_export_notification_state (
 mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), fingerprint TEXT NOT NULL CHECK(length(fingerprint) BETWEEN 1 AND 1024),
 last_notified_at INTEGER NOT NULL CHECK(last_notified_at>=0), PRIMARY KEY(mailbox_id,fingerprint)
) STRICT;
CREATE TRIGGER async_export_notification_state_identity BEFORE UPDATE ON async_export_notification_state
 WHEN NEW.mailbox_id IS NOT OLD.mailbox_id OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.last_notified_at<OLD.last_notified_at
 BEGIN SELECT RAISE(ABORT,'Async export notification state identity is immutable'); END;
CREATE TRIGGER async_export_terminal_notification AFTER UPDATE OF state ON async_alert_notification_exports
 WHEN OLD.state IN('queued','running') AND NEW.state IN('succeeded','failed')
 BEGIN
  INSERT INTO async_export_notifications(job_id,mailbox_id,outcome,format,total_decisions,processed_decisions,processed_deliveries,body_bytes,
   error_code,completed_at,expires_at,created_at)
  VALUES(NEW.id,NEW.mailbox_id,NEW.state,NEW.format,NEW.total_decisions,NEW.processed_decisions,NEW.processed_deliveries,NEW.body_bytes,
   CASE WHEN NEW.state='succeeded' THEN NULL WHEN NEW.error_code IN('async_export_failed','async_export_storage_unavailable','async_export_limit_exceeded',
    'async_export_batch_too_large','async_export_lease_expired','async_export_checksum_mismatch','async_export_missing_chunk','async_export_expired','async_export_source_changed')
    THEN NEW.error_code ELSE 'async_export_failed' END,COALESCE(NEW.completed_at,NEW.updated_at),NEW.expires_at,COALESCE(NEW.completed_at,NEW.updated_at));
 END;
