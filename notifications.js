const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

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
async function createMessageNotifications(conversationId, senderId, title, preview, link) {
    try {
        const result = await pool.query(
            `INSERT INTO notifications (user_id, type, title, message, link)
             SELECT cm.user_id, 'new_message', $3, $4, $5
             FROM conversation_members cm
             LEFT JOIN user_preferences up ON up.user_id = cm.user_id
             WHERE cm.conversation_id = $1
               AND cm.user_id <> $2
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
            [conversationId, senderId, title, preview, link, LARGE_CONVERSATION_MEMBERS]
        );
        return result.rowCount;
    } catch (err) {
        console.error('Error creating message notifications:', err);
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
    createNotification,
    createMessageNotifications,
    getUnreadCount,
    getNotifications,
    getNotificationCount,
    markAsRead,
    markAllAsRead,
    hasRecentLikeNotification,
    DEFAULT_NOTIFICATION_SETTINGS,
};
