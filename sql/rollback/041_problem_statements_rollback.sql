-- Rollback for 041_problem_statements.sql.
-- Dropping problem_difficulty discards paid-for API results; export it first if you may
-- want it back:  \copy problem_difficulty TO 'difficulty.csv' CSV HEADER
DROP TABLE IF EXISTS problem_difficulty;
DROP TABLE IF EXISTS problem_statements;
