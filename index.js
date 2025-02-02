// Import the sitemap generation script
require('./sitemap');

const express = require("express");
const path = require("path");
const ejs = require("ejs");
const fs = require("fs"); // Import fs module
const bodyParser = require("body-parser");
const { parseMarkdown, getMarkdownFiles, getLineStatement, transformImageMarkdown } = require("./utils"); // Importing functions from utils.js
const { getLanguageData, getBothLanguages } = require("./parents"); // generating content for the main english page

const bcrypt = require("bcrypt");
const session = require("express-session"); // Import express-session for session management
const { Pool } = require("pg");
require("dotenv").config();
const i18n = require('i18n');
const connectPgSimple = require('connect-pg-simple'); // Add this import
const multer = require('multer');
const getContributionsList = require('./contributions_list');
const { getContribution, getContributionsByUserId, getTotalContributions } = require('./contributions');
const renderFileList = require('./file-list');
const { renderPost, getPageViewsData } = require('./post'); // Import the renderPost function
const getUserProfile = require('./userProfile');

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
app.get('/img/:name', (req, res) => {
    const dirPath = path.join(__dirname, 'img', req.params.name);
    fs.readdir(dirPath, (err, files) => {
        if (err) {
            console.error(`Error reading directory ${dirPath}:`, err); // Log the error
            return res.status(500).json({ message: 'Error reading directory.' });
        }
        const images = files.filter(file => /\.(jpg|jpeg|png|gif|svg)$/i.test(file));
        res.json(images);
    });
});

// Add a new route for user profiles
app.get("/user/:username", getUserProfile);

app.post("/create-problem", async (req, res) => {
    const { problemName, chapter, lang = 'en' } = req.body;

    const { chapters } = await getLanguageData(lang);

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

    const userId = req.session.userId || null; // Retrieve userId from session
    const clientIp = req.headers["x-forwarded-for"] || req.ip; // Retrieve client IP address

    try {
        await fs.promises.writeFile(filePath, content);
        console.log(`Problem file created: ${filePath}`);

        // Record the creation in the contributions table with content_changed set to false
        await pool.query(
            `INSERT INTO contributions (
                user_id, 
                problem_name, 
                language, 
                edited_at,
                original_content,
                new_content,
                ip_address,
                content_changed
            ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7)`,
            [userId, problemName, lang, '', content, clientIp, false]
        );

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
        console.log(userResult);
        const user = userResult.rows[0];
        res.redirect(`/user/${user.username}`);
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

app.get("/", async (req, res) => {
    const lang = req.session.lang || req.acceptsLanguages('en', 'ru') || 'en';
    const { chapters, theory, sections, pinnedChapters } = await getLanguageData(lang);
    const recentContributions = await getRecentContributions(3);

    i18n.setLocale(res, lang);
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;

    const userAgent = req.headers['user-agent'];
    const isMobile = /mobile/i.test(userAgent);
    const working_page = isMobile ? "eng_page_old" : "eng_page";

    let profilePicture = null; // Initialize profilePicture

    if (req.session.userId) {
        const userResult = await pool.query(
            "SELECT profile_picture FROM users WHERE id = $1",
            [req.session.userId]
        );
        profilePicture = userResult.rows[0]?.profile_picture || null;
    }
    
    res.render(working_page, {
        __: i18n.__,
        title: i18n.__('title'),
        chapters,
        theory,
        username: res.locals.username,
        userId: res.locals.userId,
        sections,
        pinnedChapters,
        profilePicture, // Pass profilePicture to the template
        lang,
        recentContributions
    });
});

async function getRecentContributions(limit) {
    try {
        const result = await pool.query(
            "SELECT id, problem_name, user_id, edited_at, ip_address FROM contributions ORDER BY edited_at DESC LIMIT $1",
            [limit]
        );

        const contributions = await Promise.all(result.rows.map(async (row) => {
            const userResult = await pool.query("SELECT username FROM users WHERE id = $1", [row.user_id]);
            const username = userResult.rows[0]?.username || row.ip_address; // Show ip_address if username is 'Unknown'

            return {
                version: row.problem_name,
                editor: username, // Convert user_id to username or show ip_address
                timestamp: new Intl.DateTimeFormat('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    month: 'short',
                    day: '2-digit'
                }).format(row.edited_at), // Format the timestamp
                id: row.id
            };
        }));

        return contributions;
    } catch (error) {
        console.error("Error fetching recent contributions:", error);
        return [];
    }
}

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
    const { chapters, theory, sections, pinnedChapters } = await getLanguageData('ru');
    const recentContributions = await getRecentContributions(3);
    i18n.setLocale(res, 'ru');
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;

    const userAgent = req.headers['user-agent'];
    const isMobile = /mobile/i.test(userAgent);
    const working_page = isMobile ? "eng_page_old" : "eng_page";

    let profilePicture = null; // Initialize profilePicture

    if (req.session.userId) {
        const userResult = await pool.query(
            "SELECT profile_picture FROM users WHERE id = $1",
            [req.session.userId]
        );
        profilePicture = userResult.rows[0]?.profile_picture || null;
    }
    
    res.render(working_page, {
        __: i18n.__,
        title: i18n.__('title'),
        chapters,
        theory,
        username: res.locals.username,
        userId: res.locals.userId,
        sections,
        pinnedChapters,
        profilePicture, // Pass profilePicture to the template
        lang: 'ru',
        recentContributions
    });
});

