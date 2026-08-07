const express = require('express');
const path = require('path');
const fs = require('fs');
const i18n = require('i18n');
const { Pool } = require('pg');
const { AXIS_META, axesByCategory } = require('./lib/difficultyAxes');
const { AXIS_KEYS } = require('./difficultyRubric');
const { readCSV, getSolvedSet } = require('./parents');
const { toRating, FLOOR: RATING_FLOOR, CEIL: RATING_CEIL, STEP: RATING_STEP } = require('./lib/difficultyRating');
const { heatColor, heatTextColor } = require('./lib/heatColor');
const { getStatements } = require('./lib/statementRender');

// mergeParams so :lang from the mount path ('/:lang(en|ru)/problems') reaches
// handlers here — same reasoning as recommendations.js's router.
const router = express.Router({ mergeParams: true });

// These pages are actively being iterated on and the underlying data/rating scale/labels
// have already changed multiple times in one day — no HTTP or intermediate cache should
// ever hold a stale copy across a deploy.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const pool = new Pool({
    user: process.env.PG_USER, host: process.env.PG_HOST, database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD, port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const getLang = (req) => (req.params.lang === 'ru' ? 'ru' : (req.session?.lang || 'en'));

function base(req, res) {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    return {
        __: i18n.__,
        lang,
        username: req.session?.username || null,
        userId: req.session?.userId || null,
    };
}

// Within-section AUC of the AI score against Savchenko's own withheld ∗ mark
// (scripts/score-difficulty.js's withinSectionAuc()), and the null-model baseline
// from solution length alone. Hand-maintained, not recomputed per request: the
// scoring run that produces these numbers is a rare, deliberate batch job (see
// scripts/score-difficulty.js), not something worth an O(pairs) query on every
// page view. Update this after any re-scoring run.
const RELIABILITY = { auc: 0.714, baselineAuc: 0.584, sections: null, pairs: 11974, generated: '2026-07-30' };

// The taxonomy scripts/canonicalize-tags.js proposed and problem_difficulty.canonical_tags
// was classified against. Loaded once at require time — Node caches JSON requires, and it
// only changes when the canonicalization script is re-run and the process restarted, same
// as every other build artifact on this site (data/recommendations.json, etc).
let TAXONOMY = { tags: [] };
try {
    TAXONOMY = require('./data/topic-taxonomy.json');
} catch { /* not built yet — the finder still works, just without a tag filter */ }

// Chapter/section titles have their own Russian CSVs (src/ru/database/*.csv, same
// convention as parents.js's getLanguageData) — hardcoding the English path here was
// the bug that made /ru/problems show English chapter names.
function chapterTitleMap(lang) {
    try {
        const csv = path.join(__dirname, lang === 'ru' ? 'src/ru/database/chapters.csv' : 'src/database/chapters.csv');
        const nums = readCSV(csv, 0);
        const titles = readCSV(csv, 1);
        const map = {};
        nums.forEach((n, i) => { map[n] = titles[i]; });
        return map;
    } catch { return {}; }
}

function sectionTitleMap(lang) {
    try {
        const csv = path.join(__dirname, lang === 'ru' ? 'src/ru/database/sections.csv' : 'src/database/sections.csv');
        const nums = readCSV(csv, 0);
        const titles = readCSV(csv, 1);
        const map = {};
        nums.forEach((n, i) => { map[n] = titles[i]; });
        return map;
    } catch { return {}; }
}

// Row layout, documented once here rather than repeated at every call site (server route,
// client JS, tests): [name, chapter, section, idx, starred, calibrated, estMinutes,
// prerequisites[], canonicalTags[], voteAvg, voteCount, solvedEn, solvedRu, scores[]]
// scores[] is aligned to axisKeys order; a null entry means that axis wasn't scored.
//
// Statement HTML deliberately is NOT in this row. It was, briefly (full rendered markdown
// + images for all 2,023 problems in one embedded blob), and that shipped a real production
// bug: the payload got large enough that a slow/flaky connection could truncate the
// response mid-stream, and `JSON.parse` on truncated JSON throws "Unexpected end of JSON
// input" — which, because it happens at the top of this file's IIFE before any listener is
// wired, took every button and slider on the page down with it. Statement HTML is fetched
// per-card instead, on demand, via the same GET /api/problem/:name/statement endpoint
// index.js already serves for the upload-page preview (parseMarkdown + transformImageMarkdown
// + renderMathInHtml, response-cached there) — one card's fetch failing degrades that one
// card, not the whole page.
const COL = {
    NAME: 0, CHAPTER: 1, SECTION: 2, IDX: 3, STARRED: 4, CALIBRATED: 5, EST_MINUTES: 6,
    PREREQUISITES: 7, CANONICAL_TAGS: 8, VOTE_AVG: 9, VOTE_COUNT: 10, SOLVED_EN: 11, SOLVED_RU: 12, SCORES: 13,
};

