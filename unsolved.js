const path = require('path');
const fs = require('fs');
const { getLanguageData } = require('./parents');

async function getUnsolvedProblems(lang = 'en') {
    const { chapters } = await getLanguageData(lang);
    const postsDir = path.join(__dirname, 'posts', lang);
    const existingProblems = new Set();
    const unsolvedProblems = [];

    // Get list of existing problems
    if (fs.existsSync(postsDir)) {
        fs.readdirSync(postsDir).forEach(file => {
            if (file.endsWith('.md')) {
                existingProblems.add(file.replace('.md', ''));
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
                        maximum: section.maximum
                    });
                }
            }
        });
    });

    return unsolvedProblems;
}

// Express route handler
async function renderUnsolvedList(req, res) {
    try {
        const lang = req.params.lang || 'en';
        const unsolved = await getUnsolvedProblems(lang);
        
        // Calculate total statistics
        const { chapters } = await getLanguageData(lang);
        let totalProblems = 0;
        
        // Calculate total problems by summing maximums from each section
        chapters.forEach(chapter => {
            chapter.sections.forEach(section => {
                // Ensure we're working with valid numbers
                const maximum = parseInt(section.maximum) || 0;
                totalProblems += maximum;
            });
        });
        
        const solvedProblems = Math.max(0, totalProblems - unsolved.length);
        console.log(solvedProblems);
        
        // Sort problems by chapter, section, and problem number
        unsolved.sort((a, b) => {
            if (a.chapterNum !== b.chapterNum) return a.chapterNum - b.chapterNum;
            if (a.sectionNum !== b.sectionNum) return a.sectionNum - b.sectionNum;
            return a.problemNum - b.problemNum;
        });

        res.render('unsolved', {
            unsolved,
            lang,
            title: lang === 'ru' ? 'Нерешенные задачи' : 'Unsolved Problems',
            totalProblems,
            solvedProblems
        });
    } catch (error) {
        console.error('Error rendering unsolved problems:', error);
        res.status(500).send('Error loading unsolved problems');
    }
}

module.exports = renderUnsolvedList;
