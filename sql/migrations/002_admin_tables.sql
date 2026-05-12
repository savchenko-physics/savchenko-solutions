-- Admin dashboard tables
-- Run this migration to enable admin features

-- 1. Add status tracking to solution_reports (if columns don't exist)
ALTER TABLE solution_reports ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE solution_reports ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id);
ALTER TABLE solution_reports ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;

-- 2. Blocked IPs table (replaces hardcoded array in index.js)
CREATE TABLE IF NOT EXISTS blocked_ips (
  id SERIAL PRIMARY KEY,
  ip_address VARCHAR(45) NOT NULL UNIQUE,
  reason TEXT,
  blocked_by INTEGER REFERENCES users(id),
  blocked_at TIMESTAMP DEFAULT NOW()
);

-- Migrate the 13 hardcoded IPs
INSERT INTO blocked_ips (ip_address, reason) VALUES
  ('88.150.230.32', 'Legacy blocklist migration'),
  ('176.193.25.172', 'Legacy blocklist migration'),
  ('77.37.146.158', 'Legacy blocklist migration'),
  ('79.139.132.133', 'Legacy blocklist migration'),
  ('178.176.78.181', 'Legacy blocklist migration'),
  ('65.109.58.154', 'Legacy blocklist migration'),
  ('83.220.238.208', 'Legacy blocklist migration'),
  ('178.176.77.74', 'Legacy blocklist migration'),
  ('109.252.153.135', 'Legacy blocklist migration'),
  ('176.59.207.161', 'Legacy blocklist migration'),
  ('5.228.81.203', 'Legacy blocklist migration'),
  ('81.57.75.160', 'Legacy blocklist migration'),
  ('82.194.13.2', 'Legacy blocklist migration')
ON CONFLICT (ip_address) DO NOTHING;

-- 3. Admin activity log
CREATE TABLE IF NOT EXISTS admin_actions (
  id SERIAL PRIMARY KEY,
  admin_user_id INTEGER REFERENCES users(id),
  action_type VARCHAR(50) NOT NULL,
  target_type VARCHAR(50),
  target_id INTEGER,
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 4. Add is_verified_user to users if it doesn't exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified_user BOOLEAN DEFAULT FALSE;
