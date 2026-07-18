-- Per-conversation mute, "delete for me", and message reports.

-- Mute: suppress notifications for a conversation (per member).
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT FALSE;

-- "Delete for me": a message hidden for a single user (vs. deleted for everyone).
CREATE TABLE IF NOT EXISTS message_hidden (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hidden_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_hidden_user ON message_hidden (user_id);

-- Reporting a message to moderators.
CREATE TABLE IF NOT EXISTS message_reports (
    id           SERIAL PRIMARY KEY,
    message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reporter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason       VARCHAR(500),
    status       VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_message_reports_status ON message_reports (status, created_at);
