-- Agent Mail 个人自部署版，Cloudflare D1 / SQLite。
-- 初始快照与 migrations/0001_initial.sql 一致。ID 为应用生成的 UUID TEXT。
-- 所有 *_at 是 UTC Unix 毫秒 INTEGER。D1 无 RLS；权限由应用执行。
-- D1 隐式事务/外键始终开启；不用 BEGIN/COMMIT 或 PostgreSQL 类型。
CREATE TABLE instance_settings (
 id INTEGER NOT NULL PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL UNIQUE,
 display_name TEXT NOT NULL, setup_state TEXT NOT NULL DEFAULT 'pending' CHECK(setup_state IN('pending','ready','maintenance')),
 app_version TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at>=0),
 updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
) STRICT;
-- Owner 由受信任配置和 Access JWT 确定，不接受首访者认领。
CREATE TABLE mailboxes (
 id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','paused','deleting','deleted')),
 daily_recipient_limit INTEGER NOT NULL DEFAULT 20 CHECK(daily_recipient_limit>=0),
 max_message_bytes INTEGER NOT NULL DEFAULT 10485760 CHECK(max_message_bytes>0),
 allowed_recipients_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_recipients_json) AND json_type(allowed_recipients_json)='array'),
 created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at), deleted_at INTEGER
) STRICT;
CREATE TABLE mailbox_addresses (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
 address TEXT NOT NULL UNIQUE CHECK(address=lower(address) AND length(address)<=254),
 is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN(0,1)),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','disabled','retired')),
 created_at INTEGER NOT NULL CHECK(created_at>=0), retired_at INTEGER,
 UNIQUE(mailbox_id,id),
 CHECK(instr(address,'@') BETWEEN 2 AND 65 AND instr(substr(address,instr(address,'@')+1),'@')=0),
 CHECK(status<>'retired' OR retired_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX mailbox_primary_address ON mailbox_addresses(mailbox_id) WHERE is_primary=1 AND status<>'retired';
CREATE TRIGGER address_no_delete BEFORE DELETE ON mailbox_addresses BEGIN SELECT RAISE(ABORT,'address tombstones must be retained'); END;
CREATE TRIGGER address_immutable BEFORE UPDATE ON mailbox_addresses
 WHEN NEW.mailbox_id<>OLD.mailbox_id OR NEW.address<>OLD.address OR NEW.id<>OLD.id
 BEGIN SELECT RAISE(ABORT,'address ownership is immutable'); END;
CREATE TRIGGER address_no_reactivate BEFORE UPDATE ON mailbox_addresses WHEN OLD.status='retired' AND NEW.status<>'retired'
 BEGIN SELECT RAISE(ABORT,'retired address cannot be reactivated'); END;

CREATE TABLE mailbox_tokens (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), name TEXT NOT NULL,
 secret_sha256 TEXT NOT NULL UNIQUE CHECK(length(secret_sha256)=64 AND secret_sha256 NOT GLOB '*[^0-9a-f]*'),
 can_read INTEGER NOT NULL DEFAULT 1 CHECK(can_read IN(0,1)),
 can_read_attachments INTEGER NOT NULL DEFAULT 0 CHECK(can_read_attachments IN(0,1)),
 can_draft INTEGER NOT NULL DEFAULT 0 CHECK(can_draft IN(0,1)),
 can_send INTEGER NOT NULL DEFAULT 0 CHECK(can_send IN(0,1)),
 requires_approval INTEGER NOT NULL DEFAULT 1 CHECK(requires_approval IN(0,1)),
 expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER,
 created_at INTEGER NOT NULL CHECK(created_at>=0), UNIQUE(mailbox_id,id),
 CHECK(can_read+can_draft+can_send>0), CHECK(can_read_attachments<=can_read),
 CHECK(expires_at IS NULL OR expires_at>created_at)
) STRICT;
CREATE INDEX tokens_mailbox ON mailbox_tokens(mailbox_id,created_at,id);
CREATE TRIGGER token_mailbox_immutable BEFORE UPDATE ON mailbox_tokens WHEN NEW.mailbox_id<>OLD.mailbox_id OR NEW.id<>OLD.id
 BEGIN SELECT RAISE(ABORT,'token cannot move to another mailbox'); END;
-- 随机256-bit secret仅展示一次；存SHA256摘要，不存Cloudflare管理token。

