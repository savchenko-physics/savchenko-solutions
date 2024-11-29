const express = require("express");
const path = require("path");
const ejs = require("ejs");
const fs = require("fs"); // Import fs module
const bodyParser = require("body-parser");
const { parseMarkdown, getMarkdownFiles, getLineStatement, transformImageMarkdown } = require("./utils"); // Importing functions from utils.js
const { getPageData } = require("./parents_en"); // generating content for the main english page

const { ru_page } = require("./parents_ru"); // generating content for the main russian page
const bcrypt = require("bcrypt");
const session = require("express-session"); // Import express-session for session management
const { Pool } = require("pg");
require("dotenv").config();
const i18n = require('i18n');
const connectPgSimple = require('connect-pg-simple'); // Add this import

const app = express();
const PORT = 3000;

// PostgreSQL setup (move this BEFORE session configuration)
const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

// Session configuration (AFTER pool is created)
app.use(
    session({
        store: new (connectPgSimple(session))({
            pool: pool,
            tableName: 'session'
        }),
        secret: process.env.SESSION_SECRET || "your_secret_key",
        resave: false,
        saveUninitialized: false,
        cookie: { 
            secure: process.env.NODE_ENV === 'production',
            maxAge: 1000 * 60 * 60 * 24 * 365,
            httpOnly: true,
            sameSite: 'lax'
        },
    })
);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
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
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
    res.locals.username = req.session.username || null; // Set username globally
    next(); // Move to the next middleware/route handler
});

// Authentication middleware
function checkAuthenticated(req, res, next) {
    const lang = req.query.lang || req.body.lang || 'en';
    i18n.setLocale(res, lang);

    if (req.session.userId) {
        return next();
    }
    
    res.redirect(`/${lang}/login?error=${i18n.__('Please log in to access this page')}`);
}

function checkNotAuthenticated(req, res, next) {
    const lang = req.query.lang || req.body.lang || 'en';
    i18n.setLocale(res, lang);

    if (!req.session.userId) {
        return next();
    }
    
    res.redirect(`/${lang}/profile`);
}

app.post("/create-problem", async (req, res) => {
    const { problemName, chapter, lang = 'en' } = req.body;

    const { chapters } = await getPageData(
        lang === 'ru' ? "src/ru/database/chapters.csv" : "src/database/chapters.csv",
        lang === 'ru' ? "src/ru/database/sections.csv" : "src/database/sections.csv",
        lang
    );

    if (!problemName || !problemName.match(/^\d+\.\d+\.\d+$/)) {
        return res.status(400).json({ message: "Invalid problem name format. Use chapter.section.problem format." });
    }

    const [chapterNumber, sectionNumber, problemNumber] = problemName.split('.').map(Number);

    if (!chapterNumber || !sectionNumber || !problemNumber) {
        return res.status(400).json({ message: "Invalid problem name format. Use chapter.section.problem format." });
    }


    // Validate chapter exists
    const currentChapter = chapters[chapterNumber - 1]; // Adjust for zero-based indexing
    if (!currentChapter) {
        return res.status(400).json({ message: `Chapter ${chapterNumber} does not exist.` });
    }

    // Validate section exists
    const currentSection = currentChapter.sections[sectionNumber - 1]; // Adjust for zero-based indexing
    if (!currentSection) {
        return res.status(400).json({ message: `Section ${chapterNumber}.${sectionNumber} does not exist.` });
    }

    // Validate problemNumber against section maximum
    const maxProblems = currentSection.maximum;
    if (problemNumber > maxProblems) {
        return res.status(400).json({
            message: `Problem number (${problemNumber}) exceeds the maximum allowed (${maxProblems}) for Section ${chapterNumber}.${sectionNumber}.`,
        });
    }

    const problemsDir = path.join(__dirname, "posts", lang);
    const filePath = path.join(problemsDir, `${problemName}.md`);

    if (fs.existsSync(filePath)) {
        return res.status(400).json({ message: "Problem file already exists." });
    }

    const content = lang === 'ru' ? 
        `### Условие

$${problemName}.$ [Вставьте описание задачи]

__Пример условия__:
$1.1.1.$ Определите координату $x(t)$ тела как функцию времени $t$, если его ускорение задано как $a(t) = bt$, где $b$ - константа.


### Решение

[Здесь должно быть ваше решение]

__Пример решения__:
Ускорение тела задано как

$$a(t) = bt$$

Мы знаем, что ускорение - это производная скорости по времени:

$$a(t) = \\frac{d v(t)}{d t}$$

Чтобы найти скорость $v(t)$, интегрируем $a(t)$ по времени:

$$v(t) = \\int a(t) \\, dt = \\int b t \\, dt$$

Если начальная скорость $v(0) = 0$, то скорость становится:

$$v(t) = \\frac{b t^2}{2}$$

Аналогично, интегрируем $v(t)$ по времени:

$$x(t)= \\int v(t) \\, dt = \\frac{b}{2} \\int t^2 \\, dt$$

Откуда координата от времени, учитывая начальные условия:

$$\\boxed{x(t)=\\frac{bt^3}{6}}$$

#### Ответ

[Вставьте краткий ответ или результат в рамке, например:]


__Пример ответа__:
$$ x(t)=\\frac{bt^3}{6} $$` 
        : 
        // Original English template
        `### Statement

$${problemName}.$ [Insert problem description here]

__Example Statement__:
$1.1.1.$ Determine the coordinate $x(t)$ of a body as a function of time $t$, given that its acceleration is defined as $a(t) = bt$, where $b$ is a constant. 


### Solution

[Your solution should be placed here]

__Example Solution__:
The acceleration of the body defined by 

$$a(t) = bt$$

We know that acceleration is the time derivative of velocity:

$$a(t) = \\frac{d v(t)}{d t}$$

To find the velocity $v(t)$, we integrate $a(t)$ with respect to time:

$$v(t) = \\int a(t) \\, dt = \\int b t \\, dt$$

If the initial velocity is $v(0) = 0$, then the velocity becomes:

$$v(t) = \\frac{b t^2}{2}$$

Likewise, integrate $v(t)$ with respect to time:

$$x(t)= \\int v(t) \\, dt = \\frac{b}{2} \\int t^2 \\, dt$$

From where the coordinate from time, considering the initial conditions: 

$$\\boxed{x(t)=\\frac{bt^3}{6}}$$

#### Answer

[Insert a concise answer or boxed result, like this:]


__Example Answer__:
$$ x(t)=\\frac{bt^3}{6} $$
`

    try {
        await fs.promises.writeFile(filePath, content);
        console.log(`Problem file created: ${filePath}`);
        res.json({ 
            message: lang === 'ru' ? 
                `Задача ${problemName} успешно создана!` : 
                `Problem ${problemName} created successfully!`,
            redirectUrl: `/${lang}/edit/${problemName}` 
        });
    } catch (err) {
        console.error("Error creating file:", err);
        res.status(500).json({ 
            message: lang === 'ru' ? 
                "Не удалось создать файл задачи." : 
                "Failed to create problem file." 
        });
    }
});


