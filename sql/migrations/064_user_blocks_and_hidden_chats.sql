-- 2026-09-21, the DM info panel gets "Block" and "Delete chat" (one-to-one chats only).
--
-- Blocking is a row here: the blocked person can no longer write to the blocker (a DM send,
-- a forward into it, a new DM), and sees why in place of the composer. Taking it back deletes
-- the row. Nothing about the messages changes.
CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks (blocked_id);

-- "Delete chat" removes nothing (the owner's rule: everything stays in the database). It stamps
-- the member's own row, and from then on that member sees only what arrives after the stamp:
-- the chat leaves their sidebar until a new message comes, and opens empty if opened by its
-- address. The other member sees everything as before.
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
