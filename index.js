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
// Shared with the browser (views/edit_post.ejs loads the same file) so that "did this
// text actually change?" has exactly one answer on both sides. See js/draft-state.js.
const { isSameContent } = require("./js/draft-state");
const { getLanguageData, getSolvedSet } = require("./parents"); // generating content for the main english page

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
const renderContributorPage = require('./contributorPage');
const crypto = require("crypto");
const { getSortedCountryNames } = require("./lib/countries");
const registerContributorAndUserMetricsApi = require("./contributorsUserMetricsApi");
const { getOnlineUsernames } = require("./lib/presence");
const { sendEmail } = require("./email");
const { processAvatar } = require("./avatar");

const rateLimit = require('express-rate-limit');
const { botgate, isCountable, isTaggable, init: initBotgate } = require('./botgate');
const tracker = require('./tracker');
const { router: adminRouter, isIpBlocked } = require('./admin');
const searchIndex = require('./searchIndex');
const blogRouter = require('./blog');
const toolsRouter = require('./tools');
const recommendationsRouter = require('./recommendations');
const bankRouter = require('./bank');
const problemsRouter = require('./problems');
const forumRouter = require('./forum');
const { router: challengesRouter, getCurrentChallengeWidget } = require('./challenges');
const { router: contestRouter, getActiveContestBanner } = require('./contest');
const { getPracticumBanner } = require('./practicum');
const { router: unsubscribeRouter } = require('./unsubscribe');
const { router: feedbackRouter, api: feedbackApi } = require('./feedback');
const { getWidgetCopy: getFeedbackCopy, getCategories: getFeedbackCategories } = require('./feedbackQuestions');
const { router: trackingRouter } = require('./tracking');
const { router: contestJudgeRouter } = require('./contestJudge');
const { router: pathsRouter, getPathsForProblem } = require('./paths');
const notifications = require('./notifications');
const { router: messagesRouter, getUnreadMessageCount } = require('./messages');
const { pingIndexNow } = require('./indexnow');
// ALLOWED_REACTIONS is shared with the chat and the brainstorm threads, so a reaction
// means the same thing everywhere on the site.
const { router: brainstormRouter, renderRoom: renderBrainstormRoom, ALLOWED_REACTIONS } = require('./brainstorm');

const app = express();
const PORT = 3000;

// Caddy APPENDS the peer address to X-Forwarded-For, so with one trusted hop req.ip is
// the real client and the raw header is attacker-controlled. Always prefer req.ip.
app.set('trust proxy', 1);

// Gzip compression — first middleware for best coverage
app.use(compression());

// Tracker first, botgate second — the order matters and is easy to get backwards.
// botgate ends the request on a block without calling next(), so anything mounted after
// it never runs for blocked traffic. With the two the other way round the attempt
// counters recorded zero blocks, which is the exact number you least want to be wrong.
// The tracker only registers a res.on('finish') handler here; that handler reads req.bot
// after the response, by which time botgate has set it.
app.use(tracker.middleware);

// Bot classification runs BEFORE session() on purpose: a machine must never reach the
// session store, because writing to a session is what creates a row (see the lang
// middleware below). It never blocks on IP address — see botgate.js for why.
app.use(botgate);

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

// botgate and tracker need the shared pool for their cached IP lists and buffered writes.
initBotgate(pool);
tracker.init(pool);

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
            // 30 days for anonymous sessions. This used to be a year, which meant
            // connect-pg-simple's pruner (which deletes WHERE expire < now()) had nothing
            // to delete, ever. Logged-in users get the year back on successful login.
            maxAge: 1000 * 60 * 60 * 24 * 30,
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

// Credential stuffing: loginLimiter above is keyed by IP, which is the express-rate-limit
// default and is worth almost nothing here. The proxy pool already pointed at this site
// spreads over 12,000+ residential addresses in a week, so an attacker spraying one
// password across many accounts gets five attempts *per address*. This limiter is keyed by
// the account instead, so a single username cannot be attacked from anywhere at any rate.
// skipSuccessfulRequests means a legitimate user is never locked out by their own logins.
const loginAccountLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,                  // failed attempts per account per hour
    keyGenerator: (req) => `u:${String(req.body?.username || '').trim().toLowerCase().slice(0, 150)}`,
    skipSuccessfulRequests: true,
    message: 'Too many failed login attempts for this account, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// 20/hour was low enough to punish the very people it should protect: one contributor
// legitimately published the same problem 11 times in a session fixing LaTeX, and a
// single second of held Ctrl+S (OS key repeat, ~30/s) used to burn the entire budget.
// The burst itself is now closed at both ends — the editor refuses to publish while a
// publish is in flight, and an unchanged save writes nothing — so this ceiling only has
// to stop deliberate abuse, and 60 leaves plenty of room for a real person polishing.
const editSaveLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 60,
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
app.use("/physics-telegram-catalog.pdf", express.static(path.join(__dirname, "pdf/physics-telegram-catalog.pdf")));
app.use("/savchenko.pdf", express.static(path.join(__dirname, "pdf/savchenko.pdf")));
// The 3rd edition, which /savchenko.pdf served until the 4th replaced it. Kept
// reachable because it is the typeset copy: the 4th edition is a scan with an OCR text
// layer, so this one is still the better source for exact text and the smaller download
// (5.4 MB against 21 MB).
app.use("/savchenko-3rd-ed.pdf", express.static(path.join(__dirname, "pdf/savchenko-3rd-ed.pdf")));
// Contributor CVs, uploaded from settings. Served read-only; the filename is derived
// from the user id, never from what the browser sent.
app.use("/cv", express.static(path.join(__dirname, "uploads", "cv"), { maxAge: '1d' }));
// Analytics tag gate. Registered BEFORE the /js static mount so it wins for this one URL.
//
// 40 templates carry a bare <script src="/js/analytics.js">, so intercepting the URL is
// the only single-point fix. Machines get an inert file and therefore never appear in
// Google Analytics or Yandex Metrika — which is the entire reason realtime showed ~800
// "users" from Singapore while the database saw a couple of hundred requests.
//
// no-store matters: /js is served with maxAge 7d, and a shared cache must never be able
// to hand a person the empty version.
app.get('/js/analytics.js', (req, res) => {
    if (!isTaggable(req)) {
        return res
            .type('application/javascript')
            .set('Cache-Control', 'no-store')
            .send('/* analytics: not loaded for automated traffic */\n');
    }
    // no-store, not a week's cache. This file's content depends on a per-request
    // classification, so caching it hands a client a verdict that outlives the decision.
    // That is not theoretical: the browser farm fetched it while it was still being
    // served freely, then kept firing Google Analytics from the cached copy for hours
    // after every one of its requests started returning 403 — the beacons go straight
    // from its browser to Google and never touch this server, so nothing here could stop
    // them. An extra ~3 KB per pageview is a cheap price for the gate actually applying.
    res.set('Cache-Control', 'no-store');
    res.set('Vary', 'User-Agent, Accept-Language');
    return res.sendFile(path.join(__dirname, 'js', 'analytics.js'));
});

app.use("/js", express.static(path.join(__dirname, "js"), { maxAge: '7d' }));
// Self-hosted video. express.static answers Range requests, which is what a <video>
// element needs in order to seek, so a file dropped in here plays on the site with no
// third-party player involved. Empty until someone puts a file in it — see
// views/default/video_embed.ejs.
app.use("/video", express.static(path.join(__dirname, "video"), { maxAge: '30d' }));
// MathJax 3 served from the installed mathjax-full package instead of a public CDN.
// cdn.jsdelivr.net is blocked on some networks (notably several post-Soviet ISPs),
// which left every page without its scripts and stylesheets. See css/vendor, js/vendor.
app.use("/vendor/mathjax", express.static(path.join(__dirname, "node_modules", "mathjax-full", "es5"), { maxAge: '30d' }));
// PWA assets (manifest.webmanifest, sw.js, offline.html) served at web root
app.use(express.static(path.join(__dirname, "public")));
// Stylesheet for server-rendered math SVG (constant; generated from mathRender)
app.get('/css/mathjax.css', (req, res) => {
    res.type('css').set('Cache-Control', 'public, max-age=604800').send(require('./mathRender').getMathCss());
});
app.use(express.static(path.join(__dirname, "public")));

