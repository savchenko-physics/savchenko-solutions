// Import the sitemap generation script
require('./sitemap');

const compression = require('compression');
const express = require("express");
const path = require("path");
const fs = require("fs"); // Import fs module
const bodyParser = require("body-parser");
const {
    convertLatexToPlainText,
    validateSolutionMarkdownContent,
    isValidSolutionLang,
    isValidSolutionProblemName,
} = require("./utils"); // Importing functions from utils.js
const { getLanguageData } = require("./parents"); // generating content for the main english page

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
const uploadRouter = require('./upload');
const renderUnsolvedList = require('./unsolved');
const crypto = require("crypto");
const { getSortedCountryNames } = require("./lib/countries");
const registerContributorAndUserMetricsApi = require("./contributorsUserMetricsApi");

const rateLimit = require('express-rate-limit');
const { router: adminRouter, isIpBlocked } = require('./admin');
const searchIndex = require('./searchIndex');
const blogRouter = require('./blog');
const toolsRouter = require('./tools');
const bankRouter = require('./bank');
const forumRouter = require('./forum');
const { router: challengesRouter, getCurrentChallengeWidget } = require('./challenges');
const { router: contestRouter, getActiveContestBanner } = require('./contest');
const { router: pathsRouter, getPathsForProblem } = require('./paths');
const notifications = require('./notifications');
const { router: messagesRouter, getUnreadMessageCount } = require('./messages');

const app = express();
const PORT = 3000;

app.set('trust proxy', 1);

// Gzip compression — first middleware for best coverage
app.use(compression());

// Require SESSION_SECRET — refuse to start with the insecure default
if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET environment variable is required. The server will not start without it.');
}

// PostgreSQL setup (move this BEFORE session configuration)
const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

const DEFAULT_PROFILE_AVATAR = "/img/profile_images/Default_placeholder.svg";

// Session configuration (AFTER pool is created)
app.use(
    session({
        store: new (connectPgSimple(session))({
            pool: pool,
            tableName: 'session'
        }),
        secret: process.env.SESSION_SECRET,
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

// Rate limiters
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    message: 'Too many login attempts, please try again after 15 minutes.',
    standardHeaders: true,
    legacyHeaders: false,
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    message: 'Too many registration attempts, please try again after an hour.',
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    // Effectively unlimited API requests (practical infinity)
    max: Number.MAX_SAFE_INTEGER,
    message: { error: 'Too many API requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const searchLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    message: { error: 'Too many search requests, please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const editSaveLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20,
    keyGenerator: (req) => String(req.session?.userId ?? 'anonymous'),
    message: 'Too many save attempts, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.set("view engine", "ejs");

// Apply API rate limiter to all /api/* routes
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, "posts")));
app.use("/img", express.static(path.join(__dirname, "img"), { maxAge: '30d' }));
app.use("/css", express.static(path.join(__dirname, "css"), { maxAge: '7d' }));
app.use("/en", express.static(path.join(__dirname, "en")));
app.use("/theory", express.static(path.join(__dirname, "theory")));
app.use("/ru/theory", express.static(path.join(__dirname, "ru", "theory")));
// Removed: app.use(express.static(path.join(__dirname, "src")));
// The src directory contains Python scripts and CSV data — must not be publicly served.
app.use("/en/savchenko_en.pdf", express.static(path.join(__dirname, "pdf/savchenko_en.pdf")));
app.use("/savchenko.pdf", express.static(path.join(__dirname, "pdf/savchenko.pdf")));
app.use("/js", express.static(path.join(__dirname, "js"), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
    const langMatch = req.path.match(/^\/(en|ru)(\/|$)/);
    if (langMatch) {
        req.session.lang = langMatch[1];
    }
    next();
});

// Expose the active contest banner to every rendered page (cheap, no DB hit).
app.use((req, res, next) => {
    try {
        res.locals.activeContest = getActiveContestBanner(req.session.lang || 'en');
    } catch (_err) {
        res.locals.activeContest = null;
    }
    next();
});

app.use((req, res, next) => {
    res.locals.username = req.session.username || null;
    res.locals.profilePicture = null;
    res.locals.unreadNotificationCount = 0;
    if (!req.session.userId) {
        return next();
    }
    res.locals.unreadMessageCount = 0;
    Promise.all([
        pool.query("SELECT profile_picture FROM users WHERE id = $1", [req.session.userId]),
        notifications.getUnreadCount(req.session.userId),
        getUnreadMessageCount(req.session.userId),
    ])
        .then(([profileResult, unreadCount, unreadMessages]) => {
            res.locals.profilePicture = profileResult.rows[0]?.profile_picture || null;
            res.locals.unreadNotificationCount = unreadCount;
            res.locals.unreadMessageCount = unreadMessages;
            next();
        })
        .catch((err) => {
            console.error("Error loading user context for header:", err);
            next();
        });
});


// Authentication middleware
function checkAuthenticated(req, res, next) {
    const lang = req.params.lang || req.query.lang || req.body.lang || 'en';
    i18n.setLocale(res, lang);

    if (req.session.userId) {
        return next();
    }

    res.redirect(`/${lang}/login?error=${i18n.__('Please log in to access this page')}`);
}

function checkNotAuthenticated(req, res, next) {
    const lang = req.params.lang || req.query.lang || req.body.lang || 'en';
    i18n.setLocale(res, lang);

    if (!req.session.userId) {
        return next();
    }

    res.redirect(`/${lang}/profile`);
}

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

// Configure multer for profile pictures
const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'img', 'profile_images');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${req.session.userId}${ext}`);
    }
});

const profileUpload = multer({ 
    storage: profileStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedExt = /\.(jpe?g|png|gif|webp)$/i.test(file.originalname);
        const okMime = !file.mimetype || /image\/(jpeg|png|gif|webp)/i.test(file.mimetype);

        if (okMime && allowedExt) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

function normalizeProfileUrl(val) {
    if (val == null) return null;
    const s = String(val).trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    return "https://" + s.replace(/^\/+/, "");
}

// Add this route to handle image uploads
app.post('/upload-image/:name', checkAuthenticated, upload.single('image'), (req, res) => {
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

// User Settings Routes
app.get(["/settings", "/:lang/settings"], checkAuthenticated, async (req, res) => {
    const lang = req.params.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        // Get user data
        const userResult = await pool.query(
            "SELECT * FROM users WHERE id = $1",
            [req.session.userId]
        );
        const user = userResult.rows[0];

        // Get user preferences
        const preferencesResult = await pool.query(
            "SELECT * FROM user_preferences WHERE user_id = $1",
            [req.session.userId]
        );
        const preferences = preferencesResult.rows[0] || {};

        const notificationSettings = preferences.notification_settings || notifications.DEFAULT_NOTIFICATION_SETTINGS;

        res.render("user_settings", {
            __: i18n.__,
            lang,
            username: user.username,
            fullName: user.full_name,
            email: user.email,
            bio: user.bio,
            countryLocation: user.country_location,
            institution: user.institution,
            linkedin: user.linkedin,
            github: user.github,
            personalWebsite: user.personal_website,
            profilePicture: user.profile_picture || `/img/profile_images/${user.id}.png`,
            preferences,
            notificationSettings,
            countryNames: getSortedCountryNames(),
            error: req.query.error || "",
            success: req.query.success || "",
            activeTab: req.query.tab || ""
        });
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/profile?error=${i18n.__('Failed to load settings')}`);
    }
});

