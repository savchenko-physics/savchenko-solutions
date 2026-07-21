-- Self-hosted email open/click tracking (see tracking.js). The app also creates
-- this table idempotently on startup; this migration documents the schema for
-- prod parity.
CREATE TABLE IF NOT EXISTS email_events (
    id         SERIAL PRIMARY KEY,
    campaign   VARCHAR(64),
    user_id    INTEGER,
    event      VARCHAR(16) NOT NULL,   -- 'open' | 'click'
    url        TEXT,
    ip         VARCHAR(64),
    ua         VARCHAR(300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_events_campaign ON email_events (campaign, event);
