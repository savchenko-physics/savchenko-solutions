-- Rollback for 046_feedback_resolved.sql. Run by hand.
--
-- Threads stay locked afterwards, because locking is derived from status and does not depend
-- on this column. Only the "solved on <date>" line loses its date.

ALTER TABLE feedback_items DROP COLUMN IF EXISTS resolved_at;
