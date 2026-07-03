// Shared online-presence helpers.
//
// A user counts as "online" while their users.last_seen_at is within
// ONLINE_WINDOW_MS. last_seen_at is refreshed (throttled) on each
// authenticated request by middleware in index.js. Presence must always be
// queried fresh — never served from a long-lived cache — otherwise the green
// dot would lag reality by up to the cache TTL.
//
// Visibility respects the user_preferences.show_online_status privacy flag
// (defaults to true). A user who hides their status never appears online here.

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// Given a list of usernames, return a Set of those currently online (fresh,
// privacy-respecting). Safe before the 027_user_last_seen migration has run:
// on any error it resolves to an empty Set rather than throwing.
async function getOnlineUsernames(pool, usernames) {
    const unique = [...new Set((usernames || []).filter(Boolean))];
    if (unique.length === 0) return new Set();
    try {
        const result = await pool.query(
            `SELECT u.username
               FROM users u
               LEFT JOIN user_preferences pr ON pr.user_id = u.id
              WHERE u.username = ANY($1)
                AND u.last_seen_at > NOW() - INTERVAL '5 minutes'
                AND COALESCE(pr.show_online_status, true) = true`,
            [unique]
        );
        return new Set(result.rows.map((r) => r.username));
    } catch (_err) {
        // last_seen_at column may not exist yet (pre-migration); treat as none online.
        return new Set();
    }
}

module.exports = { ONLINE_WINDOW_MS, getOnlineUsernames };
