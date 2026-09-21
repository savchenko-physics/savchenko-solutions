// One person's contribution score and rank tier, for the places that show a username in its
// rank's colour (the contributors page, the profile, the homepage's Top Authors, a DM's header;
// 2026-09-21). The score is the leaderboard's formula, 19 · ln(problems · √edits), over the same
// rows getTopAuthors() and contributorsUserMetricsApi count. The owner (user 28) has no tier and
// is "Headquarters" (js/palettes.js RANK_HQ).
'use strict';

const pool = require('./db');
const Palettes = require('../js/palettes');

const OWNER_ID = 28;

async function scoreFor(userId) {
    const r = await pool.query(
        `WITH all_contributions AS (
            SELECT problem_name FROM contributions
            WHERE user_id = $1 AND content_changed = true AND invisible = false
            UNION ALL
            SELECT problem_name FROM github_contributions WHERE user_id = $1
         )
         SELECT CASE WHEN COUNT(*) = 0 THEN 0
                     ELSE ROUND((19 * LN(COUNT(DISTINCT problem_name) * SQRT(COUNT(*))))::numeric, 0)::int END AS score
         FROM all_contributions`, [userId]);
    return r.rows.length ? Number(r.rows[0].score) || 0 : 0;
}

// { key, color } for a user id and its score (the score is looked up when not given).
async function rankFor(userId, score) {
    if (userId === OWNER_ID) return { key: Palettes.RANK_HQ.key, color: Palettes.RANK_HQ.color };
    const s = score == null ? await scoreFor(userId) : score;
    const tier = Palettes.rankFor(s);
    return { key: tier.key, color: tier.color };
}

module.exports = { scoreFor, rankFor, OWNER_ID };
