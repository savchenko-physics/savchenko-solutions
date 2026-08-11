-- Rollback for 050_compose_time_and_drafts.sql.
--
-- solution_drafts holds unfinished work that exists nowhere else: an abandoned draft has
-- never been written to posts/<lang>/*.md and has no contributions row. Dropping it
-- destroys writing people expect the site to be keeping for them. Export first:
--   \copy solution_drafts TO 'solution_drafts.csv' CSV HEADER
--
-- Note this also removes the only record of which problems people started and gave up on,
-- which was half the reason the table was added.
DROP TABLE IF EXISTS solution_drafts;

-- Safe to drop: compose_seconds is a measurement, derivable again from new edits.
ALTER TABLE contributions DROP COLUMN IF EXISTS compose_seconds;
