const express = require('express');
const fs = require('fs');
const path = require('path');
const i18n = require('i18n');
const { label } = require('./lib/recommendationLabels');

// mergeParams so the :lang segment from the mount path ('/:lang(en|ru)/recommendations')
// reaches req.params here — without it every page renders in English.
const router = express.Router({ mergeParams: true });

/**
 * The catalog is a build artifact: a few thousand read-only rows regenerated
 * offline by scripts/build-recommendations.js. Loaded once at boot, like
 * searchIndex.js does for problems — no database round-trip per request, and the
 * page stays server-rendered so Google (140,399 sessions, the single largest
 * traffic source) can actually read the entries.
 */
const CATALOG_PATH = path.join(__dirname, 'data', 'recommendations.json');

let catalog = null;
let byRubric = new Map();
/** rubric id -> which corpus it belongs to, so a rubric page lights the right tab. */
let rubricTab = new Map();
let counts = { telegram: 0, websites: 0 };

function load() {
    try {
        catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
        const tg = catalog.telegram?.entries || [];
        const web = catalog.websites?.entries || [];
        counts = { telegram: tg.length, websites: web.length };

        byRubric = new Map();
        rubricTab = new Map();
        for (const [list, tab] of [[tg, 'telegram'], [web, 'websites']]) {
            for (const e of list) {
                if (!byRubric.has(e.rubric)) byRubric.set(e.rubric, []);
                byRubric.get(e.rubric).push(e);
                rubricTab.set(e.rubric, tab);
            }
        }
        for (const list of byRubric.values()) list.sort((a, b) => b.score - a.score);
        console.log(`recommendations: ${tg.length} telegram + ${web.length} websites `
            + `across ${byRubric.size} rubrics`);
    } catch (err) {
        catalog = null;
        console.error(`recommendations: catalog unavailable — ${err.message}`);
    }
}
load();

const getLang = (req) => (req.params.lang === 'ru' ? 'ru' : (req.session?.lang || 'en'));

/**
 * Order entries so a reader sees their own language first — without hiding
 * anything.
 *
 * An earlier version filtered instead of sorted, and that was wrong twice over:
 * it hid useful Russian-language sites whose language field was undetected, and
 * it made a reader click to discover the catalog was bigger than it looked. All
 * languages are always present; only the order changes.
 *
 * Persian and Arabic sort to the very bottom. They are 21% and 4% of the corpus
 * against an audience where Iran is roughly 0.1% of users, so for a Russian- or
 * English-speaking reader they are the least likely to be useful — but they stay
 * on the page, and the language facet jumps straight to them.
 */
const DEMOTED_LANGUAGES = new Set(['fa', 'ar']);

function languageTier(entryLang, readerLang) {
    if (entryLang === readerLang) return 0;
    if (DEMOTED_LANGUAGES.has(entryLang)) return 2;
    return 1;
}

/**
 * Reader's language first, everything else next, Persian/Arabic last; within
 * each tier the existing relevance score decides.
 */
function orderForReader(entries, readerLang) {
    return entries.slice().sort((a, b) => {
        const ta = languageTier(a.language, readerLang);
        const tb = languageTier(b.language, readerLang);
        if (ta !== tb) return ta - tb;
        return (b.score || 0) - (a.score || 0);
    });
}

function headerLocals(req, res) {
    const usernameCurrent = req.session?.username || null;
    const profilePictureCurrent = res.locals.profilePicture || req.session?.profilePicture || null;
    return {
        username: usernameCurrent,
        userId: req.session?.userId || null,
        profilePicture: profilePictureCurrent,
        usernameCurrent,
        profilePictureCurrent,
    };
}

/** Authority bar, in the spirit of the score bars in the original PageRank paper. */
function bar(value, max, segments = 10) {
    if (!max) return 0;
    return Math.max(1, Math.min(segments, Math.round((value / max) * segments)));
}

function base(req, res) {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    // `label` renders facet values in the reader's language; templates must never
    // print a raw enum like `exam_prep` or `fa`.
    return { __: i18n.__, lang, counts, label, ...headerLocals(req, res) };
}

/** Landing for one corpus. Core rubrics up front; adjacent ones listed below. */
function renderLanding(req, res, tab) {
    if (!catalog) return res.status(503).render('404', { ...base(req, res), pageUrl: req.originalUrl });
    const rubrics = (catalog.rubrics || [])
        .filter((r) => (rubricTab.get(r.id) || 'telegram') === tab && byRubric.get(r.id)?.length)
        // The grid is the page. Show enough of each rubric that a reader can pick a
        // link without clicking through — four names read as a teaser, twelve read
        // as a directory.
        .map((r) => {
            const all = byRubric.get(r.id) || [];
            const pool = orderForReader(all, getLang(req));
            // The front page is a shop window: it shows only entries the reader can
            // actually read. Persian and Arabic stay in the catalog and remain fully
            // browsable inside the rubric — they just never occupy one of the twenty
            // preview slots a Russian or English reader sees first.
            const shown = pool.filter((e) => !DEMOTED_LANGUAGES.has(e.language));
            return { ...r, entries: (shown.length ? shown : pool).slice(0, 20), count: all.length };
        });
    res.render('recommendations/index', {
        ...base(req, res),
        tab,
        core: rubrics.filter((r) => r.class === 'core'),
        adjacent: rubrics.filter((r) => r.class !== 'core'),
        generated: catalog.generated,
    });
}

// Websites open first: they carry the strongest measured demand on this site —
// problem archives and textbook solutions — and unlike Telegram they need no app.
router.get('/', (req, res) => renderLanding(req, res, 'websites'));
router.get('/channels', (req, res) => renderLanding(req, res, 'telegram'));
router.get('/sites', (req, res) => res.redirect(301, `/${getLang(req)}/recommendations`));

router.get('/methodology', (req, res) => {
    res.render('recommendations/methodology', {
        ...base(req, res),
        tab: 'telegram',
        diagnostics: catalog?.diagnostics || null,
        generated: catalog?.generated || null,
    });
});

router.get('/:rubric', (req, res) => {
    if (!catalog) return res.status(503).render('404', { ...base(req, res), pageUrl: req.originalUrl });
    const meta = (catalog.rubrics || []).find((r) => r.id === req.params.rubric);
    const all = byRubric.get(req.params.rubric) || [];
    if (!meta || !all.length) {
        return res.status(404).render('404', { ...base(req, res), pageUrl: req.originalUrl });
    }

    // Facets filter; they never re-sort. The default order already encodes who
    // the catalog is for.
    const { lang: langFilter, level, format } = req.query;
    let entries = langFilter && langFilter !== 'all'
        ? all.filter((e) => e.language === langFilter)
        : orderForReader(all, getLang(req));
    if (level) entries = entries.filter((e) => e.level === level);
    if (format) entries = entries.filter((e) => e.format === format);

    const maxRefs = Math.max(1, ...entries.map((e) => e.inRefs || 0));
    const facetCounts = (key) => {
        const m = new Map();
        for (const e of all) if (e[key]) m.set(e[key], (m.get(e[key]) || 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };

    res.render('recommendations/rubric', {
        ...base(req, res),
        tab: rubricTab.get(req.params.rubric) || 'telegram',
        rubric: meta,
        entries: entries.map((e) => ({ ...e, bar: bar(e.inRefs || 0, maxRefs) })),
        totalInRubric: all.length,
        facets: { languages: facetCounts('language'), levels: facetCounts('level'), formats: facetCounts('format') },
        active: { lang: langFilter || '', level: level || '', format: format || '' },
    });
});

module.exports = router;
module.exports.reload = load;
module.exports.getCatalog = () => catalog;
