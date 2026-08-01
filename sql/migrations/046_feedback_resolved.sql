-- 046_feedback_resolved.sql
--
-- Records when a thread was closed, so a resolved item can say so plainly and stop taking
-- votes.
--
-- reviewed_at already existed but is the wrong field for this: it is stamped on every triage
-- edit, so it moves every time a title is tweaked. What the board needs is the moment the
-- outcome was reached and after which nothing more is being collected, and that has to
-- survive later edits or the date on a solved item drifts forward forever.
--
-- Locking is derived from status rather than stored as its own flag. done and declined are
-- the only terminal states, so a separate boolean could only ever disagree with them.

ALTER TABLE feedback_items
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Anything already in a terminal state keeps the best date available.
UPDATE feedback_items
SET resolved_at = COALESCE(reviewed_at, created_at)
WHERE resolved_at IS NULL AND status IN ('done', 'declined');

COMMENT ON COLUMN feedback_items.resolved_at IS
    'When the thread reached a terminal state (done or declined) and stopped taking votes. Set once on the transition in, cleared if it is ever reopened. Not the same as reviewed_at, which moves on every triage edit.';