// ── Static-asset cache busting ───────────────────────────────────────────────
// CSS/JS are served with a long max-age (good for performance), which means a
// returning visitor keeps the OLD file until it expires — they would have to
// clear their cache to see updated styles. Appending a content hash to the URL
// (`/css/design-system.css?v=<hash>`) gives every changed file a brand-new URL
// that all browsers (even old ones) fetch fresh, with no manual cache clear.
// The hash only changes when the file content changes, so caching still works.
// (crypto is already required at the top of this file.)
const assetVersionCache = new Map(); // cleanPath -> { mtimeMs, versioned }
function assetUrl(p) {
    try {
        const clean = String(p).split("?")[0];
        const full = path.join(__dirname, clean.replace(/^\/+/, ""));
        const stat = fs.statSync(full); // cheap; OS caches the inode
        const cached = assetVersionCache.get(clean);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached.versioned;
        const hash = crypto.createHash("md5").update(fs.readFileSync(full)).digest("hex").slice(0, 10);
        const versioned = `${clean}?v=${hash}`;
        assetVersionCache.set(clean, { mtimeMs: stat.mtimeMs, versioned });
        return versioned;
    } catch (_err) {
        return p; // never break a page over a missing/locked file
    }
}
app.locals.asset = assetUrl;   // available in every res.render (incl. partials)

// Versioned URL for a file that may or may not exist yet, or null if it does not.
// Lets a template offer a self-hosted video the moment the file is copied onto the
// server, with no code change and no redeploy.
function assetIfPresent(p) {
    try {
        const clean = String(p).split("?")[0];
        fs.statSync(path.join(__dirname, clean.replace(/^\/+/, "")));
        return assetUrl(clean);
    } catch (_err) {
        return null;
    }
}
app.locals.assetIfPresent = assetIfPresent;

app.use((req, res, next) => {
    const langMatch = req.path.match(/^\/(en|ru)(\/|$)/);
    // Writing to the session marks it dirty, and express-session persists any session
    // that was modified — saveUninitialized:false does NOT save you here (shouldSave()
    // reduces to isModified() for a cookie-less request). With a 30-day cookie that used
    // to be a year, every crawler hit was an INSERT that nothing could prune: 1.46M rows
    // and 497 MB by the time anyone looked. So only real visitors get to write, and only
    // when the value would actually change.
    if (langMatch && isCountable(req) && req.session.lang !== langMatch[1]) {
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
    try {
        res.locals.practicumBanner = getPracticumBanner(req.session.lang || 'en');
    } catch (_err) {
        res.locals.practicumBanner = null;
    }
    // Copy for the feedback widget, which the site-wide header renders on every page.
    // The path prefix wins over the session because a reader can land on /ru/2.2.12 from a
    // search with an 'en' session from months ago, and the widget must speak the language
    // of the page they are actually looking at.
    try {
        const pathLang = (req.path.match(/^\/(en|ru)(\/|$)/) || [])[1];
        const fbLang = pathLang || req.session.lang || 'en';
        res.locals.feedbackWidget = {
            lang: fbLang,
            copy: getFeedbackCopy(fbLang),
            categories: getFeedbackCategories(fbLang),
        };
    } catch (_err) {
        res.locals.feedbackWidget = null;
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
    res.locals.unfinishedDraftCount = 0;
    Promise.all([
        pool.query("SELECT profile_picture FROM users WHERE id = $1", [req.session.userId]),
        notifications.getUnreadCount(req.session.userId),
        getUnreadMessageCount(req.session.userId),
        // Cheap (partial index on user_id) and it decides whether the header shows a
        // Drafts entry at all — nothing appears for the people who have none.
        pool.query(
            "SELECT COUNT(*)::int AS n FROM solution_drafts WHERE user_id = $1 AND completed_at IS NULL",
            [req.session.userId]
        ).catch(() => ({ rows: [{ n: 0 }] })),
    ])
        .then(([profileResult, unreadCount, unreadMessages, draftResult]) => {
            res.locals.profilePicture = profileResult.rows[0]?.profile_picture || null;
            res.locals.unreadNotificationCount = unreadCount;
            res.locals.unreadMessageCount = unreadMessages;
            res.locals.unfinishedDraftCount = draftResult.rows[0]?.n || 0;
            next();
        })
        .catch((err) => {
            console.error("Error loading user context for header:", err);
            next();
        });
});

// ─── Online presence tracking ───────────────────────────────────────
// Refresh users.last_seen_at on activity, throttled to at most one write
// per user per LAST_SEEN_THROTTLE_MS so we never write on every request.
// Fire-and-forget: never blocks the response. A user counts as "online"
// while last_seen_at is within ONLINE_WINDOW_MS (see /api/online-users and
// the profile stats endpoint).
const LAST_SEEN_THROTTLE_MS = 60 * 1000;
const lastSeenWrites = new Map(); // userId -> last write epoch ms
app.use((req, res, next) => {
    const uid = req.session && req.session.userId;
    if (uid) {
        const now = Date.now();
        if (now - (lastSeenWrites.get(uid) || 0) > LAST_SEEN_THROTTLE_MS) {
            lastSeenWrites.set(uid, now);
            pool.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1", [uid])
                .catch((err) => console.error("last_seen update failed:", err.message));
        }
    }
    next();
});

// Currently-online users (last_seen within 5 min), respecting the
// show_online_status privacy preference. Powers the "Online now" avatar strip.
// Three tiers rather than one. Strictly "online now" is a five-minute window, and on a
// site this size that is usually one or two people — a strip built from it is nearly always
// empty, which reads as nobody being here at all. Widening it to a day and colouring by
// recency shows the place is inhabited without overstating who is present right now: the
// headline count still means the five-minute window and nothing else.
//
// The same show_online_status preference governs all three. It already covers "last seen"
// as well as the online dot (see user_settings.ejs), so this exposes nothing that opting in
// did not already cover.
app.get("/api/online-users", async (req, res) => {
    try {
        const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 40));
        const visible = `COALESCE(p.show_online_status, true) = true`;
        const [usersResult, countResult] = await Promise.all([
            pool.query(
                `SELECT u.username, u.full_name, u.profile_picture, u.last_seen_at
                 FROM users u
                 LEFT JOIN user_preferences p ON p.user_id = u.id
                 WHERE u.last_seen_at > NOW() - INTERVAL '24 hours' AND ${visible}
                 ORDER BY u.last_seen_at DESC
                 LIMIT $1`,
                [limit]
            ),
            pool.query(
                `SELECT
                   COUNT(*) FILTER (WHERE u.last_seen_at > NOW() - INTERVAL '5 minutes')::int AS online,
                   COUNT(*) FILTER (WHERE u.last_seen_at > NOW() - INTERVAL '1 hour')::int      AS within_hour,
                   COUNT(*)::int AS total
                 FROM users u
                 LEFT JOIN user_preferences p ON p.user_id = u.id
                 WHERE u.last_seen_at > NOW() - INTERVAL '24 hours' AND ${visible}`
            ),
        ]);

        const c = countResult.rows[0];
        const now = Date.now();
        const tierOf = (seenAt) => {
            const minutes = (now - new Date(seenAt).getTime()) / 60000;
            if (minutes < 5) return "online";
            if (minutes < 60) return "recent";
            return "today";
        };

        res.set("Cache-Control", "no-store");
        res.json({
            // `total` keeps its old meaning for any caller that only wants a headline
            // number: people here in the last five minutes.
            total: c.online,
            counts: { online: c.online, recent: c.within_hour - c.online, today: c.total - c.within_hour },
            users: usersResult.rows.map((r) => ({
                username: r.username,
                fullName: r.full_name || r.username,
                profilePicture: r.profile_picture || "/img/profile_images/Default_placeholder.svg",
                tier: tierOf(r.last_seen_at),
            })),
        });
    } catch (error) {
        console.error("Failed to load online users:", error.message);
        res.status(500).json({ error: "Failed to load online users" });
    }
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
            cvUrl: user.cv_url || null,
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
            try {
                // Optimize the raw upload into a 320px WebP + 96px thumbnail.
                profilePictureValue = await processAvatar(req.file.path, req.session.userId);
                // Drop the raw upload, unless it was already the .webp we just wrote.
                const mainPath = path.join(__dirname, "img", "profile_images", `${req.session.userId}.webp`);
                if (path.resolve(req.file.path) !== path.resolve(mainPath)) {
                    fs.unlink(req.file.path, () => {});
                }
            } catch (e) {
                console.error("Avatar optimization failed, keeping raw upload:", e);
                profilePictureValue = `/img/profile_images/${req.file.filename}`;
            }
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
// Upload (or replace) your CV.
//
// The profile is already a public record of what someone has done here; attaching the
// document they would send an admissions committee turns that record into something
// usable as a credential. PDF only, 5 MB, and the stored name is derived from the user
// id — a filename from the browser is attacker-controlled and has no business on disk.
const CV_DIR = path.join(__dirname, "uploads", "cv");
const cvUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            fs.mkdirSync(CV_DIR, { recursive: true });
            cb(null, CV_DIR);
        },
        filename: (req, file, cb) => cb(null, `${req.session.userId}.pdf`),
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const isPdf = file.mimetype === "application/pdf" &&
            path.extname(file.originalname).toLowerCase() === ".pdf";
        cb(null, isPdf);
    },
});

