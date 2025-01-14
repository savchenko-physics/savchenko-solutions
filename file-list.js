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

            const lastModified = stats.mtime;
            const options = {
                timeZone: "America/New_York",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
            };
            const easternTime = new Intl.DateTimeFormat("en-US", options).format(lastModified);

            // Split the formatted string into date and time
            const [date, time] = easternTime.split(", ");

            return {
                name: file,
                version,
                ipAddress,
                size: stats.size, // File size in bytes
                date, // Date in YYYY-MM-DD format
                time, // Time in HH:MM:SS format
                language, // Include the language in the file details
            };
        });
    };

    // Combine file details from both directories
    const enFiles = processFiles(enDirectoryPath, "English");
    const ruFiles = processFiles(ruDirectoryPath, "Russian");
    const fileDetails = [...enFiles, ...ruFiles];

    fileDetails.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));

    // Render the details in the EJS template
    res.render("file_list", { fileDetails });
}

module.exports = renderFileList; 