-- Rollback for 052_custom_reaction_emoji.sql
--
-- Rolling back only the code needs NONE of this: the old code shows a stored :shortcode: as
-- text and answers a click on it with 400, and the wider column harms nothing.
--
-- Narrowing the columns destroys every custom reaction, so export them first, from psql:
--   \copy (SELECT * FROM message_reactions WHERE emoji ~ '^:[a-z0-9_]+:$') TO 'message_reactions_custom.csv' CSV HEADER
--   \copy (SELECT * FROM solution_comment_reactions WHERE emoji ~ '^:[a-z0-9_]+:$') TO 'solution_comment_reactions_custom.csv' CSV HEADER
--
-- Delete by pattern, not by length: ':ai:' and ':cat:' fit in eight characters and would
-- survive a length filter as reactions the old code cannot toggle.

DELETE FROM message_reactions WHERE emoji ~ '^:[a-z0-9_]+:$';
DELETE FROM solution_comment_reactions WHERE emoji ~ '^:[a-z0-9_]+:$';

ALTER TABLE message_reactions ALTER COLUMN emoji TYPE VARCHAR(8);
ALTER TABLE solution_comment_reactions ALTER COLUMN emoji TYPE VARCHAR(8);

-- Then remove the migration record so it can be re-applied:
--   DELETE FROM applied_migrations WHERE name = '052_custom_reaction_emoji.sql';
