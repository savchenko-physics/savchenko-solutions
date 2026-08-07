-- Rollback for 042_feedback.sql.
--
-- Kept out of sql/migrations/ on purpose: the runner is forward-only and applies every file
-- it finds there, so a rollback living beside its migration would drop the tables it just
-- created. Run this by hand.
--
-- Destructive. feedback_items holds the only copy of what people have written in; export it
-- before running this if there is anything in it.

DROP TABLE IF EXISTS poll_answers;
DROP TABLE IF EXISTS feedback_votes;
DROP TABLE IF EXISTS feedback_items;
