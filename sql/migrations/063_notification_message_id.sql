-- 2026-09-21. A moderator deleted a 32-message spree in the English chat and every member kept
-- 32 "New message from Бека" bell entries: nothing tied a notification to its message. Now a
-- new_message row carries the message's id (notifications.js createMessageNotifications) and a
-- delete removes its rows (removeForMessage). Rows from before stay NULL.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_notifications_message_id ON notifications (message_id) WHERE message_id IS NOT NULL;
