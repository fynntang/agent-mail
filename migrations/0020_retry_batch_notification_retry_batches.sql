-- Separate execution history has no terminal notification trigger: retrying a notice cannot recursively create notice events.
CREATE UNIQUE INDEX retry_batch_notifications_target ON async_export_retry_batch_notifications(mailbox_id,id,batch_id);
-- Immutable Owner-reviewed selection, independent bounded execution and result receipts.
CREATE TABLE retry_batch_notification_retry_batches (
 id TEXT PRIMARY KEY NOT NULL,mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
 preview_request_id TEXT NOT NULL,request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 from_ms INTEGER NOT NULL CHECK(from_ms>=0),to_ms INTEGER NOT NULL CHECK(to_ms>from_ms AND to_ms-from_ms<=2678400000),
 filter_reason TEXT NOT NULL CHECK(length(filter_reason) BETWEEN 1 AND 80),
 state TEXT NOT NULL DEFAULT 'preview' CHECK(state IN('preview','queued','running','completed','expired')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at INTEGER NOT NULL CHECK(created_at>=0),updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),preview_expires_at INTEGER NOT NULL CHECK(preview_expires_at>created_at AND preview_expires_at<=expires_at),
 commit_request_id TEXT,commit_expected_version INTEGER CHECK(commit_expected_version IS NULL OR commit_expected_version>0),
 committed_at INTEGER,completed_at INTEGER,cancelled_at INTEGER CHECK(cancelled_at IS NULL OR cancelled_at>=0),
 total_items INTEGER NOT NULL CHECK(total_items BETWEEN 0 AND 1000),eligible_items INTEGER NOT NULL CHECK(eligible_items BETWEEN 0 AND total_items),
 processed_items INTEGER NOT NULL DEFAULT 0 CHECK(processed_items BETWEEN 0 AND total_items),
 requeued_items INTEGER NOT NULL DEFAULT 0 CHECK(requeued_items>=0),skipped_items INTEGER NOT NULL DEFAULT 0 CHECK(skipped_items>=0),
 failed_items INTEGER NOT NULL DEFAULT 0 CHECK(failed_items>=0),unknown_items INTEGER NOT NULL DEFAULT 0 CHECK(unknown_items>=0),
 UNIQUE(mailbox_id,id),UNIQUE(mailbox_id,preview_request_id),UNIQUE(mailbox_id,commit_request_id),
 CHECK(processed_items=requeued_items+skipped_items+failed_items+unknown_items),
 CHECK((commit_request_id IS NULL AND commit_expected_version IS NULL AND committed_at IS NULL)
   OR(commit_request_id IS NOT NULL AND commit_expected_version IS NOT NULL AND committed_at IS NOT NULL)),
 CHECK(state NOT IN('queued','running','completed') OR committed_at IS NOT NULL),
 CHECK(state<>'completed' OR(processed_items=total_items AND unknown_items=0 AND completed_at IS NOT NULL))
) STRICT;
CREATE INDEX notice_retry_batch_mailbox ON retry_batch_notification_retry_batches(mailbox_id,created_at DESC,id DESC);
CREATE INDEX notice_retry_batch_claim ON retry_batch_notification_retry_batches(state,updated_at,id);
CREATE TRIGGER notice_retry_batch_identity BEFORE UPDATE ON retry_batch_notification_retry_batches
 WHEN NEW.id IS NOT OLD.id OR NEW.mailbox_id IS NOT OLD.mailbox_id OR NEW.preview_request_id IS NOT OLD.preview_request_id OR NEW.request_hash IS NOT OLD.request_hash
 OR NEW.from_ms IS NOT OLD.from_ms OR NEW.to_ms IS NOT OLD.to_ms OR NEW.filter_reason IS NOT OLD.filter_reason
 OR NEW.total_items IS NOT OLD.total_items OR NEW.eligible_items IS NOT OLD.eligible_items OR NEW.created_at IS NOT OLD.created_at
 OR NEW.expires_at IS NOT OLD.expires_at OR NEW.preview_expires_at IS NOT OLD.preview_expires_at OR NEW.version<>OLD.version+1 OR NEW.updated_at<=OLD.updated_at
 OR NEW.processed_items<OLD.processed_items
 OR(OLD.commit_request_id IS NOT NULL AND(NEW.commit_request_id IS NOT OLD.commit_request_id OR NEW.commit_expected_version IS NOT OLD.commit_expected_version OR NEW.committed_at IS NOT OLD.committed_at))
 OR(OLD.state='preview' AND NEW.state NOT IN('preview','queued','expired'))
 OR(OLD.state='queued' AND NEW.state NOT IN('queued','running','completed','expired'))
 OR(OLD.state='running' AND NEW.state NOT IN('running','completed','expired'))
 OR(OLD.state='completed' AND NEW.state<>'completed') OR(OLD.state='expired' AND NEW.state<>'expired')
 BEGIN SELECT RAISE(ABORT,'Batch retry identity/selection is immutable'); END;
