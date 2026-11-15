-- Async Owner exports use immutable private R2 fragments. Metadata remains after expiry for safe orphan cleanup.
CREATE TABLE async_alert_notification_exports (
 id TEXT PRIMARY KEY NOT NULL, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
 client_request_id TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 format TEXT NOT NULL CHECK(format IN('csv','json')),
 filter_decision TEXT NOT NULL CHECK(filter_decision IN('all','allowed','disabled','quiet_hours','repeat_limited','recovery_disabled','no_subscribers')),
 filter_event_type TEXT NOT NULL CHECK(filter_event_type IN('all','created','resolved')),
 from_ms INTEGER NOT NULL CHECK(from_ms>=0), to_ms INTEGER NOT NULL CHECK(to_ms>from_ms AND to_ms-from_ms<=2678400000),
 decision_watermark INTEGER NOT NULL CHECK(decision_watermark>=0),
 total_decisions INTEGER NOT NULL CHECK(total_decisions BETWEEN 0 AND 100000),
 processed_decisions INTEGER NOT NULL DEFAULT 0 CHECK(processed_decisions>=0 AND processed_decisions<=total_decisions),
 processed_deliveries INTEGER NOT NULL DEFAULT 0 CHECK(processed_deliveries BETWEEN 0 AND 1000000),
 next_time INTEGER, next_event_id TEXT, chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count>=0),
 body_bytes INTEGER NOT NULL DEFAULT 0 CHECK(body_bytes BETWEEN 0 AND 268435456),
 summary_json TEXT NOT NULL CHECK(json_valid(summary_json) AND json_type(summary_json)='object' AND length(summary_json)<=8192),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','succeeded','failed','cancelled','expired')),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code)<=80),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
 started_at INTEGER, completed_at INTEGER, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 observed_from INTEGER, observed_to INTEGER,
 lease_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0), available_at INTEGER NOT NULL CHECK(available_at>=0),
 cleanup_due_at INTEGER NOT NULL CHECK(cleanup_due_at>=0), last_cleanup_at INTEGER,
 UNIQUE(mailbox_id,id), UNIQUE(mailbox_id,client_request_id),
 CHECK((next_time IS NULL)=(next_event_id IS NULL)), CHECK(next_time IS NULL OR next_time>=0),
 CHECK((observed_from IS NULL)=(observed_to IS NULL)), CHECK(observed_from IS NULL OR observed_to>=observed_from),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR(state<>'running' AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK(state<>'succeeded' OR processed_decisions=total_decisions)
) STRICT;
CREATE INDEX async_export_claim ON async_alert_notification_exports(state,available_at,created_at,id);
CREATE INDEX async_export_mailbox_list ON async_alert_notification_exports(mailbox_id,created_at DESC,id DESC);
CREATE INDEX async_export_cleanup ON async_alert_notification_exports(state,cleanup_due_at,id);
CREATE TRIGGER async_export_identity BEFORE UPDATE ON async_alert_notification_exports
 WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.client_request_id<>OLD.client_request_id OR NEW.request_hash<>OLD.request_hash
 OR NEW.format<>OLD.format OR NEW.filter_decision<>OLD.filter_decision OR NEW.filter_event_type<>OLD.filter_event_type
 OR NEW.from_ms<>OLD.from_ms OR NEW.to_ms<>OLD.to_ms OR NEW.decision_watermark<>OLD.decision_watermark OR NEW.total_decisions<>OLD.total_decisions
 OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at OR NEW.version<>OLD.version+1 OR NEW.updated_at<=OLD.updated_at
 OR NEW.processed_decisions<OLD.processed_decisions OR NEW.processed_deliveries<OLD.processed_deliveries OR NEW.chunk_count<OLD.chunk_count OR NEW.body_bytes<OLD.body_bytes
 OR NEW.attempts<OLD.attempts OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
 OR (OLD.observed_from IS NOT NULL AND (NEW.observed_from IS NOT OLD.observed_from OR NEW.observed_to<OLD.observed_to))
 OR (OLD.state='queued' AND NEW.state NOT IN('queued','running','cancelled','expired'))
 OR (OLD.state='running' AND NEW.state NOT IN('running','queued','succeeded','failed','cancelled','expired'))
 OR (OLD.state='succeeded' AND NEW.state NOT IN('succeeded','expired'))
 OR (OLD.state IN('failed','cancelled','expired') AND NEW.state<>OLD.state)
 BEGIN SELECT RAISE(ABORT,'Async export identity/progress is immutable'); END;
CREATE TRIGGER async_export_retained BEFORE DELETE ON async_alert_notification_exports BEGIN SELECT RAISE(ABORT,'Async export cleanup tombstone is retained'); END;
CREATE TABLE async_alert_notification_export_chunks (
 job_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
 object_key TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=8388608),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'), created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(job_id,sequence), FOREIGN KEY(mailbox_id,job_id) REFERENCES async_alert_notification_exports(mailbox_id,id)
) STRICT;
CREATE TRIGGER async_export_chunk_update BEFORE UPDATE ON async_alert_notification_export_chunks BEGIN SELECT RAISE(ABORT,'Async export chunks are immutable'); END;
CREATE TRIGGER async_export_chunk_delete BEFORE DELETE ON async_alert_notification_export_chunks BEGIN SELECT RAISE(ABORT,'Async export chunk manifest is retained'); END;