app.post("/:lang/settings/cv", checkAuthenticated, cvUpload.single("cv"), async (req, res) => {
    const lang = req.params.lang === "ru" ? "ru" : "en";
    try {
        if (!req.file) {
            return res.redirect(`/${lang}/settings?tab=profile&error=cv`);
        }
        // A .pdf extension and a claimed MIME type are both trivially forged; the magic
        // bytes are the only check that means anything. A rejected file is removed
        // rather than left sitting in uploads/.
        const head = fs.readFileSync(req.file.path).subarray(0, 5).toString("latin1");
        if (head !== "%PDF-") {
            fs.unlinkSync(req.file.path);
            return res.redirect(`/${lang}/settings?tab=profile&error=cv`);
        }
        // Cache-busted, so a replaced CV is not served from the old copy for a day.
        const url = `/cv/${req.session.userId}.pdf?v=${Date.now()}`;
        await pool.query(
            "UPDATE users SET cv_url = $1, cv_uploaded_at = NOW() WHERE id = $2",
            [url, req.session.userId]
        );
        res.redirect(`/${lang}/settings?tab=profile&saved=cv`);
    } catch (error) {
        console.error("CV upload failed:", error);
        res.redirect(`/${lang}/settings?tab=profile&error=cv`);
    }
});

app.post("/:lang/settings/cv/delete", checkAuthenticated, async (req, res) => {
    const lang = req.params.lang === "ru" ? "ru" : "en";
    try {
        await pool.query(
            "UPDATE users SET cv_url = NULL, cv_uploaded_at = NULL WHERE id = $1",
            [req.session.userId]
        );
        fs.unlinkSync(path.join(CV_DIR, `${req.session.userId}.pdf`));
    } catch (_error) { /* already gone is the desired state */ }
    res.redirect(`/${lang}/settings?tab=profile&saved=cv`);
});

