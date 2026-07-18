-- Rollback for 035_messaging_extras.sql

DROP TABLE IF EXISTS message_reports;
DROP TABLE IF EXISTS message_hidden;
ALTER TABLE conversation_members DROP COLUMN IF EXISTS muted;

-- Then remove the migration record so it can be re-applied:
--   DELETE FROM applied_migrations WHERE name = '035_messaging_extras.sql';
