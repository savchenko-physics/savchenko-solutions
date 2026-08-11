-- Two signals the site has never captured.
--
-- 1. How long a solution took to write. The editor already knows when it opened and
--    when it saved; nothing recorded it, so "1,506 solutions" could never be stated as
--    an amount of work. Nullable: every existing row predates the measurement, and a
--    contribution saved by any other path legitimately has no figure.
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS compose_seconds INTEGER;

-- 2. Drafts, including the ones nobody finishes. Where people give up is more useful
--    than where they succeed: a problem five contributors started and none completed is
--    the most valuable line the unsolved list could carry, and today an abandoned
--    attempt leaves no trace at all.
--
--    One row per person per problem per language — a draft is a work in progress, not a
--    history, so saving again replaces it.
CREATE TABLE IF NOT EXISTS solution_drafts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    problem_name TEXT NOT NULL,
    language TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    -- Set when the draft turned into a published contribution. Rows that keep NULL
    -- forever are exactly the abandoned attempts worth knowing about.
    completed_at TIMESTAMPTZ,
    UNIQUE(user_id, problem_name, language)
);

-- "Who is working on this problem" and "what am I part-way through" are the two reads.
CREATE INDEX IF NOT EXISTS idx_solution_drafts_problem
    ON solution_drafts(problem_name, language) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_solution_drafts_user
    ON solution_drafts(user_id, updated_at DESC);
