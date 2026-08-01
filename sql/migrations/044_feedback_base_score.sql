-- 044_feedback_base_score.sql
--
-- Fixes a flaw exposed by the first real vote on production.
--
-- The board was seeded with fourteen requests that people had actually made — in the
-- September 2025 survey, in the forum, in DMs — and each carried a count of how many
-- distinct people were recorded asking for it. But those counts were written straight into
-- `votes`, and 043 recomputes `votes` from the rows in feedback_votes inside the vote
-- transaction. There are no vote rows behind a seeded count, so the first click on an item
-- silently deleted its entire history: the theory-wiki request went from 10 to 1.
--
-- Recomputing is still right — a counter nudged by deltas drifts and stays wrong. What was
-- wrong is conflating two different facts in one column. So they are separated:
--
--   base_score  people recorded asking for this BEFORE the board existed. Fixed, evidenced,
--               never changes. Not a vote and not pretending to be one — the alternative was
--               inventing fake rows in feedback_votes with fabricated voter keys.
--   upvotes/downvotes   actual votes cast here.
--   votes       base_score + upvotes - downvotes, i.e. what gets displayed.

ALTER TABLE feedback_items
    ADD COLUMN IF NOT EXISTS base_score INTEGER NOT NULL DEFAULT 0;

-- Move the seeded history out of the vote counters and into the column that means it.
-- 043 backfilled upvotes = votes for these rows, which was the same mistake one layer down:
-- nobody had actually voted, so upvotes must go back to zero.
UPDATE feedback_items
SET base_score = GREATEST(votes, upvotes),
    upvotes    = 0,
    downvotes  = 0,
    votes      = GREATEST(votes, upvotes)
WHERE public_id LIKE 'seed-%';

-- Any non-seeded row that somehow carries a score without vote rows behind it gets the same
-- treatment, so the invariant below holds for every row in the table.
UPDATE feedback_items f
SET base_score = f.votes, upvotes = 0, downvotes = 0
WHERE f.public_id NOT LIKE 'seed-%'
  AND f.votes <> 0
  AND NOT EXISTS (SELECT 1 FROM feedback_votes v WHERE v.item_id = f.id);

COMMENT ON COLUMN feedback_items.base_score IS
    'People recorded asking for this before the board existed, from the survey/forum/DM archive. Evidenced, fixed, and deliberately NOT stored as votes — inventing vote rows would have meant fabricating voters.';
COMMENT ON COLUMN feedback_items.votes IS
    'Displayed score: base_score + upvotes - downvotes. May go negative.';
