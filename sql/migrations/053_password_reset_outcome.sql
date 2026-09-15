-- What happened to each account-recovery request, so the email limits can be counted.
--
-- password_reset_requests has logged every "Forgot password?" and recovery appeal since
-- migration 015, but not whether an email went out. The limits in lib/passwordReset.js (per
-- account and site-wide) count emails, and they have to be counted in the database: the per-IP
-- limiter keeps its counters in memory, which every restart empties, and a proxy pool has
-- thousands of addresses. outcome stays NULL on the rows from before this migration.
--   sent           handed to SES
--   failed         SES refused it; still counts toward the limits, it was an attempt
--   no_account     nothing matched what was typed; no email
--   account_limit  the account had used up its emails for now; no email
--   site_limit     the site-wide ceiling was reached; no email
--
-- The two partial indexes serve the two counts in accountRecovery.js, whose WHERE clause must
-- keep exactly this predicate. Adding a nullable column without a default is a catalogue
-- change (no table rewrite), but ALTER TABLE still takes an ACCESS EXCLUSIVE lock, so give up
-- rather than queue behind a long reader of the admin page.
--
-- Deploy this before the code that writes outcome.
SET lock_timeout = '5s';

ALTER TABLE password_reset_requests ADD COLUMN IF NOT EXISTS outcome VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_password_reset_requests_emailed
    ON password_reset_requests (created_at) WHERE outcome IN ('sent', 'failed');
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_user_emailed
    ON password_reset_requests (user_id, created_at) WHERE outcome IN ('sent', 'failed');

RESET lock_timeout;
