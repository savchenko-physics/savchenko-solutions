-- Migration: contest_evaluations
-- Blind dual-judge quality grades for the June contest (see contestJudge.js).
--
-- Each of the two organizers independently grades a credited submission
-- (problem_name, language) on six quality parameters (stored in `scores`
-- JSONB, keyed by parameter). `total` is the mean of that judge's parameters.
-- The two judges' totals combine into a geometric-mean quality score used to
-- highlight the best works. Neither judge ever sees the other's row.
--
-- One row per (contest_slug, problem_name, language, judge_id); upsert on save.
--
-- Run once with: psql $DATABASE_URL -f sql/migrations/create_contest_evaluations.sql
-- (The app also auto-creates this table via ensureEvaluationsTable() on first hit.)

CREATE TABLE IF NOT EXISTS contest_evaluations (
    id            SERIAL PRIMARY KEY,
    contest_slug  TEXT        NOT NULL,
    problem_name  TEXT        NOT NULL,
    language      TEXT        NOT NULL,
    judge_id      INTEGER     NOT NULL,
    scores        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    total         NUMERIC(5,2),
    comment       TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (contest_slug, problem_name, language, judge_id)
);

CREATE INDEX IF NOT EXISTS idx_contest_eval_lookup
    ON contest_evaluations (contest_slug, problem_name, language);
