-- Decision history reuses immutable rows; these indexes bound reason-filtered pages and event delivery aggregation.
CREATE INDEX alert_notification_decision_reason ON alert_notification_decisions(mailbox_id,decision,decided_at DESC,event_id DESC);
CREATE INDEX webhook_event_deliveries ON webhook_deliveries(mailbox_id,event_id);
