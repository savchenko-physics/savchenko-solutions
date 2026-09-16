const path = require('path');
const fs = require('fs');
const { getLanguageData } = require('./parents');
const i18n = require('i18n');
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

// Same 1-9 difficulty bucket the homepage heatmap uses (index.js getDifficultyGrid),
// keyed per problem so the unsolved chips can be coloured on the same YlOrRd scale.
// `calibrated` is 0-100; bucket = ceil(calibrated/100 * 9), clamped to 1-9. `starred`
// is Savchenko's own ∗ marker. Cached 10 min — this page is far cooler than the homepage
// but there is no reason to re-run the 2k-row scan on every hit.
let _diffByProblemCache = { at: 0, value: null };
async function getDifficultyByProblem() {
    if (_diffByProblemCache.value && Date.now() - _diffByProblemCache.at < 10 * 60 * 1000) {
        return _diffByProblemCache.value;
    }
    const map = new Map();
    try {
        const { rows } = await pool.query(
            `SELECT problem_name, calibrated, starred FROM problem_difficulty WHERE calibrated IS NOT NULL`
        );
        for (const r of rows) {
            const bucket = Math.min(9, Math.max(1, Math.ceil((r.calibrated / 100) * 9) || 1));
            map.set(r.problem_name, { bucket, starred: !!r.starred });
        }
    } catch (err) {
        // A missing table must not take the unsolved page down.
        if (err.code !== '42P01') console.error('difficulty by problem:', err.message);
    }
    _diffByProblemCache = { at: Date.now(), value: map };
    return map;
}

// A problem is unsolved when nobody has written it up in *any* language. A problem that
// exists only in Russian is not unsolved on /en/unsolved — /en/8.2.1 redirects to the
// Russian solution (post.js) — it is waiting for a translation, and it is counted and
// listed apart. Until 2026-09-16 both were pushed onto one list called "unsolved", so the
// page's own headline said 23 above a grid of 1,114 chips.
async function getUnsolvedProblems(lang = 'en') {
    const { chapters } = await getLanguageData(lang);
    const postsDir = path.join(__dirname, 'posts', lang);
    const otherLang = lang === 'en' ? 'ru' : 'en';
    const otherPostsDir = path.join(__dirname, 'posts', otherLang);

    const existingProblems = new Set();
    const otherLangProblems = new Set();
    const unsolvedProblems = [];
    const untranslatedProblems = [];

    // Get list of existing problems in current language
    if (fs.existsSync(postsDir)) {
        fs.readdirSync(postsDir).forEach(file => {
            if (file.endsWith('.md')) {
                existingProblems.add(file.replace('.md', ''));
            }
        });
    }

    // Get list of problems in other language
    if (fs.existsSync(otherPostsDir)) {
        fs.readdirSync(otherPostsDir).forEach(file => {
            if (file.endsWith('.md')) {
                otherLangProblems.add(file.replace('.md', ''));
            }
        });
    }

    // Build a set of all solved problems (in either language)
    const allSolvedProblems = new Set([...existingProblems, ...otherLangProblems]);

    // Check each chapter and section for missing problems
    chapters.forEach((chapter, chapterIndex) => {
        const chapterNum = chapterIndex + 1;

        chapter.sections.forEach((section, sectionIndex) => {
            const sectionNum = sectionIndex + 1;

            // Check each possible problem number up to the maximum
            for (let problemNum = 1; problemNum <= section.maximum; problemNum++) {
                const problemName = `${chapterNum}.${sectionNum}.${problemNum}`;

                if (existingProblems.has(problemName)) continue;

                const entry = {
                    problem: problemName,
                    chapter: chapter.title,
                    section: section.title,
                    chapterNum,
                    sectionNum,
                    problemNum,
                    maximum: section.maximum
                };
                if (otherLangProblems.has(problemName)) {
                    untranslatedProblems.push(entry);
                } else {
                    unsolvedProblems.push(entry);
                }
            }
        });
    });

    return {
        unsolvedProblems,
        untranslatedProblems,
        allSolvedProblems,
        currentLangSolutions: existingProblems.size,
        otherLangSolutions: otherLangProblems.size
    };
}

