-- Pinned messages. A message with pinned_at set is pinned in its conversation;
-- the most recently pinned one is surfaced in a bar above the chat.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_pinned
    ON messages (conversation_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;
