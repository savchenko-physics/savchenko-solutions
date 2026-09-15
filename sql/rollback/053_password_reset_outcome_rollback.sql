-- Rollback for 053_password_reset_outcome.sql. Run only after the code that writes outcome
-- (accountRecovery.js) is gone, or every "Forgot password?" fails inside its INSERT.
DROP INDEX IF EXISTS idx_password_reset_requests_user_emailed;
DROP INDEX IF EXISTS idx_password_reset_requests_emailed;
ALTER TABLE password_reset_requests DROP COLUMN IF EXISTS outcome;
DELETE FROM applied_migrations WHERE name = '053_password_reset_outcome.sql';