function computeTotalProblems(chapters) {
    let totalProblems = 0;
    chapters.forEach(chapter => {
        chapter.sections.forEach(section => {
            totalProblems += parseInt(section.maximum, 10) || 0;
        });
    });
    return totalProblems;
}

/**
 * Query page_views for the top N most-viewed unsolved problems.
 * Returns an array of { problem_name, total_views }.
 */
async function getMostWantedProblems(allSolvedProblems, limit = 10) {
    try {
        const result = await pool.query(`
            SELECT problem_name, SUM(views) AS total_views
            FROM (
                SELECT problem_name, views FROM page_views
                UNION ALL
                SELECT problem_name, views FROM page_views_old
            ) combined
            GROUP BY problem_name
            ORDER BY total_views DESC
        `);

        // Filter to only unsolved problems and take top N.
        // page_views contains legacy zero-padded names ("04.1.3") alongside the canonical
        // form ("4.1.3"), so compare on a normalised key — otherwise a solved problem
        // reappears in the most-wanted list under its padded alias.
        const canonical = (n) => n.split('.').map((part) => String(parseInt(part, 10))).join('.');
        const mostWanted = [];
        const seen = new Set();
        for (const row of result.rows) {
            if (!/^\d+\.\d+\.\d+$/.test(row.problem_name)) continue;
            const key = canonical(row.problem_name);
            if (allSolvedProblems.has(key) || allSolvedProblems.has(row.problem_name)) continue;
            if (seen.has(key)) continue;
            seen.add(key);
            mostWanted.push({ problem_name: key, total_views: parseInt(row.total_views, 10) });
            if (mostWanted.length >= limit) break;
        }
        return mostWanted;
    } catch (err) {
        console.error('Error fetching most wanted problems:', err);
        return [];
    }
}

/**
 * Single pass: same filesystem + chapter metadata as /:lang/unsolved.
 * Used by the unsolved page (sorts `unsolved` in place) and by the homepage stats card.
 */
async function loadUnsolvedPagePayload(lang) {
    const [langData, unsolvedData] = await Promise.all([
        getLanguageData(lang),
        getUnsolvedProblems(lang)
    ]);
    const totalProblems = computeTotalProblems(langData.chapters);
    const unsolved = unsolvedData.unsolvedProblems;
    const untranslated = unsolvedData.untranslatedProblems;
    // Solved = written up in either language, the same set the homepage counts as
    // totalUniqueSolutions. One source, so the headline and the list cannot disagree.
    const solvedProblems = Math.max(0, totalProblems - unsolved.length);
    return {
        unsolved,
        untranslated,
        chapters: langData.chapters,
        allSolvedProblems: unsolvedData.allSolvedProblems,
        totalProblems,
        solvedProblems,
        currentLangSolutions: unsolvedData.currentLangSolutions,
        otherLangSolutions: unsolvedData.otherLangSolutions,
        // The homepage's "N solutions" and this page's "N unsolved" are the two halves of
        // one count, so they are read off one number. Counting the files instead would
        // drift the moment posts/ held a name the book does not have (a legacy "04.1.3"
        // both adds a solution here and leaves 4.1.3 on the unsolved list).
        totalUniqueSolutions: solvedProblems
    };
}

/** Progress fields only (no unsolved array reference in the returned object). */
async function getSolutionProgressStats(lang) {
    const { unsolved, untranslated, chapters, allSolvedProblems, ...stats } = await loadUnsolvedPagePayload(lang);
    return stats;
}

