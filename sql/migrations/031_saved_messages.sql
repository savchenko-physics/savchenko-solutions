-- "Saved Messages" self-chat: a conversation a user has with themselves.
-- saved_for_user_id (when set) marks the conversation as that user's private
-- saved chat, so it is never confused with a DM whose other member was deleted.
-- The partial unique index guarantees at most one saved chat per user.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS saved_for_user_id INTEGER
    REFERENCES users(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_saved_for_user
    ON conversations (saved_for_user_id) WHERE saved_for_user_id IS NOT NULL;
