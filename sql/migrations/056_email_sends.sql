-- Every email the site sends, so a flood can be stopped and counted.
--
-- On 2026-09-16 a follow/unfollow toggle put ten identical emails in one inbox in 27 seconds.
-- Nothing recorded sends, so nothing could enforce "enough for now", and answering "how many
-- emails did we send, and to whom" meant reconstructing it from notifications, users,
-- password_reset_requests, feedback_items and email_events.
--
-- One row per attempt, written by email.js:
--   sent        handed to SES
--   failed      SES refused it
--   suppressed  the recipient was over the cap in lib/mailGuard.js, nothing was sent
-- kind is the notification type for notification mail, else password_reset, appeal_ack,
-- email_verify, email_change or other. thread is the link the mail was about, which is what
-- notifications.js debounces on.
--
-- The index is the one the two counts in email.js need (per address, last hour and day) and
-- the debounce in notifications.js (per address, kind and thread).
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS email_sends (
    id BIGSERIAL PRIMARY KEY,
    to_address VARCHAR(255) NOT NULL,
    kind VARCHAR(40) NOT NULL DEFAULT 'other',
    thread VARCHAR(255),
    subject VARCHAR(255),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_sends_address_time ON email_sends (to_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_sends_time ON email_sends (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_sends_user ON email_sends (user_id, created_at DESC);

RESET lock_timeout;