// One page of results. This single constant governs how many cards the server renders into
// the HTML, how many the client renders per "Load more", and the ceiling on a statement
// batch — they must agree. They did not, once: the server rendered 50 cards, the client
// primed statements for all 50, and the batch endpoint capped at 40, so the last 10 cards
// permanently showed "Could not load the statement" until something re-rendered them.
const PAGE_SIZE = 20;

// Cached per language: statement_tex and chapter/section titles are language-specific
// (problem_statements has one row per problem per lang), so a single shared cache would
// leak English statement text onto the Russian page — confirmed live on /ru/problems.
const _finderCache = { en: { at: 0, value: undefined }, ru: { at: 0, value: undefined } };
const FINDER_CACHE_MS = 10 * 60 * 1000;

async function getProblemFinderDataset(lang) {
    lang = lang === 'ru' ? 'ru' : 'en';
    const slot = _finderCache[lang];
    if (slot.value !== undefined && Date.now() - slot.at < FINDER_CACHE_MS) {
        return slot.value;
    }
    let value = null;
    try {
        const { rows } = await pool.query(
            `SELECT ps.problem_name, ps.chapter, ps.section, ps.idx, ps.starred,
                    pd.calibrated, pd.scores, pd.est_minutes, pd.prerequisites, pd.canonical_tags,
                    v.avg_vote, v.vote_count
               FROM problem_statements ps
               LEFT JOIN problem_difficulty pd ON pd.problem_name = ps.problem_name
               LEFT JOIN (
                   SELECT problem_name, AVG(vote)::numeric(3,1) AS avg_vote, COUNT(*)::int AS vote_count
                     FROM problem_difficulty_votes GROUP BY problem_name
               ) v ON v.problem_name = ps.problem_name
              WHERE ps.lang = $1
              ORDER BY ps.chapter, ps.section, ps.idx`,
            [lang]
        );
        const enSolved = getSolvedSet('en');
        const ruSolved = getSolvedSet('ru');
        const dataRows = rows.map((r) => {
            return [
                r.problem_name, r.chapter, r.section, r.idx, r.starred ? 1 : 0,
                r.calibrated, r.est_minutes,
                r.prerequisites || [], r.canonical_tags || [],
                r.avg_vote != null ? Number(r.avg_vote) : null, r.vote_count || 0,
                enSolved.has(r.problem_name) ? 1 : 0, ruSolved.has(r.problem_name) ? 1 : 0,
                r.scores ? AXIS_KEYS.map((k) => (r.scores[k] != null ? r.scores[k] : null)) : null,
            ];
        });
        value = {
            axisKeys: AXIS_KEYS,
            chapters: chapterTitleMap(lang),
            sections: sectionTitleMap(lang),
            tags: TAXONOMY.tags.map((t) => [t.key, t.labelEn, t.labelRu]),
            rows: dataRows,
            scoredCount: dataRows.filter((r) => r[COL.CALIBRATED] != null).length,
            taggedCount: dataRows.filter((r) => r[COL.CANONICAL_TAGS].length).length,
        };
    } catch (err) {
        if (err.code !== '42P01') console.error('problem finder dataset:', err.message);
    }
    _finderCache[lang] = { at: Date.now(), value };
    return value;
}

function applyFilters(rows, q) {
    let out = rows;
    if (q.chapter) {
        const chapters = new Set(String(q.chapter).split(',').map(Number));
        out = out.filter((r) => chapters.has(r[COL.CHAPTER]));
    }
    if (q.tag) {
        const tags = String(q.tag).split(',').filter(Boolean);
        const mode = q.tagMode === 'and' ? 'and' : 'or';
        out = out.filter((r) => (mode === 'and'
            ? tags.every((t) => r[COL.CANONICAL_TAGS].includes(t))
            : tags.some((t) => r[COL.CANONICAL_TAGS].includes(t))));
    }
    if (q.starred) out = out.filter((r) => r[COL.STARRED] === 1);
    if (q.min) out = out.filter((r) => r[COL.CALIBRATED] != null && r[COL.CALIBRATED] >= Number(q.min));
    if (q.max) out = out.filter((r) => r[COL.CALIBRATED] != null && r[COL.CALIBRATED] <= Number(q.max));
    if (q.q) {
        const needle = String(q.q).toLowerCase();
        out = out.filter((r) => r[COL.NAME].includes(needle)
            || r[COL.PREREQUISITES].some((t) => t.toLowerCase().includes(needle))
            || r[COL.CANONICAL_TAGS].some((t) => t.toLowerCase().includes(needle)));
    }
    return out;
}