CREATE TABLE objects (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), object_key TEXT NOT NULL UNIQUE,
 purpose TEXT NOT NULL CHECK(purpose IN('raw_email','body','attachment','draft','outbound')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','ready','deleting','deleted','failed')),
 size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes>=0),
 sha256 TEXT CHECK(sha256 IS NULL OR(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
 content_type TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at>=0), ready_at INTEGER,
 UNIQUE(mailbox_id,id), CHECK(state<>'ready' OR(ready_at IS NOT NULL AND sha256 IS NOT NULL))
) STRICT;
CREATE INDEX objects_reconcile ON objects(state,created_at,id);
CREATE TRIGGER object_identity_immutable BEFORE UPDATE ON objects
 WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.object_key<>OLD.object_key OR NEW.purpose<>OLD.purpose
 BEGIN SELECT RAISE(ABORT,'object identity is immutable'); END;
CREATE TRIGGER object_content_immutable BEFORE UPDATE ON objects
 WHEN OLD.sha256 IS NOT NULL AND (NEW.sha256 IS NOT OLD.sha256 OR NEW.size_bytes<>OLD.size_bytes OR NEW.content_type<>OLD.content_type)
 BEGIN SELECT RAISE(ABORT,'persisted object content is immutable'); END;
-- R2私有，key不是授权；pending/orphan由任务补账或清理。

CREATE TABLE ingest_receipts (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), raw_object_id TEXT NOT NULL,
 provider_delivery_key TEXT, envelope_from TEXT NOT NULL, envelope_to TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending_blob' CHECK(status IN('pending_blob','stored','indexed','failed')),
 error_code TEXT, received_at INTEGER NOT NULL CHECK(received_at>=0),
 UNIQUE(mailbox_id,id), UNIQUE(mailbox_id,raw_object_id), UNIQUE(mailbox_id,provider_delivery_key),
 FOREIGN KEY(mailbox_id,raw_object_id) REFERENCES objects(mailbox_id,id)
) STRICT;
-- 无可信投递ID则delivery_key保持NULL，不能用Message-ID/hash冒充。
CREATE TABLE threads (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), subject TEXT, last_message_at INTEGER,
 created_at INTEGER NOT NULL CHECK(created_at>=0), UNIQUE(mailbox_id,id)
) STRICT;
CREATE INDEX threads_list ON threads(mailbox_id,last_message_at DESC,id DESC);
CREATE TABLE messages (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), thread_id TEXT, ingest_receipt_id TEXT,
 raw_object_id TEXT NOT NULL, body_object_id TEXT, rfc_message_id TEXT, in_reply_to TEXT, subject TEXT,
 preview TEXT CHECK(preview IS NULL OR length(preview)<=512),
 direction TEXT NOT NULL CHECK(direction IN('inbound','outbound')),
 folder TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN('inbox','sent','archive','trash','spam')),
 is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN(0,1)),
 parse_state TEXT NOT NULL DEFAULT 'pending' CHECK(parse_state IN('pending','ready','failed')),
 size_bytes INTEGER NOT NULL CHECK(size_bytes>=0), received_at INTEGER NOT NULL CHECK(received_at>=0), deleted_at INTEGER,
 UNIQUE(mailbox_id,id), UNIQUE(mailbox_id,ingest_receipt_id),
 FOREIGN KEY(mailbox_id,thread_id) REFERENCES threads(mailbox_id,id),
 FOREIGN KEY(mailbox_id,ingest_receipt_id) REFERENCES ingest_receipts(mailbox_id,id),
 FOREIGN KEY(mailbox_id,raw_object_id) REFERENCES objects(mailbox_id,id),
 FOREIGN KEY(mailbox_id,body_object_id) REFERENCES objects(mailbox_id,id)
) STRICT;
CREATE INDEX messages_list ON messages(mailbox_id,folder,received_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX messages_thread ON messages(mailbox_id,thread_id,received_at,id);
CREATE INDEX messages_rfc_id ON messages(mailbox_id,rfc_message_id);
CREATE TABLE message_addresses (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL, message_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('from','sender','reply_to','to','cc','bcc','envelope_to')),
 ordinal INTEGER NOT NULL CHECK(ordinal>=0), address TEXT NOT NULL, display_name TEXT,
 UNIQUE(mailbox_id,id), UNIQUE(message_id,kind,ordinal),
 FOREIGN KEY(mailbox_id,message_id) REFERENCES messages(mailbox_id,id)
) STRICT;
CREATE TABLE attachments (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL, message_id TEXT NOT NULL, object_id TEXT NOT NULL,
 part_id TEXT NOT NULL, filename TEXT,
 disposition TEXT NOT NULL DEFAULT 'attachment' CHECK(disposition IN('attachment','inline')), content_id TEXT,
 scan_status TEXT NOT NULL DEFAULT 'unscanned' CHECK(scan_status IN('unscanned','clean','blocked','failed')),
 UNIQUE(mailbox_id,id), UNIQUE(message_id,part_id),
 FOREIGN KEY(mailbox_id,message_id) REFERENCES messages(mailbox_id,id),
 FOREIGN KEY(mailbox_id,object_id) REFERENCES objects(mailbox_id,id)
) STRICT;
CREATE TABLE drafts (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), content_object_id TEXT NOT NULL,
 created_by_token_id TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 state TEXT NOT NULL DEFAULT 'editing' CHECK(state IN('editing','awaiting_approval','approved','submitted','discarded')),
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
 approved_version INTEGER, approved_sha256 TEXT, approved_at INTEGER,
 created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
 UNIQUE(mailbox_id,id),
 FOREIGN KEY(mailbox_id,content_object_id) REFERENCES objects(mailbox_id,id),
 FOREIGN KEY(mailbox_id,created_by_token_id) REFERENCES mailbox_tokens(mailbox_id,id),
 CHECK(state<>'approved' OR(approved_version IS NOT NULL AND approved_version=version
   AND approved_sha256 IS NOT NULL AND approved_sha256=content_sha256 AND approved_at IS NOT NULL))
) STRICT;

