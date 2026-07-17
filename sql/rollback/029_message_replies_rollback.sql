-- Rollback for 029_message_replies.sql

DROP INDEX IF EXISTS idx_messages_reply_to;
ALTER TABLE messages DROP COLUMN IF EXISTS reply_to_id;

-- Then remove the migration record so it can be re-applied:
--   DELETE FROM applied_migrations WHERE name = '029_message_replies.sql';
