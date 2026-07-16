// contestJudge.js — Blind dual-judge quality evaluation for the June contest.
//
// The public standings (contest.js) rank contributors by mechanical *points*
// and decide the merch prizes. This module is a SEPARATE quality track: the
// two contest organizers (astrosander, emixter) independently grade the
// quality of every credited submission on six Russian parameters, and the two
// grades combine into one geometric-mean quality score used to surface the
// best works. It never touches the prize points.
//
// Fairness / independence ("umnaya sistema"):
//   - Fully BLIND. Neither organizer ever sees the other's individual scores
//     or comment. The API and both views expose only: my own evaluation, a
//     boolean `otherEvaluated`, and — once BOTH have graded — the combined
//     geometric mean sqrt(total_A × total_B).
//   - Identity is forced server-side: judge_id is always req.session.userId,
//     so an organizer physically cannot write the other's row.
//
// A "submission" here is exactly the credited new solution (problem_name,
// language) defined by contest.js — same CTE logic, one row per solution.

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const i18n = require('i18n');
const { CONTEST, isContestOrganizer } = require('./contest');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

// ─── Quality rubric (single source of truth) ───────────────────────
// Six parameters, each graded 1–10 (step 0.5). A judge's total is the mean of
// the parameters they filled in. `scores` is stored as JSONB keyed by `key`,
// so this list can change without a schema migration.
const QUALITY_CRITERIA = [
    { key: 'correctness',  ru: 'Правильность' },
    { key: 'completeness', ru: 'Полнота решения' },
    { key: 'rigor',        ru: 'Строгость и обоснованность' },
    { key: 'clarity',      ru: 'Ясность изложения' },
    { key: 'presentation', ru: 'Оформление' },
    { key: 'elegance',     ru: 'Элегантность метода' },
];
const QUALITY_SCALE = { min: 1, max: 10, step: 0.5 };
const CRITERIA_KEYS = new Set(QUALITY_CRITERIA.map(c => c.key));

let evaluationsTableReady = false;

async function ensureEvaluationsTable() {
    if (evaluationsTableReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS contest_evaluations (
            id            SERIAL PRIMARY KEY,
            contest_slug  TEXT        NOT NULL,
            problem_name  TEXT        NOT NULL,
            language      TEXT        NOT NULL,
            judge_id      INTEGER     NOT NULL,
            scores        JSONB       NOT NULL DEFAULT '{}'::jsonb,
            total         NUMERIC(5,2),
            comment       TEXT,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (contest_slug, problem_name, language, judge_id)
        )
    `);
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_contest_eval_lookup
            ON contest_evaluations (contest_slug, problem_name, language)
    `);
    evaluationsTableReady = true;
}

function getLang(req) {
    return req.session && req.session.lang ? req.session.lang : 'en';
}

// The organizer id that is NOT me — used to detect the second grade without
// ever exposing its value.
function otherJudgeId(myId) {
    const found = (CONTEST.organizers || []).find(o => o.id !== myId);
    return found ? found.id : null;
}

// Keep only recognised parameters whose value is a finite number inside the
// scale. Returns { scores: {...}, total: number|null }.
function sanitizeScores(raw) {
    const scores = {};
    if (raw && typeof raw === 'object') {
        for (const { key } of QUALITY_CRITERIA) {
            const v = Number(raw[key]);
            if (Number.isFinite(v) && v >= QUALITY_SCALE.min && v <= QUALITY_SCALE.max) {
                // snap to the nearest allowed step so stored data stays clean
                const snapped = Math.round(v / QUALITY_SCALE.step) * QUALITY_SCALE.step;
                scores[key] = Math.round(snapped * 100) / 100;
            }
        }
    }
    const vals = Object.values(scores);
    const total = vals.length
        ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100
        : null;
    return { scores, total };
}

// Geometric mean of the two judges' totals, or null until both exist.
function combinedScore(totalA, totalB) {
    const a = Number(totalA), b = Number(totalB);
    if (!(a > 0) || !(b > 0)) return null;
    return Math.round(Math.sqrt(a * b) * 100) / 100;
}

// ─── Submissions ───────────────────────────────────────────────────
// One row per credited solution in the contest window, with author and the
// current mechanical "weight" (base points) shown read-only for reference.
// Mirrors the credited CTE + multiplier math in contest.js.
const SUBMISSIONS_SQL = `
WITH params AS (SELECT $1::date AS start_d, $2::date AS end_d),
all_edits AS (
    SELECT problem_name, language, edited_at FROM contributions WHERE problem_name IS NOT NULL
    UNION ALL
    SELECT problem_name, language, edited_at FROM github_contributions WHERE problem_name IS NOT NULL
),
first_pl AS (
    SELECT problem_name, language, MIN(edited_at) AS first_at FROM all_edits GROUP BY problem_name, language
),
first_p AS (
    SELECT problem_name, MIN(edited_at) AS first_at_any FROM all_edits GROUP BY problem_name
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
SELECT cr.problem_name, cr.language, cr.user_id, u.username, u.full_name, cr.user_first_at,
       ROUND((1.0
        * CASE WHEN cr.language = 'en' THEN 1.5 ELSE 1 END
        * CASE WHEN split_part(cr.problem_name, '.', 1) = ANY($3) THEN 1.5 ELSE 1 END
        * CASE WHEN (SELECT fp.first_at_any FROM first_p fp WHERE fp.problem_name = cr.problem_name)::date
                    BETWEEN (SELECT start_d FROM params) AND (SELECT end_d FROM params) THEN 1.5 ELSE 1 END
       )::numeric, 3) AS base_points
FROM credited cr
JOIN users u ON u.id = cr.user_id
ORDER BY cr.problem_name, cr.language;
`;

