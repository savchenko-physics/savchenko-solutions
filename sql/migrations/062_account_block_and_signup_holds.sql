-- 2026-09-21. After the 24-hour chat block (061) the same person moved to the English chat
-- (32 messages in twelve minutes, all deleted by a moderator) and to a DM. Two things:
--
-- 1. An account-wide block on writing: every chat and DM (messages.js), new conversations,
--    solution comments. 'infinity' is for good. lib/chatRestrictions.js decides;
--    scripts/chat-restrict.js sets it. Reading and signing in are not restricted.
ALTER TABLE users ADD COLUMN IF NOT EXISTS posting_blocked_until TIMESTAMPTZ;

-- 2. Registrations from listed networks are held for manual review on /admin/signups instead
--    of being created (lib/signupHolds.js). The list holds IPv4 addresses or CIDRs.
CREATE TABLE IF NOT EXISTS signup_ip_holds (
    id          SERIAL PRIMARY KEY,
    cidr        VARCHAR(64) NOT NULL UNIQUE,
    reason      TEXT,
    created_by  INTEGER REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per held registration attempt, with everything needed to create the account on
-- approval (the password is already hashed). status: pending | approved | rejected.
CREATE TABLE IF NOT EXISTS signup_holds (
    id             SERIAL PRIMARY KEY,
    username       VARCHAR(255) NOT NULL,
    email          VARCHAR(255) NOT NULL,
    full_name      VARCHAR(255),
    password_hash  TEXT NOT NULL,
    lang           VARCHAR(2) NOT NULL DEFAULT 'en',
    ip             VARCHAR(64),
    user_agent     VARCHAR(300),
    matched_cidr   VARCHAR(64),
    status         VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by    INTEGER REFERENCES users(id),
    reviewed_at    TIMESTAMPTZ,
    user_id        INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_signup_holds_status ON signup_holds (status, created_at DESC);

-- The list itself is data, kept in the database and managed on /admin/signups (the first entry,
-- one mobile carrier's pool, was added by hand on 2026-09-21); nothing is seeded here.