function applySort(rows, sort, dir, axisKeys) {
    const mul = dir === 'asc' ? 1 : -1;
    const axisIdx = axisKeys.indexOf(sort);
    return [...rows].sort((a, b) => {
        let av, bv;
        if (sort === 'calibrated') { av = a[COL.CALIBRATED]; bv = b[COL.CALIBRATED]; }
        else if (sort === 'est_minutes') { av = a[COL.EST_MINUTES]; bv = b[COL.EST_MINUTES]; }
        else if (sort === 'vote_avg') { av = a[COL.VOTE_AVG]; bv = b[COL.VOTE_AVG]; }
        else if (axisIdx !== -1) { av = a[COL.SCORES] ? a[COL.SCORES][axisIdx] : null; bv = b[COL.SCORES] ? b[COL.SCORES][axisIdx] : null; }
        else {
            return (a[COL.CHAPTER] - b[COL.CHAPTER]) || (a[COL.SECTION] - b[COL.SECTION]) || (a[COL.IDX] - b[COL.IDX]);
        }
        if (av == null && bv == null) return 0;
        if (av == null) return 1;  // unscored always sorts last, regardless of direction
        if (bv == null) return -1;
        return (av - bv) * mul;
    });
}

// The filterable dataset arrives via a real fetch() to this endpoint rather than being
// embedded inline in the page's HTML. It was embedded inline first, and that caused a real
// production incident: large or unusual HTML responses are exactly what's most likely to
// get mangled by network-path interference (proxies, ISP-level inspection — this project
// has hit that before, see the self-hosted-vendor-assets history), and when it happened the
// corrupted JSON.parse call crashed before any button or slider got wired up, taking the
// whole page down at once. A dedicated JSON endpoint gets normal HTTP semantics (its own
// completion/failure, retryable, inspectable in the network tab) instead of silently living
// or dying with the page load.
router.get('/data', async (req, res) => {
    const lang = getLang(req);
    const dataset = await getProblemFinderDataset(lang);
    if (!dataset) return res.status(503).json({ error: 'unavailable' });
    res.json(dataset);
});

// Statement previews for a whole page of cards in ONE request.
//
// Each card used to fetch its own statement, which meant ~20 requests per screen. Rendering
// is not the bottleneck (a cache hit and a cache miss both measure ~0.85s from outside the
// datacentre, i.e. it is nearly all round-trip latency), and browsers cap concurrent
// requests per host at ~6, so 20 individual fetches serialise into several waves and the
// cards sat on "Loading statement…" for seconds. Batching collapses that to a single
// round-trip.
router.get('/statements', async (req, res) => {
    const lang = getLang(req);
    // Bounded so one URL cannot ask the server to render an unbounded amount of maths.
    // Deliberately generous relative to PAGE_SIZE: a cap that silently drops names is how
    // cards ended up stuck on "Could not load the statement", so the client is expected to
    // chunk by PAGE_SIZE and this only ever catches a hand-edited URL.
    const MAX_BATCH = PAGE_SIZE * 3;
    const names = String(req.query.names || '')
        .split(',')
        .map((n) => n.trim())
        .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
        .slice(0, MAX_BATCH);
    if (!names.length) return res.json({});

    try {
        res.json(await getStatements(pool, names, lang));
    } catch (err) {
        console.error('batch statements failed:', err.message);
        res.status(500).json({ error: 'render failed' });
    }
});

