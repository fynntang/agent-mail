-- Scoped delivery retry history reuses existing append-only Owner audits.
CREATE INDEX audit_resource_history ON audit_events(mailbox_id,resource_id,action,occurred_at DESC,id DESC);
