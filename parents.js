const fs = require("fs");
const path = require("path");

// Helper function to split a filename into numeric parts
function splitNumbers(inputString) {
    return inputString.split(".").map(Number);
}

// Helper function to sort files numerically by their parts
function sortFilesNumerically(files) {
    return files.sort((a, b) => {
        const aParts = splitNumbers(a);
        const bParts = splitNumbers(b);

        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
            const aNum = aParts[i] || 0; // Default to 0 if part doesn't exist
            const bNum = bParts[i] || 0;

            if (aNum !== bNum) {
                return aNum - bNum;
            }
        }
        return 0;
    });
}

function isValidMarkdownFile(fileName, sections) {
    // Split the filename into parts based on the expected format
    const parts = fileName.replace(".md", "").split(".");

    // Ensure there are exactly three numeric parts
    if (parts.length !== 3 || parts.some((part) => isNaN(Number(part)))) {
        return false;
    }

    const [chapter, section] = parts.map(Number);

    // Check if the chapter.section exists in the `sections` data
    const chapterSection = `${chapter}.${section}`;

    return sections.some((sec) => sec.number === chapterSection);
}


// Function to get markdown files sorted numerically
function existedFolders(directory, sections) {
    const files = fs
        .readdirSync(directory) // Get all files in the directory
        .filter((f) => {
            const fullPath = path.join(directory, f);
            return (
                fs.statSync(fullPath).isFile() &&
                f.endsWith(".md") &&
                isValidMarkdownFile(f, sections) // Validate filename
            );
        });
    if (!Array.isArray(files)) {
        throw new Error("Files is not an array. Received: " + typeof files);
    }

    const validFiles = files.map((file) => file.replace(".md", "")); // Remove .md extension

    return sortFilesNumerically(validFiles); // Sort files numerically
}

// Function to distribute problems into columns
function distributeProblems(problems, columns = 3) {
    const columnCounts = Array(columns).fill(Math.floor(problems.length / columns));
    for (let i = 0; i < problems.length % columns; i++) {
        columnCounts[i]++;
    }

    const distributed = [];
    let startIndex = 0;
    for (const count of columnCounts) {
        distributed.push(problems.slice(startIndex, startIndex + count));
        startIndex += count;
    }

    return distributed;
}

// Main function to generate page data
async function getLanguageData(lang = 'en') {
    const chaptersCSV = lang === 'ru' ? "src/ru/database/chapters.csv" : "src/database/chapters.csv"
    const sectionsCSV = lang === 'ru' ? "src/ru/database/sections.csv" : "src/database/sections.csv"

    const baseDir = __dirname;
    const postsDir = path.join(baseDir, "posts", lang);

    if (!fs.existsSync(postsDir)) {
        throw new Error("Posts directory does not exist: " + postsDir);
    }

    // Use the passed CSV paths
    const chapters = readCSV(chaptersCSV, 1);
    const theory = readCSV(chaptersCSV, 2);
    const sectionNumbers = readCSV(sectionsCSV, 0);
    const sectionTitles = readCSV(sectionsCSV, 1);
    const sectionMaximum = readCSV(sectionsCSV, 2); // New column for section maximum

    // Combine sections data
    const sections = sectionNumbers.map((num, index) => ({
        number: num,
        title: sectionTitles[index],
        maximum: sectionMaximum[index], // Include maximum here
    }));

    // Get valid markdown files
    const markdownFiles = existedFolders(postsDir, sections);

    // Generate sections data
    const sectionsData = sectionNumbers.map((num, index) => {
        const sectionProblems = markdownFiles.filter((file) => file.startsWith(`${num}.`));

        return {
            number: num,
            title: sectionTitles[index],
            maximum: sectionMaximum[index], // Include maximum here
            problems: distributeProblems(sectionProblems), // Can be empty
        };
    });


    // Group sections under chapters
    const groupedSections = chapters.map((chapter, chapterIndex) => {
        const chapterSections = sectionsData.filter((section) =>
            section.number.startsWith(`${chapterIndex + 1}.`)
        );

        return {
            title: chapter,
            theory: theory[chapterIndex] || null,
            sections: chapterSections.length > 0 ? chapterSections : [], // Include empty sections
        };
    });


    // Create pinned chapters for the sidebar
    const pinnedChapters = groupedSections.map((chapter) => chapter.title);

    return {
        chapters: groupedSections,
        pinnedChapters,
    };
}


