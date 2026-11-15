ALTER TABLE cloudflare_suppression_operations ADD COLUMN retry_of TEXT REFERENCES cloudflare_suppression_operations(id);
ALTER TABLE cloudflare_suppression_operations ADD COLUMN verified_at INTEGER;
ALTER TABLE cloudflare_suppression_operations ADD COLUMN verified_read_only INTEGER CHECK(verified_read_only IN(0,1));
ALTER TABLE cloudflare_suppression_operations ADD COLUMN verified_version TEXT;
CREATE TRIGGER cloudflare_suppression_retry_identity BEFORE UPDATE ON cloudflare_suppression_operations
 WHEN NEW.retry_of IS NOT OLD.retry_of BEGIN SELECT RAISE(ABORT,'Suppression retry lineage is immutable'); END;
CREATE UNIQUE INDEX cloudflare_suppression_operation_scope ON cloudflare_suppression_operations(account_id,domain,mailbox_id,id);

CREATE TABLE cloudflare_suppression_sync_runs (
 id TEXT PRIMARY KEY NOT NULL, request_hash TEXT NOT NULL, account_id TEXT NOT NULL, domain TEXT NOT NULL,
 mailbox_id TEXT REFERENCES mailboxes(id), source TEXT NOT NULL CHECK(source IN('owner','scheduled')),
 retry_of TEXT REFERENCES cloudflare_suppression_sync_runs(id),
 state TEXT NOT NULL CHECK(state IN('running','succeeded','failed')), count INTEGER,
 error_code TEXT, started_at INTEGER NOT NULL, completed_at INTEGER, lease_token TEXT, lease_until INTEGER,
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 FOREIGN KEY(account_id,domain,retry_of) REFERENCES cloudflare_suppression_sync_runs(account_id,domain,id)
) STRICT;
CREATE UNIQUE INDEX cloudflare_suppression_run_scope ON cloudflare_suppression_sync_runs(account_id,domain,id);
CREATE INDEX cloudflare_suppression_sync_runs_list ON cloudflare_suppression_sync_runs(account_id,domain,started_at DESC,id DESC);
CREATE TRIGGER cloudflare_suppression_run_identity BEFORE UPDATE ON cloudflare_suppression_sync_runs
 WHEN NEW.id<>OLD.id OR NEW.request_hash<>OLD.request_hash OR NEW.account_id<>OLD.account_id OR NEW.domain<>OLD.domain
 OR NEW.mailbox_id IS NOT OLD.mailbox_id OR NEW.source<>OLD.source OR NEW.retry_of IS NOT OLD.retry_of OR NEW.started_at<>OLD.started_at
 OR OLD.state<>'running' BEGIN SELECT RAISE(ABORT,'Suppression sync history is immutable'); END;

CREATE TABLE cloudflare_suppression_reconciliations (
 id TEXT PRIMARY KEY NOT NULL, request_hash TEXT NOT NULL, operation_id TEXT NOT NULL REFERENCES cloudflare_suppression_operations(id),
 account_id TEXT NOT NULL, domain TEXT NOT NULL, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
 state TEXT NOT NULL CHECK(state IN('running','succeeded','failed')), error_code TEXT,
 started_at INTEGER NOT NULL, completed_at INTEGER, lease_token TEXT, lease_until INTEGER,
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 FOREIGN KEY(account_id,domain,mailbox_id,operation_id) REFERENCES cloudflare_suppression_operations(account_id,domain,mailbox_id,id)
) STRICT;
CREATE TRIGGER cloudflare_suppression_reconcile_identity BEFORE UPDATE ON cloudflare_suppression_reconciliations
 WHEN NEW.id<>OLD.id OR NEW.request_hash<>OLD.request_hash OR NEW.operation_id<>OLD.operation_id OR NEW.account_id<>OLD.account_id
 OR NEW.domain<>OLD.domain OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.started_at<>OLD.started_at OR OLD.state<>'running'
 BEGIN SELECT RAISE(ABORT,'Suppression reconciliation history is immutable'); END;