app.post("/:lang/settings/privacy", checkAuthenticated, async (req, res) => {
    const { lang } = req.params;
    i18n.setLocale(res, lang);
    const { publicProfile, emailNotifications, showCountryOnLeaderboard, showOnlineStatus } = req.body;

    // Build notification_settings from form checkboxes
    const notifSettings = {
        comment_on_solution: !!req.body.notif_comment_on_solution,
        reply_to_comment: !!req.body.notif_reply_to_comment,
        solution_liked: !!req.body.notif_solution_liked,
        new_follower: !!req.body.notif_new_follower,
        forum_reply: !!req.body.notif_forum_reply,
        challenge_result: !!req.body.notif_challenge_result,
        new_message: !!req.body.notif_new_message,
        report_resolved: true, // always on
        forum_solution: true,  // always on
    };

    try {
        await pool.query(
            `INSERT INTO user_preferences (user_id, public_profile, show_online_status, email_notifications, privacy_level, show_country_on_leaderboard, notification_settings)
             VALUES ($1, $2, $6, $3, 'public', $4, $5)
             ON CONFLICT (user_id)
             DO UPDATE SET
                public_profile = EXCLUDED.public_profile,
                show_online_status = EXCLUDED.show_online_status,
                email_notifications = EXCLUDED.email_notifications,
                show_country_on_leaderboard = EXCLUDED.show_country_on_leaderboard,
                notification_settings = EXCLUDED.notification_settings,
                updated_at = NOW()`,
            [req.session.userId, !!publicProfile, !!emailNotifications, !!showCountryOnLeaderboard, JSON.stringify(notifSettings), !!showOnlineStatus]
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

        // Email the confirmation link to the NEW address. A send failure must not
        // abort the change request (the pending token is already stored), so it's
        // logged and swallowed.
        try {
            const subject = lang === 'ru'
                ? 'Подтвердите новый email — Savchenko Solutions'
                : 'Confirm your new email — Savchenko Solutions';
            const body = lang === 'ru'
                ? 'Подтвердите изменение адреса электронной почты. Ссылка действительна 24 часа:'
                : 'Confirm your email change. This link is valid for 24 hours:';
            await sendEmail({
                to: email,
                subject,
                html: `<p>${body}</p><p><a href="${confirmUrl}">${confirmUrl}</a></p>`,
                text: `${body}\n\n${confirmUrl}`,
            });
        } catch (mailErr) {
            console.error('Email change confirmation failed:', mailErr);
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

// Vote on a problem's perceived difficulty (1-10), separate from the AI score.
// Deliberately not `checkAuthenticated`: that middleware redirects, which a
// fetch() POST can't follow usefully — a logged-out vote should fail loudly
// with 401 JSON instead of silently landing on a login page's HTML.
app.post("/api/problems/:name/difficulty-vote", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Log in to vote" });

    const vote = parseInt(req.body.vote, 10);
    if (!Number.isInteger(vote) || vote < 1 || vote > 10) {
        return res.status(400).json({ error: "Vote must be an integer 1-10" });
    }

    try {
        await pool.query(
            `INSERT INTO problem_difficulty_votes (problem_name, user_id, vote)
             VALUES ($1, $2, $3)
             ON CONFLICT (problem_name, user_id) DO UPDATE SET vote = $3, created_at = now()`,
            [req.params.name, req.session.userId, vote]
        );
        const { rows } = await pool.query(
            `SELECT AVG(vote)::numeric(3,1) AS avg_vote, COUNT(*)::int AS vote_count
               FROM problem_difficulty_votes WHERE problem_name = $1`,
            [req.params.name]
        );
        res.json({ ok: true, avgVote: rows[0].avg_vote, voteCount: rows[0].vote_count });
    } catch (err) {
        if (err.code === '23503') return res.status(404).json({ error: "Unknown problem" });
        if (err.code === '42P01') return res.status(503).json({ error: "Voting is temporarily unavailable" });
        console.error("difficulty vote error:", err.message);
        res.status(500).json({ error: "Internal server error" });
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
                c.id, c.user_id, c.content, c.parent_id, c.created_at, c.updated_at, c.is_brainstorm,
                u.username, u.full_name, u.profile_picture
            FROM solution_comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.problem_name = $1 AND c.language = $2 AND c.is_deleted = false
            ORDER BY c.created_at ASC`,
            [problemName, language]
        );

        const currentUserId = req.session.userId || null;
        const now = new Date();

        // Fresh online presence for comment-author avatars (privacy-aware).
        const online = await getOnlineUsernames(pool, result.rows.map(r => r.username));

        // Every reaction for this thread in one query, grouped per comment. `me` marks
        // the ones the viewer left, so the UI can show them as pressed.
        const reactionsByComment = new Map();
        if (result.rows.length > 0) {
            const reactionRows = await pool.query(
                `SELECT comment_id, emoji, COUNT(*)::int AS count,
                        BOOL_OR(user_id = $2) AS me
                 FROM solution_comment_reactions
                 WHERE comment_id = ANY($1::int[])
                 GROUP BY comment_id, emoji
                 ORDER BY MIN(created_at)`,
                [result.rows.map(r => r.id), currentUserId]
            ).catch(() => ({ rows: [] }));   // pre-migration 048: simply no reactions
            for (const r of reactionRows.rows) {
                if (!reactionsByComment.has(r.comment_id)) reactionsByComment.set(r.comment_id, []);
                reactionsByComment.get(r.comment_id).push({ emoji: r.emoji, count: r.count, me: !!r.me });
            }
        }

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
                isBrainstorm: row.is_brainstorm,
                isOwnComment,
                isEditable,
                reactions: reactionsByComment.get(row.id) || [],
                author: {
                    username: row.username,
                    fullName: row.full_name,
                    profilePicture: row.profile_picture || DEFAULT_PROFILE_AVATAR,
                    isOnline: online.has(row.username)
                }
            };
        });

        res.json({ comments });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to get comments" });
    }
});

// Toggle a reaction on a solution comment.
//
// Same six emoji as the chat and the brainstorm threads (ALLOWED_REACTIONS), and the
// same toggle semantics: pressing the one you already left removes it. The emoji is
// checked against that list rather than stored as sent — the column is VARCHAR(8) and
// this is a public write path.
app.post("/api/solutions/comments/:commentId/reactions", checkAuthenticated, async (req, res) => {
    const commentId = parseInt(req.params.commentId, 10);
    const emoji = String(req.body?.emoji || "");
    const userId = req.session.userId;

    if (!Number.isFinite(commentId)) {
        return res.status(400).json({ error: "Invalid comment id" });
    }
    if (!ALLOWED_REACTIONS.includes(emoji)) {
        return res.status(400).json({ error: "Unsupported reaction" });
    }

    try {
        // A reaction on a deleted comment would be invisible and uncountable.
        const comment = await pool.query(
            "SELECT id FROM solution_comments WHERE id = $1 AND is_deleted = false",
            [commentId]
        );
        if (comment.rows.length === 0) {
            return res.status(404).json({ error: "Comment not found" });
        }

        // One reaction per person per comment. Picking a different emoji replaces the
        // one you had, in a single click — the alternative made changing your mind a
        // three-click chore: un-react, reopen the picker, react again.
        const existing = await pool.query(
            "SELECT emoji FROM solution_comment_reactions WHERE comment_id = $1 AND user_id = $2",
            [commentId, userId]
        );
        const current = existing.rows[0]?.emoji || null;

        if (current === emoji) {
            // Pressing the one you already left takes it back.
            await pool.query(
                "DELETE FROM solution_comment_reactions WHERE comment_id = $1 AND user_id = $2",
                [commentId, userId]
            );
        } else {
            // Swap. Both statements in one transaction so a failure between them
            // cannot leave the comment with no reaction from someone who has one.
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await client.query(
                    "DELETE FROM solution_comment_reactions WHERE comment_id = $1 AND user_id = $2",
                    [commentId, userId]
                );
                await client.query(
                    `INSERT INTO solution_comment_reactions (comment_id, user_id, emoji)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (comment_id, user_id, emoji) DO NOTHING`,
                    [commentId, userId, emoji]
                );
                await client.query("COMMIT");
            } catch (txError) {
                await client.query("ROLLBACK").catch(() => {});
                throw txError;
            } finally {
                client.release();
            }
        }

        const reactions = await pool.query(
            `SELECT emoji, COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS me
             FROM solution_comment_reactions
             WHERE comment_id = $1
             GROUP BY emoji ORDER BY MIN(created_at)`,
            [commentId, userId]
        );
        const mine = reactions.rows.find((r) => r.me);
        res.json({ ok: true, reactions: reactions.rows, mine: mine ? mine.emoji : null });
    } catch (error) {
        console.error("Comment reaction error:", error);
        res.status(500).json({ error: "Failed to save reaction" });
    }
});

// Add comment to solution
app.post("/api/solutions/:problemName/:language/comments", checkAuthenticated, async (req, res) => {
    const { problemName, language } = req.params;
    const { content, parentId } = req.body;
    // Replies are always plain comments; only top-level comments carry the brainstorm mark.
    const isBrainstorm = parentId ? false : Boolean(req.body.isBrainstorm);
    const userId = req.session.userId;

    if (!content || content.trim().length === 0) {
        return res.status(400).json({ error: "Comment content is required" });
    }

    try {
        const result = await pool.query(
            "INSERT INTO solution_comments (user_id, problem_name, language, content, parent_id, is_brainstorm) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at",
            [userId, problemName, language, content.trim(), parentId || null, isBrainstorm]
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
            isBrainstorm,
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

// ─── Problem statements ──────────────────────────────────────
//
// The upload and create-problem forms ask people to write a solution to a problem the site
// has never actually shown them; this is what puts the statement under the input. Maths is
// rendered to SVG server-side rather than in the browser so neither form has to load MathJax.
//
// The rendering and its bounded, TTL'd cache live in lib/statementRender.js — shared with
// the problem finder's batch endpoint (problems.js) so there is only ever one copy of a
// given statement's SVG in memory.
const { getStatement } = require("./lib/statementRender");

app.get("/api/problem/:name/statement", async (req, res) => {
    const name = req.params.name;
    const lang = isValidSolutionLang(req.query.lang) ? req.query.lang : "en";
    if (!isValidSolutionProblemName(name)) {
        return res.status(400).json({ error: "bad problem name" });
    }

    try {
        const payload = await getStatement(pool, name, lang);
        if (!payload) return res.status(404).json({ error: "no statement on record" });
        res.json(payload);
    } catch (err) {
        console.error("statement lookup failed:", err.message);
        res.status(500).json({ error: "lookup failed" });
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

// Add a new route for user profiles. /en/user/x and /ru/user/x give each language a
// URL of its own, matching every other page on the site; the bare /user/x still works
// and picks the language up from the session. Both must be registered before the
// /:lang/:name catch-all, or "user" is treated as a problem slug.
// /user/ with no username is not a page; send it to the list of people it implies.
app.get(["/user", "/user/", "/:lang(en|ru)/user", "/:lang(en|ru)/user/"], (req, res) => {
    const lang = req.params.lang === 'ru' ? 'ru' : 'en';
    res.redirect(301, `/${lang}/contributors`);
});
app.get(["/user/:username", "/:lang(en|ru)/user/:username"], getUserProfile);
// Public, English, CV-linkable record of what a contributor has actually done. The
// leaderboard stops at the edge of the site; this is the part they can show someone.
app.get("/contributor/:username", renderContributorPage);

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
    const clientIp = req.ip; // Caddy appends to XFF, so req.ip is the real client (see botgate.js)

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
        const ip = req.ip || '';

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

        // Send the reset email — only when the account exists. Send failures are
        // swallowed so we never reveal whether the address is registered.
        if (token) {
            const resetUrl = `${req.protocol}://${req.get("host")}/reset-password?token=${token}&lang=${lang}`;
            const subject = lang === 'ru'
                ? 'Сброс пароля — Savchenko Solutions'
                : 'Reset your Savchenko Solutions password';
            const intro = lang === 'ru'
                ? 'Мы получили запрос на сброс пароля для вашего аккаунта. Ссылка действительна 24 часа:'
                : 'We received a request to reset your password. This link is valid for 24 hours:';
            const ignore = lang === 'ru'
                ? 'Если вы не запрашивали сброс, просто проигнорируйте это письмо.'
                : "If you didn't request this, you can safely ignore this email.";
            try {
                await sendEmail({
                    to: email,
                    subject,
                    html: `<p>${intro}</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>${ignore}</p>`,
                    text: `${intro}\n\n${resetUrl}\n\n${ignore}`,
                });
            } catch (mailErr) {
                console.error('Password reset email failed:', mailErr);
            }
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
            "SELECT id, username FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()",
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

        // Log the user straight in — they proved control of the account via the reset link
        req.session.userId = result.rows[0].id;
        req.session.username = result.rows[0].username;
        req.session.lang = lang;
        res.redirect(`/${lang}/profile`);
    } catch (error) {
        console.error('Reset password error:', error);
        res.redirect(`/${lang}/login?error=${encodeURIComponent(
            lang === 'ru' ? 'Произошла ошибка.' : 'Something went wrong.'
        )}`);
    }
});

// Email verification (soft): mark the account verified when the emailed link is opened
app.get("/verify-email", async (req, res) => {
    const lang = req.query.lang || 'en';
    const token = req.query.token;
    if (!token) return res.redirect(`/${lang}/login`);
    try {
        const r = await pool.query(
            `SELECT id FROM users
             WHERE email_verification_token = $1
               AND (email_verification_expires IS NULL OR email_verification_expires > NOW())`,
            [token]
        );
        if (r.rows.length === 0) {
            return res.redirect(`/${lang}/login?error=${encodeURIComponent(
                lang === 'ru' ? 'Ссылка подтверждения недействительна или истекла.' : 'This verification link is invalid or has expired.'
            )}`);
        }
        await pool.query(
            "UPDATE users SET email_verified = TRUE, email_verification_token = NULL, email_verification_expires = NULL WHERE id = $1",
            [r.rows[0].id]
        );
        const dest = req.session.userId ? `/${lang}/profile` : `/${lang}/login`;
        return res.redirect(`${dest}?success=${encodeURIComponent(
            lang === 'ru' ? 'Email подтверждён.' : 'Your email has been verified.'
        )}`);
    } catch (error) {
        console.error('verify-email error:', error);
        return res.redirect(`/${lang}/login`);
    }
});

// Account recovery appeal (middle-ground: never reveals whether an email exists;
// files an appeal into the /admin/password-resets "needs review" queue)
app.get("/recover-account", (req, res) => {
    const lang = req.query.lang || 'en';
    i18n.setLocale(res, lang);
    res.render("recover_account", {
        __: i18n.__,
        lang,
        error: req.query.error || "",
        success: req.query.success || "",
    });
});

app.post("/recover-account", async (req, res) => {
    const lang = req.body.lang || 'en';
    const email = String(req.body.email || "").trim();
    const message = String(req.body.message || "").trim().slice(0, 2000);
    const ip = req.ip || '';

    if (!email) {
        return res.redirect(`/recover-account?lang=${lang}&error=${encodeURIComponent(
            lang === 'ru' ? 'Укажите адрес электронной почты.' : 'Please enter your email address.'
        )}`);
    }

    try {
        // Link to a user if the email matches — never revealed to the requester.
        const u = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
        const userId = u.rows.length ? u.rows[0].id : null;

        await pool.query(
            `INSERT INTO password_reset_requests (email, user_id, ip_address, status, request_type, note)
             VALUES ($1, $2, $3, 'pending', 'recovery_appeal', $4)`,
            [email, userId, ip, message || null]
        );

        // Best-effort acknowledgement email to the requester
        try {
            await sendEmail({
                to: email,
                subject: lang === 'ru'
                    ? 'Мы получили ваш запрос на восстановление — Savchenko Solutions'
                    : 'We received your account recovery request — Savchenko Solutions',
                html: `<p>${lang === 'ru'
                    ? 'Мы получили ваш запрос на восстановление доступа. Наша команда рассмотрит его в течение 5 рабочих дней и свяжется с вами по электронной почте.'
                    : 'We received your account recovery request. Our team will review it within 5 business days and follow up by email.'}</p>`,
            });
        } catch (mailErr) {
            console.error('Recovery acknowledgement email failed:', mailErr);
        }

        return res.redirect(`/recover-account?lang=${lang}&success=${encodeURIComponent(
            lang === 'ru'
                ? 'Мы получили ваш запрос. Ответ будет предоставлен в течение 5 рабочих дней — проверьте вашу электронную почту.'
                : 'We received your appeal. You will get a response within 5 business days — please check your email for further details.'
        )}`);
    } catch (error) {
        console.error('recover-account error:', error);
        return res.redirect(`/recover-account?lang=${lang}&error=${encodeURIComponent(
            lang === 'ru' ? 'Произошла ошибка. Попробуйте позже.' : 'Something went wrong. Please try again.'
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
            // created_at is set explicitly rather than left to the column DEFAULT so the
            // provenance is recorded too: 'exact' distinguishes real signup times from the
            // dates scripts/backfill-user-created-at.js inferred for pre-existing accounts,
            // which are only upper bounds.
            "INSERT INTO users (username, email, full_name, password, created_at, created_at_source) VALUES ($1, $2, $3, $4, now(), 'exact') RETURNING id",
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

        // Send a verification email (soft: the account works right away; the user
        // shows as unverified until they click the link). Failures are swallowed.
        try {
            const verifyToken = crypto.randomBytes(32).toString("hex");
            const verifyExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
            await pool.query(
                "UPDATE users SET email_verification_token = $1, email_verification_expires = $2 WHERE id = $3",
                [verifyToken, verifyExpires, newUser.rows[0].id]
            );
            const verifyUrl = `${req.protocol}://${req.get("host")}/verify-email?token=${verifyToken}&lang=${lang}`;
            await sendEmail({
                to: email,
                subject: lang === 'ru'
                    ? 'Подтвердите ваш email — Savchenko Solutions'
                    : 'Confirm your email — Savchenko Solutions',
                html: `<p>${lang === 'ru'
                    ? 'Добро пожаловать в Savchenko Solutions! Подтвердите свой адрес электронной почты (ссылка действительна 7 дней):'
                    : 'Welcome to Savchenko Solutions! Please confirm your email address (this link is valid for 7 days):'}</p>
                       <p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
                text: verifyUrl,
            });
        } catch (mailErr) {
            console.error('Verification email failed:', mailErr);
        }

        // Log the new user straight in instead of bouncing them to the login page
        req.session.userId = newUser.rows[0].id;
        req.session.username = username;
        req.session.lang = lang;
        res.redirect(`/${lang}/profile`);
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
app.post("/login", loginLimiter, loginAccountLimiter, async (req, res) => {
    const { username, password, lang = 'en' } = req.body;

    // bcrypt.compare is the expensive part of this route and it is otherwise a free
    // CPU-exhaustion vector on a 2-vCPU box, so refuse automated clients before hashing.
    if (req.bot && req.bot.cls === 'block') {
        return res.redirect(`/${lang}/login?error=${i18n.__('Invalid credentials')}`);
    }

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
        // Signed-in users keep the old year-long "remember me"; the 30-day default in the
        // session config exists only so abandoned anonymous sessions become prunable.
        req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 365;

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
    // "Most wanted" = unsolved problems ranked by how many people looked for them and
    // found nothing. Same query the /unsolved page uses, surfaced on the homepage so the
    // worklist is visible rather than buried: a physicist is far more likely to write
    // 5.5.7 when told 287 people wanted it than when asked to "contribute".
    const {
        recentContributions, topAuthors, solutionProgress, challengeWidget,
        recentContributors, mostWanted, proofNumbers, difficultyGrid,
    } = await getHomeWidgets(lang);

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
        recentContributors,
        enSolvedSet: getSolvedSet('en'),
        ruSolvedSet: getSolvedSet('ru'),
        mostWanted,
        proofNumbers,
        difficultyGrid,
    });
});

// The homepage grid can recolour itself by difficulty instead of by progress. The payload
// is one character per problem, in the same section-keyed shape as gridStates, so the
// existing lazy fill can read it without a second request:
//
//   '0'       no score yet
//   '1'-'9'   difficulty bucket, from the calibrated 0-100 score
//   'a'-'i'   the same nine buckets, for a problem Savchenko marked with a ∗
//
// Packing the star into the same character rather than shipping a parallel array is what
// keeps this around 2 KB for all 2,023 problems. Returns null when nothing has been scored,
// and the toggle is then not rendered at all.
let _difficultyCache = { at: 0, value: undefined };
async function getDifficultyGrid() {
    if (_difficultyCache.value !== undefined && Date.now() - _difficultyCache.at < 10 * 60 * 1000) {
        return _difficultyCache.value;
    }
    let value = null;
    try {
        const { rows } = await pool.query(
            `SELECT problem_name, calibrated, starred FROM problem_difficulty WHERE calibrated IS NOT NULL`
        );
        if (rows.length) {
            const bySection = new Map();
            for (const r of rows) {
                const cut = r.problem_name.lastIndexOf('.');
                const section = r.problem_name.slice(0, cut);
                const idx = parseInt(r.problem_name.slice(cut + 1), 10) - 1;
                if (!(idx >= 0)) continue;
                const bucket = Math.min(9, Math.max(1, Math.ceil((r.calibrated / 100) * 9) || 1));
                if (!bySection.has(section)) bySection.set(section, []);
                bySection.get(section)[idx] = r.starred ? String.fromCharCode(96 + bucket) : String(bucket);
            }
            value = {};
            for (const [section, chars] of bySection) {
                for (let i = 0; i < chars.length; i++) if (!chars[i]) chars[i] = '0';
                value[section] = chars.join('');
            }
        }
    } catch (err) {
        // A missing table must not take the homepage down.
        if (err.code !== '42P01') console.error('difficulty grid:', err.message);
    }
    _difficultyCache = { at: Date.now(), value };
    return value;
}

// Three numbers that prove other people are here: solutions, contributors, edits.
// Shown to logged-out visitors in place of a top-ten leaderboard, which means nothing to
// someone who has never seen the site. Cached — these move slowly and the homepage is
// the most-hit page there is.
let _proofCache = { at: 0, value: null };
async function getProofNumbers() {
    if (_proofCache.value && Date.now() - _proofCache.at < 10 * 60 * 1000) return _proofCache.value;
    try {
        const { rows } = await pool.query(`
            SELECT
              -- contributions has no "author" column; the free-text name field is
              -- full_name, used when someone uploads without an account.
              (SELECT count(DISTINCT COALESCE(user_id::text, NULLIF(btrim(full_name), '')))
                 FROM contributions
                WHERE COALESCE(user_id::text, NULLIF(btrim(full_name), '')) IS NOT NULL) AS contributors,
              (SELECT count(*) FROM contributions)                                  AS edits
        `);
        const value = {
            contributors: parseInt(rows[0].contributors, 10) || 0,
            edits: parseInt(rows[0].edits, 10) || 0,
        };
        _proofCache = { at: Date.now(), value };
        return value;
    } catch (err) {
        console.error('getProofNumbers failed:', err.message);
        return _proofCache.value || { contributors: 0, edits: 0 };
    }
}

// The homepage "Последние изменения" thread. Edits and comments are both things that
// happened to a solution, so they share one time-ordered feed rather than sitting in
// two boxes competing for the same corner of the sidebar. Comments are rare next to
// edits (355 against 8,277), so they read as occasional punctuation, not noise.
function formatFeedTimestamp(date) {
    return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        month: 'short',
        day: '2-digit',
        timeZoneName: 'short'
    }).format(date);
}

// The homepage widget set — recent changes, top authors, progress, most wanted — is
// the same for every visitor and costs 400-600 ms of database work, which it used to
// pay on every single request. None of it changes by the second, so it is held briefly
// and shared. Sixty seconds keeps "Последние изменения" honest while taking the
// queries off the hot path for essentially everyone.
const HOME_WIDGET_TTL_MS = 60 * 1000;
const homeWidgetCache = new Map();   // lang -> { at, value }

async function getHomeWidgets(lang) {
    const hit = homeWidgetCache.get(lang);
    if (hit && Date.now() - hit.at < HOME_WIDGET_TTL_MS) return hit.value;

    const [recentContributions, topAuthors, solutionProgress, challengeWidget, recentContributors] =
        await Promise.all([
            getRecentContributions(10),
            getTopAuthors(),
            renderUnsolvedList.getSolutionProgressStats(lang),
            getCurrentChallengeWidget(),
            getRecentContributors(6),
        ]);
    const mostWanted = await renderUnsolvedList
        .getMostWantedProblems(new Set([...getSolvedSet('en'), ...getSolvedSet('ru')]), 7)
        .catch(() => []);
    const [proofNumbers, difficultyGrid] = await Promise.all([getProofNumbers(), getDifficultyGrid()]);

    const value = {
        recentContributions, topAuthors, solutionProgress, challengeWidget,
        recentContributors, mostWanted, proofNumbers, difficultyGrid,
    };
    homeWidgetCache.set(lang, { at: Date.now(), value });
    return value;
}

async function getRecentContributions(limit) {
    try {
        // Each side is asked for `limit` rows because the merge can take all of its
        // entries from either one.
        const [edits, comments] = await Promise.all([
            pool.query(
                `SELECT c.id, c.problem_name, c.language, c.user_id, c.edited_at AT TIME ZONE 'UTC' as edited_at, c.ip_address, c.invisible,
                        u.username,
                        (SELECT COUNT(*) FROM contributions c2 WHERE c2.problem_name = c.problem_name AND c2.invisible IS NOT TRUE AND c2.edited_at <= c.edited_at) AS edit_number
                 FROM contributions c
                 LEFT JOIN users u ON c.user_id = u.id
                 WHERE c.invisible IS NOT TRUE
                 ORDER BY c.edited_at DESC LIMIT $1`,
                [limit]
            ),
            pool.query(
                `SELECT sc.id, sc.problem_name, sc.language, sc.created_at AT TIME ZONE 'UTC' as created_at,
                        u.username
                 FROM solution_comments sc
                 LEFT JOIN users u ON sc.user_id = u.id
                 WHERE sc.is_deleted = false
                   AND sc.problem_name IS NOT NULL
                 ORDER BY sc.created_at DESC LIMIT $1`,
                [limit]
            ).catch(() => ({ rows: [] })),
        ]);

        const editEntries = edits.rows.map(row => ({
            kind: 'edit',
            version: row.problem_name,
            lang: row.language || 'en',
            editor: row.username || 'Anonymous',
            hasUser: !!row.username,
            isNew: parseInt(row.edit_number) === 1,
            timestamp: formatFeedTimestamp(row.edited_at),
            relativeTime: row.edited_at,
            sortAt: new Date(row.edited_at).getTime(),
            id: row.id,
            // The diff view for this edit.
            href: `/${row.language || 'en'}/contributions/${row.id}`,
        }));

        const commentEntries = comments.rows.map(row => ({
            kind: 'comment',
            version: row.problem_name,
            lang: row.language || 'en',
            editor: row.username || 'Anonymous',
            hasUser: !!row.username,
            isNew: false,
            timestamp: formatFeedTimestamp(row.created_at),
            relativeTime: row.created_at,
            sortAt: new Date(row.created_at).getTime(),
            id: row.id,
            // Straight to the comment in the solution's thread.
            href: `/${row.language || 'en'}/${encodeURIComponent(row.problem_name)}#comment-${row.id}`,
        }));

        return [...editEntries, ...commentEntries]
            .sort((a, b) => b.sortAt - a.sortAt)
            .slice(0, limit);
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
    // "Most wanted" = unsolved problems ranked by how many people looked for them and
    // found nothing. Same query the /unsolved page uses, surfaced on the homepage so the
    // worklist is visible rather than buried: a physicist is far more likely to write
    // 5.5.7 when told 287 people wanted it than when asked to "contribute".
    const {
        recentContributions, topAuthors, solutionProgress, challengeWidget,
        recentContributors, mostWanted, proofNumbers, difficultyGrid,
    } = await getHomeWidgets('ru');
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
        recentContributors,
        enSolvedSet: getSolvedSet('en'),
        ruSolvedSet: getSolvedSet('ru'),
        mostWanted,
        proofNumbers,
        difficultyGrid,
    });
});

// Admin dashboard
app.use('/admin', adminRouter);

// Blog
app.use('/:lang(en|ru)/blog', blogRouter);
app.use('/blog', blogRouter);

// Email unsubscribe (one-click, token-based, no login) for announcement emails.
app.use('/unsubscribe', unsubscribeRouter);

// Feedback: suggestion box, public board, one-question poll.
// Deliberately NOT auth-gated anywhere — 59% of visits never return and virtually none of
// them are signed in, which is exactly why every other feedback channel on this site only
// ever hears from the same ten people. The router carries its own per-IP rate limiter; the
// global apiLimiter registered above is set to MAX_SAFE_INTEGER and protects nothing.
// Mounted here, well ahead of the `/:lang/:name` solution route, so /ru/feedback is not
// swallowed as a problem number.
app.use('/:lang(en|ru)/feedback', feedbackRouter);
app.use('/feedback', feedbackRouter);
app.use('/api/feedback', feedbackApi);

// Self-hosted email open/click tracking (pixel + signed click redirect).
app.use('/e', trackingRouter);

// Physics tools
app.use('/:lang/tools', toolsRouter);
app.use('/tools', toolsRouter);
app.use('/:lang(en|ru)/recommendations', recommendationsRouter);
app.use('/recommendations', recommendationsRouter);

// Problem Bank
app.use('/bank', bankRouter);

// Problem difficulty finder + methodology
app.use('/:lang(en|ru)/problems', problemsRouter);
app.use('/problems', problemsRouter);

// Discussion Forum
app.use('/discuss', forumRouter);

// Messages
app.use('/messages', messagesRouter);

// Brainstorm Room (per-problem, unified across languages) — API.
// Reads are public; writes are auth-gated inside the router. The /api/ prefix
// picks up the global apiLimiter registered above.
app.use('/api/brainstorm', brainstormRouter);

// Weekly Challenges
app.use('/compete', challengesRouter);

// Monthly Contest (live dashboard).
// The blind dual-judge evaluation router is mounted FIRST so its more specific
// /:slug/judge* routes win before the contest dashboard's /:slug catch-all.
app.use('/:lang(en|ru)/challenge', contestJudgeRouter);
app.use('/challenge', contestJudgeRouter);
app.use('/:lang(en|ru)/challenge', contestRouter);
app.use('/challenge', contestRouter);

// Study Paths
app.use('/paths', pathsRouter);

// Remove the old upload routes and add the new router
app.use('/', uploadRouter);

app.get("/en", async (req, res) => {
    const { chapters, theory, sections, pinnedChapters } = await getLanguageData('en');
    // "Most wanted" = unsolved problems ranked by how many people looked for them and
    // found nothing. Same query the /unsolved page uses, surfaced on the homepage so the
    // worklist is visible rather than buried: a physicist is far more likely to write
    // 5.5.7 when told 287 people wanted it than when asked to "contribute".
    const {
        recentContributions, topAuthors, solutionProgress, challengeWidget,
        recentContributors, mostWanted, proofNumbers, difficultyGrid,
    } = await getHomeWidgets('en');
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
        recentContributors,
        enSolvedSet: getSolvedSet('en'),
        ruSolvedSet: getSolvedSet('ru'),
        mostWanted,
        proofNumbers,
        difficultyGrid,
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
        res.status(500).render("500", {
            __: i18n.__,
            pageUrl: req.originalUrl,
            lang,
        });
    }
}

app.get(["/contributors", "/:lang/contributors"], handleContributorsRanking);

// Russian breadcrumb targets: /ru/1 and /ru/1,1 → main catalog anchors (not problem files)
// Brainstorm Room retired: its real messages were moved into the solution's comment
// thread (flagged is_brainstorm). Redirect any old room URL or bookmark to the solution
// page so nothing 404s. Must precede the /:lang/:name catch-all.
// The page a contributor comes back to. Everything unfinished, newest first, private.
//
// This is the half of drafts that was missing: the editor has been autosaving since
// 2026-08-09, but nothing ever showed anyone their own drafts or let them finish one, so
// the reassurance the feature exists to give — "close the tab, it will still be here" —
// was not something a person could actually see.
//
// Registered above the `/:lang/:name` catch-all below, for the same reason /user/:username
// is: two segments, so otherwise "drafts" is parsed as a problem slug and 404s.
app.get(["/drafts", "/:lang(en|ru)/drafts"], checkAuthenticated, async (req, res) => {
    // Bare /drafts has no language in the path, so fall back to the visitor's own
    // `lang` cookie rather than dropping a Russian-speaking contributor into English.
    // Read from the header directly: cookie-parser is not mounted, so `req.cookies`
    // does not exist, and adding a dependency for one lookup is not worth it.
    const cookieLang = /(?:^|;\s*)lang=(en|ru)\b/.exec(req.get("cookie") || "")?.[1];
    const lang = isValidSolutionLang(req.params.lang)
        ? req.params.lang
        : (cookieLang || "en");
    i18n.setLocale(res, lang);
    try {
        const result = await pool.query(
            `SELECT problem_name, language, content, updated_at
             FROM solution_drafts
             WHERE user_id = $1 AND completed_at IS NULL
             ORDER BY updated_at DESC
             LIMIT 100`,
            [req.session.userId]
        );
        const drafts = result.rows.map((row) => {
            // Same stripper the search index uses, so the preview line reads as prose
            // rather than as LaTeX source.
            const plain = searchIndex.stripLatexAndMarkdown(row.content || "");
            return {
                problemName: row.problem_name,
                language: row.language,
                updatedAt: row.updated_at,
                snippet: plain.length > 160 ? `${plain.slice(0, 160)}…` : plain,
            };
        });
        res.render("drafts", { __: i18n.__, lang, drafts });
    } catch (error) {
        console.error("Drafts page failed:", error);
        res.status(500).render("drafts", { __: i18n.__, lang, drafts: [] });
    }
});

app.get("/:lang(en|ru)/:name/brainstorm", (req, res) => {
    return res.redirect(301, `/${req.params.lang}/${req.params.name}`);
});

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
        // When this text was last published. The editor needs it to decide whether a
        // saved draft is still ahead of the solution or has been overtaken by someone
        // else's edit — a stale draft must never silently reappear over newer work.
        let fileModifiedAt = 0;
        try {
            fileModifiedAt = fs.statSync(filePath).mtimeMs;
        } catch { /* fall back to 0: any draft then counts as newer */ }
        i18n.setLocale(res, lang);
        res.render("edit_post", {
            __: i18n.__,
            lang,
            name,
            content: fileContents,
            fileModifiedAt: Math.round(fileModifiedAt),
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
// ── Drafts ──────────────────────────────────────────────────────────────────────
//
// Autosaved from the editor. The point is not convenience — it is that an attempt
// nobody finishes currently leaves no trace, so the site cannot tell a problem nobody
// wants from one five people tried and gave up on.
//
// A draft is private: only its author can read it back. The only thing anyone else
// ever sees is a count.
//
// Deliberately not `checkAuthenticated` — same reason as the difficulty vote above, but
// it bites harder here: that middleware redirects, a fetch() follows the redirect, and
// the login page comes back as 200 HTML. The editor would read `res.ok`, believe the
// draft was stored and display "all changes saved" over an expired session that saved
// nothing. A feature whose whole promise is "your work is safe" must fail loudly.
const requireAuthJson = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
    next();
};

// Autosave writes on a debounce, so a fast typist is a few requests a minute; this only
// has to stop something pathological. On 429 the editor keeps the work in localStorage
// and says so, rather than treating it as an error.
const draftSaveLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 400,
    keyGenerator: (req) => `d:${req.session?.userId ?? 'anonymous'}`,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: "rate_limited" }),
});

