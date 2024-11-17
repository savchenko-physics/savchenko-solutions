const express = require("express");
const path = require("path");
const ejs = require("ejs");
const fs = require("fs"); // Import fs module
const bodyParser = require("body-parser");
const { parseMarkdown, getMarkdownFiles, getLineStatement, transformImageMarkdown } = require("./utils"); // Importing functions from utils.js
const { eng_page } = require("./parents_en"); // generating content for the main english page

const { ru_page } = require("./parents_ru"); // generating content for the main russian page
const bcrypt = require("bcrypt");
const session = require("express-session"); // Import express-session for session management
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
    session({
        secret: "your_secret_key", // Replace with a strong secret
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false }, // Set to true if using HTTPS
    })
);

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "posts")));
app.use("/img", express.static(path.join(__dirname, "img"))); // Serve images from img folder
app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/en", express.static(path.join(__dirname, "en")));
app.use("/theory", express.static(path.join(__dirname, "theory")));
app.use("/ru/theory", express.static(path.join(__dirname, "ru", "theory")));
app.use(express.static(path.join(__dirname, "src")));
app.use("/en/savchenko_en.pdf", express.static(path.join(__dirname, "pdf/savchenko_en.pdf")));
app.use("/savchenko.pdf", express.static(path.join(__dirname, "pdf/savchenko.pdf")));
app.use("/js", express.static(path.join(__dirname, "js")));

// PostgreSQL setup
const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

app.get("/login", (req, res) => {
    res.render("login", {
        error: req.query.error || "", // Provide a default empty string if no error
        success: req.query.success || "", // Provide a default empty string if no success message
    });
});

app.get("/register", (req, res) => {
    res.render("register", {
        error: req.query.error || "", // Provide a default empty string if no error
        success: req.query.success || "", // Provide a default empty string if no success message
    });
});

// Registration Route
app.post("/register", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.redirect("/register?error=Username and password are required");
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query("INSERT INTO users (username, password) VALUES ($1, $2)", [username, hashedPassword]);
        res.redirect("/login?success=Registration successful");
    } catch (error) {
        console.error(error);
        res.redirect("/register?error=Username already taken");
    }
});

// Login Route
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.redirect("/login?error=Username and password are required");
    }

    try {
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (result.rows.length === 0 || !(await bcrypt.compare(password, result.rows[0].password))) {
            return res.redirect("/login?error=Invalid credentials");
        }

        // Set session variables
        req.session.userId = result.rows[0].id;
        req.session.username = result.rows[0].username;

        // Redirect to profile page
        res.redirect("/profile");
    } catch (error) {
        console.error(error);
        res.redirect("/login?error=Something went wrong");
    }
});

app.get("/profile", (req, res) => {
    if (!req.session.userId) {
        return res.redirect("/login?error=Please log in to access your profile");
    }

    // Render the profile page with the user's information
    res.render("profile", { username: req.session.username });
});

// Logout Route
app.get("/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.redirect("/profile");
        }
        res.redirect("/login?success=Logged out successfully");
    });
});

// Home route to list all posts
app.get("/", eng_page);

app.get("/en", (req, res) => {
    res.redirect("/");
});

app.get(/^\/(\d+\.\d+\.\d+)$/, (req, res) => {
    const version = req.params[0]; // Capture the version part
    res.redirect(`/en/${version}`);
});

app.get("/ru", ru_page);

app.get("/en/about", (req, res) => {
    res.redirect(`/about#description`);
});

app.get("/about", (req, res) => {
    res.render("about_en");
});

app.get("/ru/about", (req, res) => {
    res.render("about_ru");
});

app.get("/study-guide", (req, res) => {
    res.render("study-guide");
});

app.get("/:lang/:name", (req, res) => {
    const { lang, name } = req.params;

    if (/^(1[0-4]|[1-9])$/.test(lang)) {
        return res.redirect(`/ru/${name}`);
    }

    const filePath = path.join(__dirname, `posts/${lang}`, `${name}.md`);

    // Check if the specified file exists
    if (fs.existsSync(filePath)) {
        let fileContents = fs.readFileSync(filePath, "utf8").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\*/g, "\\*").replace(/~/g, "\\~");
        fileContents = transformImageMarkdown(fileContents);
        titleContent = getLineStatement(fileContents);
        console.log(titleContent);

        let html = parseMarkdown(fileContents); // Convert Markdown to HTML
        html = html.replace(/<em>/g, "_").replace(/<\/em>/g, "_");
        html = html.replace(/\\\*/g, "*");

        const pageRef = name.split(".").slice(0, 2).join(".");

        res.render(lang === "ru" ? "post_ru" : "post_en", {
            pageRef,
            problemRef: name,
            title: name + ". " + titleContent,
            content: html,
        });
    } else {
        res.status(404).render("404", {
            pageUrl: req.originalUrl,
        });
    }
});