// Targeted single-solution variant of SUBMISSIONS_SQL (fast path for the
// solution-page widget) — scoped to one problem_name.
const SUBMISSION_ONE_SQL = `
WITH params AS (SELECT $1::date AS start_d, $2::date AS end_d),
all_edits AS (
    SELECT problem_name, language, edited_at FROM contributions WHERE problem_name = $4
    UNION ALL
    SELECT problem_name, language, edited_at FROM github_contributions WHERE problem_name = $4
),
first_pl AS (
    SELECT problem_name, language, MIN(edited_at) AS first_at FROM all_edits GROUP BY problem_name, language
),
first_p AS (
    SELECT problem_name, MIN(edited_at) AS first_at_any FROM all_edits GROUP BY problem_name
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
      AND c.problem_name = $4 AND c.edited_at::date BETWEEN p.start_d AND p.end_d
    GROUP BY c.problem_name, c.language, c.user_id
),
credited AS (
    SELECT DISTINCT ON (cand.problem_name, cand.language)
           cand.problem_name, cand.language, cand.user_id, cand.user_first_at
    FROM cand JOIN new_pl USING (problem_name, language)
    ORDER BY cand.problem_name, cand.language, cand.user_first_at ASC
)
SELECT cr.problem_name, cr.language, cr.user_id, u.username, u.full_name,
       ROUND((1.0
        * CASE WHEN cr.language = 'en' THEN 1.5 ELSE 1 END
        * CASE WHEN split_part(cr.problem_name, '.', 1) = ANY($3) THEN 1.5 ELSE 1 END
        * CASE WHEN (SELECT fp.first_at_any FROM first_p fp WHERE fp.problem_name = cr.problem_name)::date
                    BETWEEN (SELECT start_d FROM params) AND (SELECT end_d FROM params) THEN 1.5 ELSE 1 END
       )::numeric, 3) AS base_points
FROM credited cr
JOIN users u ON u.id = cr.user_id
WHERE cr.language = $5
LIMIT 1;
`;

function submissionArgs() {
    return [CONTEST.startDate, CONTEST.endDate, CONTEST.lowCoverageChapters];
}

// Fetch all evaluations for the contest, grouped by "problem|lang".
async function loadEvaluations() {
    await ensureEvaluationsTable();
    const res = await pool.query(
        `SELECT problem_name, language, judge_id, scores, total, comment
         FROM contest_evaluations WHERE contest_slug = $1`,
        [CONTEST.slug]
    );
    const map = new Map();
    for (const r of res.rows) {
        const k = `${r.problem_name}|${r.language}`;
        if (!map.has(k)) map.set(k, {});
        map.get(k)[r.judge_id] = {
            scores: r.scores || {},
            total: r.total == null ? null : parseFloat(r.total),
            comment: r.comment || '',
        };
    }
    return map;
}

// Build one blind row for a submission from `myId`'s perspective. Never leaks
// the other judge's scores/comment — only a boolean and the combined mean.
function blindRow(byJudge, myId) {
    const mineRaw = byJudge ? byJudge[myId] : null;
    const otherRaw = byJudge ? byJudge[otherJudgeId(myId)] : null;
    const mine = mineRaw && mineRaw.total != null ? mineRaw : (mineRaw || null);
    const otherEvaluated = !!(otherRaw && otherRaw.total != null);
    const iEvaluated = !!(mineRaw && mineRaw.total != null);
    const combined = (iEvaluated && otherEvaluated)
        ? combinedScore(mineRaw.total, otherRaw.total)
        : null;
    return {
        mine: mine ? { scores: mine.scores || {}, total: mine.total ?? null, comment: mine.comment || '' } : null,
        otherEvaluated,
        combined,
    };
}

// ─── Full evaluation table for one judge ───────────────────────────
async function getJudgeTable(myId) {
    const [subsRes, evalMap] = await Promise.all([
        pool.query(SUBMISSIONS_SQL, submissionArgs()),
        loadEvaluations(),
    ]);
    const rows = subsRes.rows.map(s => {
        const blind = blindRow(evalMap.get(`${s.problem_name}|${s.language}`), myId);
        return {
            problemName: s.problem_name,
            language: s.language,
            userId: s.user_id,
            author: { username: s.username || null, fullName: s.full_name || null },
            basePoints: s.base_points != null ? parseFloat(s.base_points) : null,
            mine: blind.mine,
            otherEvaluated: blind.otherEvaluated,
            combined: blind.combined,
        };
    });
    return {
        slug: CONTEST.slug,
        title: CONTEST.title,
        criteria: QUALITY_CRITERIA,
        scale: QUALITY_SCALE,
        rows,
    };
}