router.get('/', async (req, res) => {
    const locals = base(req, res);
    const dataset = await getProblemFinderDataset(locals.lang);

    if (!dataset) {
        return res.render('problems/index', {
            ...locals, dataset: null, ssrRows: [], total: 0, query: req.query, bookmarked: [],
            axisMeta: { cost: axesByCategory('cost'), shape: axesByCategory('shape'), reward: axesByCategory('reward') },
            toRating, ratingFloor: RATING_FLOOR, ratingCeil: RATING_CEIL, ratingStep: RATING_STEP, pageSize: PAGE_SIZE,
        });
    }

    const filtered = applyFilters(dataset.rows, req.query);
    const sorted = req.query.sort ? applySort(filtered, req.query.sort, req.query.dir || 'desc', dataset.axisKeys) : filtered;
    const ssrRows = sorted.slice(0, PAGE_SIZE);

    let bookmarked = [];
    if (req.session?.userId) {
        try {
            const { rows } = await pool.query('SELECT problem_name FROM starred_solutions WHERE user_id = $1', [req.session.userId]);
            bookmarked = rows.map((r) => r.problem_name);
        } catch (err) { console.error('bookmarked lookup:', err.message); }
    }

    res.render('problems/index', {
        ...locals,
        dataset,
        ssrRows,
        total: filtered.length,
        query: req.query,
        bookmarked,
        axisMeta: { cost: axesByCategory('cost'), shape: axesByCategory('shape'), reward: axesByCategory('reward') },
        toRating, ratingFloor: RATING_FLOOR, ratingCeil: RATING_CEIL, ratingStep: RATING_STEP, pageSize: PAGE_SIZE,
    });
});

// SEO landing page per canonical tag, modeled on bank.js's GET /bank/topic/:topic.
// Reuses the same cached dataset as GET / rather than a second query.
router.get('/topic/:tag', async (req, res) => {
    const locals = base(req, res);
    const tag = req.params.tag;
    const meta = TAXONOMY.tags.find((t) => t.key === tag);
    if (!meta) return res.status(404).render('404', { ...locals, pageUrl: req.originalUrl });

    const dataset = await getProblemFinderDataset(locals.lang);
    const matching = dataset ? dataset.rows.filter((r) => r[COL.CANONICAL_TAGS].includes(tag)) : [];
    const sorted = applySort(matching, 'calibrated', 'desc', dataset ? dataset.axisKeys : []);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = 40;
    const pageRows = sorted.slice((page - 1) * perPage, page * perPage);

    res.render('problems/topic', {
        ...locals,
        tagMeta: meta,
        rows: pageRows,
        total: sorted.length,
        page,
        totalPages: Math.max(1, Math.ceil(sorted.length / perPage)),
        toRating,
    });
});

router.get('/methodology', async (req, res) => {
    const locals = base(req, res);
    // Ties at the very top of the scale come from two compounding effects: the raw
    // percentile itself ties (several problems can share the highest overall_difficulty),
    // and rounding to the nearest 100 for the Codeforces-style display (lib/difficultyRating.js)
    // merges neighbouring percentiles together. So "who's at the max" is computed here from
    // the rating, not hardcoded to calibrated = 100.
    let topRatingProblems = [];
    try {
        const { rows } = await pool.query(
            `SELECT problem_name, calibrated, starred, (scores->>'overall_difficulty')::int AS overall_difficulty
               FROM problem_difficulty WHERE calibrated IS NOT NULL ORDER BY calibrated DESC`
        );
        // calibrated is the percentile display value, but it's an integer 0-100 rounded
        // from a rank — among just the top slice (everyone tied at the max rating) it only
        // takes 3-4 distinct values, so coloring by it renders nearly one flat color.
        // overall_difficulty is the model's pre-percentile raw score and has real spread
        // even within that same top slice (confirmed: 9 distinct values 74-85 among
        // problems all rated calibrated 97-100) — using it is what actually gives every
        // problem in this list its own shade instead of one flat color for all of them.
        const withRating = rows.map((r) => ({
            ...r, rating: toRating(r.calibrated),
            bg: heatColor(r.overall_difficulty), fg: heatTextColor(r.overall_difficulty),
        }));
        const maxRating = withRating.length ? withRating[0].rating : null;
        topRatingProblems = withRating.filter((r) => r.rating === maxRating).sort((a, b) => a.problem_name.localeCompare(b.problem_name));
    } catch (err) {
        if (err.code !== '42P01') console.error('methodology top-rating query:', err.message);
    }

    res.render('difficulty/methodology', {
        ...locals,
        axes: {
            headline: axesByCategory('headline'),
            cost: axesByCategory('cost'),
            shape: axesByCategory('shape'),
            reward: axesByCategory('reward'),
        },
        widgetKeys: new Set(['insight_required', 'math_level', 'computational_load', 'trap_density', 'specialist_knowledge', 'elegance', 'novelty', 'curiosity', 'pleasure']),
        topRatingProblems,
        maxRating: topRatingProblems.length ? topRatingProblems[0].rating : RATING_CEIL,
        reliability: RELIABILITY,
        ratingFloor: RATING_FLOOR, ratingCeil: RATING_CEIL,
    });
});

module.exports = router;
