-- Reverse of sql/migrations/045_comment_brainstorm_flag.sql.
-- Kept out of the migrations dir so the forward-only runner never auto-applies it.

ALTER TABLE solution_comments
    DROP COLUMN IF EXISTS is_brainstorm;
