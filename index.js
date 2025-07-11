// Import the sitemap generation script
require('./sitemap');

const express = require("express");
const path = require("path");
const fs = require("fs"); // Import fs module
const bodyParser = require("body-parser");
const { convertLatexToPlainText } = require("./utils"); // Importing functions from utils.js
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
        const allowedTypes = /jpeg|jpg|png|gif/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

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

        // Get user interests
        const interestsResult = await pool.query(
            "SELECT interest_tag FROM user_interests WHERE user_id = $1",
            [req.session.userId]
        );
        const interests = interestsResult.rows;

        res.render("user_settings", {
            __: i18n.__,
            lang,
            username: user.username,
            fullName: user.full_name,
            email: user.email,
            bio: user.bio,
            countryLocation: user.country_location,
            linkedin: user.linkedin,
            github: user.github,
            instagram: user.instagram,
            personalWebsite: user.personal_website,
            profilePicture: user.profile_picture || `/img/profile_images/${user.id}.png`,
            preferences,
            interests,
            error: req.query.error || "",
            success: req.query.success || ""
        });
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/profile?error=${i18n.__('Failed to load settings')}`);
    }
});


// Add comprehensive contributors ranking page
app.get(["/contributors", "/:lang/contributors"], async (req, res) => {
    const lang = req.params.lang || 'en';
    const page = parseInt(req.query.page) || 1;
    const limit = 25;
    const offset = (page - 1) * limit;
    
    i18n.setLocale(res, lang);

    try {
        // Get total count for pagination
        const countQuery = `
            WITH all_contributions AS (
                SELECT user_id, problem_name FROM contributions WHERE user_id != 28 AND user_id IS NOT NULL
                UNION ALL
                SELECT user_id, problem_name FROM github_contributions WHERE user_id != 28 AND user_id IS NOT NULL
            )
            SELECT COUNT(DISTINCT user_id) as total
            FROM all_contributions
        `;
        
        const countResult = await pool.query(countQuery);
        const totalContributors = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(totalContributors / limit);

        // Get contributors with rankings
        const contributorsQuery = `
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
            ),
            ranked_users AS (
                SELECT 
                    *,
                    ROUND(raw_rank::numeric, 0) AS rank,
                    ROW_NUMBER() OVER (ORDER BY raw_rank DESC) AS position
                FROM user_stats
            )
            SELECT * FROM ranked_users
            ORDER BY rank DESC
            LIMIT $1 OFFSET $2
        `;
        
        const contributorsResult = await pool.query(contributorsQuery, [limit, offset]);
        console.log(contributorsResult.rows);
        // Add some artificial high-ranking entries for the first page
        let contributors = contributorsResult.rows;
        if (page === 1) {
            const artificialEntries = [
                { 
                    id: 999, 
                    username: 'ar4senN', 
                    full_name: 'Арсен Алмашкан', 
                    profile_picture: null,
                    created_at: new Date('2023-01-15'),
                    rank: 116, 
                    unique_contributions: 55, 
                    total_contributions: 110,
                    position: 1
                },
                { 
                    id: 998, 
                    username: 'a.yersh', 
                    full_name: 'Андрей Ёрш', 
                    profile_picture: null,
                    created_at: new Date('2023-02-20'),
                    rank: 110, 
                    unique_contributions: 45, 
                    total_contributions: 90,
                    position: 2
                },
                { 
                    id: 997, 
                    username: 'jepkinsss', 
                    full_name: 'Артем Левко', 
                    profile_picture: null,
                    created_at: new Date('2023-03-10'),
                    rank: 99, 
                    unique_contributions: 30, 
                    total_contributions: 60,
                    position: 3
                }
            ];

            // Adjust positions for real contributors
            contributors = contributors.map(contributor => ({
                ...contributor,
                position: contributor.position + 3
            }));

            contributors = [...artificialEntries, ...contributors];
        } else {
            // Adjust positions for other pages
            contributors = contributors.map(contributor => ({
                ...contributor,
                position: contributor.position + 3 + ((page - 1) * limit)
            }));
        }

        // Get user's profile picture if logged in
        let profilePicture = null;
        if (req.session.userId) {
            const userResult = await pool.query(
                "SELECT profile_picture FROM users WHERE id = $1",
                [req.session.userId]
            );
            profilePicture = userResult.rows[0]?.profile_picture || null;
        }

        res.render("contributors_ranking", {
            __: i18n.__,
            lang,
            contributors,
            currentPage: page,
            totalPages,
            totalContributors: totalContributors + 3, // Add artificial entries to total
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
            username: req.session.username || null,
            userId: req.session.userId || null,
            profilePicture
        });
    } catch (error) {
        console.error("Error fetching contributors:", error);
        res.status(500).render("404", {
            __: i18n.__,
            pageUrl: req.originalUrl,
            lang
        });
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
// Profile settings update
app.post("/:lang/settings/profile", checkAuthenticated, profileUpload.single('profilePicture'), async (req, res) => {
    const { lang } = req.params;
    const { fullName, email, bio, countryLocation } = req.body;

    try {
        let updateData = { fullName, email, bio, countryLocation };
        
        // Handle profile picture upload
        if (req.file) {
            updateData.profilePicture = `/img/profile_images/${req.file.filename}`;
        }

        // Update user data
        await pool.query(
            `UPDATE users SET 
                full_name = $1, 
                email = $2, 
                bio = $3, 
                country_location = $4
                ${req.file ? ', profile_picture = $5' : ''}
            WHERE id = ${req.file ? '$6' : '$5'}`,
            req.file 
                ? [fullName, email, bio, countryLocation, updateData.profilePicture, req.session.userId]
                : [fullName, email, bio, countryLocation, req.session.userId]
        );

        res.redirect(`/${lang}/settings?success=${encodeURIComponent('Profile updated successfully')}`);
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/settings?error=${encodeURIComponent('Failed to update profile')}`);
    }
});

