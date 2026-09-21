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

// Every contributor's tier at once, { username: key }, for colouring usernames site-wide
// (js/user-ranks.js, inlined by the header as window.__USER_RANKS__). Held five minutes and
// refreshed behind the reader (lib/swr.js); a name not in the map is a newbie. The query is
// getTopAuthors()'s without its LIMIT.
const { SwrCache } = require('./swr');
const rankMapCache = new SwrCache({ ttlMs: 5 * 60 * 1000, name: 'user ranks' });

async function loadRankMap() {
    const r = await pool.query(
        `WITH all_contributions AS (
            SELECT user_id, problem_name FROM contributions
            WHERE user_id IS NOT NULL AND content_changed = true AND invisible = false
            UNION ALL
            SELECT user_id, problem_name FROM github_contributions WHERE user_id IS NOT NULL
         )
         SELECT u.username, ROUND((19 * LN(COUNT(DISTINCT ac.problem_name) * SQRT(COUNT(*))))::numeric, 0)::int AS score
         FROM all_contributions ac JOIN users u ON u.id = ac.user_id
         WHERE u.id <> $1
         GROUP BY u.id, u.username`, [OWNER_ID]);
    const map = {};
    for (const row of r.rows) {
        const key = Palettes.rankFor(row.score).key;
        if (key !== 'newbie') map[row.username] = key;
    }
    const owner = await pool.query('SELECT username FROM users WHERE id = $1', [OWNER_ID]);
    if (owner.rows.length) map[owner.rows[0].username] = Palettes.RANK_HQ.key;
    return map;
}

function rankMap() {
    return rankMapCache.get('all', loadRankMap);
}

/** The held map without waiting (empty until the first load finishes). */
function rankMapNow() {
    const held = rankMapCache.peek('all');
    if (held === undefined) rankMap().catch(() => {});
    return held || {};
}

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// The names worth painting in running text: every contributor with a tier, plus the owner.
// Whole words, case-sensitive, longest first (so "Alexphysics" is not cut at "Alex").
function paintableNames() {
    return Object.keys(rankMapNow()).sort((a, b) => b.length - a.length);
}

// Plain text (a title, an excerpt) with every contributor's username in its rank's colour: the
// text is escaped here, and each name becomes a link to the profile, or a coloured span when
// the text already sits inside a link (`link: false`). Nothing else is touched.
function paintUsernames(text, { link = true } = {}) {
    const names = paintableNames();
    const map = rankMapNow();
    if (!names.length) return escapeHtml(text || '');
    const re = new RegExp('(^|[^A-Za-z0-9_])(' + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z0-9_])', 'g');
    return escapeHtml(text || '').replace(re, (m, before, name) => {
        const key = map[name] || 'newbie';
        const cls = `ss-rank-c-${key} ss-rank-${key}`;
        return before + (link
            ? `<a href="/user/${encodeURIComponent(name)}" class="${cls}" data-no-rank>${name}</a>`
            : `<span class="${cls}">${name}</span>`);
    });
}

module.exports = { scoreFor, rankFor, rankMap, rankMapNow, paintUsernames, OWNER_ID };