CREATE TRIGGER notice_retry_batch_retained BEFORE DELETE ON retry_batch_notification_retry_batches
 BEGIN SELECT RAISE(ABORT,'Batch retry history is retained'); END;
CREATE TABLE retry_batch_notification_retry_items (
 batch_id TEXT NOT NULL,mailbox_id TEXT NOT NULL,delivery_id TEXT NOT NULL,notification_id TEXT NOT NULL,source_batch_id TEXT NOT NULL,
 expected_updated_at INTEGER NOT NULL CHECK(expected_updated_at>=0),failure_reason TEXT NOT NULL CHECK(length(failure_reason) BETWEEN 1 AND 80),failed_at INTEGER NOT NULL CHECK(failed_at>=0),
 preview_eligible INTEGER NOT NULL CHECK(preview_eligible IN(0,1)),preview_reason TEXT CHECK(preview_reason IS NULL OR length(preview_reason)<=80),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','requeued','skipped','failed','unknown')),
 client_request_id TEXT NOT NULL UNIQUE,reason TEXT CHECK(reason IS NULL OR length(reason)<=80),manual_retry_id TEXT REFERENCES audit_events(id),
 created_at INTEGER NOT NULL CHECK(created_at>=0),updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),completed_at INTEGER,
 lease_token TEXT,lease_until INTEGER,version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(batch_id,delivery_id),
 FOREIGN KEY(mailbox_id,batch_id) REFERENCES retry_batch_notification_retry_batches(mailbox_id,id),
 FOREIGN KEY(mailbox_id,delivery_id) REFERENCES webhook_deliveries(mailbox_id,id),
 FOREIGN KEY(mailbox_id,notification_id,source_batch_id) REFERENCES async_export_retry_batch_notifications(mailbox_id,id,batch_id),
 CHECK((preview_eligible=1 AND preview_reason IS NULL) OR(preview_eligible=0 AND preview_reason IS NOT NULL)),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR(state<>'running' AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK(state NOT IN('requeued','skipped','failed','unknown') OR completed_at IS NOT NULL)
) STRICT;
CREATE INDEX notice_retry_item_claim ON retry_batch_notification_retry_items(state,updated_at,batch_id,delivery_id);
CREATE INDEX notice_retry_item_batch ON retry_batch_notification_retry_items(batch_id,delivery_id);
CREATE TRIGGER notice_retry_item_identity BEFORE UPDATE ON retry_batch_notification_retry_items
 WHEN NEW.batch_id IS NOT OLD.batch_id OR NEW.mailbox_id IS NOT OLD.mailbox_id OR NEW.delivery_id IS NOT OLD.delivery_id OR NEW.notification_id IS NOT OLD.notification_id OR NEW.source_batch_id IS NOT OLD.source_batch_id
 OR NEW.expected_updated_at IS NOT OLD.expected_updated_at OR NEW.failure_reason IS NOT OLD.failure_reason OR NEW.failed_at IS NOT OLD.failed_at
 OR NEW.preview_eligible IS NOT OLD.preview_eligible OR NEW.preview_reason IS NOT OLD.preview_reason OR NEW.client_request_id IS NOT OLD.client_request_id OR NEW.created_at IS NOT OLD.created_at
 OR NEW.version<>OLD.version+1 OR NEW.updated_at<=OLD.updated_at
 OR(OLD.manual_retry_id IS NOT NULL AND NEW.manual_retry_id IS NOT OLD.manual_retry_id)
 OR(OLD.state IN('requeued','skipped','failed') AND NEW.state<>OLD.state)
 OR(OLD.state='unknown' AND NEW.state NOT IN('unknown','requeued','skipped','failed'))
 OR(OLD.state='running' AND NEW.state='pending')
 BEGIN SELECT RAISE(ABORT,'Batch retry item selection/result is immutable'); END;
CREATE TRIGGER notice_retry_item_retained BEFORE DELETE ON retry_batch_notification_retry_items
 BEGIN SELECT RAISE(ABORT,'Batch retry item history is retained'); END;

CREATE TRIGGER notice_retry_batch_cancel_immutable BEFORE UPDATE OF cancelled_at ON retry_batch_notification_retry_batches
 WHEN OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NOT OLD.cancelled_at
 BEGIN SELECT RAISE(ABORT,'Notice retry cancellation marker is immutable'); END;
