// Import the 'fs' module to handle file operations
const fs = require('fs');
const path = require('path');

function readCSV(filePath, column) {
    const csvData = fs.readFileSync(filePath, 'utf8');
    
    const lines = csvData.trim().split('\n');
    const chapterNames = [];

    for (let i = 0; i < lines.length; i++) {
        const columns = lines[i].split(',');
        chapterNames.push(columns[column].trim());
    }

    return chapterNames;
}

// Example usage
const chapters = getChapterNames('src/database/sections.csv', 1);
console.log(chapters);


const theory = getChapterNames('src/database/chapters.csv', 2);
console.log(theory);