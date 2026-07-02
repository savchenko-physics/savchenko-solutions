-- Profile settings: institution, email change flow
ALTER TABLE users ADD COLUMN IF NOT EXISTS institution TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_token VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_expires TIMESTAMPTZ;

-- Privacy: show country flag on leaderboard
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS show_country_on_leaderboard BOOLEAN DEFAULT TRUE;
