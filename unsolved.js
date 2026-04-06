const path = require('path');
const fs = require('fs');
const { getLanguageData } = require('./parents');
const i18n = require('i18n');

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
        currentLangSolutions: existingProblems.size,
        otherLangSolutions: otherLangProblems.size,
        totalUniqueSolutions: new Set([...existingProblems, ...otherLangProblems]).size
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
        totalProblems,
        solvedProblems,
        currentLangSolutions: unsolvedData.currentLangSolutions,
        otherLangSolutions: unsolvedData.otherLangSolutions,
        totalUniqueSolutions: unsolvedData.totalUniqueSolutions
    };
}

/** Progress fields only (no unsolved array reference in the returned object). */
async function getSolutionProgressStats(lang) {
    const { unsolved, ...stats } = await loadUnsolvedPagePayload(lang);
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
        const { unsolved, ...stats } = payload;

        // Sort problems by chapter, section, and problem number
        unsolved.sort((a, b) => {
            if (a.chapterNum !== b.chapterNum) return a.chapterNum - b.chapterNum;
            if (a.sectionNum !== b.sectionNum) return a.sectionNum - b.sectionNum;
            return a.problemNum - b.problemNum;
        });

        res.render('unsolved', {
            unsolved,
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
