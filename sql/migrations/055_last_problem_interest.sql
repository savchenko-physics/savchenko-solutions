-- «Последняя задача»: conservation of interest (lastProblem.js, js/lmsr.js solve).
--
-- The market opened on 2026-09-15 as winner takes all: a share paid 1 ħ if its problem was the very
-- last one solved, and nothing moved until then, most likely in 2027. The same evening, before any
-- problem had been solved, the owner changed the rule: every solve pays interest to everything
-- still in play, at the rate p / (1 - p) of the solved problem's price p, so a problem solved near
-- the end pays off even if it is not the last and one solved early loses. The market keeps prices
-- per share steady by shrinking a scale at each solve (a share costs scale × price), which is
-- exactly what the interest pays out.
--
-- No trade changes: with nothing solved yet the scale is 1, where every existing share was bought.
-- Only adds columns with defaults. Deploy this before the code.

ALTER TABLE lp_market ADD COLUMN IF NOT EXISTS scale DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (scale > 0);
ALTER TABLE lp_market ADD COLUMN IF NOT EXISTS demon_interest NUMERIC(14, 4) NOT NULL DEFAULT 0;
COMMENT ON COLUMN lp_market.scale IS 'what one unit of price costs in quanta; 1 at the start, times (1 - p) at every solve';

-- Interest a position has earned, kept apart from sales and the final payout.
ALTER TABLE lp_positions ADD COLUMN IF NOT EXISTS interest NUMERIC(14, 4) NOT NULL DEFAULT 0;

-- On a 'solved' tick: the rate that solve paid, so the feed can show it and a revert can undo it.
ALTER TABLE lp_ticks ADD COLUMN IF NOT EXISTS rate DOUBLE PRECISION;

COMMENT ON COLUMN quanta_ledger.reason IS 'grant | buy | sell | payout | unlock | cancel | interest | clawback';