app.get("/:lang/edit/:name", (req, res) => {
    const clientIp = req.headers["x-forwarded-for"] || req.ip;
    const { lang, name } = req.params;
    const filePath = path.join(__dirname, `posts/${lang}`, `${name}.md`);

    if (fs.existsSync(filePath)) {
        let fileContents = fs.readFileSync(filePath, "utf8");
        res.render("edit_post", { lang, name, content: fileContents });
    } else {
        res.status(404).render("404", { pageUrl: req.originalUrl });
    }
});

// Route for saving edited content
app.post("/:lang/save/:name", (req, res) => {
    const { lang, name } = req.params;
    const { content } = req.body;
    const filePath = path.join(__dirname, `posts/${lang}`, `${name}.md`);
    const clientIp = req.headers["x-forwarded-for"] || req.ip;

    const backupFilePath = path.join(__dirname, `posts-old/${lang}`, `${name}_${new Date().toISOString().replace(/[:.]/g, "-")}_${clientIp.replace(/[:.]/g, "-")}.md`);
    // Backup the original file before overwriting

    fs.copyFile(filePath, backupFilePath, (err) => {
        if (err) {
            console.error("Error creating backup:", err);
            return res.status(500).send("Error creating backup");
        }

        // Now, overwrite the original file with the new content
        fs.writeFile(filePath, content, "utf8", (err) => {
            if (err) {
                console.error("Error saving file:", err);
                return res.status(500).send("Error saving file");
            } else {
                res.redirect(`/${lang}/${name}`); // Redirect to view the updated content
            }
        });
    });
});

app.get("/file-list", (req, res) => {
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
});


app.get("/search", (req, res) => {
    const query = req.query.q?.toLowerCase();

    if (!query) {
        return res.json({ results: [] }); // Return empty results for empty query
    }

    const searchDirectory = path.join(__dirname, "posts");
    const results = [];
    const processedFiles = new Set(); // Track processed file names

    const truncateWithHighlight = (name, text, query, maxLength = 150) => {
        text = text.replace(name, "").replace(".$", "").replace("\^", "").replace("\*", "").replace("##", "").replace("#", "");

        const matchIndex = text.toLowerCase().indexOf(query);

        if (matchIndex === -1) {
            return text.slice(0, maxLength); // Fallback: return the truncated text
        }

        const start = Math.max(0, matchIndex - Math.floor((maxLength - query.length) / 2));
        const end = Math.min(text.length, start + maxLength);

        let snippet = text.slice(start, end);

        // Ensure no partial words at the boundaries
        if (start > 0) snippet = `...${snippet}`;
        if (end < text.length) snippet = `${snippet}...`;

        // Highlight the query term
        return snippet.replace(new RegExp(query, "gi"), (match) => `<strong>${match}</strong>`);
    };

    const searchFiles = (directory) => {
        const files = fs.readdirSync(directory);

        files.forEach((file) => {
            const fullPath = path.join(directory, file);

            if (fs.statSync(fullPath).isDirectory()) {
                searchFiles(fullPath); // Recursively search directories
            } else if (file.endsWith(".md")) {
                if (processedFiles.has(file)) return; // Skip if file is already processed

                const fileContents = fs.readFileSync(fullPath, "utf8");
                const lines = fileContents.split("\n"); // Split file into lines

                for (const [index, line] of lines.entries()) {
                    if (line.toLowerCase().includes(query)) {
                        const relativePath = path.relative(searchDirectory, fullPath);
                        const lang = relativePath.split(path.sep)[0];
                        const name = file.replace(".md", "");

                        // Truncate and highlight the matching line
                        const snippet = truncateWithHighlight(name, line, query);

                        results.push({
                            lang,
                            name,
                            relativePath: `/${lang}/${name}`,
                            snippet: snippet,
                            lineNumber: index + 1
                        });
                        
                        processedFiles.add(file); // Mark this file as processed
                        break; // Stop further matches in the same file
                    }
                }
            }
        });
    };


    searchFiles(searchDirectory);

    // Limit to the first 10 results
    const limitedResults = results.slice(0, 10);

    res.json({ results: limitedResults });
});

app.get("/global-search", async (req, res) => {
    const query = req.query.search?.trim() || ""; // Extract the 'search' query parameter

    if (!query) {
        return res.render("search", { results: [], searchTerm: "" }); // Render with no results if no query is provided
    }

    try {
        // Fetch results from the /search endpoint (relative URL ensures it works in any environment)
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const response = await fetch(`${baseUrl}/search?q=${encodeURIComponent(query)}`);
        const data = await response.json();

        res.render("search", { results: data.results, searchTerm: query });
    } catch (error) {
        console.error("Error fetching search results:", error);
        res.render("search", { results: [], searchTerm: query });
    }
});



// Start the server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