CREATE TABLE daily_send_counters (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
 day_utc TEXT NOT NULL CHECK(length(day_utc)=10 AND day_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 limit_snapshot INTEGER NOT NULL CHECK(limit_snapshot>=0),
 reserved_units INTEGER NOT NULL DEFAULT 0 CHECK(reserved_units>=0), used_units INTEGER NOT NULL DEFAULT 0 CHECK(used_units>=0),
 UNIQUE(mailbox_id,id), UNIQUE(mailbox_id,day_utc)
) STRICT;
CREATE TABLE send_reservations (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL, counter_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
 units INTEGER NOT NULL CHECK(units>0),
 state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','reconciling','committed','released')),
 created_at INTEGER NOT NULL CHECK(created_at>=0), settled_at INTEGER,
 UNIQUE(mailbox_id,id), FOREIGN KEY(mailbox_id,counter_id) REFERENCES daily_send_counters(mailbox_id,id)
) STRICT;
CREATE TRIGGER reservation_reserve BEFORE INSERT ON send_reservations BEGIN
 SELECT CASE WHEN NEW.state<>'reserved' THEN RAISE(ABORT,'new reservation must be reserved') END;
 UPDATE daily_send_counters SET reserved_units=reserved_units+NEW.units
   WHERE id=NEW.counter_id AND mailbox_id=NEW.mailbox_id AND NEW.units<=limit_snapshot-used_units-reserved_units;
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'send limit exceeded or counter mismatch') END;
END;
CREATE TRIGGER reservation_transition BEFORE UPDATE ON send_reservations BEGIN
 SELECT CASE WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.counter_id<>OLD.counter_id
   OR NEW.operation_id<>OLD.operation_id OR NEW.units<>OLD.units THEN RAISE(ABORT,'reservation identity is immutable') END;
 SELECT CASE WHEN NEW.state<>OLD.state AND NOT((OLD.state='reserved' AND NEW.state IN('reconciling','committed','released'))
   OR(OLD.state='reconciling' AND NEW.state IN('committed','released'))) THEN RAISE(ABORT,'invalid reservation transition') END;
END;
CREATE TRIGGER reservation_commit AFTER UPDATE OF state ON send_reservations
 WHEN OLD.state IN('reserved','reconciling') AND NEW.state='committed' BEGIN
 UPDATE daily_send_counters SET reserved_units=reserved_units-NEW.units,used_units=used_units+NEW.units
   WHERE id=NEW.counter_id AND mailbox_id=NEW.mailbox_id AND reserved_units>=NEW.units;
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reservation counter mismatch') END;
END;
CREATE TRIGGER reservation_release AFTER UPDATE OF state ON send_reservations
 WHEN OLD.state IN('reserved','reconciling') AND NEW.state='released' BEGIN
 UPDATE daily_send_counters SET reserved_units=reserved_units-NEW.units
   WHERE id=NEW.counter_id AND mailbox_id=NEW.mailbox_id AND reserved_units>=NEW.units;
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reservation counter mismatch') END;
END;
CREATE TRIGGER reservation_no_delete BEFORE DELETE ON send_reservations BEGIN SELECT RAISE(ABORT,'reservation history must be retained'); END;

