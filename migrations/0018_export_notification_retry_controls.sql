-- Additive cancellation marker preserves the immutable selection and original commit state.
ALTER TABLE async_export_notification_retry_batches ADD COLUMN cancelled_at INTEGER CHECK(cancelled_at IS NULL OR cancelled_at>=0);
CREATE TRIGGER export_retry_batch_cancel_immutable
BEFORE UPDATE OF cancelled_at ON async_export_notification_retry_batches
WHEN OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NOT OLD.cancelled_at
BEGIN
  SELECT RAISE(ABORT,'export_retry_batch_cancel_immutable');
END;