app.get("/en", async (req, res) => {
    const { chapters, theory, sections, pinnedChapters } = await getLanguageData('en');
    const recentContributions = await getRecentContributions(3);
    i18n.setLocale(res, 'en');
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;

    const userAgent = req.headers['user-agent'];
    const isMobile = /mobile/i.test(userAgent);
    const working_page = isMobile ? "eng_page_old" : "eng_page";

    let profilePicture = null; // Initialize profilePicture

    if (req.session.userId) {
        const userResult = await pool.query(
            "SELECT profile_picture FROM users WHERE id = $1",
            [req.session.userId]
        );
        profilePicture = userResult.rows[0]?.profile_picture || null;
    }
    
    res.render(working_page, {
        __: i18n.__,
        title: i18n.__('title'),
        chapters,
        theory,
        username: res.locals.username,
        userId: res.locals.userId,
        sections,
        pinnedChapters,
        profilePicture, // Pass profilePicture to the template
        lang: 'en',
        recentContributions
    });
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

app.get("/:lang/:name", renderPost); // Use the renderPost function for this route

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
            content: fileContents,
            title: lang === 'ru' ? `Изменить решение - ${name}` : `Edit Solution - ${name}`
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

// Define a list of blocked IPs
const blockedIPs = [
    '88.150.230.32',
    '176.193.25.172',
    '77.37.146.158',
    '79.139.132.133',
    '178.176.78.181',
    '65.109.58.154',
    '83.220.238.208',
    '178.176.77.74',
    '109.252.153.135',
    '176.59.207.161',
    '5.228.81.203'
];

// Route for saving edited content
app.post("/:lang/save/:name", async (req, res) => {
    const { lang, name } = req.params;
    const { content } = req.body;
    const userId = req.session.userId || null; // Will be null for unauthenticated users
    const filePath = path.join(__dirname, `posts/${lang}`, `${name}.md`);
    const clientIp = req.headers["x-forwarded-for"] || req.ip;

    // Define originalContent before using it
    let originalContent;

    try {
        // Get original content for comparison
        try {
            originalContent = await fs.promises.readFile(filePath, "utf8");
        } catch (error) {
            console.error("Error reading original content:", error);
            return res.status(500).send("Error reading original content");
        }

        // Check for emojis in the content
        const emojiRegex = /[\u{1F600}-\u{1F64F}]/u; // Basic emoji range

        // Check if the client's IP is blocked
        if (blockedIPs.includes(clientIp) || emojiRegex.test(content)) {
            // Save to a special database or table
            await pool.query(
                `INSERT INTO special_contributions (
                    user_id, 
                    problem_name, 
                    language, 
                    edited_at,
                    old_content,
                    new_content,
                    ip_address
                ) VALUES ($1, $2, $3, NOW(), $4, $5, $6)`,
                [userId, name, lang, originalContent, content, clientIp]
            );

            // Render a page indicating the submission for review
            return res.render("review_submission", {
                lang,
                message: lang === 'ru' ? 
                    "Ваши изменения были отправлены на проверку!" : 
                    "Your edits have been successfully submitted for review!"
            });
        }

        // Determine if the content was changed
        const contentChanged = originalContent !== content;

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

        // Record the contribution with change details
        await pool.query(
            `INSERT INTO contributions (
                user_id, 
                problem_name, 
                language, 
                edited_at,
                original_content,
                new_content,
                ip_address,
                content_changed
            ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7)`,
            [userId, name, lang, originalContent, content, clientIp, contentChanged]
        );

        res.redirect(`/${lang}/${name}`);
    } catch (error) {
        console.error("Error saving file:", error);
        res.status(500).send("Error saving file");
    }
});

app.get("/file-list", renderFileList);

app.get("/search", (req, res) => {
    const query = req.query.q?.toLowerCase();

    if (!query) {
        return res.json({ results: [] }); // Return empty results for empty query
    }

    const searchDirectory = path.join(__dirname, "posts");
    const results = [];
    const processedFiles = new Set(); // Track processed file names

    const truncateWithHighlight = (name, text, query, maxLength = 57) => {
        text = text.replace(name, "").replace(/\$/g, "").replace(/_/g, "").replace(".$", "").replace("\^", "").replace("\*", "").replace("##", "").replace("#", "").replace("\ell", "l").replace("#", "");

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

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'img', req.params.name);
        fs.mkdirSync(dir, { recursive: true }); // Ensure the directory exists
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname); // Use the original file name
    }
});

const upload = multer({ storage: storage });

// Add this route to handle image uploads
app.post('/upload-image/:name', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }

    const dir = path.join(__dirname, 'img', req.params.name);
    fs.mkdirSync(dir, { recursive: true });

    const imagePath = `/img/${req.params.name}/${req.file.originalname}`;

    // Use a library like 'sharp' to get image dimensions
    const sharp = require('sharp');
    sharp(req.file.path).metadata().then(metadata => {
        res.json({
            imagePath,
            width: metadata.width,
            height: metadata.height
        });
    }).catch(err => {
        console.error("Error getting image metadata:", err);
        res.status(500).json({ message: 'Error processing image.' });
    });
});

// Update the route to handle contributions with an ID
app.get("/api/contributions/:id", checkAuthenticated, async (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit = 25;
    const userId = req.params.id; // Get the user ID from the route parameter

    try {
        const contributions = await getContributionsByUserId(userId, limit, offset);
        res.json(contributions);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch contributions' });
    }
});

app.get("/:lang/contributions/:problemName", (req, res, next) => {
    const { problemName } = req.params;
    if ((problemName.match(/\./g) || []).length === 2) {
        return getContributionsList(req, res, next);
    } else {
        return getContribution(req, res, next);
    }
});

// Add redirection routes
app.get(/^\/([1-9]|1[0-4])\/?$/, (req, res) => {
    const sectionNumber = req.params[0];
    res.redirect(301, `/ru/#${sectionNumber}`);
});

// Add this route to handle page views data requests
app.get("/api/page-views/:name", getPageViewsData);

// Start the server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
