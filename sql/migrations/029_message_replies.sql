-- Reply-to-message support: a message can quote/reply to an earlier one
-- in the same conversation. ON DELETE SET NULL so removing the original
-- message leaves the reply intact (it just loses the quote).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER
    REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages (reply_to_id);
