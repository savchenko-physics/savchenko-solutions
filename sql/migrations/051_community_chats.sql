-- Two community chats instead of one.
--
-- Since May 2026 every account joined one site-wide group chat, "Savchenko Solutions"
-- (conversation 5 in production). By September it held 253 messages: 215 Russian, 12
-- English and 3 bilingual announcements, so the people who write in English had nowhere to
-- talk and Russian speakers had started posting English copies of their own messages.
--
-- It becomes two chats, one per language. This column marks them: NULL for every ordinary
-- DM and group, 'en' or 'ru' for the community chat in that language, at most one each.
-- Code finds the chats through it (registration used to look the chat up by its title,
-- which any chat moderator could rename). The data move itself (tagging the existing chat,
-- creating the English one, moving the English messages, default mutes) is a reviewed
-- one-off: scripts/split-community-chat.js.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS community_lang VARCHAR(2)
    CHECK (community_lang IN ('en', 'ru'));

CREATE UNIQUE INDEX IF NOT EXISTS conversations_community_lang_uniq
    ON conversations (community_lang) WHERE community_lang IS NOT NULL;
