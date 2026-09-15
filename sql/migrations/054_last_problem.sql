-- «Последняя задача»: the one-time prediction mini app in the community chats (lastProblem.js).
--
-- On 2026-09-15 emixter asked both community chats which problem will be solved last (#1958,
-- #1959), astrosander answered that the betting could start, and Valter and emixter named their
-- picks. This is that market: the problems still unsolved are the outcomes, everyone gets
-- 1000 quanta (ħ) to predict with, a share pays 1 ħ if its problem is the last one solved, and
-- quanta buy premium reactions (js/reactions.js). Play money: it cannot be bought or cashed out.
--
-- Only new tables, nothing existing is altered. Deploy this before the code.

-- One wallet per account, created when the account first claims its 1000 ħ.
CREATE TABLE IF NOT EXISTS quanta_wallets (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance     NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every change to a wallet, so a balance can always be explained and a mistake undone.
CREATE TABLE IF NOT EXISTS quanta_ledger (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta       NUMERIC(14, 4) NOT NULL,
    reason      VARCHAR(24) NOT NULL,
    ref         VARCHAR(64),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON COLUMN quanta_ledger.reason IS 'grant | buy | sell | payout | unlock | cancel';
CREATE INDEX IF NOT EXISTS idx_quanta_ledger_user ON quanta_ledger (user_id, created_at);

-- The market itself, one row. b is the LMSR liquidity (js/lmsr.js). The house trader,
-- Laplace's demon, is not an account, so its money is counted here.
CREATE TABLE IF NOT EXISTS lp_market (
    id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    b               DOUBLE PRECISION NOT NULL CHECK (b > 0),
    opened_at       TIMESTAMPTZ NOT NULL,
    decided_at      TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    winner          VARCHAR(16),
    demon_spent     NUMERIC(14, 4) NOT NULL DEFAULT 0,
    demon_received  NUMERIC(14, 4) NOT NULL DEFAULT 0
);

-- One row per problem that was unsolved when the market opened. q is shares outstanding.
-- A solved problem keeps its q, so a junk post that knocked it out can be reverted.
CREATE TABLE IF NOT EXISTS lp_outcomes (
    problem_name  VARCHAR(16) PRIMARY KEY,
    q             DOUBLE PRECISION NOT NULL DEFAULT 0,
    demon_shares  DOUBLE PRECISION NOT NULL DEFAULT 0,
    status        VARCHAR(8) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'solved', 'won')),
    solved_at     TIMESTAMPTZ,
    solved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Everything that moved the market, with every open price after it: the chart and the feed.
CREATE TABLE IF NOT EXISTS lp_ticks (
    id            BIGSERIAL PRIMARY KEY,
    kind          VARCHAR(10) NOT NULL CHECK (kind IN ('open', 'trade', 'solved', 'reverted', 'decided', 'resolved')),
    actor         VARCHAR(8) NOT NULL DEFAULT 'user' CHECK (actor IN ('user', 'demon', 'chat', 'system')),
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    problem_name  VARCHAR(16),
    shares        DOUBLE PRECISION,
    amount        NUMERIC(14, 4),
    prices        JSONB NOT NULL,
    source        VARCHAR(64),
    cancelled_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON COLUMN lp_ticks.source IS 'chat:<message id> for a bet placed from what someone wrote in the chat';
CREATE INDEX IF NOT EXISTS idx_lp_ticks_created ON lp_ticks (created_at, id);
CREATE INDEX IF NOT EXISTS idx_lp_ticks_user ON lp_ticks (user_id) WHERE user_id IS NOT NULL;

-- A member's holding in one problem, with what went in and what came back, for the leaderboard.
CREATE TABLE IF NOT EXISTS lp_positions (
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    problem_name  VARCHAR(16) NOT NULL REFERENCES lp_outcomes(problem_name),
    shares        DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (shares >= 0),
    spent         NUMERIC(14, 4) NOT NULL DEFAULT 0,
    received      NUMERIC(14, 4) NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, problem_name)
);

-- Premium reactions a member owns. A trophy (:n2000:, :last:) belongs to exactly one person.
CREATE TABLE IF NOT EXISTS reaction_unlocks (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       VARCHAR(32) NOT NULL,
    price       NUMERIC(14, 4) NOT NULL DEFAULT 0,
    source      VARCHAR(10) NOT NULL DEFAULT 'purchase' CHECK (source IN ('purchase', 'trophy', 'grant')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, emoji)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reaction_unlocks_trophy ON reaction_unlocks (emoji) WHERE source = 'trophy';