app.get("/login", checkNotAuthenticated, (req, res) => {
    i18n.setLocale(res, 'en'); // Default to English for login
    res.render("login", {
        __: i18n.__,
        lang: 'en',
        error: req.query.error || "",
        success: req.query.success || "",
    });
});

app.get("/ru/login", checkNotAuthenticated, (req, res) => {
    i18n.setLocale(res, 'ru');
    res.render("login", {
        __: i18n.__,
        lang: 'ru',
        error: req.query.error || "",
        success: req.query.success || "",
    });
});

app.get("/en/login", checkNotAuthenticated, (req, res) => {
    i18n.setLocale(res, 'en');
    res.render("login", {
        __: i18n.__,
        lang: 'en',
        error: req.query.error || "",
        success: req.query.success || "",
    });
});

app.get("/register", checkNotAuthenticated, (req, res) => {
    i18n.setLocale(res, 'en'); // Default to English for register
    res.render("register", {
        __: i18n.__,
        lang: 'en',
        error: req.query.error || "",
        success: req.query.success || "",
    });
});

app.get("/ru/register", checkNotAuthenticated, (req, res) => {
    i18n.setLocale(res, 'ru');
    res.render("register", {
        __: i18n.__,
        lang: 'ru',
        error: req.query.error || "",
        success: req.query.success || "",
    });
});

app.get("/en/register", checkNotAuthenticated, (req, res) => {
    i18n.setLocale(res, 'en');
    res.render("register", {
        __: i18n.__,
        lang: 'en',
        error: req.query.error || "",
        success: req.query.success || "",
    });
});

// Registration Route
app.post("/register", async (req, res) => {
    const { username, email, fullname, password, password2, lang = 'en' } = req.body;

    // Validate required fields
    if (!username || !email || !fullname || !password || !password2) {
        return res.redirect(`/${lang}/register?error=${i18n.__('All fields are required')}`);
    }

    // Check if passwords match
    if (password !== password2) {
        return res.redirect(`/${lang}/register?error=${i18n.__('Passwords do not match')}`);
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert into the database
        await pool.query(
            "INSERT INTO users (username, email, full_name, password) VALUES ($1, $2, $3, $4)",
            [username, email, fullname, hashedPassword]
        );

        res.redirect(`/${lang}/login?success=${i18n.__('Registration successful')}`);
        // res.redirect("/profile");
    } catch (error) {
        console.error(error);

        // Handle errors like duplicate entries
        if (error.code === '23505') {
            return res.redirect(`/${lang}/register?error=${i18n.__('Username or email already taken')}`);
        }

        res.redirect(`/${lang}/register?error=${i18n.__('Something went wrong')}`);
    }
});



