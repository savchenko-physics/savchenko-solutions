-- Room in the reaction columns for the community's own emoji.
--
-- Reactions used to be one of six Unicode emoji, so `emoji` was VARCHAR(8). The community set
-- (img/emoji/*.svg, listed in js/reactions.js) is stored as :shortcode: ids in the same column,
-- and ':zachetka:' or ':precious:' is ten characters: without this, a click on those would
-- fail inside the INSERT while the shorter ids worked. 32 leaves room for later names.
--
-- Widening a varchar is a catalogue change in PostgreSQL (no table rewrite, no index rebuild),
-- but ALTER TABLE still takes an ACCESS EXCLUSIVE lock, so give up rather than queue behind a
-- long reader and stall the chat. brainstorm_reactions stays VARCHAR(8): the retired
-- brainstorm room only ever offers the six.
--
-- Deploy this before the code that offers the new ids.
SET lock_timeout = '5s';

ALTER TABLE message_reactions ALTER COLUMN emoji TYPE VARCHAR(32);
ALTER TABLE solution_comment_reactions ALTER COLUMN emoji TYPE VARCHAR(32);

RESET lock_timeout;
