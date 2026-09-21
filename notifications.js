
const pool = require('./lib/db');

// Notifications no longer send an email of their own. Every one of these used to mail the
// moment it happened, which made three replies in a discussion three emails nine minutes apart
// and a follow/unfollow toggle ten emails in twenty-seven seconds (2026-09-16). They are now
// collected once a week by digest.js, which reads the same events from their source tables.
// This list is what the bell shows and what the digest is built from; immediate mail is only
// for what an account needs to work (reset, verify, email change), and it goes through
// email.js like everything else.
const DIGEST_NOTIFICATION_TYPES = new Set([
    'reply_to_comment', 'comment_on_solution', 'new_follower',
    'challenge_result', 'report_resolved', 'forum_reply', 'forum_solution',
    'feedback_update', 'solution_liked',
]);

const DEFAULT_NOTIFICATION_SETTINGS = {
    comment_on_solution: true,
    reply_to_comment: true,
    solution_liked: true,
    new_follower: true,
    challenge_result: true,
    report_resolved: true,
    forum_reply: true,
    forum_solution: true,
    new_message: true,
    feedback_update: true,
};

// Above this member count a conversation is treated as an announcement channel
// rather than a chat: only members who have posted in it are notified. Real DMs
// and group chats sit far below this; the site-wide channel holds every user.
const LARGE_CONVERSATION_MEMBERS = 25;

/**
 * Check if a user has a specific notification type enabled.
 * Returns true if no preferences row exists (default = all enabled).
 */
async function isNotificationEnabled(userId, type) {
    try {
        const result = await pool.query(
            'SELECT notification_settings FROM user_preferences WHERE user_id = $1',
            [userId]
        );
        if (result.rows.length === 0) return true;
        const settings = result.rows[0].notification_settings;
        if (!settings) return true;
        return settings[type] !== false;
    } catch (err) {
        console.error('Error checking notification preferences:', err);
        return true; // default to enabled on error
    }
}

/**
 * Create a notification for a user.
 * Skips if: recipient is the performer, or the user disabled this notification type.
 */
async function createNotification(userId, type, title, message, link, performerId) {
    // Don't notify yourself
    if (performerId && userId === performerId) return;

    // Check user preferences
    const enabled = await isNotificationEnabled(userId, type);
    if (!enabled) return;

    try {
        await pool.query(
            'INSERT INTO notifications (user_id, type, title, message, link) VALUES ($1, $2, $3, $4, $5)',
            [userId, type, title, message, link]
        );
        // No email here: the weekly digest (digest.js) carries this.
    } catch (err) {
        console.error('Error creating notification:', err);
    }
}

/**
 * Fan out `new_message` notifications for a single message in one statement.
 *
 * Recipients are the other members of the conversation, minus anyone who turned
 * `new_message` off. In a conversation larger than LARGE_CONVERSATION_MEMBERS only
 * members who have themselves posted there are notified: those conversations are
 * announcement channels every user is a member of, so notifying all of them would
 * write one row per member per message and bury unrelated users.
 *
 * Returns the number of notifications created.
 */
async function createMessageNotifications(conversationId, senderId, title, preview, link, messageId = null) {
    try {
        const result = await pool.query(
            `INSERT INTO notifications (user_id, type, title, message, link, message_id)
             SELECT cm.user_id, 'new_message', $3, $4, $5, $7
             FROM conversation_members cm
             LEFT JOIN user_preferences up ON up.user_id = cm.user_id
             WHERE cm.conversation_id = $1
               AND cm.user_id <> $2
               AND cm.muted = FALSE
               AND COALESCE((up.notification_settings ->> 'new_message')::boolean, true)
               AND (
                     (SELECT count(*) FROM conversation_members m
                      WHERE m.conversation_id = $1) <= $6
                     OR EXISTS (
                         SELECT 1 FROM messages msg
                         WHERE msg.conversation_id = $1
                           AND msg.sender_id = cm.user_id
                     )
                   )
             RETURNING id`,
            [conversationId, senderId, title, preview, link, LARGE_CONVERSATION_MEMBERS, messageId]
        );
        return result.rowCount;
    } catch (err) {
        console.error('Error creating message notifications:', err);
        return 0;
    }
}