// Login Route
app.post("/login", async (req, res) => {
    const { username, password, lang = 'en' } = req.body;
    
    if (!username || !password) {
        return res.redirect(`/${lang}/login?error=${i18n.__('Username and password are required')}`);
    }

    try {
        const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (result.rows.length === 0 || !(await bcrypt.compare(password, result.rows[0].password))) {
            return res.redirect(`/${lang}/login?error=${i18n.__('Invalid credentials')}`);
        }

        req.session.userId = result.rows[0].id;
        req.session.username = result.rows[0].username;
        req.session.lang = lang; // Store language preference in session

        res.redirect(`/${lang}/profile`);
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/login?error=${i18n.__('Something went wrong')}`);
    }
});

// Profile routes
app.get(["/profile", "/:lang/profile"], checkAuthenticated, async (req, res) => {
    const lang = req.params.lang || req.query.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        const userResult = await pool.query(
            "SELECT * FROM users WHERE id = $1",
            [req.session.userId]
        );

        const contributionsResult = await pool.query(
            "SELECT * FROM contributions WHERE user_id = $1 ORDER BY edited_at DESC",
            [req.session.userId]
        );

        const user = userResult.rows[0];
        const contributions = contributionsResult.rows;

        res.render("profile", {
            __: i18n.__,
            lang,
            username: user.username,
            email: user.email,
            fullName: user.full_name,
            joinDate: new Date(user.created_at),
            contributions,
            totalEdits: contributions.length,
            error: req.query.error || "",
            success: req.query.success || ""
        });
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/login?error=${i18n.__('Something went wrong')}`);
    }
});

// Profile update routes
app.post(["/profile/update", "/:lang/profile/update"], checkAuthenticated, async (req, res) => {
    const { fullname, email, lang } = req.body;
    const language = req.params.lang || lang || 'en';
    
    try {
        await pool.query(
            "UPDATE users SET full_name = $1, email = $2 WHERE id = $3",
            [fullname, email, req.session.userId]
        );
        
        res.redirect(`/${language}/profile?success=${i18n.__('Profile updated successfully')}`);
    } catch (error) {
        console.error(error);
        res.redirect(`/${language}/profile?error=${i18n.__('Failed to update profile')}`);
    }
});

