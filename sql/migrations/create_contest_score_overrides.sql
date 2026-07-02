-- Migration: contest_score_overrides
-- Records admin decisions for ambiguous contest entries
-- (same author, both EN and RU for the same problem during the contest window).
--
-- decision values:
--   independent    — both language versions count with full multipliers (default)
--   self_translation — first language: full multipliers; second: +0.5 flat
--   exclude        — both versions excluded from scoring
--
-- Run once with: psql $DATABASE_URL -f sql/migrations/create_contest_score_overrides.sql

CREATE TABLE IF NOT EXISTS contest_score_overrides (
    id            SERIAL PRIMARY KEY,
    problem_name  TEXT        NOT NULL,
    user_id       INTEGER     NOT NULL,
    decision      TEXT        NOT NULL CHECK (decision IN ('independent', 'self_translation', 'exclude')),
    decided_by    INTEGER,
    decided_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes         TEXT,
    UNIQUE (problem_name, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cso_lookup ON contest_score_overrides (problem_name, user_id);