// Metadata for a single (problem, language): is it a submission, and who authored it.
async function getSubmissionMeta(problemName, language) {
    const res = await pool.query(SUBMISSION_ONE_SQL, [
        CONTEST.startDate, CONTEST.endDate, CONTEST.lowCoverageChapters, problemName, language,
    ]);
    if (!res.rows.length) return null;
    const r = res.rows[0];
    return {
        userId: r.user_id,
        author: { username: r.username || null, fullName: r.full_name || null },
        basePoints: r.base_points != null ? parseFloat(r.base_points) : null,
    };
}

// ─── Solution-page widget payload (organizer only) ─────────────────
// Returns null-ish descriptor used by post.js -> solution_post.ejs. Never
// includes the other judge's scores.
async function getSolutionJudgingWidget(myId, problemName, language) {
    try {
        const meta = await getSubmissionMeta(problemName, language);
        if (!meta) {
            return { isOrganizer: true, isSubmission: false, slug: CONTEST.slug };
        }
        const evalMap = await loadEvaluations();
        const blind = blindRow(evalMap.get(`${problemName}|${language}`), myId);
        return {
            isOrganizer: true,
            isSubmission: true,
            slug: CONTEST.slug,
            problemName,
            language,
            author: meta.author,
            basePoints: meta.basePoints,
            criteria: QUALITY_CRITERIA,
            scale: QUALITY_SCALE,
            mine: blind.mine,
            otherEvaluated: blind.otherEvaluated,
            combined: blind.combined,
        };
    } catch (err) {
        console.error('getSolutionJudgingWidget error:', err);
        return null;
    }
}

// ─── Access guards ─────────────────────────────────────────────────
function requireOrganizerPage(req, res, next) {
    if (!isContestOrganizer(req)) {
        const lang = getLang(req);
        i18n.setLocale(res, lang);
        return res.status(403).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
    next();
}
function requireOrganizerApi(req, res, next) {
    if (!isContestOrganizer(req)) return res.status(403).json({ error: 'Forbidden' });
    next();
}

// ─── GET /challenge/:slug/judge — full-width evaluation table ───────
router.get('/:slug/judge', requireOrganizerPage, async (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    if (req.params.slug !== CONTEST.slug) {
        return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
    try {
        const table = await getJudgeTable(req.session.userId);
        res.render('contest/judge', {
            __: i18n.__,
            lang,
            username: req.session.username || null,
            userId: req.session.userId,
            table,
        });
    } catch (err) {
        console.error('Contest judge page error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── GET /challenge/:slug/judge/data — JSON refresh (blind) ─────────
router.get('/:slug/judge/data', requireOrganizerApi, async (req, res) => {
    if (req.params.slug !== CONTEST.slug) return res.status(404).json({ error: 'Unknown contest' });
    try {
        const table = await getJudgeTable(req.session.userId);
        res.json(table);
    } catch (err) {
        console.error('Contest judge data error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── POST /challenge/:slug/judge/save — upsert MY evaluation ───────
router.post('/:slug/judge/save', requireOrganizerApi, async (req, res) => {
    if (req.params.slug !== CONTEST.slug) return res.status(404).json({ error: 'Unknown contest' });
    try {
        const { problem_name, language } = req.body || {};
        const comment = typeof (req.body && req.body.comment) === 'string'
            ? req.body.comment.slice(0, 5000) : '';
        if (!problem_name || (language !== 'en' && language !== 'ru')) {
            return res.status(400).json({ error: 'Invalid problem or language' });
        }
        // Only real credited submissions can be graded.
        const meta = await getSubmissionMeta(problem_name, language);
        if (!meta) return res.status(400).json({ error: 'Not a contest submission' });

        const { scores, total } = sanitizeScores(req.body && req.body.scores);
        const myId = req.session.userId;

        await ensureEvaluationsTable();
        await pool.query(
            `INSERT INTO contest_evaluations
                 (contest_slug, problem_name, language, judge_id, scores, total, comment, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())
             ON CONFLICT (contest_slug, problem_name, language, judge_id)
             DO UPDATE SET scores = $5::jsonb, total = $6, comment = $7, updated_at = NOW()`,
            [CONTEST.slug, problem_name, language, myId, JSON.stringify(scores), total, comment]
        );

        // Re-read for a blind response (fresh combined if both graded).
        const evalMap = await loadEvaluations();
        const blind = blindRow(evalMap.get(`${problem_name}|${language}`), myId);
        res.json({ ok: true, mine: blind.mine, otherEvaluated: blind.otherEvaluated, combined: blind.combined });
    } catch (err) {
        console.error('Contest judge save error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = {
    router,
    getSolutionJudgingWidget,
    getJudgeTable,
    isContestOrganizer,
    QUALITY_CRITERIA,
    QUALITY_SCALE,
    // Pure helpers exposed for unit testing (no DB).
    _test: { sanitizeScores, combinedScore, blindRow, otherJudgeId },
};
