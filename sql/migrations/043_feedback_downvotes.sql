-- 043_feedback_downvotes.sql
--
-- The board shipped with upvotes only, which can express "I want this" and nothing else.
-- That is a real gap, not just a missing button: with fourteen seeded requests competing for
-- one person's attention, "nobody objects to this" and "half the readers actively do not
-- want it" look identical, and the second one is the more useful thing to learn. Reddit's
-- arrangement, one score with two directions, is the cheapest way to ask.
--
-- `votes` keeps its meaning as the displayed score (up minus down) so nothing that reads it
-- needs to change. The two directions are also counted separately, because a score of 2 from
-- 2/0 and a score of 2 from 40/38 are completely different signals and only the admin queue
-- needs to tell them apart.

ALTER TABLE feedback_votes
    ADD COLUMN IF NOT EXISTS value SMALLINT NOT NULL DEFAULT 1;

-- Guard against a future bug writing 0 or 7 and silently corrupting every score.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'feedback_votes_value_check'
    ) THEN
        ALTER TABLE feedback_votes
            ADD CONSTRAINT feedback_votes_value_check CHECK (value IN (-1, 1));
    END IF;
END $$;

ALTER TABLE feedback_items
    ADD COLUMN IF NOT EXISTS upvotes   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS downvotes INTEGER NOT NULL DEFAULT 0;

-- Everything cast before this migration was an upvote by construction, so the seeded counts
-- carry over as-is rather than being reset to zero.
UPDATE feedback_items SET upvotes = votes WHERE upvotes = 0 AND votes > 0;

COMMENT ON COLUMN feedback_items.votes IS
    'Displayed score: upvotes minus downvotes. May go negative.';
COMMENT ON COLUMN feedback_votes.value IS
    '+1 or -1. One row per voter per item; switching direction updates this rather than inserting again.';
