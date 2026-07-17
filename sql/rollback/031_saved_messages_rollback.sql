-- Rollback for 031_saved_messages.sql

DROP INDEX IF EXISTS idx_conversations_saved_for_user;
ALTER TABLE conversations DROP COLUMN IF EXISTS saved_for_user_id;

-- Then remove the migration record so it can be re-applied:
--   DELETE FROM applied_migrations WHERE name = '031_saved_messages.sql';
