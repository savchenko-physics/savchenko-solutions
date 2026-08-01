-- Rollback for 043_feedback_downvotes.sql. Run by hand; the migration runner is forward-only.
--
-- Destructive in one direction only: downvotes are discarded and `votes` is recomputed from
-- the surviving upvotes, so scores will rise. Nothing else is lost.

DELETE FROM feedback_votes WHERE value = -1;

UPDATE feedback_items f
SET votes = COALESCE((SELECT count(*) FROM feedback_votes v WHERE v.item_id = f.id), 0);

ALTER TABLE feedback_votes DROP CONSTRAINT IF EXISTS feedback_votes_value_check;
ALTER TABLE feedback_votes DROP COLUMN IF EXISTS value;
ALTER TABLE feedback_items DROP COLUMN IF EXISTS upvotes;
ALTER TABLE feedback_items DROP COLUMN IF EXISTS downvotes;
