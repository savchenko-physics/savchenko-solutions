-- Rollback for 054_last_problem.sql. Run only after the code that reads these tables
-- (lastProblem.js, the premium check in messages.js and index.js) is gone.
--
-- Premium reactions people left go first: without reaction_unlocks nothing could tell who owns
-- them, and the old code does not know their ids.
DELETE FROM message_reactions
 WHERE emoji IN (':kvant:', ':errata:', ':ammeter:', ':dino:', ':cyborgs:', ':libra:', ':laplace:', ':perpetuum:', ':n2000:', ':last:');
DELETE FROM solution_comment_reactions
 WHERE emoji IN (':kvant:', ':errata:', ':ammeter:', ':dino:', ':cyborgs:', ':libra:', ':laplace:', ':perpetuum:', ':n2000:', ':last:');

-- The announcement's bell notifications and the market's own.
DELETE FROM notifications WHERE type = 'last_problem';

DROP TABLE IF EXISTS reaction_unlocks;
DROP TABLE IF EXISTS lp_positions;
DROP TABLE IF EXISTS lp_ticks;
DROP TABLE IF EXISTS lp_outcomes;
DROP TABLE IF EXISTS lp_market;
DROP TABLE IF EXISTS quanta_ledger;
DROP TABLE IF EXISTS quanta_wallets;
DELETE FROM applied_migrations WHERE name = '054_last_problem.sql';
