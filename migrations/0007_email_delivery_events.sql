-- Durable, redacted provider-event inbox: receipt can precede the native send() acknowledgement.
CREATE TABLE email_delivery_events (
 id TEXT NOT NULL PRIMARY KEY,
 account_id TEXT NOT NULL, event_id TEXT NOT NULL, zone_id TEXT NOT NULL, subscription_id TEXT NOT NULL, domain TEXT NOT NULL,
 provider_message_id TEXT NOT NULL CHECK(length(provider_message_id) BETWEEN 1 AND 1024),
 sender TEXT NOT NULL CHECK(length(sender) BETWEEN 3 AND 254), recipient TEXT NOT NULL CHECK(length(recipient) BETWEEN 3 AND 254),
 event_type TEXT NOT NULL CHECK(event_type IN('delivered','deferred','bounced','failed','rejected','complained')),
 event_at INTEGER NOT NULL CHECK(event_at>=0), terminal INTEGER NOT NULL CHECK(terminal IN(0,1)),
 canonical_sha256 TEXT NOT NULL CHECK(length(canonical_sha256)=64 AND canonical_sha256 NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','applied','ignored')),
 mailbox_id TEXT REFERENCES mailboxes(id), outbound_id TEXT,
 received_at INTEGER NOT NULL CHECK(received_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>received_at),
 next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0), reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_attempts BETWEEN 0 AND 64),
 applied_at INTEGER CHECK(applied_at IS NULL OR applied_at>=0), ignore_reason TEXT CHECK(ignore_reason IS NULL OR length(ignore_reason)<=80),
 UNIQUE(account_id,event_id),
 FOREIGN KEY(mailbox_id,outbound_id) REFERENCES outbound_messages(mailbox_id,id),
 CHECK((mailbox_id IS NULL)=(outbound_id IS NULL)),
 CHECK((state='pending' AND applied_at IS NULL) OR(state<>'pending' AND applied_at IS NOT NULL)),
 CHECK(state<>'applied' OR(mailbox_id IS NOT NULL AND outbound_id IS NOT NULL))
) STRICT;
CREATE INDEX email_delivery_pending ON email_delivery_events(state,next_attempt_at,id);
CREATE INDEX email_delivery_outbound ON email_delivery_events(mailbox_id,outbound_id,event_at,id);
CREATE INDEX email_delivery_message ON email_delivery_events(account_id,provider_message_id,state);
CREATE TRIGGER email_delivery_identity BEFORE UPDATE ON email_delivery_events
 WHEN NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.event_id<>OLD.event_id OR NEW.zone_id<>OLD.zone_id
 OR NEW.subscription_id<>OLD.subscription_id OR NEW.domain<>OLD.domain OR NEW.provider_message_id<>OLD.provider_message_id
 OR NEW.sender<>OLD.sender OR NEW.recipient<>OLD.recipient OR NEW.event_type<>OLD.event_type OR NEW.event_at<>OLD.event_at
 OR NEW.terminal<>OLD.terminal OR NEW.canonical_sha256<>OLD.canonical_sha256 OR NEW.received_at<>OLD.received_at OR NEW.expires_at<>OLD.expires_at
 OR NEW.reconcile_attempts<OLD.reconcile_attempts OR(OLD.state<>'pending' AND NEW.state<>OLD.state)
 BEGIN SELECT RAISE(ABORT,'provider event identity is immutable'); END;

ALTER TABLE outbound_recipients ADD COLUMN last_provider_event_id TEXT;
ALTER TABLE outbound_recipients ADD COLUMN delivery_event_type TEXT CHECK(delivery_event_type IS NULL OR delivery_event_type IN('delivered','deferred','bounced','failed','rejected'));
ALTER TABLE outbound_recipients ADD COLUMN complained_at INTEGER CHECK(complained_at IS NULL OR complained_at>=0);
ALTER TABLE outbound_recipients ADD COLUMN last_delivery_event_at INTEGER CHECK(last_delivery_event_at IS NULL OR last_delivery_event_at>=0);
ALTER TABLE outbound_recipients ADD COLUMN last_delivery_event_id TEXT;
-- Preserve ordering if an earlier installation already populated the reserved provider timestamp.
UPDATE outbound_recipients SET last_delivery_event_at=last_provider_event_at,
 delivery_event_type=CASE WHEN status IN('delivered','deferred','bounced','failed') THEN status ELSE NULL END;
