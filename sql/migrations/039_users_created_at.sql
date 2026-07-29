-- 039_users_created_at.sql
--
-- users.created_at is NULL for all 963 rows. Not most — all of them. So signup cohorts,
-- growth rate, activation rate and retention curves do not exist for this platform and
-- never have; every number quoted about growth is currently a guess.
--
-- Two halves to the fix. This migration makes the column correct going forward. The
-- backfill of existing rows is scripts/backfill-user-created-at.js, which is separate
-- because it is a data migration with judgement in it, and because a row we cannot date
-- must stay NULL rather than be invented.
--
-- Note the column is deliberately NOT made NOT NULL: rows with no datable evidence are
-- honestly unknown, and writing now() into them would silently claim that 848 dormant
-- accounts all registered today. created_at_source records which is which, so a query can
-- always exclude inferred dates from a cohort analysis.

-- New signups get a real timestamp from here on.
ALTER TABLE users ALTER COLUMN created_at SET DEFAULT now();

-- 'exact'    — recorded at signup by the application (everything after this migration)
-- 'inferred' — earliest activity we can find for the account; a UPPER BOUND on the true
--              signup date, since the account existed at least that early
-- 'unknown'  — no activity anywhere; the account is undatable
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at_source VARCHAR(16);

COMMENT ON COLUMN users.created_at IS
    'Signup time. NULL means undatable — see created_at_source. Inferred values are an upper bound on the true date.';
COMMENT ON COLUMN users.created_at_source IS
    'exact | inferred | unknown — provenance of created_at. Exclude non-exact rows from cohort analysis.';

CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);
