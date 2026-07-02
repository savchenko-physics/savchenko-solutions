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

async function getUnsolvedProblems(lang = 'en') {
    const { chapters } = await getLanguageData(lang);
    const postsDir = path.join(__dirname, 'posts', lang);
    const otherLang = lang === 'en' ? 'ru' : 'en';
    const otherPostsDir = path.join(__dirname, 'posts', otherLang);

    const existingProblems = new Set();
    const otherLangProblems = new Set();
    const unsolvedProblems = [];

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

                if (!existingProblems.has(problemName)) {
                    unsolvedProblems.push({
                        problem: problemName,
                        chapter: chapter.title,
                        section: section.title,
                        chapterNum,
                        sectionNum,
                        problemNum,
                        maximum: section.maximum,
                        existsInOtherLang: otherLangProblems.has(problemName)
                    });
                }
            }
        });
    });

    return {
        unsolvedProblems,
        allSolvedProblems,
        currentLangSolutions: existingProblems.size,
        otherLangSolutions: otherLangProblems.size,
        totalUniqueSolutions: allSolvedProblems.size
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

        // Filter to only unsolved problems and take top N
        const mostWanted = [];
        for (const row of result.rows) {
            if (!allSolvedProblems.has(row.problem_name) && /^\d+\.\d+\.\d+$/.test(row.problem_name)) {
                mostWanted.push({
                    problem_name: row.problem_name,
                    total_views: parseInt(row.total_views, 10)
                });
                if (mostWanted.length >= limit) break;
            }
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
    const solvedProblems = Math.max(0, totalProblems - unsolved.length);
    return {
        unsolved,
        chapters: langData.chapters,
        allSolvedProblems: unsolvedData.allSolvedProblems,
        totalProblems,
        solvedProblems,
        currentLangSolutions: unsolvedData.currentLangSolutions,
        otherLangSolutions: unsolvedData.otherLangSolutions,
        totalUniqueSolutions: unsolvedData.totalUniqueSolutions
    };
}

/** Progress fields only (no unsolved array reference in the returned object). */
async function getSolutionProgressStats(lang) {
    const { unsolved, chapters, allSolvedProblems, ...stats } = await loadUnsolvedPagePayload(lang);
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
        const { unsolved, chapters, allSolvedProblems, ...stats } = payload;

        // Sort problems by chapter, section, and problem number
        unsolved.sort((a, b) => {
            if (a.chapterNum !== b.chapterNum) return a.chapterNum - b.chapterNum;
            if (a.sectionNum !== b.sectionNum) return a.sectionNum - b.sectionNum;
            return a.problemNum - b.problemNum;
        });

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
            chapterData,
            mostWanted: mostWantedEnriched,
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