CREATE TABLE outbound_messages (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), sender_address_id TEXT NOT NULL,
 draft_id TEXT, requested_by_token_id TEXT, frozen_object_id TEXT NOT NULL, reservation_id TEXT NOT NULL UNIQUE,
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN('queued','submitting','accepted','partial','delivered','bounced','failed','cancelled','unknown')),
 provider TEXT NOT NULL DEFAULT 'cloudflare', provider_message_id TEXT, accepted_at INTEGER, last_error_code TEXT,
 created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
 UNIQUE(mailbox_id,id), UNIQUE(provider,provider_message_id),
 FOREIGN KEY(mailbox_id,sender_address_id) REFERENCES mailbox_addresses(mailbox_id,id),
 FOREIGN KEY(mailbox_id,draft_id) REFERENCES drafts(mailbox_id,id),
 FOREIGN KEY(mailbox_id,requested_by_token_id) REFERENCES mailbox_tokens(mailbox_id,id),
 FOREIGN KEY(mailbox_id,frozen_object_id) REFERENCES objects(mailbox_id,id),
 FOREIGN KEY(mailbox_id,reservation_id) REFERENCES send_reservations(mailbox_id,id)
) STRICT;
CREATE INDEX outbound_list ON outbound_messages(mailbox_id,created_at DESC,id DESC);
CREATE TRIGGER outbound_validate BEFORE INSERT ON outbound_messages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM send_reservations r WHERE r.id=NEW.reservation_id
   AND r.mailbox_id=NEW.mailbox_id AND r.operation_id=NEW.id AND r.state='reserved')
   THEN RAISE(ABORT,'outbound reservation mismatch') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM objects o WHERE o.id=NEW.frozen_object_id
   AND o.mailbox_id=NEW.mailbox_id AND o.state='ready' AND o.purpose='outbound')
   THEN RAISE(ABORT,'outbound object is not ready') END;
END;
CREATE TRIGGER outbound_frozen BEFORE UPDATE ON outbound_messages
 WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.sender_address_id<>OLD.sender_address_id
   OR NEW.frozen_object_id<>OLD.frozen_object_id OR NEW.reservation_id<>OLD.reservation_id OR NEW.request_sha256<>OLD.request_sha256
   OR NEW.draft_id IS NOT OLD.draft_id OR NEW.requested_by_token_id IS NOT OLD.requested_by_token_id
 BEGIN SELECT RAISE(ABORT,'outbound content is immutable'); END;
CREATE TABLE outbound_recipients (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL, outbound_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('to','cc','bcc')), address TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN('queued','accepted','deferred','delivered','bounced','failed','unknown')),
 last_provider_event_at INTEGER, diagnostic_redacted TEXT, UNIQUE(mailbox_id,id), UNIQUE(outbound_id,address),
 FOREIGN KEY(mailbox_id,outbound_id) REFERENCES outbound_messages(mailbox_id,id)
) STRICT;
CREATE TRIGGER recipient_frozen BEFORE UPDATE ON outbound_recipients
 WHEN NEW.mailbox_id<>OLD.mailbox_id OR NEW.outbound_id<>OLD.outbound_id OR NEW.address<>OLD.address OR NEW.kind<>OLD.kind
 BEGIN SELECT RAISE(ABORT,'recipient identity is immutable'); END;
CREATE TABLE send_attempts (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL, outbound_id TEXT NOT NULL,
 attempt_no INTEGER NOT NULL CHECK(attempt_no>0), lease_token TEXT NOT NULL,
 outcome TEXT NOT NULL DEFAULT 'started' CHECK(outcome IN('started','accepted','rejected','unknown')),
 error_code TEXT, started_at INTEGER NOT NULL CHECK(started_at>=0), finished_at INTEGER,
 UNIQUE(mailbox_id,id), UNIQUE(outbound_id,attempt_no),
 FOREIGN KEY(mailbox_id,outbound_id) REFERENCES outbound_messages(mailbox_id,id),
 CHECK(finished_at IS NULL OR finished_at>=started_at)
) STRICT;

