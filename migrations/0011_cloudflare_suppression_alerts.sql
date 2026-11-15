-- Consume the old journal as a deployment barrier; upgrading never broadcasts historical failures.
CREATE TABLE cloudflare_suppression_alert_cursors (
 account_id TEXT NOT NULL, domain TEXT NOT NULL, last_rowid INTEGER NOT NULL CHECK(last_rowid>=0),
 PRIMARY KEY(account_id,domain), CHECK((account_id='')=(domain=''))
) STRICT;
INSERT INTO cloudflare_suppression_alert_cursors VALUES('','',COALESCE((SELECT MAX(rowid) FROM cloudflare_suppression_history_events),0));
CREATE TABLE cloudflare_suppression_alerts (
 id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, domain TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('sync','release')), group_key TEXT NOT NULL,
 mailbox_id TEXT REFERENCES mailboxes(id), global_scope INTEGER NOT NULL CHECK(global_scope IN(0,1)),
 status TEXT NOT NULL CHECK(status IN('open','acknowledged','resolved')),
 outcome TEXT NOT NULL CHECK(outcome IN('failed','unknown','resolved')),
 version INTEGER NOT NULL CHECK(version>0), generation INTEGER NOT NULL CHECK(generation>0), occurrences INTEGER NOT NULL CHECK(occurrences>0),
 error_code TEXT, first_occurred_at INTEGER NOT NULL, last_occurred_at INTEGER NOT NULL,
 acknowledged_at INTEGER, resolved_at INTEGER, source_id TEXT NOT NULL,
 last_fingerprint TEXT NOT NULL, last_journal_id TEXT NOT NULL REFERENCES cloudflare_suppression_history_events(id),
 UNIQUE(account_id,domain,kind,group_key),
 CHECK((global_scope=1 AND mailbox_id IS NULL AND kind='sync') OR(global_scope=0 AND mailbox_id IS NOT NULL)),
 CHECK((status='resolved')=(outcome='resolved'))
) STRICT;
CREATE INDEX cloudflare_suppression_alert_list ON cloudflare_suppression_alerts(account_id,domain,last_occurred_at DESC,id DESC);
CREATE TRIGGER cloudflare_suppression_alert_identity BEFORE UPDATE ON cloudflare_suppression_alerts
 WHEN NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.domain<>OLD.domain OR NEW.kind<>OLD.kind OR NEW.group_key<>OLD.group_key
 OR NEW.mailbox_id IS NOT OLD.mailbox_id OR NEW.global_scope<>OLD.global_scope OR NEW.first_occurred_at<>OLD.first_occurred_at
 OR NEW.version<>OLD.version+1 OR NEW.generation<OLD.generation OR NEW.occurrences<OLD.occurrences
 BEGIN SELECT RAISE(ABORT,'Suppression alert identity/version is immutable'); END;
CREATE TABLE cloudflare_suppression_alert_occurrences (
 id TEXT PRIMARY KEY NOT NULL, alert_id TEXT NOT NULL REFERENCES cloudflare_suppression_alerts(id),
 journal_id TEXT NOT NULL REFERENCES cloudflare_suppression_history_events(id),
 action TEXT NOT NULL CHECK(action IN('failed','resolved')), outcome TEXT NOT NULL CHECK(outcome IN('failed','unknown','resolved')),
 version INTEGER NOT NULL, error_code TEXT, occurred_at INTEGER NOT NULL, source_id TEXT NOT NULL,
 UNIQUE(alert_id,journal_id)
) STRICT;
CREATE INDEX cloudflare_suppression_alert_timeline ON cloudflare_suppression_alert_occurrences(alert_id,version DESC);
CREATE TRIGGER cloudflare_suppression_alert_occurrence_update BEFORE UPDATE ON cloudflare_suppression_alert_occurrences BEGIN SELECT RAISE(ABORT,'Alert timeline is append only'); END;
CREATE TRIGGER cloudflare_suppression_alert_occurrence_delete BEFORE DELETE ON cloudflare_suppression_alert_occurrences BEGIN SELECT RAISE(ABORT,'Alert timeline is append only'); END;
