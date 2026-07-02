-- Reverse of sql/migrations/026_brainstorm.sql.
--
-- IMPORTANT: this lives OUTSIDE sql/migrations/ on purpose. The migration runner
-- (scripts/run-migrations.js) applies EVERY *.sql file in sql/migrations/, so a
-- rollback script placed there would be auto-applied and drop the feature right
-- after it was created. Keep all reverse scripts under sql/rollback/.
--
-- The runner is forward-only, so run this manually with psql to fully undo the
-- Brainstorm Room schema:
--
--   psql "$DATABASE_URL" -f sql/rollback/026_brainstorm_rollback.sql
--
-- Non-destructive to every pre-existing table: it only drops the brainstorm
-- tables and the single column this feature added.

-- Drop in FK-dependency order (children first).
DROP TABLE IF EXISTS brainstorm_message_links;
DROP TABLE IF EXISTS brainstorm_reactions;
DROP TABLE IF EXISTS brainstorm_messages;

ALTER TABLE user_preferences DROP COLUMN IF EXISTS brainstorm_display_mode;

-- Forget the applied-migration record so the forward migration can re-run.
DELETE FROM applied_migrations WHERE name = '026_brainstorm.sql';
