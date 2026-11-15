-- A provider bounce can mean exhausted temporary retries. Only explicit hard-bounce
-- evidence is eligible for new automatic suppressions; historical bounces lack that evidence.
ALTER TABLE email_delivery_events ADD COLUMN bounce_type TEXT CHECK(bounce_type IS NULL OR bounce_type IN('hard','soft'));
ALTER TABLE email_delivery_events ADD COLUMN evidence_version INTEGER NOT NULL DEFAULT 0 CHECK(evidence_version IN(0,1));
ALTER TABLE email_delivery_events ADD COLUMN suppression_applied_at INTEGER CHECK(suppression_applied_at IS NULL OR suppression_applied_at>=0);

CREATE TABLE recipient_suppressions (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), address TEXT NOT NULL CHECK(length(address) BETWEEN 3 AND 254),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','released')),
 reason TEXT NOT NULL CHECK(reason IN('hard_bounce','complaint')), version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 last_event_at INTEGER NOT NULL CHECK(last_event_at>=0), last_event_id TEXT NOT NULL CHECK(length(last_event_id) BETWEEN 1 AND 200),
 created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
 released_at INTEGER CHECK(released_at IS NULL OR released_at>=0), release_watermark INTEGER NOT NULL DEFAULT 0 CHECK(release_watermark>=0),
 UNIQUE(mailbox_id,id), UNIQUE(mailbox_id,address)
) STRICT;
CREATE INDEX recipient_suppression_list ON recipient_suppressions(mailbox_id,status,updated_at DESC,id DESC);
CREATE TRIGGER recipient_suppression_identity BEFORE UPDATE ON recipient_suppressions
 WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.address<>OLD.address OR NEW.created_at<>OLD.created_at
 OR NEW.version<=OLD.version OR NEW.updated_at<OLD.updated_at OR NEW.last_event_at<OLD.last_event_at OR NEW.release_watermark<OLD.release_watermark
 OR(OLD.reason='complaint' AND NEW.reason<>'complaint')
 BEGIN SELECT RAISE(ABORT,'recipient suppression identity is immutable'); END;

-- Complaints already correlated by the verified 0007 pipeline remain trustworthy.
-- Seed one latest item per mailbox/address and mark every such receipt as consumed.
INSERT INTO recipient_suppressions(id,mailbox_id,address,reason,last_event_at,last_event_id,created_at,updated_at)
 SELECT id,mailbox_id,recipient,'complaint',event_at,account_id||':'||event_id,received_at,received_at FROM (
   SELECT e.*,ROW_NUMBER() OVER(PARTITION BY e.mailbox_id,e.recipient ORDER BY e.event_at DESC,e.event_id DESC) ordinal
   FROM email_delivery_events e JOIN outbound_recipients r ON r.mailbox_id=e.mailbox_id AND r.outbound_id=e.outbound_id AND r.address=e.recipient
   JOIN outbound_messages o ON o.id=e.outbound_id AND o.mailbox_id=e.mailbox_id AND o.provider='cloudflare' AND o.provider_message_id=e.provider_message_id
   JOIN mailbox_addresses a ON a.id=o.sender_address_id AND a.mailbox_id=o.mailbox_id AND a.address=e.sender
   WHERE e.event_type='complained' AND(e.state='applied' OR(e.state='ignored' AND e.ignore_reason='stale_event'))
 ) WHERE ordinal=1;
UPDATE email_delivery_events SET suppression_applied_at=COALESCE(applied_at,received_at)
 WHERE event_type='complained' AND(state='applied' OR(state='ignored' AND ignore_reason='stale_event'))
 AND EXISTS(SELECT 1 FROM outbound_recipients r JOIN outbound_messages o ON o.id=r.outbound_id AND o.mailbox_id=r.mailbox_id
   JOIN mailbox_addresses a ON a.id=o.sender_address_id AND a.mailbox_id=o.mailbox_id WHERE r.mailbox_id=email_delivery_events.mailbox_id
   AND r.outbound_id=email_delivery_events.outbound_id AND r.address=email_delivery_events.recipient
   AND o.provider='cloudflare' AND o.provider_message_id=email_delivery_events.provider_message_id AND a.address=email_delivery_events.sender);

DROP TRIGGER email_delivery_identity;
CREATE TRIGGER email_delivery_identity BEFORE UPDATE ON email_delivery_events
 WHEN NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.event_id<>OLD.event_id OR NEW.zone_id<>OLD.zone_id
 OR NEW.subscription_id<>OLD.subscription_id OR NEW.domain<>OLD.domain OR NEW.provider_message_id<>OLD.provider_message_id
 OR NEW.sender<>OLD.sender OR NEW.recipient<>OLD.recipient OR NEW.event_type<>OLD.event_type OR NEW.event_at<>OLD.event_at
 OR NEW.terminal<>OLD.terminal OR NEW.canonical_sha256<>OLD.canonical_sha256 OR NEW.received_at<>OLD.received_at OR NEW.expires_at<>OLD.expires_at
 OR NEW.bounce_type IS NOT OLD.bounce_type OR NEW.evidence_version<>OLD.evidence_version
 OR(OLD.suppression_applied_at IS NOT NULL AND NEW.suppression_applied_at IS NOT OLD.suppression_applied_at)
 OR NEW.reconcile_attempts<OLD.reconcile_attempts OR(OLD.state<>'pending' AND NEW.state<>OLD.state)
 BEGIN SELECT RAISE(ABORT,'provider event identity is immutable'); END;