CREATE TABLE jobs (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
 kind TEXT NOT NULL CHECK(kind IN('parse_email','send_email','reconcile_send','publish_event','delete_mailbox','reconcile_objects')),
 dedupe_key TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','done','dead','cancelled')),
 available_at INTEGER NOT NULL CHECK(available_at>=0), lease_token TEXT, lease_until INTEGER,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), max_attempts INTEGER NOT NULL DEFAULT 8 CHECK(max_attempts>0),
 last_error_code TEXT, created_at INTEGER NOT NULL CHECK(created_at>=0),
 UNIQUE(mailbox_id,id), UNIQUE(mailbox_id,kind,dedupe_key),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
   OR(state<>'running' AND lease_token IS NULL AND lease_until IS NULL))
) STRICT;
CREATE INDEX jobs_claim ON jobs(state,available_at,id);
CREATE INDEX jobs_expired ON jobs(lease_until,id) WHERE state='running';
CREATE TABLE idempotency_keys (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), principal_key TEXT NOT NULL, operation TEXT NOT NULL,
 key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 200),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL DEFAULT 'processing' CHECK(state IN('processing','completed','failed','unknown')),
 resource_id TEXT, response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
 created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 UNIQUE(mailbox_id,id), UNIQUE(mailbox_id,principal_key,operation,key)
) STRICT;
CREATE TABLE events (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
 source TEXT NOT NULL CHECK(source IN('app','cloudflare','external_provider')), source_event_id TEXT NOT NULL, type TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
 occurred_at INTEGER NOT NULL CHECK(occurred_at>=0), created_at INTEGER NOT NULL CHECK(created_at>=0),
 UNIQUE(mailbox_id,id), UNIQUE(mailbox_id,source,source_event_id)
) STRICT;
CREATE INDEX events_list ON events(mailbox_id,created_at,id);
CREATE TABLE webhook_endpoints (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), url TEXT NOT NULL CHECK(url LIKE 'https://%'),
 event_types_json TEXT NOT NULL CHECK(json_valid(event_types_json) AND json_type(event_types_json)='array'),
 signing_secret_ciphertext TEXT NOT NULL CHECK(json_valid(signing_secret_ciphertext) AND json_type(signing_secret_ciphertext)='object'),
 secret_version INTEGER NOT NULL DEFAULT 1 CHECK(secret_version>0),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','paused','disabled')),
 created_at INTEGER NOT NULL CHECK(created_at>=0), UNIQUE(mailbox_id,id)
) STRICT;
CREATE TABLE webhook_deliveries (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, event_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','succeeded','dead','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at INTEGER NOT NULL CHECK(available_at>=0),
 lease_token TEXT, lease_until INTEGER, signed_secret_version INTEGER NOT NULL CHECK(signed_secret_version>0),
 signing_secret_ciphertext TEXT NOT NULL CHECK(json_valid(signing_secret_ciphertext) AND json_type(signing_secret_ciphertext)='object'),
 last_http_status INTEGER CHECK(last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
 created_at INTEGER NOT NULL CHECK(created_at>=0), UNIQUE(mailbox_id,id), UNIQUE(endpoint_id,event_id),
 FOREIGN KEY(mailbox_id,endpoint_id) REFERENCES webhook_endpoints(mailbox_id,id),
 FOREIGN KEY(mailbox_id,event_id) REFERENCES events(mailbox_id,id),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
   OR(state<>'running' AND lease_token IS NULL AND lease_until IS NULL))
) STRICT;
CREATE INDEX webhook_claim ON webhook_deliveries(state,available_at,id);
CREATE TABLE audit_events (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT REFERENCES mailboxes(id),
 actor_kind TEXT NOT NULL CHECK(actor_kind IN('owner','token','system')), token_id TEXT,
 action TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL CHECK(outcome IN('success','denied','failure')),
 request_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
 occurred_at INTEGER NOT NULL CHECK(occurred_at>=0),
 FOREIGN KEY(mailbox_id,token_id) REFERENCES mailbox_tokens(mailbox_id,id),
 CHECK((actor_kind='token' AND token_id IS NOT NULL AND mailbox_id IS NOT NULL) OR(actor_kind<>'token' AND token_id IS NULL))
) STRICT;
CREATE INDEX audit_list ON audit_events(mailbox_id,occurred_at DESC,id DESC);
-- 正文/MIME/附件进R2；D1只存小元数据。所有SQL按已验证mailbox_id绑定参数。
