-- Provider snapshots stay separate from the permanent mailbox-local evidence list.
CREATE TABLE cloudflare_suppression_cache (
 account_id TEXT NOT NULL, configured_domain TEXT NOT NULL, remote_id TEXT NOT NULL,
 address TEXT NOT NULL, scope_type TEXT NOT NULL CHECK(scope_type IN('account','sending_domain')), scope_value TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN('manual','complaint','hard_bounce','soft_bounce','policy')), read_only INTEGER NOT NULL CHECK(read_only IN(0,1)),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','absent')), version_hash TEXT NOT NULL CHECK(length(version_hash)=64),
 expires_at INTEGER CHECK(expires_at IS NULL OR expires_at>=0), provider_created_at INTEGER NOT NULL CHECK(provider_created_at>=0),
 seen_at INTEGER NOT NULL CHECK(seen_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=0), last_sync_id TEXT NOT NULL,
 PRIMARY KEY(account_id,configured_domain,remote_id),
 CHECK((scope_type='account' AND scope_value='') OR(scope_type='sending_domain' AND scope_value=configured_domain))
) STRICT;
CREATE INDEX cloudflare_suppression_lookup ON cloudflare_suppression_cache(account_id,configured_domain,status,address);
CREATE TABLE cloudflare_suppression_sync (
 account_id TEXT NOT NULL, domain TEXT NOT NULL, lease_token TEXT, lease_until INTEGER,
 last_attempt_at INTEGER, last_success_at INTEGER, last_error_code TEXT,
 PRIMARY KEY(account_id,domain), CHECK((lease_token IS NULL)=(lease_until IS NULL))
) STRICT;
CREATE TABLE cloudflare_suppression_operations (
 id TEXT NOT NULL PRIMARY KEY, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 account_id TEXT NOT NULL, domain TEXT NOT NULL, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), remote_id TEXT NOT NULL,
 address TEXT NOT NULL, scope_type TEXT NOT NULL CHECK(scope_type IN('account','sending_domain')), scope_value TEXT NOT NULL,
 version_hash TEXT NOT NULL CHECK(length(version_hash)=64),
 release_local INTEGER NOT NULL CHECK(release_local IN(0,1)), local_id TEXT, local_version INTEGER,
 state TEXT NOT NULL CHECK(state IN('preparing','deleting','succeeded','failed','unknown','confirmed_absent')),
 remote_status TEXT NOT NULL CHECK(remote_status IN('in_progress','deleted','already_absent','unknown','failed')),
 local_status TEXT NOT NULL CHECK(local_status IN('not_requested','released','changed','pending')),
 lease_token TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER, error_code TEXT,
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK((release_local=0 AND local_id IS NULL AND local_version IS NULL) OR(release_local=1 AND local_id IS NOT NULL AND local_version>0)),
 FOREIGN KEY(mailbox_id,local_id) REFERENCES recipient_suppressions(mailbox_id,id)
) STRICT;
CREATE UNIQUE INDEX cloudflare_suppression_open_operation ON cloudflare_suppression_operations(account_id,domain,remote_id)
 WHERE state IN('preparing','deleting','unknown');
CREATE INDEX cloudflare_suppression_operation_list ON cloudflare_suppression_operations(account_id,domain,mailbox_id,created_at DESC,id DESC);
CREATE TRIGGER cloudflare_suppression_operation_identity BEFORE UPDATE ON cloudflare_suppression_operations
 WHEN NEW.id<>OLD.id OR NEW.request_hash<>OLD.request_hash OR NEW.account_id<>OLD.account_id OR NEW.domain<>OLD.domain
 OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.remote_id<>OLD.remote_id OR NEW.address<>OLD.address OR NEW.scope_type<>OLD.scope_type
 OR NEW.scope_value<>OLD.scope_value OR NEW.version_hash<>OLD.version_hash OR NEW.release_local<>OLD.release_local
 OR NEW.local_id IS NOT OLD.local_id OR NEW.local_version IS NOT OLD.local_version OR NEW.created_at<>OLD.created_at OR NEW.updated_at<OLD.updated_at
 BEGIN SELECT RAISE(ABORT,'Cloudflare suppression operation identity is immutable'); END;