async function getBothLanguages() {
    const languages = ['en', 'ru'];
    const results = {};

    for (const lang of languages) {
        const chaptersCSV = lang === 'ru' ? "src/ru/database/chapters.csv" : "src/database/chapters.csv";
        const sectionsCSV = lang === 'ru' ? "src/ru/database/sections.csv" : "src/database/sections.csv";

        const baseDir = __dirname;
        const postsDir = path.join(baseDir, "posts", lang);

        if (!fs.existsSync(postsDir)) {
            throw new Error("Posts directory does not exist: " + postsDir);
        }

        // Use the passed CSV paths
        const chapters = readCSV(chaptersCSV, 1);
        const theory = readCSV(chaptersCSV, 2);
        const sectionNumbers = readCSV(sectionsCSV, 0);
        const sectionTitles = readCSV(sectionsCSV, 1);
        const sectionMaximum = readCSV(sectionsCSV, 2); // New column for section maximum

        // Combine sections data
        const sections = sectionNumbers.map((num, index) => ({
            number: num,
            title: sectionTitles[index],
            maximum: sectionMaximum[index], // Include maximum here
        }));

        // Get valid markdown files
        const markdownFiles = existedFolders(postsDir, sections);

        // Generate sections data
        const sectionsData = sectionNumbers.map((num, index) => {
            const sectionProblems = markdownFiles.filter((file) => file.startsWith(`${num}.`));

            console.log(file);
            
            return {
                number: num,
                title: sectionTitles[index],
                maximum: sectionMaximum[index], // Include maximum here
                problems: distributeProblems(sectionProblems), // Can be empty
            };
        });

        // Group sections under chapters
        const groupedSections = chapters.map((chapter, chapterIndex) => {
            const chapterSections = sectionsData.filter((section) =>
                section.number.startsWith(`${chapterIndex + 1}.`)
            );

            return {
                title: chapter,
                theory: theory[chapterIndex] || null,
                sections: chapterSections.length > 0 ? chapterSections : [], // Include empty sections
            };
        });

        // Create pinned chapters for the sidebar
        const pinnedChapters = groupedSections.map((chapter) => chapter.title);

        results[lang] = {
            chapters: groupedSections,
            pinnedChapters,
        };
    }

    // console.log(results);

    return results;
}


// Helper function to read CSV files and extract a specific column
function readCSV(filePath, column) {
    const csvData = fs.readFileSync(filePath, "utf8");
    return csvData
        .trim()
        .split("\n")
        .map((line) => line.split(",")[column].trim());
}

/**
 * Chapter / section titles and anchor ids for breadcrumb links on problem pages.
 */
function getProblemBreadcrumbParts(name, lang) {
    const parts = name.split(".");
    if (parts.length !== 3 || parts.some((p) => isNaN(Number(p)))) {
        return null;
    }

    const sectionRef = `${parts[0]}.${parts[1]}`;
    const chapterNum = parts[0];
    const chapterIdx = parseInt(parts[0], 10) - 1;

    const chaptersCSV = path.join(
        __dirname,
        lang === "ru" ? "src/ru/database/chapters.csv" : "src/database/chapters.csv"
    );
    const sectionsCSV = path.join(
        __dirname,
        lang === "ru" ? "src/ru/database/sections.csv" : "src/database/sections.csv"
    );

    if (!fs.existsSync(chaptersCSV) || !fs.existsSync(sectionsCSV)) {
        return null;
    }

    const chapterTitles = readCSV(chaptersCSV, 1);
    const sectionNumbers = readCSV(sectionsCSV, 0);
    const sectionTitles = readCSV(sectionsCSV, 1);

    const chapterTitle = chapterTitles[chapterIdx];
    const secIdx = sectionNumbers.findIndex((n) => n === sectionRef);
    if (chapterTitle == null || chapterTitle === undefined || secIdx === -1) {
        return null;
    }

    const sectionTitle = sectionTitles[secIdx];
    const problemLabel =
        lang === "ru" ? `Задача ${name}` : `Problem ${name}`;

    const chapterHref =
        lang === "ru" ? `/${lang}/${chapterNum}` : `../#${chapterNum}`;
    const sectionHref =
        lang === "ru"
            ? `/${lang}/${sectionRef.replace(/\./g, ",")}`
            : `../#${sectionRef}`;

    return {
        chapterNum,
        chapterTitle,
        sectionRef,
        sectionTitle,
        problemLabel,
        chapterHref,
        sectionHref,
    };
}

