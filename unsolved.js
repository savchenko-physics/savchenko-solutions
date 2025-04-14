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

        // Get unsolved problems and language data
        const { 
            unsolvedProblems: unsolved, 
            currentLangSolutions,
            otherLangSolutions,
            totalUniqueSolutions 
        } = await getUnsolvedProblems(lang);
        const { chapters } = await getLanguageData(lang);

        // Calculate total problems and solved count
        let totalProblems = 0;
        chapters.forEach(chapter => {
            chapter.sections.forEach(section => {
                totalProblems += parseInt(section.maximum) || 0;
            });
        });
        const solvedProblems = Math.max(0, totalProblems - unsolved.length);
        
        // Sort problems by chapter, section, and problem number
        unsolved.sort((a, b) => {
            if (a.chapterNum !== b.chapterNum) return a.chapterNum - b.chapterNum;
            if (a.sectionNum !== b.sectionNum) return a.sectionNum - b.sectionNum;
            return a.problemNum - b.problemNum;
        });

        // Render the page
        res.render('unsolved', {
            unsolved,
            lang,
            __: i18n.__,
            title: i18n.__('unsolved.title'),
            totalProblems,
            solvedProblems,
            currentLangSolutions,
            otherLangSolutions,
            totalUniqueSolutions
        });
    } catch (error) {
        console.error('Error rendering unsolved problems:', error);
        res.status(500).send('Error loading unsolved problems');
    }
}

module.exports = renderUnsolvedList;