// Social links update
app.post("/:lang/settings/social", checkAuthenticated, async (req, res) => {
    const { lang } = req.params;
    const { linkedin, github, instagram, personalWebsite } = req.body;

    try {
        await pool.query(
            "UPDATE users SET linkedin = $1, github = $2, instagram = $3, personal_website = $4 WHERE id = $5",
            [linkedin, github, instagram, personalWebsite, req.session.userId]
        );

        res.redirect(`/${lang}/settings?success=${encodeURIComponent('Social links updated successfully')}`);
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/settings?error=${encodeURIComponent('Failed to update social links')}`);
    }
});

// Privacy settings update
app.post("/:lang/settings/privacy", checkAuthenticated, async (req, res) => {
    const { lang } = req.params;
    const { publicProfile, showOnlineStatus, emailNotifications, privacyLevel } = req.body;

    try {
        // Insert or update user preferences
        await pool.query(
            `INSERT INTO user_preferences (user_id, public_profile, show_online_status, email_notifications, privacy_level)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id) 
             DO UPDATE SET 
                public_profile = $2,
                show_online_status = $3,
                email_notifications = $4,
                privacy_level = $5,
                updated_at = NOW()`,
            [req.session.userId, !!publicProfile, !!showOnlineStatus, !!emailNotifications, privacyLevel]
        );

        res.redirect(`/${lang}/settings?success=${encodeURIComponent('Privacy settings updated successfully')}`);
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/settings?error=${encodeURIComponent('Failed to update privacy settings')}`);
    }
});