/**
 * Breadcrumb title for a problem page, e.g.
 * "Kinematics > Motion in gravity field. Curvilinear motion > Problem 1.3.18" (en)
 * "Кинематика > ... > Задача 1.3.18" (ru)
 */
function getProblemBreadcrumbTitle(name, lang) {
    const p = getProblemBreadcrumbParts(name, lang);
    if (!p) return null;
    return `${p.chapterTitle} > ${p.sectionTitle} > ${p.problemLabel}`;
}

/**
 * Compute previous and next problem names for navigation.
 * Crosses section and chapter boundaries.
 */
function getPrevNextProblems(name, lang) {
    const parts = name.split(".");
    if (parts.length !== 3 || parts.some((p) => isNaN(Number(p)))) {
        return { prev: null, next: null };
    }

    const problemNum = parseInt(parts[2], 10);
    const sectionRef = `${parts[0]}.${parts[1]}`;

    const sectionsCSV = path.join(
        __dirname,
        lang === "ru" ? "src/ru/database/sections.csv" : "src/database/sections.csv"
    );

    if (!fs.existsSync(sectionsCSV)) {
        return { prev: null, next: null };
    }

    const sectionNumbers = readCSV(sectionsCSV, 0);
    const sectionMaximums = readCSV(sectionsCSV, 2);

    const currentIdx = sectionNumbers.findIndex((n) => n === sectionRef);
    if (currentIdx === -1) return { prev: null, next: null };

    const currentMax = parseInt(sectionMaximums[currentIdx], 10);

    let prev = null;
    let next = null;

    if (problemNum > 1) {
        prev = `${sectionRef}.${problemNum - 1}`;
    } else if (currentIdx > 0) {
        const prevSection = sectionNumbers[currentIdx - 1];
        const prevMax = parseInt(sectionMaximums[currentIdx - 1], 10);
        prev = `${prevSection}.${prevMax}`;
    }

    if (problemNum < currentMax) {
        next = `${sectionRef}.${problemNum + 1}`;
    } else if (currentIdx < sectionNumbers.length - 1) {
        const nextSection = sectionNumbers[currentIdx + 1];
        next = `${nextSection}.1`;
    }

    return { prev, next };
}

/**
 * Build the problem number grid for the current section.
 * Returns { sectionRef, sectionTitle, problems: [{name, solved, current}] }
 */
