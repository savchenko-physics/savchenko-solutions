-- 037_bot_mitigation.sql
--
-- Supporting tables for botgate.js (request classifier) and tracker.js (standing request
-- log). DDL only: the migration runner wraps each file in a single transaction, so no
-- VACUUM, no CREATE INDEX CONCURRENTLY and no bulk DELETE belongs here — those live in
-- scripts/ and are run by hand.

-- Addresses that must never be demoted or blocked by any rule.
-- Seeded with the Novosibirsk gateway: one shared NAT behind which sits the site's most
-- engaged audience (10,692 visits at 3.14 pages each, 472 s average, 9.5% bounce). A
-- naive per-IP rule would punish them harder than any scraper, because the scrapers
-- spread across hundreds of /24s while a whole school shares one address.
CREATE TABLE IF NOT EXISTS trusted_ips (
    ip_address VARCHAR(64) PRIMARY KEY,   -- bare address or CIDR; bare implies /32
    note       TEXT,
    added_by   INTEGER REFERENCES users(id),
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO trusted_ips (ip_address, note) VALUES
    ('84.237.49.0/24', 'Novosibirsk NAT gateway - school/library; 10692 visits, 3.14 pages/visit, 472s, 9.5% bounce'),
    ('162.120.128.0/17', 'VPN by Google (Google One) - measured 348 hits/117 IPs of real readers')
ON CONFLICT (ip_address) DO NOTHING;

-- Standing request log. Deliberately a short-retention diagnostic buffer, not an archive:
-- tracker.js prunes it (default 14 days) and rolls it up into request_log_hourly.
CREATE TABLE IF NOT EXISTS request_log (
    id              BIGSERIAL PRIMARY KEY,
    ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip              VARCHAR(64),
    method          VARCHAR(8),
    path            VARCHAR(500),
    status          INTEGER,
    duration_ms     INTEGER,
    user_agent      VARCHAR(300),
    -- NULL means the header was absent, which is itself the strongest single signal we
    -- have. Do not conflate it with an empty string.
    accept_language VARCHAR(120),
    accept_encoding VARCHAR(120),
    sec_ch_ua       VARCHAR(200),
    referer         VARCHAR(300),
    verdict         VARCHAR(16),
    reasons         TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_request_log_verdict_ts ON request_log (verdict, ts DESC);
CREATE INDEX IF NOT EXISTS idx_request_log_ip ON request_log (ip);

-- Tiny, kept indefinitely: the long-run view of whether mitigation is working.
CREATE TABLE IF NOT EXISTS request_log_hourly (
    hour         TIMESTAMPTZ NOT NULL,
    verdict      VARCHAR(16) NOT NULL,
    requests     INTEGER NOT NULL,
    distinct_ips INTEGER NOT NULL,
    PRIMARY KEY (hour, verdict)
);

-- recent_views has never recorded a User-Agent, which is precisely why the historical
-- traffic cannot be reclassified after the fact. Capture it from now on so the next wave
-- is analysable retrospectively. Length cap matches the tracking.js idiom.
ALTER TABLE recent_views ADD COLUMN IF NOT EXISTS user_agent VARCHAR(300);
