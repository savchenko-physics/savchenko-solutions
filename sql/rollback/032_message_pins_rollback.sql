-- Rollback for 032_message_pins.sql

DROP INDEX IF EXISTS idx_messages_pinned;
ALTER TABLE messages DROP COLUMN IF EXISTS pinned_at;
ALTER TABLE messages DROP COLUMN IF EXISTS pinned_by;

-- Then remove the migration record so it can be re-applied:
--   DELETE FROM applied_migrations WHERE name = '032_message_pins.sql';
