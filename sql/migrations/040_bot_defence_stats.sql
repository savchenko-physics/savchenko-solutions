-- 040_bot_defence_stats.sql
--
-- Durable record of what the bot gate actually turned away, so a future wave can be
-- compared against this one instead of being investigated from scratch.
--
-- Two problems this fixes.
--
-- First, request_log keeps raw rows for 14 days and then deletes them, and the only
-- rollup ran inside the prune — so nothing was aggregated until rows were already two
-- weeks old, and the history vanished after that.
--
-- Second, and worse: request_log deliberately skips static assets, but a blocked bot's
-- traffic is almost entirely assets. During one 90-second capture the farm made ~1,000
-- requests from two /24s and every one was a CSS, JS or font fetch returning 403 — so
-- request_log recorded 141 blocked requests when the real figure was orders of magnitude
-- higher. Counting attempts and storing request bodies are different jobs; these tables
-- do the first one, cheaply, for every request including assets.

-- What fired, per hour. Small enough to keep forever: ~3 verdicts x ~15 reasons an hour.
CREATE TABLE IF NOT EXISTS bot_defence_hourly (
    hour         TIMESTAMPTZ NOT NULL,
    verdict      VARCHAR(16) NOT NULL,   -- human | quiet | block
    rule         VARCHAR(24) NOT NULL,   -- which rule decided it ('-' when none did)
    reason       VARCHAR(48) NOT NULL,   -- the specific signal, e.g. ua-encoding-contradiction
    requests     BIGINT      NOT NULL DEFAULT 0,
    distinct_ips INTEGER     NOT NULL DEFAULT 0,
    assets       BIGINT      NOT NULL DEFAULT 0,  -- of `requests`, how many were static assets
    PRIMARY KEY (hour, verdict, rule, reason)
);
CREATE INDEX IF NOT EXISTS idx_bot_defence_hourly_hour ON bot_defence_hourly (hour DESC);

-- Where it came from, per day, per /16. Only non-human verdicts are recorded, which keeps
-- this bounded — a few hundred rows a day — while still being exactly the input you would
-- want when deciding whether a range has earned a permanent entry in blocked_ips.
CREATE TABLE IF NOT EXISTS bot_network_daily (
    day          DATE        NOT NULL,
    net16        VARCHAR(16) NOT NULL,
    verdict      VARCHAR(16) NOT NULL,
    requests     BIGINT      NOT NULL DEFAULT 0,
    distinct_ips INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (day, net16, verdict)
);
CREATE INDEX IF NOT EXISTS idx_bot_network_daily_day ON bot_network_daily (day DESC);

COMMENT ON TABLE bot_defence_hourly IS
    'Hourly count of bot-gate decisions, including static-asset requests that request_log omits. Kept indefinitely.';
COMMENT ON COLUMN bot_defence_hourly.distinct_ips IS
    'Exact within an hour. A process restart mid-hour can undercount this (the in-memory IP set restarts); requests stays exact because it is written as a delta.';
COMMENT ON TABLE bot_network_daily IS
    'Daily per-/16 counts for non-human verdicts. Intended as the evidence base for future CIDR decisions.';
