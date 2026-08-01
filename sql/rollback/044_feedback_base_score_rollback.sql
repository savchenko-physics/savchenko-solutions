-- Rollback for 044_feedback_base_score.sql. Run by hand.
--
-- Folds base_score back into votes, which restores the pre-044 shape and also restores the
-- bug it fixed: the next vote on a seeded item will wipe its recorded history again.

UPDATE feedback_items SET votes = base_score + upvotes - downvotes;
ALTER TABLE feedback_items DROP COLUMN IF EXISTS base_score;