// Update the existing getTopAuthors function to be more comprehensive
async function getAllContributors(limit = 50, offset = 0) {
    try {
        const query = `
            WITH all_contributions AS (
                SELECT user_id, problem_name FROM contributions WHERE user_id != 28 AND user_id IS NOT NULL
                UNION ALL
                SELECT user_id, problem_name FROM github_contributions WHERE user_id != 28 AND user_id IS NOT NULL
            ),
            user_stats AS (
                SELECT 
                    u.id,
                    u.username,
                    u.full_name,
                    u.profile_picture,
                    u.created_at,
                    COUNT(DISTINCT ac.problem_name) AS unique_contributions,
                    COUNT(*) AS total_contributions,
                    19 * LN(COUNT(DISTINCT ac.problem_name) * SQRT(COUNT(*))) AS raw_rank
                FROM all_contributions ac
                JOIN users u ON ac.user_id = u.id
                GROUP BY u.id, u.username, u.full_name, u.profile_picture, u.created_at
            )
            SELECT 
                id,
                username,
                full_name,
                profile_picture,
                created_at,
                unique_contributions,
                total_contributions,
                ROUND(raw_rank::numeric, 0) AS rank
            FROM user_stats
            ORDER BY rank DESC
            LIMIT $1 OFFSET $2
        `;
        
        const result = await pool.query(query, [limit, offset]);
        return result.rows;
    } catch (error) {
        console.error("Error fetching all contributors:", error);
        return [];
    }
}
// Profile settings update (profile + links; email is changed from Account tab only)
app.post("/:lang/settings/profile", checkAuthenticated, profileUpload.single("profilePicture"), async (req, res) => {
    const { lang } = req.params;
    i18n.setLocale(res, lang);
    const {
        fullName,
        bio,
        countryLocation,
        institution,
        username: newUsername,
        linkedin,
        github,
        personalWebsite,
        removeProfilePicture,
    } = req.body;

    const bioTrim = String(bio || "").slice(0, 300);
    const uname = String(newUsername || "").trim();
    const usernameRe = /^[a-zA-Z0-9._-]{2,32}$/;

    if (!usernameRe.test(uname)) {
        return res.redirect(
            `/${lang}/settings?tab=profile&error=${encodeURIComponent(i18n.__("settings.errors.invalidUsername"))}`
        );
    }

    try {
        const self = await pool.query("SELECT username FROM users WHERE id = $1", [req.session.userId]);
        const currentUsername = self.rows[0]?.username;
        if (uname.toLowerCase() !== String(currentUsername).toLowerCase()) {
            const clash = await pool.query(
                "SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2",
                [uname, req.session.userId]
            );
            if (clash.rows.length > 0) {
                return res.redirect(
                    `/${lang}/settings?tab=profile&error=${encodeURIComponent(i18n.__("settings.errors.usernameTaken"))}`
                );
            }
        }

        let profilePictureValue = undefined;
        if (req.file) {
            profilePictureValue = `/img/profile_images/${req.file.filename}`;
        } else if (removeProfilePicture === "1" || removeProfilePicture === "on") {
            profilePictureValue = DEFAULT_PROFILE_AVATAR;
        }

        const countryVal = countryLocation && String(countryLocation).trim() ? String(countryLocation).trim() : null;
        const instVal = institution && String(institution).trim() ? String(institution).trim() : null;

        const gh = normalizeProfileUrl(github);
        const li = normalizeProfileUrl(linkedin);
        const web = normalizeProfileUrl(personalWebsite);

        const base = [
            fullName != null ? String(fullName) : "",
            bioTrim,
            countryVal,
            instVal,
            gh,
            li,
            web,
            uname,
        ];

        if (profilePictureValue !== undefined) {
            await pool.query(
                `UPDATE users SET
                    full_name = $1,
                    bio = $2,
                    country_location = $3,
                    institution = $4,
                    github = $5,
                    linkedin = $6,
                    personal_website = $7,
                    username = $8,
                    instagram = NULL,
                    profile_picture = $9
                WHERE id = $10`,
                [...base, profilePictureValue, req.session.userId]
            );
        } else {
            await pool.query(
                `UPDATE users SET
                    full_name = $1,
                    bio = $2,
                    country_location = $3,
                    institution = $4,
                    github = $5,
                    linkedin = $6,
                    personal_website = $7,
                    username = $8,
                    instagram = NULL
                WHERE id = $9`,
                [...base, req.session.userId]
            );
        }

        req.session.username = uname;

        res.redirect(
            `/${lang}/settings?tab=profile&success=${encodeURIComponent(i18n.__("settings.messages.profileSaved"))}`
        );
    } catch (error) {
        console.error(error);
        res.redirect(
            `/${lang}/settings?tab=profile&error=${encodeURIComponent(i18n.__("settings.errors.profileUpdateFailed"))}`
        );
    }
});

// Privacy settings update
app.post("/:lang/settings/privacy", checkAuthenticated, async (req, res) => {
    const { lang } = req.params;
    i18n.setLocale(res, lang);
    const { publicProfile, emailNotifications, showCountryOnLeaderboard } = req.body;

    // Build notification_settings from form checkboxes
    const notifSettings = {
        comment_on_solution: !!req.body.notif_comment_on_solution,
        reply_to_comment: !!req.body.notif_reply_to_comment,
        solution_liked: !!req.body.notif_solution_liked,
        new_follower: !!req.body.notif_new_follower,
        forum_reply: !!req.body.notif_forum_reply,
        challenge_result: !!req.body.notif_challenge_result,
        report_resolved: true, // always on
        forum_solution: true,  // always on
    };

    try {
        await pool.query(
            `INSERT INTO user_preferences (user_id, public_profile, show_online_status, email_notifications, privacy_level, show_country_on_leaderboard, notification_settings)
             VALUES ($1, $2, false, $3, 'public', $4, $5)
             ON CONFLICT (user_id)
             DO UPDATE SET
                public_profile = EXCLUDED.public_profile,
                email_notifications = EXCLUDED.email_notifications,
                show_country_on_leaderboard = EXCLUDED.show_country_on_leaderboard,
                notification_settings = EXCLUDED.notification_settings,
                updated_at = NOW()`,
            [req.session.userId, !!publicProfile, !!emailNotifications, !!showCountryOnLeaderboard, JSON.stringify(notifSettings)]
        );

        res.redirect(
            `/${lang}/settings?tab=privacy&success=${encodeURIComponent(i18n.__("settings.messages.privacySaved"))}`
        );
    } catch (error) {
        console.error(error);
        res.redirect(
            `/${lang}/settings?tab=privacy&error=${encodeURIComponent(i18n.__("settings.errors.privacyUpdateFailed"))}`
        );
    }
});

// Password update for settings
app.post("/:lang/settings/password", checkAuthenticated, async (req, res) => {
    const { lang } = req.params;
    i18n.setLocale(res, lang);
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (newPassword !== confirmPassword) {
        return res.redirect(
            `/${lang}/settings?tab=password&error=${encodeURIComponent(i18n.__("settings.errors.passwordMismatch"))}`
        );
    }

    if (String(newPassword || "").length < 8) {
        return res.redirect(
            `/${lang}/settings?tab=password&error=${encodeURIComponent(i18n.__("settings.errors.passwordTooShort"))}`
        );
    }

    try {
        const result = await pool.query(
            "SELECT password FROM users WHERE id = $1",
            [req.session.userId]
        );

        const validPassword = await bcrypt.compare(currentPassword, result.rows[0].password);

        if (!validPassword) {
            return res.redirect(
                `/${lang}/settings?tab=password&error=${encodeURIComponent(i18n.__("settings.errors.currentPasswordWrong"))}`
            );
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query(
            "UPDATE users SET password = $1 WHERE id = $2",
            [hashedPassword, req.session.userId]
        );

        res.redirect(
            `/${lang}/settings?tab=password&success=${encodeURIComponent(i18n.__("settings.messages.passwordSaved"))}`
        );
    } catch (error) {
        console.error(error);
        res.redirect(
            `/${lang}/settings?tab=password&error=${encodeURIComponent(i18n.__("settings.errors.passwordUpdateFailed"))}`
        );
    }
});

// Username availability (settings page)
app.get("/:lang/api/username-available", async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ available: false });
    }
    const candidate = String(req.query.u || "").trim();
    if (!candidate || /\s/.test(candidate)) {
        return res.json({ available: false });
    }
    try {
        const r = await pool.query(
            "SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2",
            [candidate, req.session.userId]
        );
        res.json({ available: r.rows.length === 0 });
    } catch (e) {
        console.error(e);
        res.status(500).json({ available: false });
    }
});