// Express route handler
async function renderUnsolvedList(req, res) {
    try {
        const lang = req.params.lang || 'en';

        // Validate language and redirect if invalid
        if (!['en', 'ru'].includes(lang)) {
            return res.redirect('/unsolved');
        }

        // Set locale for translations
        i18n.setLocale(res, lang);

        const payload = await loadUnsolvedPagePayload(lang);
        const { unsolved, untranslated, chapters, allSolvedProblems, ...stats } = payload;

        // Sort problems by chapter, section, and problem number
        const byNumber = (a, b) => {
            if (a.chapterNum !== b.chapterNum) return a.chapterNum - b.chapterNum;
            if (a.sectionNum !== b.sectionNum) return a.sectionNum - b.sectionNum;
            return a.problemNum - b.problemNum;
        };
        unsolved.sort(byNumber);
        untranslated.sort(byNumber);

        // Attach difficulty so each chip can be coloured on the homepage's heatmap
        // scale. chapterData below reuses these same objects (via .filter), so
        // enriching here is enough for the sections too.
        const diffByProblem = await getDifficultyByProblem();
        const addHeat = (p) => {
            const d = diffByProblem.get(p.problem);
            p.heat = d ? d.bucket : 0;
            p.starred = d ? d.starred : false;
        };
        unsolved.forEach(addHeat);
        untranslated.forEach(addHeat);

        // Build chapter-level aggregation for accordion
        const chapterData = [];
        chapters.forEach((chapter, chapterIndex) => {
            const chapterNum = chapterIndex + 1;
            let chapterSolved = 0;
            let chapterTotal = 0;
            const sections = [];

            chapter.sections.forEach((section, sectionIndex) => {
                const sectionNum = sectionIndex + 1;
                const sectionTotal = parseInt(section.maximum, 10) || 0;
                const sectionUnsolved = unsolved.filter(
                    p => p.chapterNum === chapterNum && p.sectionNum === sectionNum
                );
                const sectionSolved = sectionTotal - sectionUnsolved.length;

                chapterSolved += sectionSolved;
                chapterTotal += sectionTotal;

                if (sectionUnsolved.length > 0) {
                    sections.push({
                        title: section.title,
                        sectionNum,
                        solved: sectionSolved,
                        total: sectionTotal,
                        unsolved: sectionUnsolved
                    });
                }
            });

            if (chapterTotal > 0) {
                chapterData.push({
                    title: chapter.title,
                    chapterNum,
                    solved: chapterSolved,
                    total: chapterTotal,
                    sections
                });
            }
        });

        // The same grouping for the problems that only need translating, kept in its own
        // block so neither list can be mistaken for the other. No progress bars here:
        // a chapter's progress is how much of it is solved, and it is stated once, above.
        const translationChapters = [];
        chapters.forEach((chapter, chapterIndex) => {
            const chapterNum = chapterIndex + 1;
            const sections = [];
            chapter.sections.forEach((section, sectionIndex) => {
                const sectionNum = sectionIndex + 1;
                const problems = untranslated.filter(
                    p => p.chapterNum === chapterNum && p.sectionNum === sectionNum
                );
                if (problems.length > 0) {
                    sections.push({ title: section.title, sectionNum, problems });
                }
            });
            if (sections.length > 0) {
                translationChapters.push({ title: chapter.title, chapterNum, sections });
            }
        });

        // Fetch most wanted problems
        const mostWanted = await getMostWantedProblems(allSolvedProblems, 10);

        // Enrich most wanted with chapter/section context
        const unsolvedMap = new Map();
        unsolved.forEach(p => unsolvedMap.set(p.problem, p));
        const mostWantedEnriched = mostWanted.map(mw => {
            const prob = unsolvedMap.get(mw.problem_name);
            return {
                problem: mw.problem_name,
                views: mw.total_views,
                chapter: prob ? prob.chapter : '',
                section: prob ? prob.section : ''
            };
        }).filter(mw => mw.chapter); // only include problems that match known structure

        res.render('unsolved', {
            unsolved,
            untranslated,
            chapterData,
            translationChapters,
            otherLang: lang === 'en' ? 'ru' : 'en',
            mostWanted: mostWantedEnriched,
            hasDifficulty: diffByProblem.size > 0,
            lang,
            __: i18n.__,
            title: i18n.__('unsolved.title'),
            username: req.session.username || null,
            ...stats
        });
    } catch (error) {
        console.error('Error rendering unsolved problems:', error);
        res.status(500).send('Error loading unsolved problems');
    }
}

renderUnsolvedList.getSolutionProgressStats = getSolutionProgressStats;
module.exports = renderUnsolvedList;
// Also exposed so the homepage can show the same "most wanted" list without duplicating
// the query. "287 people looked for this and it isn't written yet" is a far better
// prompt to a physicist than a generic call to contribute.
module.exports.getMostWantedProblems = getMostWantedProblems;