// Password update routes
app.post(["/profile/password", "/:lang/profile/password"], checkAuthenticated, async (req, res) => {
    const { currentPassword, newPassword, lang } = req.body;
    const language = req.params.lang || lang || 'en';
    
    try {
        const result = await pool.query(
            "SELECT password FROM users WHERE id = $1",
            [req.session.userId]
        );
        
        const validPassword = await bcrypt.compare(currentPassword, result.rows[0].password);
        
        if (!validPassword) {
            return res.redirect(`/${language}/profile?error=${i18n.__('Current password is incorrect')}`);
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query(
            "UPDATE users SET password = $1 WHERE id = $2",
            [hashedPassword, req.session.userId]
        );
        
        res.redirect(`/${language}/profile?success=${i18n.__('Password updated successfully')}`);
    } catch (error) {
        console.error(error);
        res.redirect(`/${language}/profile?error=${i18n.__('Failed to update password')}`);
    }
});

// Logout Route
app.get("/logout", (req, res) => {
    const lang = req.session.lang || 'en'; // Get language before destroying session
    req.session.destroy((err) => {
        if (err) {
            return res.redirect(`/${lang}/profile`);
        }
        res.redirect(`/${lang}/login?success=${i18n.__('Logged out successfully')}`);
    });
});

// Home route to list all posts
// app.get("/", (req, res) => {
//     // Modify the eng_page function or include session data
//     eng_page(req, res);
//     console.log(req.session.username);
// });


app.get("/", async (req, res) => {
    const { chapters, theory, sections, pinnedChapters } = await getPageData(
        "src/database/chapters.csv",
        "src/database/sections.csv",
        'en'
    );
    
    i18n.setLocale(res, 'en');

    res.render("eng_page", {
        __: i18n.__,
        title: i18n.__('title'),
        chapters,
        theory,
        sections,
        pinnedChapters,
        lang: 'en'
    });
});

// Configure i18n (move this before app.use statements)
i18n.configure({
    locales: ['en', 'ru'],
    directory: path.join(__dirname, 'locales'),
    defaultLocale: 'en',
    objectNotation: true,
    updateFiles: false,
    cookie: 'lang'
});

// Add i18n middleware (move this before route definitions)
app.use(i18n.init);

// Update the /ru route to use i18n.setLocale instead
app.get("/ru", async (req, res) => {
    const { chapters, theory, sections, pinnedChapters } = await getPageData(
        "src/ru/database/chapters.csv",
        "src/ru/database/sections.csv",
        'ru'
    );
    
    i18n.setLocale(req, 'ru');

    res.render("eng_page", {
        __: i18n.__,
        title: i18n.__('title'),
        chapters,
        theory,
        sections,
        pinnedChapters,
        lang: 'ru'
    });
});

app.get("/en", (req, res) => {
    res.redirect("/");
});

app.get(/^\/(\d+\.\d+\.\d+)$/, (req, res) => {
    const version = req.params[0]; // Capture the version part
    res.redirect(`/en/${version}`);
});

app.get("/en/about", (req, res) => {
    res.redirect(`/about#description`);
});

app.get("/about", (req, res) => {
    i18n.setLocale(res, 'en'); 
    res.render("about_en", {
        lang: 'en',
        __: i18n.__
    });
});

app.get("/ru/about", (req, res) => {
    i18n.setLocale(res, 'ru'); // Set locale to Russian
    res.render("about_ru", {
        lang: 'ru',
        __: i18n.__
    });
});

app.get(["/study-guide", "/:lang/study-guide"], (req, res) => {
    const lang = req.params.lang || 'en';
    i18n.setLocale(res, lang);
    
    res.render("study-guide", {
        __: i18n.__,
        lang
    });
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

        let html = parseMarkdown(fileContents);
        html = html.replace(/<em>/g, "_").replace(/<\/em>/g, "_");
        html = html.replace(/\\\*/g, "*");

        const pageRef = name.split(".").slice(0, 2).join(".");

        i18n.setLocale(res, lang);

        res.render("post", {
            __: i18n.__,
            lang,
            pageRef,
            problemRef: name,
            title: name + ". " + titleContent,
            content: html
        });
    } else {
        i18n.setLocale(res, lang);
        res.status(404).render("404", {
            __: i18n.__,
            pageUrl: req.originalUrl,
            lang
        });
    }
});

app.get("/:lang/edit/:name", (req, res) => {
    const { lang, name } = req.params;
    const filePath = path.join(__dirname, `posts/${lang}`, `${name}.md`);

    if (fs.existsSync(filePath)) {
        let fileContents = fs.readFileSync(filePath, "utf8");
        i18n.setLocale(res, lang);
        res.render("edit_post", {
            __: i18n.__,
            lang,
            name,
            content: fileContents
        });
    } else {
        i18n.setLocale(res, lang);
        res.status(404).render("404", {
            __: i18n.__,
            pageUrl: req.originalUrl,
            lang
        });
    }
});

// Route for saving edited content
app.post("/:lang/save/:name", checkAuthenticated, async (req, res) => {
    const { lang, name } = req.params;
    const { content } = req.body;
    const userId = req.session.userId;
    const filePath = path.join(__dirname, `posts/${lang}`, `${name}.md`);
    const clientIp = req.headers["x-forwarded-for"] || req.ip;

    try {
        // Create backup with editor info
        const backupFilePath = path.join(
            __dirname, 
            `posts-old/${lang}`, 
            `${name}_${new Date().toISOString().replace(/[:.]/g, "-")}_${clientIp.replace(/[:.]/g, "-")}.md`
        );

        // Backup the original file
        await fs.promises.copyFile(filePath, backupFilePath);

        // Save the new content
        await fs.promises.writeFile(filePath, content, "utf8");

        // Record the contribution in the database
        await pool.query(
            "INSERT INTO contributions (user_id, problem_name, language, edited_at) VALUES ($1, $2, $3, NOW())",
            [userId, name, lang]
        );

        res.redirect(`/${lang}/${name}`);
    } catch (error) {
        console.error("Error saving file:", error);
        res.status(500).send("Error saving file");
    }
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
    const query = req.query.search?.trim() || "";
    const lang = req.query.lang || 'en';
    
    i18n.setLocale(res, lang);

    if (!query) {
        return res.render("search", { 
            results: [], 
            searchTerm: "",
            __: i18n.__,
            lang
        });
    }

    try {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const response = await fetch(`${baseUrl}/search?q=${encodeURIComponent(query)}`);
        const data = await response.json();

        res.render("search", { 
            results: data.results, 
            searchTerm: query,
            __: i18n.__,
            lang
        });
    } catch (error) {
        console.error("Error fetching search results:", error);
        res.render("search", { 
            results: [], 
            searchTerm: query,
            __: i18n.__,
            lang
        });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