// Request email change (confirmation link — configure SMTP in production to email the link)
app.post("/:lang/settings/account/email", checkAuthenticated, async (req, res) => {
    const { lang } = req.params;
    i18n.setLocale(res, lang);
    const { newEmail, currentPassword } = req.body;
    const email = String(newEmail || "").trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.redirect(
            `/${lang}/settings?tab=account&error=${encodeURIComponent(i18n.__("settings.errors.invalidEmail"))}`
        );
    }

    try {
        const userRow = await pool.query(
            "SELECT id, email, password FROM users WHERE id = $1",
            [req.session.userId]
        );
        const u = userRow.rows[0];
        const ok = await bcrypt.compare(String(currentPassword || ""), u.password);
        if (!ok) {
            return res.redirect(
                `/${lang}/settings?tab=account&error=${encodeURIComponent(i18n.__("settings.errors.currentPasswordWrong"))}`
            );
        }
        if (email === String(u.email).toLowerCase()) {
            return res.redirect(
                `/${lang}/settings?tab=account&error=${encodeURIComponent(i18n.__("settings.errors.emailUnchanged"))}`
            );
        }
        const taken = await pool.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2", [
            email,
            req.session.userId,
        ]);
        if (taken.rows.length > 0) {
            return res.redirect(
                `/${lang}/settings?tab=account&error=${encodeURIComponent(i18n.__("settings.errors.emailTaken"))}`
            );
        }

        const token = crypto.randomBytes(32).toString("hex");
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await pool.query(
            `UPDATE users SET pending_email = $1, email_change_token = $2, email_change_expires = $3 WHERE id = $4`,
            [email, token, expires, req.session.userId]
        );

        const confirmUrl = `${req.protocol}://${req.get("host")}/${lang}/settings/confirm-email?token=${token}`;
        if (process.env.NODE_ENV !== "production") {
            console.log("[email change] confirmation URL:", confirmUrl);
        }

        res.redirect(
            `/${lang}/settings?tab=account&success=${encodeURIComponent(i18n.__("settings.messages.emailChangePending"))}`
        );
    } catch (error) {
        console.error(error);
        res.redirect(
            `/${lang}/settings?tab=account&error=${encodeURIComponent(i18n.__("settings.errors.emailChangeFailed"))}`
        );
    }
});