// Interests update
app.post("/:lang/settings/interests", checkAuthenticated, async (req, res) => {
    const { lang } = req.params;
    const { interests } = req.body;

    try {
        const interestsList = JSON.parse(interests);

        // Delete existing interests
        await pool.query("DELETE FROM user_interests WHERE user_id = $1", [req.session.userId]);

        // Insert new interests
        if (interestsList.length > 0) {
            const values = interestsList.map((interest, index) => 
                `($1, $${index + 2})`
            ).join(', ');
            
            await pool.query(
                `INSERT INTO user_interests (user_id, interest_tag) VALUES ${values}`,
                [req.session.userId, ...interestsList]
            );
        }

        res.redirect(`/${lang}/settings?success=${encodeURIComponent('Interests updated successfully')}`);
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/settings?error=${encodeURIComponent('Failed to update interests')}`);
    }
});

// Password update for settings
app.post("/:lang/settings/password", checkAuthenticated, async (req, res) => {
    const { lang } = req.params;
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (newPassword !== confirmPassword) {
        return res.redirect(`/${lang}/settings?error=${encodeURIComponent('New passwords do not match')}`);
    }

    try {
        const result = await pool.query(
            "SELECT password FROM users WHERE id = $1",
            [req.session.userId]
        );

        const validPassword = await bcrypt.compare(currentPassword, result.rows[0].password);

        if (!validPassword) {
            return res.redirect(`/${lang}/settings?error=${encodeURIComponent('Current password is incorrect')}`);
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query(
            "UPDATE users SET password = $1 WHERE id = $2",
            [hashedPassword, req.session.userId]
        );

        res.redirect(`/${lang}/settings?success=${encodeURIComponent('Password updated successfully')}`);
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/settings?error=${encodeURIComponent('Failed to update password')}`);
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
                c.id, c.content, c.parent_id, c.created_at, c.updated_at,
                u.username, u.full_name, u.profile_picture
            FROM solution_comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.problem_name = $1 AND c.language = $2 AND c.is_deleted = false
            ORDER BY c.created_at ASC`,
            [problemName, language]
        );

        // Organize comments into threads
        const comments = result.rows.map(row => ({
            id: row.id,
            content: row.content,
            parentId: row.parent_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            author: {
                username: row.username,
                fullName: row.full_name,
                profilePicture: row.profile_picture || `/img/profile_images/${row.username}.png`
            }
        }));

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

        res.json({
            id: result.rows[0].id,
            content: content.trim(),
            parentId: parentId || null,
            createdAt: result.rows[0].created_at,
            author: {
                username: user.username,
                fullName: user.full_name,
                profilePicture: user.profile_picture || `/img/profile_images/${user.username}.png`
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to add comment" });
    }
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
    const recentContributions = await getRecentContributions(10);
    const topAuthors = await getTopAuthors();

    i18n.setLocale(res, lang);
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;

    const userAgent = req.headers['user-agent'];
    const isMobile = /mobile/i.test(userAgent);
    const working_page = isMobile ? "eng_page" : "eng_page";

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
        recentContributions,
        topAuthors
    });
});

async function getRecentContributions(limit) {
    try {
        const result = await pool.query(
            "SELECT id, problem_name, user_id, edited_at AT TIME ZONE 'UTC' as edited_at, ip_address, invisible FROM contributions WHERE invisible = false ORDER BY edited_at DESC LIMIT $1",
            [limit]
        );

        const contributions = await Promise.all(result.rows.map(async (row) => {
            const userResult = await pool.query("SELECT username FROM users WHERE id = $1", [row.user_id]);
            const username = userResult.rows[0]?.username || row.ip_address;

            return {
                version: row.problem_name,
                editor: username,
                timestamp: new Intl.DateTimeFormat(undefined, { // 'undefined' uses the user's locale
                    hour: '2-digit',
                    minute: '2-digit',
                    month: 'short',
                    day: '2-digit',
                    timeZoneName: 'short'
                }).format(row.edited_at),
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
    const recentContributions = await getRecentContributions(10);
    const topAuthors = await getTopAuthors();
    i18n.setLocale(res, 'ru');
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;

    const userAgent = req.headers['user-agent'];
    const isMobile = /mobile/i.test(userAgent);
    const working_page = isMobile ? "eng_page" : "eng_page";

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
        recentContributions,
        topAuthors
    });
});

// Remove the old upload routes and add the new router
app.use('/', uploadRouter);

app.get("/en", async (req, res) => {
    const { chapters, theory, sections, pinnedChapters } = await getLanguageData('en');
    const recentContributions = await getRecentContributions(10);
    const topAuthors = await getTopAuthors();
    i18n.setLocale(res, 'en');
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;

    const userAgent = req.headers['user-agent'];
    const isMobile = /mobile/i.test(userAgent);
    const working_page = isMobile ? "eng_page" : "eng_page";

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
        recentContributions,
        topAuthors
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
    '5.228.81.203',
    '81.57.75.160',
    '82.194.13.2'
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
    const userLang = req.query.lang || res.getLocale() || 'en'; // Get language from query params first
    
    if (!query) {
        return res.json({ results: [] });
    }


    const searchDirectory = path.join(__dirname, "posts");
    const results = [];
    const processedFiles = new Set();

    const truncateWithHighlight = (name, text, query, maxLength = 48) => {
        // Remove the name and clean up special characters
        text = convertLatexToPlainText(text) // Use the enhanced convertLatexToPlainText function
            .replace(name, "")
            .replace(/#{1,3}\s*/g, "")
            .replace(/Statement\s*\./g, "")
            .replace(/Условие\s*\./g, "")
            .replace(/Условие:\s*\./g, "")
            .replace(/Условие:/g, "")
            .replace(/^\s*\./g, "");

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
        // Get list of language directories
        const langDirs = fs.readdirSync(directory).filter(dir => 
            fs.statSync(path.join(directory, dir)).isDirectory()
        );
        
        // Reorder directories to put userLang first
        const orderedDirs = [
            ...langDirs.filter(dir => dir === userLang),
            ...langDirs.filter(dir => dir !== userLang)
        ];

        const langResults = {
            primary: [],   // Results in user's language
            secondary: []  // Results in other language
        };

        // Search through directories in the preferred order
        orderedDirs.forEach(langDir => {
            const langPath = path.join(directory, langDir);
            const files = fs.readdirSync(langPath);

            // First pass: search file names
            files.forEach((file) => {
                const fullPath = path.join(langPath, file);
                if (file.endsWith(".md")) {
                    const fileKey = `${langDir}_${file}`;
                    if (processedFiles.has(fileKey)) return;

                    const name = file.replace(".md", "");
                    const nameLower = name.toLowerCase();
                    
                    if (nameLower.includes(query)) {
                        const fileContents = fs.readFileSync(fullPath, "utf8");
                        const firstFiveLines = fileContents.split("\n").slice(0, 5).join(" ");
                        
                        // Clean up the text for display, but don't search within it
                        let cleanedText = convertLatexToPlainText(firstFiveLines)
                            .replace(name, "")
                            .replace(/\$/g, "")
                            .replace(/_/g, "")
                            .replace(".$", "")
                            .replace("\^", "")
                            .replace("\*", "")
                            .replace(/#{1,3}\s*/g, "")
                            .replace("\ell", "l")
                            .replace(/Statement\s*\./g, "")
                            .replace(/Условие\s*\./g, "")
                            .replace(/Условие:\s*\./g, "")
                            .replace(/Условие:/g, "")
                            .replace(/Условие/g, "")
                            .replace(/^\s*\./g, "") // Remove leading periods (and any whitespace before them)
                            .replace(/\{[^}]*\}/g, ""); // Remove anything between curly braces

                        const result = {
                            lang: langDir,
                            name,
                            relativePath: `/${langDir}/${name}`,
                            snippet: cleanedText.slice(0, 50) + " ...", // Add ellipsis after truncation
                            lineNumber: 1,
                            isFileNameMatch: true,
                            confidence: nameLower === query && langDir === userLang ? 'high' : 'medium'
                        };

                        if (langDir === userLang) {
                            langResults.primary.push(result);
                        } else {
                            langResults.secondary.push(result);
                        }

                        processedFiles.add(fileKey);
                    }
                }
            });

            // Second pass: search file contents
            files.forEach((file) => {
                const fullPath = path.join(langPath, file);
                if (file.endsWith(".md")) {
                    const fileKey = `${langDir}_${file}`;
                    if (processedFiles.has(fileKey)) return;

                    let fileContents = fs.readFileSync(fullPath, "utf8");
                    
                    // Join lines with space to handle headings without newlines
                    const searchableContent = fileContents.split("\n").join(" ");

                    if (searchableContent.toLowerCase().includes(query)) {
                        const name = file.replace(".md", "");
                        const snippet = truncateWithHighlight(name, searchableContent, query);

                        const result = {
                            lang: langDir,
                            name,
                            relativePath: `/${langDir}/${name}`,
                            snippet: snippet,
                            lineNumber: 1, // Line number becomes less relevant with joined content
                            isFileNameMatch: false
                        };
                        
                        if (langDir === userLang) {
                            langResults.primary.push(result);
                        } else {
                            langResults.secondary.push(result);
                        }

                        processedFiles.add(fileKey);
                    }
                }
            });
        });

        // console.log(langResults.primary);
        // console.log(langResults.secondary);
        const sortResults = (a, b) => {
            // Sort by confidence first
            if ((a.confidence === 'high') !== (b.confidence === 'high')) {
                return a.confidence === 'high' ? -1 : 1;
            }
            // Then by filename match
            if (a.isFileNameMatch !== b.isFileNameMatch) {
                return b.isFileNameMatch ? 1 : -1;
            }
            // Finally by name
            return a.name.localeCompare(b.name);
        };


        langResults.primary.sort(sortResults);
        langResults.secondary.sort(sortResults);

        // Combine results with preferred language first
        results.push(...langResults.primary, ...langResults.secondary);
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
            profile_picture: row.profile_picture || `/img/profile_images/${row.user_id}.png`,
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

// Start the main server
app.listen(PORT, () => {
    console.log(`Main server listening on port ${PORT}`);
});

// Add this function near your other database query functions
async function getTopAuthors() {
    try {
        const query = `
            WITH all_contributions AS (
                SELECT user_id, problem_name FROM contributions WHERE user_id != 28
                UNION ALL
                SELECT user_id, problem_name FROM github_contributions WHERE user_id != 28
            ),
            user_stats AS (
                SELECT 
                    u.username,
                    COUNT(DISTINCT ac.problem_name) AS unique_contributions,
                    COUNT(*) AS total_contributions,
                    19 * LN(COUNT(DISTINCT ac.problem_name) * SQRT(COUNT(*))) AS raw_rank
                FROM all_contributions ac
                JOIN users u ON ac.user_id = u.id
                GROUP BY u.username
            )
            SELECT 
                username,
                unique_contributions,
                total_contributions,
                ROUND(raw_rank::numeric, 0) AS rank
            FROM user_stats
            ORDER BY rank DESC
            LIMIT 10
        `;
        
        const result = await pool.query(query);
        
        // Add artificial entries
        const artificialEntries = [
            { username: 'ar4senN', rank: 116, unique_contributions: 55, total_contributions: 110 },
            { username: 'a.yersh', rank: 110, unique_contributions: 45, total_contributions: 90 },
            { username: 'jepkinsss', rank: 99, unique_contributions: 30, total_contributions: 60 }
        ];

        // Combine real and artificial entries
        const combinedResults = [...result.rows, ...artificialEntries]
            .sort((a, b) => b.rank - a.rank) // Sort by rank in descending order
            .slice(0, 10); // Keep only top 10

        return combinedResults;
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
