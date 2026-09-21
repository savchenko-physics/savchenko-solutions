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

// A person's name and picture obey the same rule as the dot. Lists of people are cached
// (the leaderboard and the profile stats for an hour, the homepage for a minute) and a name
// and a face change the moment someone saves their settings: read from those caches, a new
// avatar stayed invisible to everyone else for the rest of the hour (2026-09-13). So the
// caches keep who is in a list and their numbers, and this one query says how each person
// looks right now, and whether they are online.
//
// Returns a Map of username -> { fullName, profilePicture, isOnline }, with the fallbacks
// every list applies anyway: the username for a missing name, the placeholder for a
// missing picture. A username it cannot find is absent from the map, and on any error the
// map is empty. Callers keep the cached name and picture for anyone absent.
const DEFAULT_PROFILE_PICTURE = "/img/profile_images/Default_placeholder.svg";

async function getPeopleNow(pool, usernames) {
    const unique = [...new Set((usernames || []).filter(Boolean))];
    if (unique.length === 0) return new Map();
    try {
        const result = await pool.query(
            `SELECT u.username, u.full_name, u.profile_picture,
                    (u.last_seen_at > NOW() - INTERVAL '5 minutes'
                     AND COALESCE(pr.show_online_status, true)) AS is_online,
                    CASE WHEN COALESCE(pr.show_online_status, true) THEN u.last_seen_at END AS last_seen_at
               FROM users u
               LEFT JOIN user_preferences pr ON pr.user_id = u.id
              WHERE u.username = ANY($1)`,
            [unique]
        );
        return new Map(result.rows.map((r) => [r.username, {
            fullName: r.full_name || r.username,
            profilePicture: r.profile_picture || DEFAULT_PROFILE_PICTURE,
            isOnline: r.is_online === true,
            // null when the person hides their presence
            lastSeenAt: r.last_seen_at || null,
        }]));
    } catch (_err) {
        return new Map();
    }
}

module.exports = { ONLINE_WINDOW_MS, getOnlineUsernames, getPeopleNow, DEFAULT_PROFILE_PICTURE };