app.get("/:lang/settings/confirm-email", async (req, res) => {
    const { lang } = req.params;
    i18n.setLocale(res, lang);
    const token = String(req.query.token || "");
    if (!token) {
        return res.redirect(`/${lang}/login?error=${encodeURIComponent(i18n.__("settings.errors.invalidToken"))}`);
    }
    try {
        const r = await pool.query(
            "SELECT id, pending_email, email_change_expires FROM users WHERE email_change_token = $1",
            [token]
        );
        if (r.rows.length === 0) {
            return res.redirect(`/${lang}/settings?tab=account&error=${encodeURIComponent(i18n.__("settings.errors.invalidToken"))}`);
        }
        const row = r.rows[0];
        if (!row.pending_email || !row.email_change_expires || new Date(row.email_change_expires) < new Date()) {
            return res.redirect(`/${lang}/settings?tab=account&error=${encodeURIComponent(i18n.__("settings.errors.invalidToken"))}`);
        }
        await pool.query(
            `UPDATE users SET email = $1, pending_email = NULL, email_change_token = NULL, email_change_expires = NULL WHERE id = $2`,
            [row.pending_email, row.id]
        );
        res.redirect(
            `/${lang}/settings?tab=account&success=${encodeURIComponent(i18n.__("settings.messages.emailConfirmed"))}`
        );
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/settings?tab=account&error=${encodeURIComponent(i18n.__("settings.errors.emailChangeFailed"))}`);
    }
});

app.post("/:lang/settings/account/delete", checkAuthenticated, async (req, res) => {
    const { lang } = req.params;
    i18n.setLocale(res, lang);
    const { password } = req.body;
    try {
        const result = await pool.query("SELECT password FROM users WHERE id = $1", [req.session.userId]);
        const valid = await bcrypt.compare(String(password || ""), result.rows[0].password);
        if (!valid) {
            return res.redirect(
                `/${lang}/settings?tab=account&error=${encodeURIComponent(i18n.__("settings.errors.currentPasswordWrong"))}`
            );
        }
        await pool.query("DELETE FROM users WHERE id = $1", [req.session.userId]);
        req.session.destroy(() => {
            res.redirect(`/${lang}/login?success=${encodeURIComponent(i18n.__("settings.messages.accountDeleted"))}`);
        });
    } catch (error) {
        console.error(error);
        res.redirect(
            `/${lang}/settings?tab=account&error=${encodeURIComponent(i18n.__("settings.errors.deleteAccountFailed"))}`
        );
    }
});

// Social Media API Routes

// Follow/Unfollow user
app.post("/api/follow/:userId", checkAuthenticated, async (req, res) => {
    const { userId } = req.params;
    const followerId = req.session.userId;

    if (followerId === parseInt(userId)) {
        return res.status(400).json({ error: "You cannot follow yourself" });
    }

    try {
        // Check if already following
        const existingFollow = await pool.query(
            "SELECT id FROM user_follows WHERE follower_id = $1 AND following_id = $2",
            [followerId, userId]
        );

        if (existingFollow.rows.length > 0) {
            // Unfollow
            await pool.query(
                "DELETE FROM user_follows WHERE follower_id = $1 AND following_id = $2",
                [followerId, userId]
            );
            
            // Log activity
            await pool.query(
                "INSERT INTO user_activities (user_id, activity_type, target_user_id) VALUES ($1, $2, $3)",
                [followerId, 'unfollow', userId]
            );

            res.json({ following: false, message: "Unfollowed successfully" });
        } else {
            // Follow
            await pool.query(
                "INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2)",
                [followerId, userId]
            );

            // Log activity
            await pool.query(
                "INSERT INTO user_activities (user_id, activity_type, target_user_id) VALUES ($1, $2, $3)",
                [followerId, 'follow', userId]
            );

            // Notify the followed user
            try {
                const followerResult = await pool.query('SELECT username FROM users WHERE id = $1', [followerId]);
                const followerName = followerResult.rows[0]?.username || 'Someone';
                await notifications.createNotification(
                    parseInt(userId),
                    'new_follower',
                    `${followerName} started following you`,
                    null,
                    `/user/${followerName}`,
                    followerId
                );
            } catch (notifErr) { console.error('Notification error (follow):', notifErr); }

            res.json({ following: true, message: "Followed successfully" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to follow/unfollow user" });
    }
});

// Like/Unlike solution
app.post("/api/solutions/:problemName/:language/like", checkAuthenticated, async (req, res) => {
    const { problemName, language } = req.params;
    const { isLike } = req.body; // true for like, false for dislike
    const userId = req.session.userId;

    try {
        // Check if already liked/disliked
        const existingLike = await pool.query(
            "SELECT id, is_like FROM solution_likes WHERE user_id = $1 AND problem_name = $2 AND language = $3",
            [userId, problemName, language]
        );

        if (existingLike.rows.length > 0) {
            const currentLike = existingLike.rows[0];
            
            if (currentLike.is_like === isLike) {
                // Remove like/dislike
                await pool.query(
                    "DELETE FROM solution_likes WHERE user_id = $1 AND problem_name = $2 AND language = $3",
                    [userId, problemName, language]
                );
                
                res.json({ action: 'removed', isLike: null });
            } else {
                // Update like/dislike
                await pool.query(
                    "UPDATE solution_likes SET is_like = $1 WHERE user_id = $2 AND problem_name = $3 AND language = $4",
                    [isLike, userId, problemName, language]
                );
                
                res.json({ action: 'updated', isLike });
            }
        } else {
            // Add new like/dislike
            await pool.query(
                "INSERT INTO solution_likes (user_id, problem_name, language, is_like) VALUES ($1, $2, $3, $4)",
                [userId, problemName, language, isLike]
            );
            
            // Log activity
            await pool.query(
                "INSERT INTO user_activities (user_id, activity_type, target_problem, target_language, metadata) VALUES ($1, $2, $3, $4, $5)",
                [userId, 'like', problemName, language, JSON.stringify({ isLike })]
            );

            // Notify primary contributor (debounce: max 1 like notification per problem per hour)
            if (isLike) {
                try {
                    const likerResult = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
                    const likerName = likerResult.rows[0]?.username || 'Someone';
                    const contribResult = await pool.query(
                        `SELECT DISTINCT user_id FROM contributions
                         WHERE problem_name = $1 AND user_id IS NOT NULL AND user_id != $2
                         ORDER BY user_id LIMIT 1`,
                        [problemName, userId]
                    );
                    if (contribResult.rows.length > 0) {
                        const recipientId = contribResult.rows[0].user_id;
                        const hasRecent = await notifications.hasRecentLikeNotification(recipientId, problemName);
                        if (!hasRecent) {
                            await notifications.createNotification(
                                recipientId,
                                'solution_liked',
                                `${likerName} liked your solution for ${problemName}`,
                                null,
                                `/${language}/${problemName}`,
                                userId
                            );
                        }
                    }
                } catch (notifErr) { console.error('Notification error (like):', notifErr); }
            }

            res.json({ action: 'added', isLike });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to like/dislike solution" });
    }
});

// Star/Unstar solution
app.post("/api/solutions/:problemName/:language/star", checkAuthenticated, async (req, res) => {
    const { problemName, language } = req.params;
    const userId = req.session.userId;

    try {
        // Check if already starred
        const existingStar = await pool.query(
            "SELECT id FROM starred_solutions WHERE user_id = $1 AND problem_name = $2 AND language = $3",
            [userId, problemName, language]
        );

        if (existingStar.rows.length > 0) {
            // Unstar
            await pool.query(
                "DELETE FROM starred_solutions WHERE user_id = $1 AND problem_name = $2 AND language = $3",
                [userId, problemName, language]
            );
            
            res.json({ starred: false, message: "Removed from favorites" });
        } else {
            // Star
            await pool.query(
                "INSERT INTO starred_solutions (user_id, problem_name, language) VALUES ($1, $2, $3)",
                [userId, problemName, language]
            );
            
            // Log activity
            await pool.query(
                "INSERT INTO user_activities (user_id, activity_type, target_problem, target_language) VALUES ($1, $2, $3, $4)",
                [userId, 'star', problemName, language]
            );
            
            res.json({ starred: true, message: "Added to favorites" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to star/unstar solution" });
    }
});

// Get solution stats (likes, dislikes, stars, comments)
app.get("/api/solutions/:problemName/:language/stats", async (req, res) => {
    const { problemName, language } = req.params;
    const userId = req.session.userId;

    try {
        // Get likes/dislikes count
        const likesResult = await pool.query(
            `SELECT 
                COUNT(CASE WHEN is_like = true THEN 1 END) as likes,
                COUNT(CASE WHEN is_like = false THEN 1 END) as dislikes
            FROM solution_likes 
            WHERE problem_name = $1 AND language = $2`,
            [problemName, language]
        );

        // Get stars count
        const starsResult = await pool.query(
            "SELECT COUNT(*) as stars FROM starred_solutions WHERE problem_name = $1 AND language = $2",
            [problemName, language]
        );

        // Get comments count
        const commentsResult = await pool.query(
            "SELECT COUNT(*) as comments FROM solution_comments WHERE problem_name = $1 AND language = $2 AND is_deleted = false",
            [problemName, language]
        );

        // Get user's interaction status
        let userInteraction = { liked: null, starred: false };
        
        if (userId) {
            const userLikeResult = await pool.query(
                "SELECT is_like FROM solution_likes WHERE user_id = $1 AND problem_name = $2 AND language = $3",
                [userId, problemName, language]
            );
            
            const userStarResult = await pool.query(
                "SELECT id FROM starred_solutions WHERE user_id = $1 AND problem_name = $2 AND language = $3",
                [userId, problemName, language]
            );

            if (userLikeResult.rows.length > 0) {
                userInteraction.liked = userLikeResult.rows[0].is_like;
            }
            
            userInteraction.starred = userStarResult.rows.length > 0;
        }

        res.json({
            likes: parseInt(likesResult.rows[0].likes),
            dislikes: parseInt(likesResult.rows[0].dislikes),
            stars: parseInt(starsResult.rows[0].stars),
            comments: parseInt(commentsResult.rows[0].comments),
            userInteraction
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to get solution stats" });
    }
});

// Get comments for a solution
app.get("/api/solutions/:problemName/:language/comments", async (req, res) => {
    const { problemName, language } = req.params;

    try {
        const result = await pool.query(
            `SELECT
                c.id, c.user_id, c.content, c.parent_id, c.created_at, c.updated_at,
                u.username, u.full_name, u.profile_picture
            FROM solution_comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.problem_name = $1 AND c.language = $2 AND c.is_deleted = false
            ORDER BY c.created_at ASC`,
            [problemName, language]
        );

        const currentUserId = req.session.userId || null;
        const now = new Date();

        const comments = result.rows.map(row => {
            const isOwnComment = currentUserId && row.user_id === currentUserId;
            const createdAt = new Date(row.created_at);
            const hoursSinceCreation = (now - createdAt) / (1000 * 60 * 60);
            const isEditable = isOwnComment && hoursSinceCreation <= 24;

            return {
                id: row.id,
                content: row.content,
                parentId: row.parent_id,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                isOwnComment,
                isEditable,
                author: {
                    username: row.username,
                    fullName: row.full_name,
                    profilePicture: row.profile_picture || DEFAULT_PROFILE_AVATAR
                }
            };
        });

        res.json({ comments });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to get comments" });
    }
});

// Add comment to solution
app.post("/api/solutions/:problemName/:language/comments", checkAuthenticated, async (req, res) => {
    const { problemName, language } = req.params;
    const { content, parentId } = req.body;
    const userId = req.session.userId;

    if (!content || content.trim().length === 0) {
        return res.status(400).json({ error: "Comment content is required" });
    }

    try {
        const result = await pool.query(
            "INSERT INTO solution_comments (user_id, problem_name, language, content, parent_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at",
            [userId, problemName, language, content.trim(), parentId || null]
        );

        // Get user info for response
        const userResult = await pool.query(
            "SELECT username, full_name, profile_picture FROM users WHERE id = $1",
            [userId]
        );
        const user = userResult.rows[0];

        // Log activity
        await pool.query(
            "INSERT INTO user_activities (user_id, activity_type, target_problem, target_language, metadata) VALUES ($1, $2, $3, $4, $5)",
            [userId, 'comment', problemName, language, JSON.stringify({ commentId: result.rows[0].id })]
        );

        // Notify: if this is a reply, notify parent comment author
        if (parentId) {
            try {
                const parentResult = await pool.query(
                    'SELECT user_id FROM solution_comments WHERE id = $1', [parentId]
                );
                if (parentResult.rows.length > 0 && parentResult.rows[0].user_id) {
                    await notifications.createNotification(
                        parentResult.rows[0].user_id,
                        'reply_to_comment',
                        `${user.username} replied to your comment`,
                        `On problem ${problemName}`,
                        `/${language}/${problemName}`,
                        userId
                    );
                }
            } catch (notifErr) { console.error('Notification error (reply):', notifErr); }
        }

        // Notify: all contributors of this problem (except the commenter)
        try {
            const contribResult = await pool.query(
                `SELECT DISTINCT user_id FROM contributions
                 WHERE problem_name = $1 AND user_id IS NOT NULL AND user_id != $2
                 UNION
                 SELECT DISTINCT user_id FROM github_contributions
                 WHERE problem_name = $1 AND user_id IS NOT NULL AND user_id != $2`,
                [problemName, userId]
            );
            for (const row of contribResult.rows) {
                await notifications.createNotification(
                    row.user_id,
                    'comment_on_solution',
                    `${user.username} commented on ${problemName}`,
                    content.trim().slice(0, 100),
                    `/${language}/${problemName}`,
                    userId
                );
            }
        } catch (notifErr) { console.error('Notification error (comment):', notifErr); }

        res.json({
            id: result.rows[0].id,
            content: content.trim(),
            parentId: parentId || null,
            createdAt: result.rows[0].created_at,
            author: {
                username: user.username,
                fullName: user.full_name,
                profilePicture: user.profile_picture || DEFAULT_PROFILE_AVATAR
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to add comment" });
    }
});

// Edit a comment (within 24 hours)
app.put("/api/solutions/:problemName/:language/comments/:commentId", checkAuthenticated, async (req, res) => {
    const { commentId } = req.params;
    const { content } = req.body;
    const userId = req.session.userId;

    if (!content || content.trim().length === 0) {
        return res.status(400).json({ error: "Comment content is required" });
    }

    try {
        const result = await pool.query(
            "SELECT id, user_id, created_at FROM solution_comments WHERE id = $1 AND is_deleted = false",
            [commentId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Comment not found" });
        }

        const comment = result.rows[0];
        if (comment.user_id !== userId) {
            return res.status(403).json({ error: "You can only edit your own comments" });
        }

        const hoursSinceCreation = (new Date() - new Date(comment.created_at)) / (1000 * 60 * 60);
        if (hoursSinceCreation > 24) {
            return res.status(403).json({ error: "Comments can only be edited within 24 hours of posting" });
        }

        await pool.query(
            "UPDATE solution_comments SET content = $1, updated_at = NOW() WHERE id = $2",
            [content.trim(), commentId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to edit comment" });
    }
});

// Search users for @mention autocomplete
app.get("/api/users/search", async (req, res) => {
    const q = (req.query.q || "").trim();
    if (q.length < 2) {
        return res.json({ users: [] });
    }

    try {
        const result = await pool.query(
            `SELECT username, full_name, profile_picture
            FROM users
            WHERE username ILIKE $1 OR full_name ILIKE $1
            ORDER BY username ASC
            LIMIT 8`,
            [`%${q}%`]
        );

        res.json({
            users: result.rows.map(row => ({
                username: row.username,
                fullName: row.full_name,
                profilePicture: row.profile_picture || DEFAULT_PROFILE_AVATAR
            }))
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to search users" });
    }
});

// Search problems for #problem autocomplete
app.get("/api/problems/search", (req, res) => {
    const q = (req.query.q || "").trim();
    const lang = req.query.lang || "en";

    if (q.length < 2) {
        return res.json({ problems: [] });
    }

    try {
        const { readCSV } = require("./parents");
        const sectionsCSV = lang === "ru" ? "src/ru/database/sections.csv" : "src/database/sections.csv";
        const sectionNumbers = readCSV(sectionsCSV, 0);
        const sectionTitles = readCSV(sectionsCSV, 1);
        const sectionMaximums = readCSV(sectionsCSV, 2);

        const results = [];
        for (let i = 0; i < sectionNumbers.length; i++) {
            const secNum = sectionNumbers[i];
            const max = parseInt(sectionMaximums[i], 10);
            for (let p = 1; p <= max; p++) {
                const problemName = `${secNum}.${p}`;
                if (problemName.startsWith(q)) {
                    results.push({
                        name: problemName,
                        sectionTitle: sectionTitles[i]
                    });
                    if (results.length >= 10) break;
                }
            }
            if (results.length >= 10) break;
        }

        res.json({ problems: results });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to search problems" });
    }
});

// ─── Notification API ────────────────────────────────────────

// Get notifications for current user (JSON)
app.get("/api/notifications", checkAuthenticated, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const offset = parseInt(req.query.offset) || 0;
        const items = await notifications.getNotifications(req.session.userId, limit, offset);
        res.json({ notifications: items });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to get notifications" });
    }
});

// Mark single notification as read
app.post("/api/notifications/:id/read", checkAuthenticated, async (req, res) => {
    try {
        await notifications.markAsRead(parseInt(req.params.id), req.session.userId);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to mark notification as read" });
    }
});

// Mark all notifications as read
app.post("/api/notifications/read-all", checkAuthenticated, async (req, res) => {
    try {
        await notifications.markAllAsRead(req.session.userId);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to mark notifications as read" });
    }
});

// Full notifications page
app.get("/notifications", checkAuthenticated, async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const perPage = 50;
        const offset = (page - 1) * perPage;
        const [items, total] = await Promise.all([
            notifications.getNotifications(req.session.userId, perPage, offset),
            notifications.getNotificationCount(req.session.userId),
        ]);
        const totalPages = Math.ceil(total / perPage);

        // Get current user info for header
        const currentUserResult = await pool.query(
            "SELECT username, profile_picture FROM users WHERE id = $1",
            [req.session.userId]
        );
        const currentUser = currentUserResult.rows[0];

        res.render("notifications", {
            __: i18n.__,
            lang,
            notifications: items,
            page,
            totalPages,
            total,
            usernameCurrent: currentUser?.username || null,
            profilePictureCurrent: currentUser?.profile_picture || DEFAULT_PROFILE_AVATAR,
            sessionUsername: req.session.username || null,
        });
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/?error=Failed to load notifications`);
    }
});

