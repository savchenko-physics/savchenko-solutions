-- Rollback for 042_difficulty_finder.sql.
-- Dropping problem_difficulty_votes discards real reader votes; export first if you may
-- want them back:  \copy problem_difficulty_votes TO 'difficulty_votes.csv' CSV HEADER
DROP TABLE IF EXISTS problem_difficulty_votes;

ALTER TABLE problem_difficulty DROP COLUMN IF EXISTS canonical_tags;
