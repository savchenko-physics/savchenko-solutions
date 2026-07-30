-- 041_problem_statements.sql
--
-- The site has served 2,023 problems for four years without ever storing what any of them
-- says. Solutions live as markdown on disk; the statements exist only inside those files,
-- inside an Overleaf .tex, and inside a scanned PDF. Nothing can query them, which is why
-- the upload form asks people to solve a problem it cannot show them, and why there has
-- never been a difficulty rating: there was nothing to rate.
--
-- Two tables. One row per problem per language (4,046), and one difficulty record per
-- problem.

CREATE TABLE IF NOT EXISTS problem_statements (
    problem_name  VARCHAR(16) NOT NULL,          -- '1.1.1'
    lang          VARCHAR(2)  NOT NULL,          -- 'ru' | 'en'
    chapter       SMALLINT    NOT NULL,
    section       SMALLINT    NOT NULL,
    idx           SMALLINT    NOT NULL,          -- position within the section
    statement_tex TEXT        NOT NULL,          -- maths kept in $...$ exactly as the book has it
    figures       TEXT[]      NOT NULL DEFAULT '{}',   -- ['/img/1.1.1/statement.png']
    -- Savchenko marks harder problems with a star in the printed book. 565 of 2,023 carry
    -- it. It is the only independent difficulty ground truth this project has, so it is
    -- stored rather than recomputed, and deliberately withheld from the scoring model.
    starred       BOOLEAN     NOT NULL DEFAULT false,
    source        VARCHAR(16) NOT NULL,          -- tex | md | pdf | pdf+llm
    needs_review  BOOLEAN     NOT NULL DEFAULT false,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (problem_name, lang)
);

CREATE INDEX IF NOT EXISTS idx_problem_statements_lang    ON problem_statements (lang);
CREATE INDEX IF NOT EXISTS idx_problem_statements_starred ON problem_statements (starred);
CREATE INDEX IF NOT EXISTS idx_problem_statements_review  ON problem_statements (needs_review) WHERE needs_review;

COMMENT ON COLUMN problem_statements.starred IS
    'Savchenko''s own ∗ marker. Means "harder than its neighbours in this section", not hard in absolute terms — use it for within-section ranking, never as an absolute scale.';
COMMENT ON COLUMN problem_statements.source IS
    'Where the text came from: tex (English Overleaf), md (posts/<lang>/*.md), pdf (raw pdftotext), pdf+llm (pdftotext with the maths re-typeset).';

-- Scores are JSONB rather than one column per axis, following the pattern already proven
-- by contest_evaluations (contestJudge.js:56) — adding an axis then needs no migration.
CREATE TABLE IF NOT EXISTS problem_difficulty (
    problem_name  VARCHAR(16) PRIMARY KEY,
    model         VARCHAR(40) NOT NULL,
    scores        JSONB       NOT NULL,          -- {overall_difficulty: 62, elegance: 80, ...}
    calibrated    SMALLINT,                      -- overall_difficulty mapped onto the ∗-anchored scale
    starred       BOOLEAN     NOT NULL DEFAULT false,   -- denormalised so one query answers "author's hard problems"
    key_idea      TEXT,
    prerequisites TEXT[]      NOT NULL DEFAULT '{}',
    est_minutes   SMALLINT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    cost_usd      NUMERIC(10,6),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_problem_difficulty_starred ON problem_difficulty (starred, calibrated DESC);
CREATE INDEX IF NOT EXISTS idx_problem_difficulty_calib   ON problem_difficulty (calibrated DESC);

COMMENT ON TABLE problem_difficulty IS
    'AI difficulty scores. The model is not shown the starred flag — keeping it blind is what makes starred-vs-unstarred separation a real check rather than an echo.';