// Add a new route for user profiles
app.get("/user/:username", getUserProfile);

app.post("/create-problem", checkAuthenticated, async (req, res) => {
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
        // console.log(`Problem file created: ${filePath}`);

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

// Forgot password
app.get("/forgot-password", (req, res) => {
    const lang = req.query.lang || 'en';
    i18n.setLocale(res, lang);
    res.render("forgot_password", {
        __: i18n.__,
        lang,
        error: req.query.error || "",
        success: req.query.success || "",
    });
});

app.post("/forgot-password", async (req, res) => {
    const { email, lang = 'en' } = req.body;
    i18n.setLocale(res, lang);

    try {
        const result = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';

        let token = null;
        let userId = null;

        if (result.rows.length > 0) {
            userId = result.rows[0].id;
            token = crypto.randomBytes(32).toString('hex');
            const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

            await pool.query(
                "UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3",
                [token, expires, userId]
            );
        }

        // Log the request for admin review
        try {
            await pool.query(
                `INSERT INTO password_reset_requests (email, user_id, reset_token, ip_address)
                 VALUES ($1, $2, $3, $4)`,
                [email, userId, token, ip]
            );
        } catch (logErr) {
            console.error('Error logging password reset request:', logErr);
        }

        // Always show the same message (don't reveal if email exists)
        res.redirect(`/forgot-password?lang=${lang}&success=${encodeURIComponent(
            lang === 'ru'
                ? 'Если аккаунт с таким адресом существует, ссылка для сброса была отправлена.'
                : 'If an account exists with that email, a reset link has been sent.'
        )}`);
    } catch (error) {
        console.error('Forgot password error:', error);
        res.redirect(`/forgot-password?lang=${lang}&error=${encodeURIComponent(
            lang === 'ru' ? 'Произошла ошибка. Попробуйте позже.' : 'Something went wrong. Please try again.'
        )}`);
    }
});

// Reset password
app.get("/reset-password", async (req, res) => {
    const { token, lang: queryLang } = req.query;
    const lang = queryLang || 'en';
    i18n.setLocale(res, lang);

    if (!token) {
        return res.redirect(`/${lang}/login`);
    }

    try {
        const result = await pool.query(
            "SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()",
            [token]
        );

        if (result.rows.length === 0) {
            return res.render("reset_password", {
                __: i18n.__,
                lang,
                token: "",
                error: lang === 'ru'
                    ? 'Ссылка для сброса недействительна или истекла.'
                    : 'This reset link is invalid or has expired.',
            });
        }

        res.render("reset_password", {
            __: i18n.__,
            lang,
            token,
            error: "",
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.redirect(`/${lang}/login`);
    }
});

app.post("/reset-password", async (req, res) => {
    const { token, password, confirmPassword, lang = 'en' } = req.body;
    i18n.setLocale(res, lang);

    if (!token || !password || !confirmPassword) {
        return res.redirect(`/${lang}/login`);
    }

    if (password !== confirmPassword) {
        return res.redirect(`/reset-password?token=${token}&lang=${lang}&error=${encodeURIComponent(
            lang === 'ru' ? 'Пароли не совпадают.' : 'Passwords do not match.'
        )}`);
    }

    if (password.length < 8) {
        return res.redirect(`/reset-password?token=${token}&lang=${lang}&error=${encodeURIComponent(
            lang === 'ru' ? 'Пароль должен быть не менее 8 символов.' : 'Password must be at least 8 characters.'
        )}`);
    }

    try {
        const result = await pool.query(
            "SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()",
            [token]
        );

        if (result.rows.length === 0) {
            return res.redirect(`/${lang}/login?error=${encodeURIComponent(
                lang === 'ru' ? 'Ссылка для сброса недействительна или истекла.' : 'Reset link is invalid or has expired.'
            )}`);
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            "UPDATE users SET password = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2",
            [hashedPassword, result.rows[0].id]
        );

        res.redirect(`/${lang}/login?success=${encodeURIComponent(
            lang === 'ru' ? 'Пароль обновлён. Войдите в аккаунт.' : 'Password updated. Please log in.'
        )}`);
    } catch (error) {
        console.error('Reset password error:', error);
        res.redirect(`/${lang}/login?error=${encodeURIComponent(
            lang === 'ru' ? 'Произошла ошибка.' : 'Something went wrong.'
        )}`);
    }
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
app.post("/register", registerLimiter, async (req, res) => {
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
        const newUser = await pool.query(
            "INSERT INTO users (username, email, full_name, password) VALUES ($1, $2, $3, $4) RETURNING id",
            [username, email, fullname, hashedPassword]
        );

        // Auto-add to global group chat
        try {
            const globalChat = await pool.query(
                `SELECT id FROM conversations WHERE title = 'Savchenko Solutions' AND is_group = TRUE ORDER BY created_at ASC LIMIT 1`
            );
            if (globalChat.rows.length > 0) {
                await pool.query(
                    `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [globalChat.rows[0].id, newUser.rows[0].id]
                );
            }
        } catch (e) {
            console.error('Failed to add user to global chat:', e);
        }

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
app.post("/login", loginLimiter, async (req, res) => {
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
        // console.log(userResult);
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
    const [recentContributions, topAuthors, solutionProgress, challengeWidget] = await Promise.all([
        getRecentContributions(10),
        getTopAuthors(),
        renderUnsolvedList.getSolutionProgressStats(lang),
        getCurrentChallengeWidget(),
    ]);

    i18n.setLocale(res, lang);
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;

    const userAgent = req.headers['user-agent'];
    const isMobile = /mobile/i.test(userAgent);
    const working_page = isMobile ? "eng_page" : "eng_page";

    res.render(working_page, {
        __: i18n.__,
        title: i18n.__('title'),
        chapters,
        theory,
        username: res.locals.username,
        userId: res.locals.userId,
        sections,
        pinnedChapters,
        lang,
        recentContributions,
        topAuthors,
        solutionProgress,
        challengeWidget,
    });
});

async function getRecentContributions(limit) {
    try {
        const result = await pool.query(
            `SELECT c.id, c.problem_name, c.user_id, c.edited_at AT TIME ZONE 'UTC' as edited_at, c.ip_address, c.invisible,
                    u.username,
                    (SELECT COUNT(*) FROM contributions c2 WHERE c2.problem_name = c.problem_name AND c2.invisible IS NOT TRUE AND c2.edited_at <= c.edited_at) AS edit_number
             FROM contributions c
             LEFT JOIN users u ON c.user_id = u.id
             WHERE c.invisible IS NOT TRUE
             ORDER BY c.edited_at DESC LIMIT $1`,
            [limit]
        );

        const contributions = result.rows.map(row => {
            return {
                version: row.problem_name,
                editor: row.username || 'Anonymous',
                hasUser: !!row.username,
                isNew: parseInt(row.edit_number) === 1,
                timestamp: new Intl.DateTimeFormat(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    month: 'short',
                    day: '2-digit',
                    timeZoneName: 'short'
                }).format(row.edited_at),
                relativeTime: row.edited_at,
                id: row.id
            };
        });

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

registerContributorAndUserMetricsApi({
    app,
    pool,
    baseDir: __dirname,
});

// Update the /ru route to use i18n.setLocale instead
app.get("/ru", async (req, res) => {
    const { chapters, theory, sections, pinnedChapters } = await getLanguageData('ru');
    const [recentContributions, topAuthors, solutionProgress, challengeWidget] = await Promise.all([
        getRecentContributions(10),
        getTopAuthors(),
        renderUnsolvedList.getSolutionProgressStats('ru'),
        getCurrentChallengeWidget(),
    ]);
    i18n.setLocale(res, 'ru');
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;

    const userAgent = req.headers['user-agent'];
    const isMobile = /mobile/i.test(userAgent);
    const working_page = isMobile ? "eng_page" : "eng_page";

    res.render(working_page, {
        __: i18n.__,
        title: i18n.__('title'),
        chapters,
        theory,
        username: res.locals.username,
        userId: res.locals.userId,
        sections,
        pinnedChapters,
        lang: 'ru',
        recentContributions,
        topAuthors,
        solutionProgress,
        challengeWidget,
    });
});

// Admin dashboard
app.use('/admin', adminRouter);

// Blog
app.use('/:lang(en|ru)/blog', blogRouter);
app.use('/blog', blogRouter);

// Physics tools
app.use('/:lang/tools', toolsRouter);
app.use('/tools', toolsRouter);

// Problem Bank
app.use('/bank', bankRouter);

// Discussion Forum
app.use('/discuss', forumRouter);

// Messages
app.use('/messages', messagesRouter);

// Weekly Challenges
app.use('/compete', challengesRouter);

// Monthly Contest (live dashboard)
app.use('/:lang(en|ru)/challenge', contestRouter);
app.use('/challenge', contestRouter);

// Study Paths
app.use('/paths', pathsRouter);

// Remove the old upload routes and add the new router
app.use('/', uploadRouter);

app.get("/en", async (req, res) => {
    const { chapters, theory, sections, pinnedChapters } = await getLanguageData('en');
    const [recentContributions, topAuthors, solutionProgress, challengeWidget] = await Promise.all([
        getRecentContributions(10),
        getTopAuthors(),
        renderUnsolvedList.getSolutionProgressStats('en'),
        getCurrentChallengeWidget(),
    ]);
    i18n.setLocale(res, 'en');
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;

    const userAgent = req.headers['user-agent'];
    const isMobile = /mobile/i.test(userAgent);
    const working_page = isMobile ? "eng_page" : "eng_page";

    res.render(working_page, {
        __: i18n.__,
        title: i18n.__('title'),
        chapters,
        theory,
        username: res.locals.username,
        userId: res.locals.userId,
        sections,
        pinnedChapters,
        lang: 'en',
        recentContributions,
        topAuthors,
        solutionProgress,
        challengeWidget,
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

// Summit page routes
app.get("/summit", (req, res) => {
    i18n.setLocale(res, 'ru'); // Default to Russian for summit
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;
    
    res.render("summit", {
        lang: 'ru',
        __: i18n.__,
        username: res.locals.username,
        userId: res.locals.userId
    });
});

app.get("/ru/summit", (req, res) => {
    i18n.setLocale(res, 'ru');
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;
    
    res.render("summit", {
        lang: 'ru',
        __: i18n.__,
        username: res.locals.username,
        userId: res.locals.userId
    });
});

// Add these routes before your other routes
app.get('/unsolved', renderUnsolvedList);
app.get('/:lang/unsolved', renderUnsolvedList);

app.get(["/study-guide", "/:lang/study-guide"], (req, res) => {
    const lang = req.params.lang || 'en';
    i18n.setLocale(res, lang);

    res.render("study-guide", {
        __: i18n.__,
        lang
    });
});

app.get(["/community-guidelines", "/:lang/community-guidelines"], (req, res) => {
    const lang = req.params.lang || 'en';
    i18n.setLocale(res, lang);

    const template = lang === 'ru' ? 'community_guidelines_ru' : 'community_guidelines_en';
    res.render(template, {
        __: i18n.__,
        lang
    });
});

// Contributors leaderboard — MUST be registered before `/:lang/:name` or "contributors" is treated as a problem slug (404).
async function handleContributorsRanking(req, res) {
    const lang = req.params.lang || "en";
    i18n.setLocale(res, lang);
    try {
        res.render("contributors_ranking", {
            __: i18n.__,
            lang,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (error) {
        console.error("Error fetching contributors:", error);
        res.status(500).render("404", {
            __: i18n.__,
            pageUrl: req.originalUrl,
            lang,
        });
    }
}

app.get(["/contributors", "/:lang/contributors"], handleContributorsRanking);

// Russian breadcrumb targets: /ru/1 and /ru/1,1 → main catalog anchors (not problem files)
app.get("/:lang/:name", (req, res, next) => {
    const { lang, name } = req.params;
    if (name === "contributors") {
        return handleContributorsRanking(req, res);
    }
    if (lang === "ru" && /^\d+$/.test(name)) {
        return res.redirect(302, `/ru/#${name}`);
    }
    if (lang === "ru" && /^\d+,\d+$/.test(name)) {
        return res.redirect(302, `/ru/#${name.replace(/,/g, ".")}`);
    }
    return renderPost(req, res).catch(next);
}); // Use the renderPost function for this route

app.get("/:lang/edit/:name", (req, res) => {
    const { lang, name } = req.params;
    if (!isValidSolutionLang(lang) || !isValidSolutionProblemName(name)) {
        i18n.setLocale(res, isValidSolutionLang(lang) ? lang : "en");
        return res.status(404).render("404", {
            __: i18n.__,
            pageUrl: req.originalUrl,
            lang: isValidSolutionLang(lang) ? lang : "en",
        });
    }
    const filePath = path.join(__dirname, `posts/${lang}`, `${name}.md`);

    if (fs.existsSync(filePath)) {
        let fileContents = fs.readFileSync(filePath, "utf8");
        i18n.setLocale(res, lang);
        res.render("edit_post", {
            __: i18n.__,
            lang,
            name,
            content: fileContents,
            title: lang === 'ru' ? `Изменить решение - ${name}` : `Edit Solution - ${name}`,
            userId: req.session.userId || null,
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

// IP blocklist is now in the database (blocked_ips table).
// Use isIpBlocked(ip) from admin.js to check.

function editSaveWantsJson(req) {
    const accept = req.get("Accept") || "";
    return accept.includes("application/json");
}

// Route for saving edited content
app.post("/:lang/save/:name", checkAuthenticated, editSaveLimiter, async (req, res) => {
    const { lang, name } = req.params;
    const { content } = req.body;
    const userId = req.session.userId || null; // Will be null for unauthenticated users
    const clientIp = req.headers["x-forwarded-for"] || req.ip;

    if (!isValidSolutionLang(lang) || !isValidSolutionProblemName(name)) {
        if (editSaveWantsJson(req)) {
            return res.status(400).json({
                ok: false,
                error: lang === "ru" ? "Некорректный запрос." : "Invalid request.",
            });
        }
        return res.status(400).send("Invalid request");
    }

    const contentValidation = validateSolutionMarkdownContent(content, lang);
    if (!contentValidation.ok) {
        i18n.setLocale(res, lang);
        if (editSaveWantsJson(req)) {
            return res.status(400).json({ ok: false, error: contentValidation.message });
        }
        let fileContents = "";
        const filePathForError = path.join(__dirname, `posts/${lang}`, `${name}.md`);
        try {
            fileContents = await fs.promises.readFile(filePathForError, "utf8");
        } catch {
            fileContents = "";
        }
        const editorContent = typeof content === "string" ? content : fileContents;
        return res.status(400).render("edit_post", {
            __: i18n.__,
            lang,
            name,
            content: editorContent,
            title: lang === "ru" ? `Изменить решение - ${name}` : `Edit Solution - ${name}`,
            saveError: contentValidation.message,
            userId: req.session.userId || null,
        });
    }

    const filePath = path.join(__dirname, `posts/${lang}`, `${name}.md`);

    // Define originalContent before using it
    let originalContent;

    try {
        // Get original content for comparison
        try {
            originalContent = await fs.promises.readFile(filePath, "utf8");
        } catch (error) {
            console.error("Error reading original content:", error);
            if (editSaveWantsJson(req)) {
                return res.status(500).json({
                    ok: false,
                    error:
                        lang === "ru"
                            ? "Не удалось прочитать файл решения."
                            : "Could not read the solution file.",
                });
            }
            return res.status(500).send("Error reading original content");
        }

        // Check for emojis in the content
        const emojiRegex = /[\u{1F600}-\u{1F64F}]/u; // Basic emoji range

        // Check if the client's IP is blocked (database lookup)
        const ipBlocked = await isIpBlocked(clientIp);
        if (ipBlocked || emojiRegex.test(content)) {
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

            const reviewMessage =
                lang === "ru"
                    ? "Ваши изменения были отправлены на проверку!"
                    : "Your edits have been successfully submitted for review!";
            if (editSaveWantsJson(req)) {
                return res.json({ ok: true, review: true, message: reviewMessage });
            }
            return res.render("review_submission", {
                lang,
                message: reviewMessage,
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

        searchIndex.rebuildIndex();

        if (editSaveWantsJson(req)) {
            return res.json({ ok: true, redirect: `/${lang}/${name}` });
        }
        res.redirect(`/${lang}/${name}`);
    } catch (error) {
        console.error("Error saving file:", error);
        if (editSaveWantsJson(req)) {
            return res.status(500).json({
                ok: false,
                error:
                    lang === "ru"
                        ? "Не удалось сохранить файл."
                        : "Could not save the file.",
            });
        }
        res.status(500).send("Error saving file");
    }
});

app.get("/file-list", renderFileList);

app.get("/search", searchLimiter, (req, res) => {
    const query = req.query.q?.trim();
    const userLang = req.query.lang || res.getLocale() || 'en';

    if (!query) {
        return res.json({ results: [] });
    }

    const results = searchIndex.search(query, userLang, 15);

    res.json({ results });
});

app.get("/global-search", (req, res) => {
    const query = req.query.search?.trim() || "";
    const lang = req.query.lang || 'en';

    i18n.setLocale(res, lang);

    const searchLocals = {
        __: i18n.__,
        lang,
        username: req.session.username || null,
        chapters: searchIndex.getChapterList(lang),
    };

    if (!query) {
        return res.render("search", {
            ...searchLocals,
            results: [],
            searchTerm: "",
        });
    }

    const results = searchIndex.search(query, lang, 50);

    res.render("search", {
        ...searchLocals,
        results,
        searchTerm: query,
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
    if (problemName === 'all') {
        return getContributionsList(req, res, next);
    } else if ((problemName.match(/\./g) || []).length === 2) {
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

// Add API endpoint for contributors
app.get("/api/contributors/:problemRef", async (req, res) => {
    const { problemRef } = req.params;
    const lang = req.query.lang || 'en';

    try {
        const result = await pool.query(
            `WITH all_contributions AS (
                SELECT 
                    user_id, 
                    edited_at,
                    'github' as source
                FROM github_contributions 
                WHERE problem_name = $1 AND language = $2
                UNION ALL
                SELECT 
                    user_id, 
                    edited_at,
                    'direct' as source
                FROM contributions 
                WHERE problem_name = $1 AND language = $2 AND content_changed = true
            ),
            contributor_stats AS (
                SELECT 
                    user_id,
                    COUNT(*) as contribution_count,
                    MIN(edited_at) as first_contribution,
                    MAX(edited_at) as last_contribution,
                    ARRAY_AGG(DISTINCT source) as sources
                FROM all_contributions
                WHERE user_id IS NOT NULL
                GROUP BY user_id
            )
            SELECT 
                cs.*,
                u.username,
                u.full_name,
                u.profile_picture
            FROM contributor_stats cs
            JOIN users u ON cs.user_id = u.id
            ORDER BY cs.contribution_count DESC, cs.first_contribution ASC`,
            [problemRef, lang]
        );

        const contributors = result.rows.map(row => ({
            id: row.user_id,
            name: row.full_name || row.username,
            username: row.username,
            profile_picture: row.profile_picture || DEFAULT_PROFILE_AVATAR,
            contributions: row.contribution_count,
            role: row.sources.includes('github') ? 'GitHub Contributor' : 'Direct Contributor',
            first_contribution: row.first_contribution,
            last_contribution: row.last_contribution
        }));

        res.json(contributors);
    } catch (error) {
        console.error("Error fetching contributors:", error);
        res.status(500).json({ error: 'Failed to fetch contributors' });
    }
});

// Update the sandbox server import to pass the session pool
const sandboxPool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

// Pass the pool to the sandbox app
require('./sandbox/sandbox-app')(sandboxPool);

// Build search index before starting server
searchIndex.buildIndex();

// Start the main server
app.listen(PORT, () => {
    console.log(`Main server listening on port ${PORT}`);
});

// Add this function near your other database query functions
async function getTopAuthors() {
    try {
        const query = `
            WITH all_contributions AS (
                SELECT user_id, problem_name FROM contributions
                WHERE user_id != 28
                  AND user_id IS NOT NULL
                  AND content_changed = true
                  AND invisible = false
                UNION ALL
                SELECT user_id, problem_name FROM github_contributions
                WHERE user_id != 28
                  AND user_id IS NOT NULL
            ),
            user_stats AS (
                SELECT 
                    u.username,
                    u.profile_picture,
                    COUNT(DISTINCT ac.problem_name) AS unique_contributions,
                    COUNT(*) AS total_contributions,
                    19 * LN(COUNT(DISTINCT ac.problem_name) * SQRT(COUNT(*))) AS raw_rank
                FROM all_contributions ac
                JOIN users u ON ac.user_id = u.id
                GROUP BY u.username, u.profile_picture
            )
            SELECT 
                username,
                profile_picture,
                unique_contributions,
                total_contributions,
                ROUND(raw_rank::numeric, 0) AS rank
            FROM user_stats
            ORDER BY raw_rank DESC
            LIMIT 10
        `;
        
        const result = await pool.query(query);
        return result.rows;
    } catch (error) {
        console.error("Error fetching top authors:", error);
        return [];
    }
}

// Add API endpoint for related problems
app.get("/api/related-problems/:problemName", async (req, res) => {
    const { problemName } = req.params;
    const lang = req.query.lang || 'en';

    try {
        // Simple algorithm to find related problems based on chapter and section similarity
        const [chapter, section] = problemName.split('.');
        
        // Find problems in the same section first
        const sameSection = await pool.query(
            `SELECT DISTINCT problem_name, COUNT(*) as popularity
             FROM (
                 SELECT problem_name FROM page_views WHERE problem_name LIKE $1 AND problem_name != $2
                 UNION ALL
                 SELECT problem_name FROM page_views_old WHERE problem_name LIKE $1 AND problem_name != $2
             ) AS combined
             GROUP BY problem_name
             ORDER BY popularity DESC
             LIMIT 3`,
            [`${chapter}.${section}.%`, problemName]
        );

        // Find problems in the same chapter if we need more
        const sameChapter = await pool.query(
            `SELECT DISTINCT problem_name, COUNT(*) as popularity
             FROM (
                 SELECT problem_name FROM page_views WHERE problem_name LIKE $1 AND problem_name != $2 AND problem_name NOT LIKE $3
                 UNION ALL
                 SELECT problem_name FROM page_views_old WHERE problem_name LIKE $1 AND problem_name != $2 AND problem_name NOT LIKE $3
             ) AS combined
             GROUP BY problem_name
             ORDER BY popularity DESC
             LIMIT 2`,
            [`${chapter}.%`, problemName, `${chapter}.${section}.%`]
        );

        const relatedProblems = [
            ...sameSection.rows.map(row => ({ 
                name: row.problem_name, 
                similarity: 95 - Math.floor(Math.random() * 10) 
            })),
            ...sameChapter.rows.map(row => ({ 
                name: row.problem_name, 
                similarity: 75 - Math.floor(Math.random() * 15) 
            }))
        ].slice(0, 5);

        res.json(relatedProblems);
    } catch (error) {
        console.error("Error fetching related problems:", error);
        res.status(500).json({ error: "Failed to fetch related problems" });
    }
});

// Add API endpoint for reporting solutions
app.post("/api/report-solution", async (req, res) => {
    const { problemName, language, reason } = req.body;
    const userId = req.session.userId;
    const clientIp = req.headers["x-forwarded-for"] || req.ip;

    if (!reason || reason.trim().length === 0) {
        return res.status(400).json({ error: "Reason is required" });
    }

    try {
        await pool.query(
            `INSERT INTO solution_reports (user_id, problem_name, language, reason, ip_address, created_at) 
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [userId, problemName, language, reason.trim(), clientIp]
        );

        res.json({ message: "Report submitted successfully" });
    } catch (error) {
        console.error("Error submitting report:", error);
        res.status(500).json({ error: "Failed to submit report" });
    }
});
