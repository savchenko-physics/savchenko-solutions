// contest.js — Monthly contributor contest ("Июньский конкурс").
//
// A time-boxed, prize-backed competition. Anyone who publishes a NEW LaTeX
// solution during the window automatically participates. The live dashboard
// is computed directly from the `contributions` table — no separate
// submission table, no extra button. Submitting a solution IS entering.
//
// Winner mechanic (confirmed with the user):
//   - Grand prize: full merch set to #1 by weighted new-solution points.
//   - Silver prize: full merch set to #2.
//   - Bronze prize: a cap for everyone who reaches BRONZE_THRESHOLD points.
//
// Multipliers reward work where the platform needs it most (see CONTEST below).

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const i18n = require('i18n');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

// ─── Contest configuration (single source of truth) ────────────────
// Config lives in code, not the database, so the page works the moment
// the code deploys. Live standings come from `contributions`, which
// always exists. The window is inclusive by date; the contest closes at
// 23:59 Moscow time (MSK, UTC+3) on endDate — extended from 30 June to
// 3 July 2026.
const CONTEST = {
    slug: 'iyun-2026',
    startDate: '2026-06-01',
    endDate: '2026-07-03',
    goalSolutions: 400,           // raised stretch goal — progress bar target
    firstMilestone: 250,          // original goal, shown as checkpoint tick on the bar
    stretchRaffleThreshold: 10,   // min points to enter the stretch raffle
    bronzeThreshold: 15,          // points needed for the bronze (cap) tier
    lowCoverageChapters: ['9', '10', '12', '14'],
    title: { ru: 'Июньский конкурс', en: 'June Contest' },
};

// Closing instant: 23:59:59 on endDate in Moscow time (UTC+3). Single source
// of truth for isLive()/daysLeft(); the client countdown in
// views/contest/show.ejs mirrors this same offset.
const CONTEST_END_INSTANT = new Date(`${CONTEST.endDate}T23:59:59+03:00`).getTime();

// In-memory cache so polling the live dashboard does not hammer the DB.
const CACHE_TTL_MS = 30 * 1000;
let standingsCache = { at: 0, data: null };

// One-time check whether the admin has already created the overrides table.
// Null = unchecked, true/false = result. Reset to null to force a recheck.
let overridesTableAvailable = null;

async function checkOverridesTable() {
    if (overridesTableAvailable !== null) return overridesTableAvailable;
    try {
        await pool.query('SELECT 1 FROM contest_score_overrides LIMIT 0');
        overridesTableAvailable = true;
    } catch (_) {
        overridesTableAvailable = false;
    }
    return overridesTableAvailable;
}

function invalidateStandingsCache() {
    standingsCache = { at: 0, data: null };
    overridesTableAvailable = null; // re-check table existence too
}

function getLang(req) {
    return req.session && req.session.lang ? req.session.lang : 'en';
}

