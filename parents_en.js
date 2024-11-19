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

// Function to get markdown files sorted numerically
function existedFolders(directory) {
    const files = fs
        .readdirSync(directory) // Get all files in the directory
        .filter((f) => {
            const fullPath = path.join(directory, f);
            return fs.statSync(fullPath).isFile() && f.endsWith(".md"); // Filter only markdown files
        })
        .map((file) => file.replace(".md", "")); // Remove .md extension

    const sortedFiles = sortFilesNumerically(files);

    return sortedFiles;
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
async function getPageData() {
    const baseDir = __dirname;
    const postsDir = path.join(baseDir, "posts", "en");

    if (!fs.existsSync(postsDir)) {
        throw new Error("Posts directory does not exist: " + postsDir);
    }

    const chaptersCSV = "src/database/chapters.csv";
    const sectionsCSV = "src/database/sections.csv";

    // Read chapters and theory from CSV
    const chapters = readCSV(chaptersCSV, 1);
    const theory = readCSV(chaptersCSV, 2);

    // Read section titles and numbers
    const sectionNumbers = readCSV(sectionsCSV, 0);
    const sectionTitles = readCSV(sectionsCSV, 1);

    // Get sorted markdown files (problems)
    const markdownFiles = existedFolders(postsDir);

    // Generate sections data
    const sections = sectionNumbers.map((num, index) => {
        const sectionProblems = markdownFiles.filter((file) => file.startsWith(`${num}.`));
        if (sectionProblems.length === 0) return null; // Exclude empty sections

        return {
            number: num,
            title: sectionTitles[index],
            problems: distributeProblems(sectionProblems).filter((col) => col.length > 0), // Exclude empty columns
        };
    }).filter(Boolean); // Remove null values

    // Group sections under chapters
    const groupedSections = chapters.map((chapter, chapterIndex) => {
        const chapterSections = sections.filter((section) =>
            section.number.startsWith(`${chapterIndex + 1}.`)
        );
        if (chapterSections.length === 0) return null; // Exclude empty chapters

        return {
            title: chapter,
            theory: theory[chapterIndex] ? theory[chapterIndex] : null, // Set theory to null if not available
            sections: chapterSections,
        };
    }).filter(Boolean); // Remove null values

    // Create pinned chapters for the sidebar
    const pinnedChapters = groupedSections.map((chapter) => chapter.title);
    console.log(sections)

    return {
        chapters: groupedSections,
        pinnedChapters,
    };
}



// Helper function to read CSV files and extract a specific column
function readCSV(filePath, column) {
    const csvData = fs.readFileSync(filePath, "utf8");
    return csvData
        .trim()
        .split("\n")
        .map((line) => line.split(",")[column].trim());
}

module.exports = {
    getPageData,
};
