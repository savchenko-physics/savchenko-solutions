-- Rollback for 030_message_files.sql

ALTER TABLE messages DROP COLUMN IF EXISTS file_url;
ALTER TABLE messages DROP COLUMN IF EXISTS file_name;
ALTER TABLE messages DROP COLUMN IF EXISTS file_size;

-- Then remove the migration record so it can be re-applied:
--   DELETE FROM applied_migrations WHERE name = '030_message_files.sql';
