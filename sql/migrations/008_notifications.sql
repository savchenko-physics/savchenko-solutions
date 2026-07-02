-- 008_notifications.sql
-- Notification system: in-app notifications + user notification preferences

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT,
    link VARCHAR(255),
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications(user_id, is_read, created_at DESC);

-- Add notification_settings JSONB column to user_preferences
-- Default: all notification types enabled
ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS notification_settings JSONB
    DEFAULT '{"comment_on_solution":true,"reply_to_comment":true,"solution_liked":true,"new_follower":true,"challenge_result":true,"report_resolved":true,"forum_reply":true,"forum_solution":true}'::jsonb;
