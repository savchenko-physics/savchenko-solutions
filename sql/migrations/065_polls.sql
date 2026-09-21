-- Polls in the messenger (2026-09-21, asked in the Russian chat, Telegram's): a message that
-- carries a question and its options, votes per member, the settings Telegram offers that make
-- sense here (anonymous or not, several answers, revoting, shuffled options, a quiz with one
-- right answer, a closing time). A forward shares the poll (the same poll_id), as Telegram does.
CREATE TABLE IF NOT EXISTS polls (
    id                SERIAL PRIMARY KEY,
    created_by        INTEGER NOT NULL REFERENCES users(id),
    question          VARCHAR(300) NOT NULL,
    anonymous         BOOLEAN NOT NULL DEFAULT TRUE,
    multiple          BOOLEAN NOT NULL DEFAULT FALSE,
    revote            BOOLEAN NOT NULL DEFAULT TRUE,
    shuffle           BOOLEAN NOT NULL DEFAULT FALSE,
    quiz              BOOLEAN NOT NULL DEFAULT FALSE,
    correct_option_id INTEGER,
    closes_at         TIMESTAMPTZ,
    closed_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poll_options (
    id        SERIAL PRIMARY KEY,
    poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    position  SMALLINT NOT NULL,
    text      VARCHAR(100) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options (poll_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id  INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (poll_id, option_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON poll_votes (poll_id, user_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll_id INTEGER REFERENCES polls(id);
CREATE INDEX IF NOT EXISTS idx_messages_poll ON messages (poll_id) WHERE poll_id IS NOT NULL;