// Days remaining (>= 0) until the contest ends, for the banner/countdown.
function daysLeft() {
    const diff = CONTEST_END_INSTANT - Date.now();
    return diff <= 0 ? 0 : Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function isLive() {
    const now = Date.now();
    const start = new Date(`${CONTEST.startDate}T00:00:00Z`).getTime();
    return now >= start && now <= CONTEST_END_INSTANT;
}

// Lightweight banner descriptor for the global header. No DB hit.
function getActiveContestBanner(lang) {
    if (!isLive()) return null;
    const l = lang === 'ru' ? 'ru' : 'en';
    return {
        slug: CONTEST.slug,
        url: `/challenge/${CONTEST.slug}`,
        daysLeft: daysLeft(),
        title: CONTEST.title[l],
        text: l === 'ru'
            ? 'Этот месяц мы соревнуемся. Публикуй новые решения и участвуй в розыгрыше мерча.'
            : 'We are competing this month. Publish new solutions and win exclusive merch.',
        cta: l === 'ru' ? 'Открыть конкурс' : 'Open the contest',
    };
}

// ─── Live standings query ──────────────────────────────────────────
// A "contest solution" credited to a registered user is a (problem_name,
// language) pair that became NEW during the window: its first-ever edit
// across both the modern `contributions` table and the legacy
// `github_contributions` table falls inside the window, the problem was
// never solved on GitHub, and a logged-in user added real content for it.
//
// Points = 1.0, multiplied (stacking) by:
//   ×1.5 English solution
//   ×1.5 problem in a low-coverage chapter (9, 10, 12, 14)
//   ×1.5 previously-untouched problem (no prior solution in ANY language)
const STANDINGS_SQL = `
WITH params AS (
    SELECT $1::date AS start_d, $2::date AS end_d
),
all_edits AS (
    SELECT problem_name, language, edited_at
    FROM contributions
    WHERE problem_name IS NOT NULL
    UNION ALL
    SELECT problem_name, language, edited_at
    FROM github_contributions
    WHERE problem_name IS NOT NULL
),
first_pl AS (
    SELECT problem_name, language, MIN(edited_at) AS first_at
    FROM all_edits
    GROUP BY problem_name, language
),
first_p AS (
    SELECT problem_name, MIN(edited_at) AS first_at_any
    FROM all_edits
    GROUP BY problem_name
),
new_pl AS (
    SELECT fpl.problem_name, fpl.language
    FROM first_pl fpl, params p
    WHERE fpl.first_at::date BETWEEN p.start_d AND p.end_d
      AND NOT EXISTS (
          SELECT 1 FROM github_contributions g
          WHERE g.problem_name = fpl.problem_name AND g.language = fpl.language
      )
),
cand AS (
    SELECT c.problem_name, c.language, c.user_id, MIN(c.edited_at) AS user_first_at
    FROM contributions c, params p
    WHERE c.user_id IS NOT NULL
      AND c.content_changed = true
      AND COALESCE(c.invisible, false) = false
      AND c.problem_name IS NOT NULL
      AND c.edited_at::date BETWEEN p.start_d AND p.end_d
    GROUP BY c.problem_name, c.language, c.user_id
),
credited AS (
    SELECT DISTINCT ON (cand.problem_name, cand.language)
           cand.problem_name, cand.language, cand.user_id, cand.user_first_at
    FROM cand
    JOIN new_pl USING (problem_name, language)
    ORDER BY cand.problem_name, cand.language, cand.user_first_at ASC
),
scored AS (
    SELECT cr.user_id, cr.problem_name, cr.language, cr.user_first_at,
           (1.0
            * CASE WHEN cr.language = 'en' THEN 1.5 ELSE 1 END
            * CASE WHEN split_part(cr.problem_name, '.', 1) = ANY($3) THEN 1.5 ELSE 1 END
            * CASE WHEN (SELECT fp.first_at_any FROM first_p fp WHERE fp.problem_name = cr.problem_name)::date
                        BETWEEN (SELECT start_d FROM params) AND (SELECT end_d FROM params)
                   THEN 1.5 ELSE 1 END
           ) AS points
    FROM credited cr
)
SELECT s.user_id, u.username, u.full_name, u.country_location, u.profile_picture,
       COUNT(*)::int AS solutions,
       ROUND(SUM(s.points)::numeric, 3) AS points,
       MAX(s.user_first_at) AS last_at
FROM scored s
JOIN users u ON u.id = s.user_id
GROUP BY s.user_id, u.username, u.full_name, u.country_location, u.profile_picture
ORDER BY points DESC, solutions DESC, last_at ASC;
`;

// Override-aware version of STANDINGS_SQL.
// Used when contest_score_overrides table exists (created by /admin/contest-review).
// Changes vs. STANDINGS_SQL:
//   - 'exclude'          decision → row dropped (NULL points filtered out)
//   - 'self_translation' decision → the chronologically LATER of the two language
//                                    versions gets 0.5 flat; the earlier keeps full multipliers
//   - 'independent' or no override → original multiplier logic unchanged
const STANDINGS_SQL_WITH_OVERRIDES = `
WITH params AS (
    SELECT $1::date AS start_d, $2::date AS end_d
),
all_edits AS (
    SELECT problem_name, language, edited_at
    FROM contributions
    WHERE problem_name IS NOT NULL
    UNION ALL
    SELECT problem_name, language, edited_at
    FROM github_contributions
    WHERE problem_name IS NOT NULL
),
first_pl AS (
    SELECT problem_name, language, MIN(edited_at) AS first_at
    FROM all_edits
    GROUP BY problem_name, language
),
first_p AS (
    SELECT problem_name, MIN(edited_at) AS first_at_any
    FROM all_edits
    GROUP BY problem_name
),
new_pl AS (
    SELECT fpl.problem_name, fpl.language
    FROM first_pl fpl, params p
    WHERE fpl.first_at::date BETWEEN p.start_d AND p.end_d
      AND NOT EXISTS (
          SELECT 1 FROM github_contributions g
          WHERE g.problem_name = fpl.problem_name AND g.language = fpl.language
      )
),
cand AS (
    SELECT c.problem_name, c.language, c.user_id, MIN(c.edited_at) AS user_first_at
    FROM contributions c, params p
    WHERE c.user_id IS NOT NULL
      AND c.content_changed = true
      AND COALESCE(c.invisible, false) = false
      AND c.problem_name IS NOT NULL
      AND c.edited_at::date BETWEEN p.start_d AND p.end_d
    GROUP BY c.problem_name, c.language, c.user_id
),
credited AS (
    SELECT DISTINCT ON (cand.problem_name, cand.language)
           cand.problem_name, cand.language, cand.user_id, cand.user_first_at
    FROM cand
    JOIN new_pl USING (problem_name, language)
    ORDER BY cand.problem_name, cand.language, cand.user_first_at ASC
),
overrides AS (
    SELECT problem_name, user_id, decision FROM contest_score_overrides
),
scored AS (
    SELECT cr.user_id, cr.problem_name, cr.language, cr.user_first_at,
           CASE
             WHEN (SELECT o.decision FROM overrides o
                   WHERE o.problem_name = cr.problem_name AND o.user_id = cr.user_id) = 'exclude'
               THEN NULL
             WHEN (SELECT o.decision FROM overrides o
                   WHERE o.problem_name = cr.problem_name AND o.user_id = cr.user_id) = 'self_translation'
               AND cr.user_first_at > (
                   SELECT cr2.user_first_at FROM credited cr2
                   WHERE cr2.problem_name = cr.problem_name
                     AND cr2.user_id     = cr.user_id
                     AND cr2.language   != cr.language
               )
               THEN 0.5
             ELSE
               (1.0
                * CASE WHEN cr.language = 'en' THEN 1.5 ELSE 1 END
                * CASE WHEN split_part(cr.problem_name, '.', 1) = ANY($3) THEN 1.5 ELSE 1 END
                * CASE WHEN (SELECT fp.first_at_any FROM first_p fp
                             WHERE fp.problem_name = cr.problem_name)::date
                            BETWEEN (SELECT start_d FROM params) AND (SELECT end_d FROM params)
                       THEN 1.5 ELSE 1 END
               )
           END AS points
    FROM credited cr
)
SELECT s.user_id, u.username, u.full_name, u.country_location, u.profile_picture,
       COUNT(*)::int AS solutions,
       ROUND(SUM(s.points)::numeric, 3) AS points,
       MAX(s.user_first_at) AS last_at
FROM scored s
JOIN users u ON u.id = s.user_id
WHERE s.points IS NOT NULL
GROUP BY s.user_id, u.username, u.full_name, u.country_location, u.profile_picture
ORDER BY points DESC, solutions DESC, last_at ASC;
`;

// Recent credited solutions, newest first, for the live activity feed.
const FEED_SQL = `
WITH params AS (
    SELECT $1::date AS start_d, $2::date AS end_d
),
all_edits AS (
    SELECT problem_name, language, edited_at FROM contributions WHERE problem_name IS NOT NULL
    UNION ALL
    SELECT problem_name, language, edited_at FROM github_contributions WHERE problem_name IS NOT NULL
),
first_pl AS (
    SELECT problem_name, language, MIN(edited_at) AS first_at FROM all_edits GROUP BY problem_name, language
),
new_pl AS (
    SELECT fpl.problem_name, fpl.language
    FROM first_pl fpl, params p
    WHERE fpl.first_at::date BETWEEN p.start_d AND p.end_d
      AND NOT EXISTS (SELECT 1 FROM github_contributions g WHERE g.problem_name = fpl.problem_name AND g.language = fpl.language)
),
cand AS (
    SELECT c.problem_name, c.language, c.user_id, MIN(c.edited_at) AS user_first_at
    FROM contributions c, params p
    WHERE c.user_id IS NOT NULL AND c.content_changed = true AND COALESCE(c.invisible, false) = false
      AND c.problem_name IS NOT NULL AND c.edited_at::date BETWEEN p.start_d AND p.end_d
    GROUP BY c.problem_name, c.language, c.user_id
),
credited AS (
    SELECT DISTINCT ON (cand.problem_name, cand.language)
           cand.problem_name, cand.language, cand.user_id, cand.user_first_at
    FROM cand JOIN new_pl USING (problem_name, language)
    ORDER BY cand.problem_name, cand.language, cand.user_first_at ASC
)
SELECT cr.problem_name, cr.language, cr.user_first_at, u.username, u.full_name
FROM credited cr
JOIN users u ON u.id = cr.user_id
ORDER BY cr.user_first_at DESC
LIMIT 20;
`;

function tierFor(rank, points) {
    if (rank === 1) return 'grand';
    if (rank === 2) return 'silver';
    if (points >= CONTEST.bronzeThreshold) return 'bronze';
    return null;
}

async function computeStandings() {
    const now = Date.now();
    if (standingsCache.data && now - standingsCache.at < CACHE_TTL_MS) {
        return standingsCache.data;
    }

    const args = [CONTEST.startDate, CONTEST.endDate, CONTEST.lowCoverageChapters];
    const hasOverrides = await checkOverridesTable();
    const standingsSql = hasOverrides ? STANDINGS_SQL_WITH_OVERRIDES : STANDINGS_SQL;
    const [standingsRes, feedRes] = await Promise.all([
        pool.query(standingsSql, args),
        pool.query(FEED_SQL, [CONTEST.startDate, CONTEST.endDate]),
    ]);

    const leaderboard = standingsRes.rows.map((r, i) => {
        const rank = i + 1;
        const points = parseFloat(r.points);
        return {
            rank,
            userId: r.user_id,
            username: r.username,
            fullName: r.full_name,
            country: r.country_location || null,
            avatar: r.profile_picture ? r.profile_picture.replace(/\\/g, '/') : '/img/profile_images/Default_placeholder.svg',
            solutions: r.solutions,
            points,
            tier: tierFor(rank, points),
        };
    });

    const totalSolutions = leaderboard.reduce((sum, r) => sum + r.solutions, 0);
    const feed = feedRes.rows.map(r => ({
        problem: r.problem_name,
        language: r.language,
        at: r.user_first_at,
        username: r.username,
        fullName: r.full_name,
    }));

    const data = {
        slug: CONTEST.slug,
        startDate: CONTEST.startDate,
        endDate: CONTEST.endDate,
        goalSolutions: CONTEST.goalSolutions,
        firstMilestone: CONTEST.firstMilestone,
        stretchRaffleThreshold: CONTEST.stretchRaffleThreshold,
        stretchUnlocked: totalSolutions >= CONTEST.goalSolutions,
        bronzeThreshold: CONTEST.bronzeThreshold,
        live: isLive(),
        daysLeft: daysLeft(),
        totalSolutions,
        participants: leaderboard.length,
        leaderboard,
        feed,
    };

    standingsCache = { at: now, data };
    return data;
}

// ─── GET /challenge — redirect to the current contest ──────────────
router.get('/', (req, res) => {
    res.redirect(`/challenge/${CONTEST.slug}`);
});

// ─── GET /challenge/:slug/data — JSON for live polling ─────────────
router.get('/:slug/data', async (req, res) => {
    if (req.params.slug !== CONTEST.slug) {
        return res.status(404).json({ error: 'Unknown contest' });
    }
    try {
        const data = await computeStandings();
        res.json(data);
    } catch (err) {
        console.error('Contest data error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── GET /challenge/:slug — live dashboard page ────────────────────
router.get('/:slug', async (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);

    if (req.params.slug !== CONTEST.slug) {
        return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }

    try {
        const data = await computeStandings();
        res.render('contest/show', {
            __: i18n.__,
            lang,
            contest: data,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (err) {
        console.error('Contest page error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

module.exports = { router, getActiveContestBanner, CONTEST, invalidateStandingsCache };
