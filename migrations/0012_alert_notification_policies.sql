-- A missing row preserves the notification behavior of pre-policy installations.
CREATE TABLE alert_notification_policies (
 mailbox_id TEXT PRIMARY KEY NOT NULL REFERENCES mailboxes(id),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),
 recovery_enabled INTEGER NOT NULL DEFAULT 1 CHECK(recovery_enabled IN(0,1)),
 repeat_interval_seconds INTEGER NOT NULL DEFAULT 0 CHECK(repeat_interval_seconds BETWEEN 0 AND 604800),
 quiet_enabled INTEGER NOT NULL DEFAULT 0 CHECK(quiet_enabled IN(0,1)),
 quiet_start_minute INTEGER NOT NULL DEFAULT 1320 CHECK(quiet_start_minute BETWEEN 0 AND 1439),
 quiet_end_minute INTEGER NOT NULL DEFAULT 480 CHECK(quiet_end_minute BETWEEN 0 AND 1439),
 time_zone TEXT NOT NULL DEFAULT 'UTC' CHECK(length(time_zone) BETWEEN 1 AND 64),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), updated_at INTEGER NOT NULL CHECK(updated_at>=0),
 CHECK(quiet_enabled=0 OR quiet_start_minute<>quiet_end_minute)
) STRICT;
CREATE TRIGGER alert_notification_policy_version BEFORE UPDATE ON alert_notification_policies
 WHEN NEW.mailbox_id<>OLD.mailbox_id OR NEW.version<>OLD.version+1 OR NEW.updated_at<=OLD.updated_at
 BEGIN SELECT RAISE(ABORT,'Alert notification policy identity/version is immutable'); END;

-- One durable publication decision per mailbox event; notification retries never revisit admission.
CREATE TABLE alert_notification_decisions (
 event_id TEXT PRIMARY KEY NOT NULL, mailbox_id TEXT NOT NULL, alert_id TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN('allowed','disabled','quiet_hours','repeat_limited','recovery_disabled','no_subscribers')),
 policy_version INTEGER NOT NULL CHECK(policy_version>=0), decided_at INTEGER NOT NULL CHECK(decided_at>=0),
 claim_token TEXT NOT NULL,
 FOREIGN KEY(mailbox_id,event_id) REFERENCES events(mailbox_id,id)
) STRICT;
CREATE INDEX alert_notification_decision_list ON alert_notification_decisions(mailbox_id,decided_at DESC,event_id DESC);
CREATE TRIGGER alert_notification_decision_update BEFORE UPDATE ON alert_notification_decisions BEGIN SELECT RAISE(ABORT,'Alert notification decisions are immutable'); END;
CREATE TRIGGER alert_notification_decision_delete BEFORE DELETE ON alert_notification_decisions BEGIN SELECT RAISE(ABORT,'Alert notification decisions are immutable'); END;
CREATE TABLE alert_notification_state (
 mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), alert_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 last_notified_at INTEGER CHECK(last_notified_at IS NULL OR last_notified_at>=0),
 PRIMARY KEY(mailbox_id,alert_id)
) STRICT;
CREATE TRIGGER alert_notification_state_identity BEFORE UPDATE ON alert_notification_state
 WHEN NEW.mailbox_id<>OLD.mailbox_id OR NEW.alert_id<>OLD.alert_id
 BEGIN SELECT RAISE(ABORT,'Alert notification state identity is immutable'); END;
