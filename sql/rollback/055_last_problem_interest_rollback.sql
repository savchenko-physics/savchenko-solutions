-- Rollback for 055_last_problem_interest.sql. Run only after the code that reads these columns
-- (lastProblem.js since conservation of interest) is gone. Interest already paid stays in the
-- wallets and in quanta_ledger (reason 'interest'); only the bookkeeping columns go.
ALTER TABLE lp_ticks DROP COLUMN IF EXISTS rate;
ALTER TABLE lp_positions DROP COLUMN IF EXISTS interest;
ALTER TABLE lp_market DROP COLUMN IF EXISTS demon_interest;
ALTER TABLE lp_market DROP COLUMN IF EXISTS scale;
DELETE FROM applied_migrations WHERE name = '055_last_problem_interest.sql';
