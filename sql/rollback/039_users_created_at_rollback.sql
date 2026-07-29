-- Rollback for 039_users_created_at.sql.
-- Note this does NOT null out backfilled created_at values; dropping the source column
-- alone would leave inferred dates indistinguishable from exact ones, so do both or
-- neither.
DROP INDEX IF EXISTS idx_users_created_at;
UPDATE users SET created_at = NULL WHERE created_at_source IN ('inferred', 'unknown');
ALTER TABLE users DROP COLUMN IF EXISTS created_at_source;
ALTER TABLE users ALTER COLUMN created_at DROP DEFAULT;
