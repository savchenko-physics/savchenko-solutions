-- Rollback for 028_fix_message_notification_fanout.sql
--
-- Restores the notifications deleted by that migration. Only works while
-- notifications_fanout_backup still exists — once it is dropped the rows are gone.
--
-- Original ids are preserved, so the notifications sequence does not need touching;
-- ON CONFLICT keeps this safe to run twice.

INSERT INTO notifications
SELECT * FROM notifications_fanout_backup
ON CONFLICT (id) DO NOTHING;

-- Restore the pre-028 default (without new_message).
ALTER TABLE user_preferences
    ALTER COLUMN notification_settings
    SET DEFAULT '{"comment_on_solution":true,"reply_to_comment":true,"solution_liked":true,"new_follower":true,"challenge_result":true,"report_resolved":true,"forum_reply":true,"forum_solution":true}'::jsonb;

-- Then remove the migration record so it can be re-applied:
--   DELETE FROM applied_migrations WHERE name = '028_fix_message_notification_fanout.sql';