app.post("/api/drafts", requireAuthJson, draftSaveLimiter, async (req, res) => {
    const problemName = String(req.body?.problemName || "").trim();
    const language = String(req.body?.language || "").trim();
    const content = String(req.body?.content || "");

    if (!isValidSolutionProblemName(problemName) || !isValidSolutionLang(language)) {
        return res.status(400).json({ error: "Invalid problem or language" });
    }
    // An empty editor is not a draft, and a megabyte of it is not one either.
    if (content.trim().length === 0 || content.length > 200000) {
        return res.status(400).json({ error: "Nothing to save" });
    }

    try {
        await pool.query(
            `INSERT INTO solution_drafts (user_id, problem_name, language, content)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, problem_name, language)
             DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
            [req.session.userId, problemName, language, content]
        );
        res.json({ ok: true });
    } catch (error) {
        console.error("Draft save failed:", error);
        res.status(500).json({ error: "Failed to save draft" });
    }
});

app.get("/api/drafts/:problemName/:language", requireAuthJson, async (req, res) => {
    if (!isValidSolutionProblemName(req.params.problemName) || !isValidSolutionLang(req.params.language)) {
        return res.status(400).json({ error: "Invalid problem or language" });
    }
    try {
        const result = await pool.query(
            `SELECT content, updated_at FROM solution_drafts
             WHERE user_id = $1 AND problem_name = $2 AND language = $3 AND completed_at IS NULL`,
            [req.session.userId, req.params.problemName, req.params.language]
        );
        res.json({ draft: result.rows[0] || null });
    } catch (error) {
        console.error("Draft read failed:", error);
        res.status(500).json({ error: "Failed to read draft" });
    }
});

app.delete("/api/drafts/:problemName/:language", requireAuthJson, async (req, res) => {
    if (!isValidSolutionProblemName(req.params.problemName) || !isValidSolutionLang(req.params.language)) {
        return res.status(400).json({ error: "Invalid problem or language" });
    }
    try {
        await pool.query(
            `DELETE FROM solution_drafts
             WHERE user_id = $1 AND problem_name = $2 AND language = $3 AND completed_at IS NULL`,
            [req.session.userId, req.params.problemName, req.params.language]
        );
        res.json({ ok: true });
    } catch (error) {
        console.error("Draft delete failed:", error);
        res.status(500).json({ error: "Failed to delete draft" });
    }
});

// How many people are part-way through this problem. A count only — never who, and
// never what they wrote.
app.get("/api/drafts/:problemName/:language/count", async (req, res) => {
    if (!isValidSolutionProblemName(req.params.problemName) || !isValidSolutionLang(req.params.language)) {
        return res.status(400).json({ error: "Invalid problem or language" });
    }
    try {
        const result = await pool.query(
            `SELECT COUNT(*)::int AS n FROM solution_drafts
             WHERE problem_name = $1 AND language = $2 AND completed_at IS NULL`,
            [req.params.problemName, req.params.language]
        );
        res.set("Cache-Control", "public, max-age=300");
        res.json({ inProgress: result.rows[0]?.n || 0 });
    } catch (error) {
        res.json({ inProgress: 0 });
    }
});

app.post("/:lang/save/:name", checkAuthenticated, editSaveLimiter, async (req, res) => {
    const { lang, name } = req.params;
    const { content } = req.body;
    // Seconds of actual composition, as counted by the editor (it stops the clock when
    // the tab is hidden or idle). Clamped hard: this arrives from the browser, so it is
    // a claim, not a measurement, and six hours is already beyond generous for one
    // problem. Anything absurd or missing is stored as NULL rather than as a lie.
    const claimed = parseInt(req.body.composeSeconds, 10);
    const composeSeconds = Number.isFinite(claimed) && claimed > 0 && claimed <= 6 * 3600
        ? claimed
        : null;
    const userId = req.session.userId || null; // Will be null for unauthenticated users
    const clientIp = req.ip;

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

        // Nothing actually changed — so this is not an edit, and recording it as one is
        // worse than useless. 1,931 of 8,318 contribution rows (23%) are exactly this,
        // and the bursts behind them (peak: 15 rows in one second, 67 identical rows in
        // one sitting) came from people pressing Save again because it looked dead.
        // Answering success without writing anything makes a double-submit harmless.
        if (isSameContent(originalContent, content)) {
            if (userId) {
                await pool.query(
                    `UPDATE solution_drafts SET completed_at = NOW(), updated_at = NOW()
                     WHERE user_id = $1 AND problem_name = $2 AND language = $3 AND completed_at IS NULL`,
                    [userId, name, lang]
                ).catch(() => {});
            }
            if (editSaveWantsJson(req)) {
                return res.json({ ok: true, unchanged: true, redirect: `/${lang}/${name}` });
            }
            return res.redirect(`/${lang}/${name}`);
        }

        // Someone else published while this person was writing. Saving would silently
        // erase their work, and "I lost my solution" is the complaint this whole change
        // exists to answer — so refuse and say so. `baseModifiedAt` is only sent by the
        // editor; any other caller skips the check exactly as before.
        //
        // Checked after the no-op case on purpose: if the submitted text already
        // matches what is on disk, there is nothing to write and so nothing to
        // conflict with, even though the file moved underneath.
        const baseModifiedAt = parseInt(req.body.baseModifiedAt, 10);
        if (Number.isFinite(baseModifiedAt) && baseModifiedAt > 0) {
            let currentModifiedAt = 0;
            try {
                currentModifiedAt = Math.round(fs.statSync(filePath).mtimeMs);
            } catch { /* unreadable stat: fall through and save as before */ }
            // A second of slack: mtime resolution and the round-trip both cost a little.
            if (currentModifiedAt > baseModifiedAt + 1000) {
                const conflictMessage = lang === "ru"
                    ? "Решение изменилось, пока вы писали. Ваш черновик сохранён — откройте решение в новой вкладке и объедините правки."
                    : "This solution changed while you were writing. Your draft is saved — open it in a new tab and merge your work.";
                if (editSaveWantsJson(req)) {
                    return res.status(409).json({ ok: false, conflict: true, error: conflictMessage });
                }
                return res.status(409).send(conflictMessage);
            }
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

        // Notify IndexNow (Yandex + Bing) that this solution changed — fast re-crawl.
        pingIndexNow(`https://savchenkosolutions.com/${lang}/${name}`);

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
                content_changed,
                compose_seconds
            ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8)`,
            [userId, name, lang, originalContent, content, clientIp, contentChanged, composeSeconds]
        );

        // The draft became a solution. Kept rather than deleted, so the record of how
        // long it sat unfinished survives; only the rows that never reach this line
        // stay NULL, and those are the abandoned attempts.
        if (userId) {
            await pool.query(
                `UPDATE solution_drafts SET completed_at = NOW(), updated_at = NOW()
                 WHERE user_id = $1 AND problem_name = $2 AND language = $3 AND completed_at IS NULL`,
                [userId, name, lang]
            ).catch(() => {});
        }

        // One document, not all 2,500. A full rebuild here blocked the event loop for
        // ~2 s, which is what made the Save button feel dead. See searchIndex.js.
        searchIndex.updateDocument(lang, name, content);

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

// GET /find — the homepage's one action: "get me to my problem".
//
// Resolving server-side rather than jumping client-side matters because English covers
// only about a third of the collection: /en/2.2.12 is a 404 while /ru/2.2.12 exists. A
// naive client-side jump would send English visitors to dead pages for most problems.
// This prefers the requested language, falls back to the other, and otherwise hands off
// to search. Being a plain GET, it also works with JavaScript disabled.
app.get("/find", searchLimiter, (req, res) => {
    const raw = String(req.query.search || req.query.q || "").trim();
    const lang = req.query.lang === "ru" ? "ru" : "en";
    const other = lang === "en" ? "ru" : "en";

    // Chapters 1-14; tolerate the comma some keyboard layouts produce for a full stop.
    const m = /^(\d{1,2})[.,](\d{1,2})[.,](\d{1,3})$/.exec(raw.replace(/\s+/g, ""));
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 14) {
        const problem = `${m[1]}.${m[2]}.${m[3]}`;
        const exists = (l) => fs.existsSync(path.join(__dirname, `posts/${l}`, `${problem}.md`));
        if (exists(lang)) return res.redirect(302, `/${lang}/${problem}`);
        if (exists(other)) return res.redirect(302, `/${other}/${problem}`);
        // A real problem number with nothing written yet. The unsolved list is the honest
        // destination — and it is where someone might decide to write one.
        return res.redirect(302, `/${lang}/unsolved`);
    }

    if (!raw) return res.redirect(302, `/${lang}/`);
    return res.redirect(302, `/global-search?search=${encodeURIComponent(raw)}&lang=${lang}`);
});

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

// Catch-all 404 for routes nothing else handled (JSON for APIs, styled page otherwise)
app.use((req, res) => {
    if (req.path && req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    const lang = (req.path && req.path.startsWith('/ru')) ? 'ru' : 'en';
    i18n.setLocale(res, lang);
    res.status(404).render("404", { __: i18n.__, lang, pageUrl: req.originalUrl });
});

// Global error handler — render a real 500 page instead of leaking a stack trace
// or (as before) showing the 404 "this problem doesn't exist" page for server errors.
app.use((err, req, res, next) => {
    console.error('Unhandled error on', req.method, req.originalUrl, '\n', err);
    if (res.headersSent) return next(err);
    if (req.path && req.path.startsWith('/api/')) {
        return res.status(500).json({ error: 'Internal server error' });
    }
    const lang = (req.path && req.path.startsWith('/ru')) ? 'ru' : 'en';
    res.status(500).render("500", { lang }, (renderErr, html) => {
        if (renderErr) {
            console.error('Failed to render 500 page:', renderErr);
            res.status(500).type('text').send("Something went wrong on our end — we're looking into it.");
        } else {
            res.send(html);
        }
    });
});

// Start the main server.
//
// Bound to loopback on purpose. Caddy is the only thing that should ever reach this port,
// and until now 0.0.0.0:3000 answered directly from the internet — which bypassed every
// control in Caddy and, worse, made req.ip forgeable: with `trust proxy: 1` a direct
// connection carrying its own X-Forwarded-For resolves to whatever the caller wrote,
// defeating the blocklist, the allowlists and the rate limiters in one header.
// HOST is overridable so a container or a different proxy setup can still work.
const HOST = process.env.BIND_HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
    console.log(`Main server listening on ${HOST}:${PORT}`);
});

// Add this function near your other database query functions
async function getRecentContributors(limit = 6) {
    try {
        const result = await pool.query(
            // created_at is unpopulated (NULL) for existing rows, so order by id —
            // the serial primary key is monotonic with signup order.
            `SELECT u.username, u.full_name, u.profile_picture
             FROM users u
             LEFT JOIN user_preferences p ON p.user_id = u.id
             WHERE COALESCE(p.public_profile, true) = true
               AND u.username IS NOT NULL
             ORDER BY u.id DESC
             LIMIT $1`,
            [limit]
        );
        return result.rows;
    } catch (err) {
        console.error('Error fetching recent contributors:', err);
        return [];
    }
}

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
                    u.last_seen_at,
                    BOOL_OR(COALESCE(pr.show_online_status, true)) AS show_online,
                    COUNT(DISTINCT ac.problem_name) AS unique_contributions,
                    COUNT(*) AS total_contributions,
                    19 * LN(COUNT(DISTINCT ac.problem_name) * SQRT(COUNT(*))) AS raw_rank
                FROM all_contributions ac
                JOIN users u ON ac.user_id = u.id
                LEFT JOIN user_preferences pr ON pr.user_id = u.id
                GROUP BY u.id, u.username, u.profile_picture, u.last_seen_at
            )
            SELECT
                username,
                profile_picture,
                unique_contributions,
                total_contributions,
                (last_seen_at > NOW() - INTERVAL '5 minutes' AND show_online) AS is_online,
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
    const clientIp = req.ip;

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
