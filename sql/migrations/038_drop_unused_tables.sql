-- 038_drop_unused_tables.sql
-- Drop three tables that were created but never used.
--
-- Verified on production (2026-07-29) before dropping:
--   * 0 rows, and pg_stat_user_tables shows lifetime n_tup_ins/upd/del = 0
--     (nothing was ever written to them, not even rows later deleted)
--   * no foreign keys from any other table reference them
--   * no views, matviews or rules depend on them
--   * no reference anywhere in the application code (only in prompts/,
--     which is documentation, not runtime)
--
-- Note on `sections`: superseded by src/database/sections.csv, which is what
-- parents.js actually reads. The table was never populated.
--
-- Deliberately NOT dropped, even though they are also empty -- these are
-- referenced by live code and dropping them would break requests at runtime:
--   bank_problems, bank_attempts, bank_comments, bank_difficulty_votes (bank.js,
--   post.js, sitemap.js), challenge_leaderboard (challenges.js, admin.js),
--   contest_score_overrides (contest.js, admin.js), message_hidden and
--   message_reports (messages.js).
--
-- Rollback: sql/rollback/038_drop_unused_tables_rollback.sql

BEGIN;

DROP TABLE IF EXISTS public.alternative_solutions;
DROP TABLE IF EXISTS public.user_achievements;
DROP TABLE IF EXISTS public.sections;

COMMIT;
