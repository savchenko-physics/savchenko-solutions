-- Rollback for 033_message_forward.sql

ALTER TABLE messages DROP COLUMN IF EXISTS forwarded_from_user_id;

-- Then remove the migration record so it can be re-applied:
--   DELETE FROM applied_migrations WHERE name = '033_message_forward.sql';