/**
 * Drop the notifications a message created (notifications.message_id, migration 063) when it
 * is deleted. Rows from before the column was filled are not found and stay.
 */
async function removeForMessage(messageId) {
    try {
        const r = await pool.query('DELETE FROM notifications WHERE message_id = $1', [messageId]);
        return r.rowCount;
    } catch (err) {
        console.error('Error removing message notifications:', err);
        return 0;
    }
}

/**
 * Get the count of unread notifications for a user.
 */
async function getUnreadCount(userId) {
    try {
        const result = await pool.query(
            'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
            [userId]
        );
        return parseInt(result.rows[0].count);
    } catch (err) {
        console.error('Error getting unread count:', err);
        return 0;
    }
}

/**
 * Get notifications for a user (paginated, newest first).
 */
async function getNotifications(userId, limit = 20, offset = 0) {
    const result = await pool.query(
        'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [userId, limit, offset]
    );
    return result.rows;
}

/**
 * Get total notification count for a user (for pagination).
 */
async function getNotificationCount(userId) {
    const result = await pool.query(
        'SELECT COUNT(*) FROM notifications WHERE user_id = $1',
        [userId]
    );
    return parseInt(result.rows[0].count);
}

/**
 * Mark a single notification as read (only if it belongs to the user).
 */
async function markAsRead(notificationId, userId) {
    return pool.query(
        'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2',
        [notificationId, userId]
    );
}

/**
 * Mark all unread notifications as read for a user.
 */
async function markAllAsRead(userId) {
    return pool.query(
        'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
        [userId]
    );
}

/**
 * A notification in the reader's language. Chat notifications are stored with an English
 * title ("New message from emixter", written at send time for every recipient at once, see
 * createMessageNotifications), so a Russian reader's bell used to be English. Translating
 * on the way out fixes the 2,800 rows already stored as well as new ones. Other types are
 * returned untouched. Pure: returns a new object.
 */
const MESSAGE_TITLE_EN = /^New message from (.+)$/;
const MESSAGE_PREVIEW_RU = { '[Image]': '[Фото]', '[File]': '[Файл]' };

function localizeNotification(n, lang) {
    if (!n || lang !== 'ru' || n.type !== 'new_message') return n;
    const out = { ...n };
    const m = typeof n.title === 'string' ? n.title.match(MESSAGE_TITLE_EN) : null;
    if (m) out.title = `Новое сообщение от ${m[1]}`;
    if (Object.prototype.hasOwnProperty.call(MESSAGE_PREVIEW_RU, n.message)) out.message = MESSAGE_PREVIEW_RU[n.message];
    return out;
}

/**
 * Check if a like notification was already sent for this problem within the last hour.
 * Used to debounce like notifications (max 1 per problem per hour).
 */
async function hasRecentLikeNotification(userId, problemName) {
    try {
        const result = await pool.query(
            `SELECT id FROM notifications
             WHERE user_id = $1 AND type = 'solution_liked' AND link LIKE $2
             AND created_at > NOW() - INTERVAL '1 hour'
             LIMIT 1`,
            [userId, `%${problemName}%`]
        );
        return result.rows.length > 0;
    } catch (err) {
        console.error('Error checking recent like notification:', err);
        return false;
    }
}

module.exports = {
    removeForMessage,
    createNotification,
    createMessageNotifications,
    getUnreadCount,
    getNotifications,
    getNotificationCount,
    markAsRead,
    markAllAsRead,
    hasRecentLikeNotification,
    DIGEST_NOTIFICATION_TYPES,
    localizeNotification,
    DEFAULT_NOTIFICATION_SETTINGS,
};
