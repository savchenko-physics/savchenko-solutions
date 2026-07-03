-- Online presence: track the last time each user was seen active.
-- Updated (throttled) on each authenticated request in index.js. A user is
-- considered "online" when last_seen_at is within the online window (5 min).
-- Visibility respects user_preferences.show_online_status.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_last_seen_at ON users (last_seen_at);
