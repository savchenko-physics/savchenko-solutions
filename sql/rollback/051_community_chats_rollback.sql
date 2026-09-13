-- Rollback for 051_community_chats.sql
--
-- Undo the data first: `node scripts/split-community-chat.js --undo <backup.json>` moves the
-- English messages back into the Russian chat before the English chat is deleted. Dropping
-- this column alone would leave two chats and break registration's lookup.

DROP INDEX IF EXISTS conversations_community_lang_uniq;
ALTER TABLE conversations DROP COLUMN IF EXISTS community_lang;

-- Then remove the migration record so it can be re-applied:
--   DELETE FROM applied_migrations WHERE name = '051_community_chats.sql';
