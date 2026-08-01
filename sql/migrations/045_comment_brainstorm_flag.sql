-- Comment "brainstorm" flag.
--
-- Adds a single boolean to solution_comments marking a comment as a brainstorm
-- note (an idea / approach for working the problem, as opposed to a plain remark).
-- This is the mark carried by the messages migrated out of the retired Brainstorm
-- Room (see scripts/migrate-brainstorm-to-comments.js) and is also user-settable
-- from the comment composer.
--
-- Additive and non-destructive: one nullable-with-default column, no data touched.
-- Reverse with sql/rollback/045_comment_brainstorm_flag_rollback.sql.

ALTER TABLE solution_comments
    ADD COLUMN IF NOT EXISTS is_brainstorm BOOLEAN NOT NULL DEFAULT FALSE;
