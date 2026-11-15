-- Immutable uploaded bytes can be shared by a draft revision, a frozen send and its Sent copy.
CREATE TABLE draft_attachments (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL, draft_id TEXT NOT NULL, object_id TEXT NOT NULL,
 filename TEXT NOT NULL, content_type TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>=0 AND size_bytes<=5242880),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 scan_status TEXT NOT NULL DEFAULT 'unscanned' CHECK(scan_status IN('unscanned','clean','blocked','failed')),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 UNIQUE(mailbox_id,id), UNIQUE(mailbox_id,draft_id,id),
 FOREIGN KEY(mailbox_id,draft_id) REFERENCES drafts(mailbox_id,id),
 FOREIGN KEY(mailbox_id,object_id) REFERENCES objects(mailbox_id,id)
) STRICT;
CREATE INDEX draft_attachments_draft ON draft_attachments(mailbox_id,draft_id,id);
CREATE TRIGGER draft_attachment_identity_immutable BEFORE UPDATE ON draft_attachments
 WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.draft_id<>OLD.draft_id OR NEW.object_id<>OLD.object_id
 OR NEW.filename<>OLD.filename OR NEW.content_type<>OLD.content_type OR NEW.size_bytes<>OLD.size_bytes
 OR NEW.sha256<>OLD.sha256 OR NEW.created_at<>OLD.created_at
 BEGIN SELECT RAISE(ABORT,'draft attachment identity is immutable'); END;

CREATE TABLE draft_attachment_uploads (
 id TEXT NOT NULL PRIMARY KEY, mailbox_id TEXT NOT NULL, draft_id TEXT NOT NULL,
 created_by_token_id TEXT, expected_version INTEGER NOT NULL CHECK(expected_version>0),
 filename TEXT NOT NULL, content_type TEXT NOT NULL,
 total_bytes INTEGER NOT NULL CHECK(total_bytes>=0 AND total_bytes<=5242880),
 received_bytes INTEGER NOT NULL DEFAULT 0 CHECK(received_bytes>=0 AND received_bytes<=total_bytes),
 state TEXT NOT NULL DEFAULT 'open' CHECK(state IN('open','completed')),
 attachment_id TEXT, created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL,
 UNIQUE(mailbox_id,id),
 FOREIGN KEY(mailbox_id,draft_id) REFERENCES drafts(mailbox_id,id),
 FOREIGN KEY(mailbox_id,created_by_token_id) REFERENCES mailbox_tokens(mailbox_id,id),
 FOREIGN KEY(mailbox_id,draft_id,attachment_id) REFERENCES draft_attachments(mailbox_id,draft_id,id),
 CHECK(expires_at>created_at),
 CHECK((state='open' AND attachment_id IS NULL) OR(state='completed' AND attachment_id IS NOT NULL AND received_bytes=total_bytes))
) STRICT;
CREATE INDEX draft_attachment_uploads_expiry ON draft_attachment_uploads(state,expires_at);
CREATE TRIGGER draft_attachment_upload_identity_immutable BEFORE UPDATE ON draft_attachment_uploads
 WHEN NEW.id<>OLD.id OR NEW.mailbox_id<>OLD.mailbox_id OR NEW.draft_id<>OLD.draft_id
 OR NEW.created_by_token_id IS NOT OLD.created_by_token_id OR NEW.expected_version<>OLD.expected_version
 OR NEW.filename<>OLD.filename OR NEW.content_type<>OLD.content_type OR NEW.total_bytes<>OLD.total_bytes
 OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at OR NEW.received_bytes<OLD.received_bytes
 OR (OLD.state='completed' AND (NEW.state<>OLD.state OR NEW.attachment_id IS NOT OLD.attachment_id))
 BEGIN SELECT RAISE(ABORT,'upload identity is immutable'); END;

CREATE TABLE draft_attachment_upload_parts (
 upload_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, offset_bytes INTEGER NOT NULL CHECK(offset_bytes>=0),
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=65536), object_key TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'), created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(upload_id,offset_bytes),
 FOREIGN KEY(mailbox_id,upload_id) REFERENCES draft_attachment_uploads(mailbox_id,id)
) STRICT;
CREATE TRIGGER draft_attachment_upload_part_immutable BEFORE UPDATE ON draft_attachment_upload_parts
 BEGIN SELECT RAISE(ABORT,'upload chunks are immutable'); END;
