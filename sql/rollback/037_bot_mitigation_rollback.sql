-- Rollback for 037_bot_mitigation.sql.
-- Dropping request_log discards the diagnostic buffer; request_log_hourly holds the
-- rollup, so drop that last and only if you really mean it.
DROP TABLE IF EXISTS request_log;
DROP TABLE IF EXISTS request_log_hourly;
DROP TABLE IF EXISTS trusted_ips;
ALTER TABLE recent_views DROP COLUMN IF EXISTS user_agent;
