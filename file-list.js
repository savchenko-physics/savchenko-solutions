const fs = require("fs");
const path = require("path");

function renderFileList(req, res) {
    const enDirectoryPath = path.join(__dirname, "posts-old", "en");
    const ruDirectoryPath = path.join(__dirname, "posts-old", "ru");

    // Helper function to process files from a given directory and language
    const processFiles = (directoryPath, language) => {
        const files = fs.readdirSync(directoryPath);
        return files.map((file) => {
            const parts = file.split("_");
            const version = parts[0] || "N/A";
            const ipAddress = (parts[2] && parts[2].replace(".md", "").replace(/-/g, ".")) || "Unknown IP";

            const filePath = path.join(directoryPath, file);
            const stats = fs.statSync(filePath);

            return {
                name: file,
                version,
                ipAddress,
                size: stats.size, // File size in bytes
                // A moment: the template writes its date and time in the reader's time zone.
                modified: stats.mtime,
                language, // Include the language in the file details
            };
        });
    };

    // Combine file details from both directories
    const enFiles = processFiles(enDirectoryPath, "English");
    const ruFiles = processFiles(ruDirectoryPath, "Russian");
    const fileDetails = [...enFiles, ...ruFiles];

    // Newest first. (The old sort compared "MM/DD/YYYY" strings, which put December 2025 above
    // January 2026.)
    fileDetails.sort((a, b) => b.modified - a.modified);

    // Render the details in the EJS template
    res.render("file_list", { fileDetails });
}

module.exports = renderFileList; 