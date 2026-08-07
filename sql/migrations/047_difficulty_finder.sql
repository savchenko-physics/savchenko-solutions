-- 047_difficulty_finder.sql
--
-- Two additions for the difficulty index/finder feature:
--   1. A canonical topic taxonomy on problem_difficulty, replacing the free-text
--      `prerequisites` (2,084 distinct values across 2,023 problems) as the
--      filterable facet, built offline by scripts/canonicalize-tags.js.
--   2. A community difficulty-vote table, deliberately separate from
--      problem_difficulty: never written by the scoring pipeline
--      (scripts/score-difficulty.js), never blended into `scores`/`calibrated`.
--      Aggregated only at read time (post.js, problems.js).
--
-- Both changes are additive against a 2,023-row table; ADD COLUMN ... DEFAULT '{}'
-- is metadata-only on PG11+, and CREATE INDEX/CREATE TABLE at this row count take
-- a lock for milliseconds. No maintenance window needed.

ALTER TABLE problem_difficulty
    ADD COLUMN IF NOT EXISTS canonical_tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_problem_difficulty_canonical_tags
    ON problem_difficulty USING GIN (canonical_tags);

COMMENT ON COLUMN problem_difficulty.canonical_tags IS
    'Fixed ~50-90 tag taxonomy (scripts/canonicalize-tags.js, taxonomy reviewed in data/topic-taxonomy.json), replacing free-text prerequisites as the filterable facet on the problem finder. prerequisites is left untouched for per-problem display.';

CREATE TABLE IF NOT EXISTS problem_difficulty_votes (
    problem_name VARCHAR(16) NOT NULL REFERENCES problem_difficulty(problem_name) ON DELETE CASCADE,
    user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote         SMALLINT    NOT NULL CHECK (vote BETWEEN 1 AND 10),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (problem_name, user_id)
);

CREATE INDEX IF NOT EXISTS idx_problem_difficulty_votes_problem
    ON problem_difficulty_votes (problem_name);

COMMENT ON TABLE problem_difficulty_votes IS
    'Reader difficulty votes, 1-10. Never read by scripts/score-difficulty.js and never written into problem_difficulty.scores/calibrated -- aggregated only at display time (post.js, problems.js). Kept in its own table by design so AI-generated and user-submitted difficulty data can never be confused or overwrite one another.';
