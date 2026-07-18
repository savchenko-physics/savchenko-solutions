-- Soft email verification for new signups + recovery-appeal support in the
-- password-reset admin queue.
--
-- Note: users.is_verified_user already exists but is the admin-granted
-- "trusted contributor" flag, NOT email verification — so we add dedicated
-- columns rather than overload it.

-- ── Users: email verification ────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMP WITH TIME ZONE;

-- Grandfather every existing user as verified (they predate verification, so
-- soft verification must not disrupt them). New signups start unverified.
UPDATE users SET email_verified = TRUE;

CREATE INDEX IF NOT EXISTS idx_users_email_verification_token
  ON users (email_verification_token) WHERE email_verification_token IS NOT NULL;

-- ── Password reset requests: recovery appeals ────────────────────────────────
-- request_type distinguishes an automatic reset request ('reset') from a
-- user-submitted account-recovery appeal ('recovery_appeal'); note holds the
-- appeal message. Appeals are inserted with status='pending' so they surface in
-- the existing /admin/password-resets "needs review" queue.
ALTER TABLE password_reset_requests ADD COLUMN IF NOT EXISTS request_type VARCHAR(20) NOT NULL DEFAULT 'reset';
ALTER TABLE password_reset_requests ADD COLUMN IF NOT EXISTS note TEXT;
