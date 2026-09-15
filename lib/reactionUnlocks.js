// Who owns which premium reaction (js/reactions.js entries with a price or a trophy), for the two
// reaction endpoints (messages.js, index.js) and the pickers (GET /api/reactions/owned in
// lastProblem.js). Takes the caller's pool, so messages.js does not open a pool of its own for one
// query.
//
// Reading fails soft: before migration 054 the table does not exist, and a missing table must
// not break reacting with the free emoji. It answers "not owned", which only ever refuses a
// premium reaction, never a free one.
'use strict';

async function ownsReaction(pool, userId, emoji) {
    if (!userId || typeof emoji !== 'string') return false;
    try {
        const { rowCount } = await pool.query(
            'SELECT 1 FROM reaction_unlocks WHERE user_id = $1 AND emoji = $2',
            [userId, emoji]
        );
        return rowCount > 0;
    } catch (_err) {
        return false;
    }
}

async function ownedReactions(pool, userId) {
    if (!userId) return [];
    try {
        const { rows } = await pool.query(
            'SELECT emoji FROM reaction_unlocks WHERE user_id = $1 ORDER BY created_at',
            [userId]
        );
        return rows.map((r) => r.emoji);
    } catch (_err) {
        return [];
    }
}

module.exports = { ownsReaction, ownedReactions };
