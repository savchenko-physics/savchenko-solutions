-- Rollback for 035_email_verification_and_recovery.sql
DROP INDEX IF EXISTS idx_users_email_verification_token;
ALTER TABLE users DROP COLUMN IF EXISTS email_verification_expires;
ALTER TABLE users DROP COLUMN IF EXISTS email_verification_token;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
ALTER TABLE password_reset_requests DROP COLUMN IF EXISTS note;
ALTER TABLE password_reset_requests DROP COLUMN IF EXISTS request_type;