function getSectionProblemsGrid(name, lang) {
    const parts = name.split(".");
    if (parts.length !== 3 || parts.some((p) => isNaN(Number(p)))) {
        return null;
    }

    const sectionRef = `${parts[0]}.${parts[1]}`;

    const sectionsCSV = path.join(
        __dirname,
        lang === "ru" ? "src/ru/database/sections.csv" : "src/database/sections.csv"
    );

    if (!fs.existsSync(sectionsCSV)) return null;

    const sectionNumbers = readCSV(sectionsCSV, 0);
    const sectionTitles = readCSV(sectionsCSV, 1);
    const sectionMaximums = readCSV(sectionsCSV, 2);

    const idx = sectionNumbers.findIndex((n) => n === sectionRef);
    if (idx === -1) return null;

    const max = parseInt(sectionMaximums[idx], 10);
    const postsDir = path.join(__dirname, "posts", lang);
    const otherLang = lang === 'en' ? 'ru' : 'en';
    const otherSolvedSet = getSolvedSet(otherLang);

    const problems = [];
    for (let i = 1; i <= max; i++) {
        const problemName = `${sectionRef}.${i}`;
        const filePath = path.join(postsDir, `${problemName}.md`);
        const solved = fs.existsSync(filePath);
        const solvedOther = otherSolvedSet.has(problemName);
        problems.push({
            name: problemName,
            solved,
            solvedOther,
            current: problemName === name,
        });
    }

    function findFirstSolvedInSection(sIdx) {
        const sMax = parseInt(sectionMaximums[sIdx], 10);
        for (let i = 1; i <= sMax; i++) {
            const pName = `${sectionNumbers[sIdx]}.${i}`;
            if (fs.existsSync(path.join(postsDir, `${pName}.md`))) {
                return pName;
            }
        }
        return null;
    }

    let prevSection = null;
    for (let i = idx - 1; i >= 0; i--) {
        const firstProblem = findFirstSolvedInSection(i);
        if (firstProblem) {
            prevSection = {
                ref: sectionNumbers[i],
                title: sectionTitles[i],
                firstProblem,
            };
            break;
        }
    }

    let nextSection = null;
    for (let i = idx + 1; i < sectionNumbers.length; i++) {
        const firstProblem = findFirstSolvedInSection(i);
        if (firstProblem) {
            nextSection = {
                ref: sectionNumbers[i],
                title: sectionTitles[i],
                firstProblem,
            };
            break;
        }
    }

    return {
        sectionRef,
        sectionTitle: sectionTitles[idx],
        problems,
        prevSection,
        nextSection,
    };
}

function getRelatedProblems(name, lang, count = 5) {
    const parts = name.split(".");
    if (parts.length !== 3 || parts.some((p) => isNaN(Number(p)))) {
        return [];
    }

    const chapterNum = parts[0];
    const currentSection = `${parts[0]}.${parts[1]}`;

    const sectionsCSV = path.join(
        __dirname,
        lang === "ru" ? "src/ru/database/sections.csv" : "src/database/sections.csv"
    );

    if (!fs.existsSync(sectionsCSV)) return [];

    const sectionNumbers = readCSV(sectionsCSV, 0);
    const sectionTitles = readCSV(sectionsCSV, 1);
    const sectionMaximums = readCSV(sectionsCSV, 2);

    const postsDir = path.join(__dirname, "posts", lang);
    const candidates = [];

    for (let i = 0; i < sectionNumbers.length; i++) {
        const secNum = sectionNumbers[i];
        if (!secNum.startsWith(`${chapterNum}.`)) continue;
        if (secNum === currentSection) continue;

        const max = parseInt(sectionMaximums[i], 10);
        for (let p = 1; p <= max; p++) {
            const problemName = `${secNum}.${p}`;
            if (fs.existsSync(path.join(postsDir, `${problemName}.md`))) {
                candidates.push({
                    name: problemName,
                    sectionRef: secNum,
                    sectionTitle: sectionTitles[i],
                });
            }
        }
    }

    for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    return candidates.slice(0, count);
}

function getSolvedSet(lang) {
    const postsDir = path.join(__dirname, 'posts', lang);
    if (!fs.existsSync(postsDir)) return new Set();
    const result = new Set();
    try {
        for (const file of fs.readdirSync(postsDir)) {
            if (file.endsWith('.md')) result.add(file.slice(0, -3));
        }
    } catch (e) {}
    return result;
}

module.exports = {
    getLanguageData,
    getBothLanguages,
    getProblemBreadcrumbTitle,
    getProblemBreadcrumbParts,
    getPrevNextProblems,
    getSectionProblemsGrid,
    getRelatedProblems,
    readCSV,
    getSolvedSet,
};
