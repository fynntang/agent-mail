-- Webhook publication and immutable delivery snapshots; existing mail and send approvals are preserved.
ALTER TABLE events ADD COLUMN webhook_published_at INTEGER CHECK(webhook_published_at IS NULL OR webhook_published_at>=0);
UPDATE events SET webhook_published_at=created_at;
CREATE INDEX events_webhook_pending ON events(created_at,id) WHERE webhook_published_at IS NULL;
CREATE TRIGGER webhook_event_identity BEFORE UPDATE ON events
 WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.source<>OLD.source OR NEW.source_event_id<>OLD.source_event_id
 OR NEW.type<>OLD.type OR NEW.payload_json<>OLD.payload_json OR NEW.occurred_at<>OLD.occurred_at OR NEW.created_at<>OLD.created_at
 BEGIN SELECT RAISE(ABORT,'mail event content is immutable'); END;
ALTER TABLE webhook_endpoints ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0 CHECK(updated_at>=0);
ALTER TABLE webhook_endpoints ADD COLUMN event_after_rowid INTEGER NOT NULL DEFAULT 0 CHECK(event_after_rowid>=0);
UPDATE webhook_endpoints SET updated_at=created_at;
ALTER TABLE webhook_deliveries ADD COLUMN url_snapshot TEXT NOT NULL DEFAULT '' CHECK(length(url_snapshot)<=2048);
ALTER TABLE webhook_deliveries ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json) AND json_type(payload_json)='object' AND length(payload_json)<=8192);
ALTER TABLE webhook_deliveries ADD COLUMN last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code)<=80);
ALTER TABLE webhook_deliveries ADD COLUMN completed_at INTEGER CHECK(completed_at IS NULL OR completed_at>=0);
ALTER TABLE webhook_deliveries ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0 CHECK(updated_at>=0);
ALTER TABLE webhook_deliveries ADD COLUMN attempt_budget INTEGER NOT NULL DEFAULT 8 CHECK(attempt_budget BETWEEN 8 AND 80);
-- Pre-feature rows have no verified notification snapshot and must never be submitted.
UPDATE webhook_deliveries SET state='cancelled',lease_token=NULL,lease_until=NULL,last_error_code='legacy_snapshot_unavailable',updated_at=created_at,completed_at=created_at;
CREATE TABLE webhook_delivery_attempts (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
 attempt_no INTEGER NOT NULL CHECK(attempt_no>0), lease_token TEXT NOT NULL,
 outcome TEXT NOT NULL DEFAULT 'started' CHECK(outcome IN('started','succeeded','retry','dead','expired','cancelled')),
 http_status INTEGER CHECK(http_status IS NULL OR http_status BETWEEN 100 AND 599),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code)<=80),
 started_at INTEGER NOT NULL CHECK(started_at>=0), finished_at INTEGER CHECK(finished_at IS NULL OR finished_at>=started_at),
 UNIQUE(mailbox_id,id), UNIQUE(delivery_id,attempt_no),
 FOREIGN KEY(mailbox_id,delivery_id) REFERENCES webhook_deliveries(mailbox_id,id)
) STRICT;
CREATE INDEX webhook_attempt_list ON webhook_delivery_attempts(mailbox_id,delivery_id,attempt_no DESC);
CREATE TRIGGER webhook_endpoint_identity BEFORE UPDATE ON webhook_endpoints
 WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.url<>OLD.url OR NEW.created_at<>OLD.created_at
 OR NEW.secret_version<OLD.secret_version OR NEW.updated_at<OLD.updated_at OR NEW.event_after_rowid<OLD.event_after_rowid
 OR (OLD.status='disabled' AND NEW.status<>'disabled')
 BEGIN SELECT RAISE(ABORT,'webhook endpoint identity is immutable'); END;
CREATE TRIGGER webhook_delivery_snapshot BEFORE UPDATE ON webhook_deliveries
 WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.endpoint_id<>OLD.endpoint_id OR NEW.event_id<>OLD.event_id
 OR NEW.url_snapshot<>OLD.url_snapshot OR NEW.payload_json<>OLD.payload_json OR NEW.created_at<>OLD.created_at
 OR NEW.signed_secret_version<>OLD.signed_secret_version OR NEW.signing_secret_ciphertext<>OLD.signing_secret_ciphertext
 OR NEW.attempts<OLD.attempts OR NEW.attempt_budget<OLD.attempt_budget OR NEW.updated_at<OLD.updated_at
 BEGIN SELECT RAISE(ABORT,'webhook delivery snapshot is immutable'); END;
CREATE TRIGGER webhook_attempt_identity BEFORE UPDATE ON webhook_delivery_attempts
 WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.delivery_id<>OLD.delivery_id OR NEW.attempt_no<>OLD.attempt_no
 OR NEW.lease_token<>OLD.lease_token OR NEW.started_at<>OLD.started_at OR (OLD.outcome<>'started' AND NEW.outcome<>OLD.outcome)
 BEGIN SELECT RAISE(ABORT,'webhook attempt identity is immutable'); END;
