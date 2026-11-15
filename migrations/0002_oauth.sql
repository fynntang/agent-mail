-- MCP OAuth: public authorization-code clients, Owner consent, opaque token digests.
-- Credentials are never persisted in plaintext. All timestamps are UTC epoch milliseconds.
CREATE TABLE oauth_clients (
 client_id TEXT NOT NULL PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN('dynamic','cimd')),
 client_name TEXT NOT NULL CHECK(length(client_name) BETWEEN 1 AND 80),
 redirect_uris_json TEXT NOT NULL CHECK(json_valid(redirect_uris_json) AND json_type(redirect_uris_json)='array'),
 scope TEXT NOT NULL CHECK(length(scope)>0),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','disabled')),
 created_at INTEGER NOT NULL CHECK(created_at>=0), metadata_expires_at INTEGER
) STRICT;
CREATE INDEX oauth_clients_created ON oauth_clients(kind,created_at,client_id);
CREATE TRIGGER oauth_client_identity BEFORE UPDATE ON oauth_clients
 WHEN NEW.client_id<>OLD.client_id OR NEW.kind<>OLD.kind OR NEW.created_at<>OLD.created_at
 BEGIN SELECT RAISE(ABORT,'OAuth client identity is immutable'); END;

CREATE TABLE oauth_authorization_requests (
 id TEXT NOT NULL PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
 redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, requested_scope TEXT NOT NULL,
 state TEXT, code_challenge TEXT NOT NULL, owner_email TEXT NOT NULL,
 csrf_sha256 TEXT NOT NULL UNIQUE CHECK(length(csrf_sha256)=64 AND csrf_sha256 NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 used_at INTEGER CHECK(used_at IS NULL OR used_at>=created_at)
) STRICT;
CREATE INDEX oauth_requests_expiry ON oauth_authorization_requests(expires_at,id) WHERE used_at IS NULL;
CREATE TRIGGER oauth_request_frozen BEFORE UPDATE ON oauth_authorization_requests
 WHEN NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.redirect_uri<>OLD.redirect_uri
   OR NEW.resource<>OLD.resource OR NEW.requested_scope<>OLD.requested_scope OR NEW.state IS NOT OLD.state
   OR NEW.code_challenge<>OLD.code_challenge OR NEW.owner_email<>OLD.owner_email OR NEW.csrf_sha256<>OLD.csrf_sha256
   OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
 BEGIN SELECT RAISE(ABORT,'OAuth authorization request is immutable'); END;

CREATE TABLE oauth_grants (
 id TEXT NOT NULL PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
 mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), mailbox_token_id TEXT NOT NULL UNIQUE,
 resource TEXT NOT NULL, scope TEXT NOT NULL CHECK(length(scope)>0),
 created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at),
 UNIQUE(mailbox_id,id),
 FOREIGN KEY(mailbox_id,mailbox_token_id) REFERENCES mailbox_tokens(mailbox_id,id)
) STRICT;
CREATE INDEX oauth_grants_mailbox ON oauth_grants(mailbox_id,created_at DESC,id);
CREATE INDEX oauth_grants_client ON oauth_grants(client_id,created_at DESC,id);
CREATE TRIGGER oauth_grant_frozen BEFORE UPDATE ON oauth_grants
 WHEN NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.mailbox_id<>OLD.mailbox_id
   OR NEW.mailbox_token_id<>OLD.mailbox_token_id OR NEW.resource<>OLD.resource OR NEW.scope<>OLD.scope
   OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
 BEGIN SELECT RAISE(ABORT,'OAuth grant binding is immutable'); END;

CREATE TABLE oauth_authorization_codes (
 id TEXT NOT NULL PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
 secret_sha256 TEXT NOT NULL UNIQUE CHECK(length(secret_sha256)=64 AND secret_sha256 NOT GLOB '*[^0-9a-f]*'),
 redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 used_at INTEGER CHECK(used_at IS NULL OR used_at>=created_at)
) STRICT;
CREATE INDEX oauth_codes_expiry ON oauth_authorization_codes(expires_at,id) WHERE used_at IS NULL;
CREATE INDEX oauth_codes_grant ON oauth_authorization_codes(grant_id,id);
CREATE TRIGGER oauth_code_frozen BEFORE UPDATE ON oauth_authorization_codes
 WHEN NEW.id<>OLD.id OR NEW.grant_id<>OLD.grant_id OR NEW.secret_sha256<>OLD.secret_sha256
   OR NEW.redirect_uri<>OLD.redirect_uri OR NEW.code_challenge<>OLD.code_challenge
   OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
 BEGIN SELECT RAISE(ABORT,'OAuth authorization code binding is immutable'); END;

CREATE TABLE oauth_access_tokens (
 id TEXT NOT NULL PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
 secret_sha256 TEXT NOT NULL UNIQUE CHECK(length(secret_sha256)=64 AND secret_sha256 NOT GLOB '*[^0-9a-f]*'),
 scope TEXT NOT NULL CHECK(length(scope)>0),
 created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at)
) STRICT;
CREATE INDEX oauth_access_grant ON oauth_access_tokens(grant_id,id);
CREATE INDEX oauth_access_expiry ON oauth_access_tokens(expires_at,id);
CREATE TRIGGER oauth_access_frozen BEFORE UPDATE ON oauth_access_tokens
 WHEN NEW.id<>OLD.id OR NEW.grant_id<>OLD.grant_id OR NEW.secret_sha256<>OLD.secret_sha256
   OR NEW.scope<>OLD.scope OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
 BEGIN SELECT RAISE(ABORT,'OAuth access token binding is immutable'); END;

CREATE TABLE oauth_refresh_tokens (
 id TEXT NOT NULL PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
 secret_sha256 TEXT NOT NULL UNIQUE CHECK(length(secret_sha256)=64 AND secret_sha256 NOT GLOB '*[^0-9a-f]*'),
 scope TEXT NOT NULL CHECK(length(scope)>0),
 created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 used_at INTEGER CHECK(used_at IS NULL OR used_at>=created_at),
 revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at),
 replaced_by_id TEXT,
 UNIQUE(grant_id,id),
 FOREIGN KEY(grant_id,replaced_by_id) REFERENCES oauth_refresh_tokens(grant_id,id)
) STRICT;
CREATE INDEX oauth_refresh_grant ON oauth_refresh_tokens(grant_id,id);
CREATE INDEX oauth_refresh_expiry ON oauth_refresh_tokens(expires_at,id);
CREATE TRIGGER oauth_refresh_frozen BEFORE UPDATE ON oauth_refresh_tokens
 WHEN NEW.id<>OLD.id OR NEW.grant_id<>OLD.grant_id OR NEW.secret_sha256<>OLD.secret_sha256
   OR NEW.scope<>OLD.scope OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
 BEGIN SELECT RAISE(ABORT,'OAuth refresh token binding is immutable'); END;

CREATE TABLE oauth_registration_windows (
 window_start INTEGER NOT NULL PRIMARY KEY CHECK(window_start>=0),
 count INTEGER NOT NULL CHECK(count>=0)
) STRICT;
