-- 028_fix_message_notification_fanout.sql
-- Remove `new_message` notifications produced by the announcement-channel fan-out.
--
-- Every message notified every other member of its conversation. That is correct for
-- a DM or a small group, but the site-wide announcement conversation has every
-- registered user as a member, so each message written there produced one
-- notification row per member — burying users who never touched the chat.
--
-- Deleted here: `new_message` notifications pointing at a conversation with more than
-- 25 members, for users who never posted in that conversation. Notifications for
-- people who actually participate are kept, as is every other notification type.
-- The 25 threshold mirrors LARGE_CONVERSATION_MEMBERS in notifications.js; change both
-- together.
--
-- Rows are copied to notifications_fanout_backup first, so this is reversible via
-- sql/rollback/028_fix_message_notification_fanout_rollback.sql. Drop that table once
-- the result looks right:  DROP TABLE notifications_fanout_backup;
--
-- The migration runner wraps this file in a transaction; no BEGIN/COMMIT here.

-- 1. Stage the rows that are about to be removed.
CREATE TABLE IF NOT EXISTS notifications_fanout_backup (LIKE notifications);

INSERT INTO notifications_fanout_backup
SELECT n.*
FROM notifications n
JOIN (
    SELECT conversation_id
    FROM conversation_members
    GROUP BY conversation_id
    HAVING count(*) > 25
) big ON n.link = '/messages/' || big.conversation_id
WHERE n.type = 'new_message'
  AND NOT EXISTS (
      SELECT 1
      FROM messages m
      WHERE m.conversation_id = big.conversation_id
        AND m.sender_id = n.user_id
  );

-- 2. Delete exactly what was staged.
DELETE FROM notifications n
USING notifications_fanout_backup b
WHERE n.id = b.id;

-- 3. `new_message` was missing from the default settings written by 008, so it could
--    never be switched off from the settings page. It is now a real toggle.
ALTER TABLE user_preferences
    ALTER COLUMN notification_settings
    SET DEFAULT '{"comment_on_solution":true,"reply_to_comment":true,"solution_liked":true,"new_follower":true,"challenge_result":true,"report_resolved":true,"forum_reply":true,"forum_solution":true,"new_message":true}'::jsonb;