CREATE TABLE cloudflare_suppression_history_events (
 id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, domain TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('sync','release')),
 resource_id TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL, remote_status TEXT, local_status TEXT,
 error_code TEXT, count INTEGER, occurred_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cloudflare_suppression_history_timeline ON cloudflare_suppression_history_events(account_id,domain,kind,resource_id,occurred_at DESC,id DESC);
CREATE TRIGGER cloudflare_suppression_history_immutable_update BEFORE UPDATE ON cloudflare_suppression_history_events BEGIN SELECT RAISE(ABORT,'Suppression journal is append only'); END;
CREATE TRIGGER cloudflare_suppression_history_immutable_delete BEFORE DELETE ON cloudflare_suppression_history_events BEGIN SELECT RAISE(ABORT,'Suppression journal is append only'); END;
INSERT INTO cloudflare_suppression_history_events SELECT lower(hex(randomblob(16))),account_id,domain,'release',id,'legacy.snapshot',state,remote_status,local_status,error_code,NULL,updated_at FROM cloudflare_suppression_operations;
CREATE TRIGGER cloudflare_suppression_operation_created AFTER INSERT ON cloudflare_suppression_operations BEGIN
 INSERT INTO cloudflare_suppression_history_events VALUES(lower(hex(randomblob(16))),NEW.account_id,NEW.domain,'release',NEW.id,'release.started',NEW.state,NEW.remote_status,NEW.local_status,NEW.error_code,NULL,NEW.created_at);
END;
CREATE TRIGGER cloudflare_suppression_operation_transition AFTER UPDATE ON cloudflare_suppression_operations
 WHEN NEW.state<>OLD.state OR NEW.remote_status<>OLD.remote_status OR NEW.local_status<>OLD.local_status OR NEW.error_code IS NOT OLD.error_code OR NEW.verified_at IS NOT OLD.verified_at BEGIN
 INSERT INTO cloudflare_suppression_history_events VALUES(lower(hex(randomblob(16))),NEW.account_id,NEW.domain,'release',NEW.id,'release.updated',NEW.state,NEW.remote_status,NEW.local_status,NEW.error_code,NULL,NEW.updated_at);
END;
CREATE TRIGGER cloudflare_suppression_sync_started AFTER INSERT ON cloudflare_suppression_sync_runs BEGIN
 INSERT INTO cloudflare_suppression_history_events VALUES(lower(hex(randomblob(16))),NEW.account_id,NEW.domain,'sync',NEW.id,'sync.started',NEW.state,NULL,NULL,NEW.error_code,NEW.count,NEW.started_at);
END;
CREATE TRIGGER cloudflare_suppression_sync_completed AFTER UPDATE ON cloudflare_suppression_sync_runs BEGIN
 INSERT INTO cloudflare_suppression_history_events VALUES(lower(hex(randomblob(16))),NEW.account_id,NEW.domain,'sync',NEW.id,'sync.completed',NEW.state,NULL,NULL,NEW.error_code,NEW.count,COALESCE(NEW.completed_at,NEW.started_at));
END;
CREATE TRIGGER cloudflare_suppression_reconcile_started AFTER INSERT ON cloudflare_suppression_reconciliations BEGIN
 INSERT INTO cloudflare_suppression_history_events SELECT lower(hex(randomblob(16))),NEW.account_id,NEW.domain,'release',NEW.operation_id,'reconcile.started',state,remote_status,local_status,NULL,NULL,NEW.started_at FROM cloudflare_suppression_operations WHERE id=NEW.operation_id;
END;
CREATE TRIGGER cloudflare_suppression_reconcile_completed AFTER UPDATE ON cloudflare_suppression_reconciliations BEGIN
 INSERT INTO cloudflare_suppression_history_events SELECT lower(hex(randomblob(16))),NEW.account_id,NEW.domain,'release',NEW.operation_id,'reconcile.completed',state,remote_status,local_status,NEW.error_code,NULL,NEW.completed_at FROM cloudflare_suppression_operations WHERE id=NEW.operation_id;
END;
