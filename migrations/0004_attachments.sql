-- Old messages are explicitly unextracted; an empty attachment list must not imply parsing succeeded.
ALTER TABLE messages ADD COLUMN attachments_state TEXT NOT NULL DEFAULT 'not_extracted'
 CHECK(attachments_state IN('not_extracted','ready'));
CREATE INDEX attachments_message ON attachments(mailbox_id,message_id,part_id);
