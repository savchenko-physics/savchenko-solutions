-- 042_feedback.sql
--
-- The site has six ways to tell its owner something and none of them work for the people
-- who actually use it. The Google Form got 20 responses in 162 days. solution_reports has
-- 63 rows of which 62 are still pending, mean age 245 days, exactly one ever resolved. The
-- forum category literally named "Platform Feedback" contains five topics, all five written
-- by the owner. Everything except the report prompt() requires an account, and 59% of
-- visits never come back, let alone register.
--
-- So the intake half is easy and is not the interesting part. The interesting part is
-- closure: a submitter has to be able to see that their message arrived and what happened
-- to it. That is what public_id, status and is_public are for, and it is the whole reason
-- this is a table rather than another mailto:.
--
-- Three tables: the submissions, their votes, and the one-question poll that runs beside
-- them.

CREATE TABLE IF NOT EXISTS feedback_items (
    id             SERIAL      PRIMARY KEY,
    -- Handed to the submitter as /feedback/<public_id> the instant they press send. An
    -- anonymous visitor has no account to check, so this token IS their receipt; it must be
    -- unguessable because the body may quote a page only they were on.
    public_id      VARCHAR(24) NOT NULL UNIQUE,
    category       VARCHAR(16) NOT NULL,          -- error | broken | idea | other
    body           TEXT        NOT NULL,
    lang           VARCHAR(2)  NOT NULL,

    user_id        INTEGER     REFERENCES users(id),   -- NULL = signed out, which is the norm
    contact_kind   VARCHAR(16),                   -- telegram | email | NULL
    contact_value  VARCHAR(255),
    -- 74% of the old survey's respondents said yes to a follow-up, and that converted into
    -- nine real conversations. Worth asking again, cheaply.
    notify_on_ship BOOLEAN     NOT NULL DEFAULT false,

    -- Context captured without asking a single extra question. This is where specificity
    -- actually comes from: 13% of legacy reports were just "неверно" with no detail, and 8%
    -- were rendering bugs mis-filed as physics errors. A bare "не работает" is still
    -- actionable if it arrives pinned to a problem, a URL and a viewport width.
    page_url       TEXT,
    problem_name   VARCHAR(16),
    problem_lang   VARCHAR(2),
    viewport_w     SMALLINT,                      -- the only mobile evidence the site has ever collected
    user_agent     TEXT,
    referrer       TEXT,
    ip_address     VARCHAR(45),

    status         VARCHAR(16) NOT NULL DEFAULT 'new',  -- new|planned|in_progress|done|declined|duplicate
    is_public      BOOLEAN     NOT NULL DEFAULT false,  -- opt-in: the owner publishes, the submitter does not
    public_title   VARCHAR(160),
    public_reply   TEXT,
    duplicate_of   INTEGER     REFERENCES feedback_items(id),
    -- Denormalised counter kept in step with feedback_votes so the board sorts without a
    -- join on every render.
    votes          INTEGER     NOT NULL DEFAULT 0,
    reviewed_by    INTEGER     REFERENCES users(id),
    reviewed_at    TIMESTAMPTZ,
    notified_at    TIMESTAMPTZ,                   -- when the "it shipped" notification went out
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_items_status  ON feedback_items (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_items_public  ON feedback_items (is_public, votes DESC) WHERE is_public;
CREATE INDEX IF NOT EXISTS idx_feedback_items_problem ON feedback_items (problem_name) WHERE problem_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_items_user    ON feedback_items (user_id) WHERE user_id IS NOT NULL;

COMMENT ON COLUMN feedback_items.public_id IS
    'Unguessable receipt token. The submitter''s only way to check on a message they sent while signed out.';
COMMENT ON COLUMN feedback_items.viewport_w IS
    'Captured silently. Mobile was 54% of clean sessions through 2025 and fell to ~32% during 2026 alongside an engagement collapse, yet not one message in the entire feedback corpus has ever mentioned the mobile experience. That silence is the reason to measure rather than ask.';

-- Anonymous voting, deliberately. Sign-in-gated voting is not a trade-off here, it is a
-- guaranteed zero: every voting feature this site has shipped has ~no rows
-- (bank_difficulty_votes 0, votes 4, user_interests 4, three of those from one person),
-- because the people who read the site are not signed in. voter_key is 'u:<id>' for
-- members and 'a:<hmac>' over an IP plus a per-browser cookie for everyone else. Gameable
-- by anyone determined; the board is advisory, not a ballot.
CREATE TABLE IF NOT EXISTS feedback_votes (
    item_id    INTEGER     NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
    voter_key  VARCHAR(72) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (item_id, voter_key)
);

-- One question per visitor, ever. A single question completes at ~86% against ~69% for six,
-- so the queue is long but each person only ever meets one member of it. That is what makes
-- it possible to ask about role, saturation, rival problem books, unmet search intent,
-- contribution barriers and past spending without anyone filling in a survey.
CREATE TABLE IF NOT EXISTS poll_answers (
    id          SERIAL      PRIMARY KEY,
    question_id VARCHAR(32) NOT NULL,             -- 'role' | 'disappointed' | 'other_book' | ...
    choice      VARCHAR(64),                      -- NULL when the question is free-text
    free_text   TEXT,                             -- the "другое ___" write-in, and the teacher follow-up
    lang        VARCHAR(2)  NOT NULL,
    user_id     INTEGER     REFERENCES users(id),
    viewport_w  SMALLINT,
    page_url    TEXT,
    ip_address  VARCHAR(45),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_poll_answers_question ON poll_answers (question_id, choice);
CREATE INDEX IF NOT EXISTS idx_poll_answers_created  ON poll_answers (created_at DESC);

COMMENT ON TABLE poll_answers IS
    'One-tap answers to a rotating single-question poll. Deliberately not tied to an account: the segmentation questions matter most for the anonymous majority nobody has ever been able to ask.';
