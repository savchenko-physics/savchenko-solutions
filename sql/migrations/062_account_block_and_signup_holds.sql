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

-- Tele2 Kazakhstan's mobile pool (RDAP: 188.124.246.0/24 "pool-net-kar", KZ). Бека (user 2621)
-- registered from 188.124.234.11 and wrote from .246.196 and .236.204 within one day; the one
-- registration from this range in the two weeks before was his.
INSERT INTO signup_ip_holds (cidr, reason, created_by) VALUES
    ('188.124.224.0/19', 'Tele2 KZ mobile pool of user 2621 (Бека), blocked for abuse in the chats on 2026-09-21', 28)
ON CONFLICT (cidr) DO NOTHING;
