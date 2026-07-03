const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const i18n = require('i18n');
const { parseMarkdown } = require('./utils');
const { getOnlineUsernames } = require('./lib/presence');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const challengeStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'img', 'challenges', String(req.params.id));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${req.session.userId}_${Date.now()}${ext}`);
    }
});

const challengeUpload = multer({
    storage: challengeStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedExt = /\.(jpe?g|png|gif|webp|heic)$/i.test(file.originalname);
        const okMime = !file.mimetype || /image\/(jpeg|png|gif|webp|heic)/i.test(file.mimetype);
        if (okMime && allowedExt) {
            return cb(null, true);
        }
        cb(new Error('Only image files are allowed'));
    }
});

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

let hasChallengesTableCache = null;

async function hasChallengesTable() {
    if (hasChallengesTableCache !== null) return hasChallengesTableCache;
    try {
        const result = await pool.query(
            `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'challenges'
            ) AS exists`
        );
        hasChallengesTableCache = !!result.rows[0]?.exists;
    } catch (_err) {
        hasChallengesTableCache = false;
    }
    return hasChallengesTableCache;
}

function getLang(req) {
    return req.session.lang || 'en';
}

// Auth middleware
function requireAuth(req, res, next) {
    const lang = getLang(req);
    if (!req.session.userId) {
        return res.status(401).redirect(`/${lang}/login?error=Please log in to submit a challenge solution`);
    }
    next();
}

// GET /compete — main challenges page
router.get('/', async (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    try {
        if (!(await hasChallengesTable())) {
            return res.render('challenges/index', {
                __: i18n.__, lang,
                currentChallenge: null, pastChallenges: [], leaderboard: [],
                userSubmission: null, submissionCount: 0,
            });
        }

        const now = new Date().toISOString().split('T')[0];

        // Current active challenge
        const currentResult = await pool.query(
            `SELECT c.*, u.username AS author_name
             FROM challenges c
             LEFT JOIN users u ON c.created_by = u.id
             WHERE c.is_active = true AND c.week_start <= $1 AND c.week_end >= $1
             ORDER BY c.week_start DESC LIMIT 1`,
            [now]
        );
        const currentChallenge = currentResult.rows[0] || null;
        if (currentChallenge && currentChallenge.problem_statement) {
            currentChallenge.problem_statement = parseMarkdown(currentChallenge.problem_statement);
        }

        // Submission count for current challenge
        let submissionCount = 0;
        let userSubmission = null;
        if (currentChallenge) {
            const countResult = await pool.query(
                'SELECT COUNT(*) FROM challenge_submissions WHERE challenge_id = $1',
                [currentChallenge.id]
            );
            submissionCount = parseInt(countResult.rows[0].count);

            if (req.session.userId) {
                const subResult = await pool.query(
                    'SELECT * FROM challenge_submissions WHERE challenge_id = $1 AND user_id = $2',
                    [currentChallenge.id, req.session.userId]
                );
                userSubmission = subResult.rows[0] || null;
            }
        }

        // Past challenges
        const pastResult = await pool.query(
            `SELECT c.id, c.title, c.difficulty, c.week_start, c.week_end, c.solution,
                    (SELECT COUNT(*) FROM challenge_submissions cs WHERE cs.challenge_id = c.id AND cs.is_correct = true) AS correct_count
             FROM challenges c
             WHERE c.week_end < $1
             ORDER BY c.week_end DESC LIMIT 20`,
            [now]
        );

        // Leaderboard top 20
        const leaderboardResult = await pool.query(
            `SELECT cl.*, u.username, u.profile_picture
             FROM challenge_leaderboard cl
             JOIN users u ON cl.user_id = u.id
             ORDER BY cl.total_score DESC, cl.total_solved DESC
             LIMIT 20`
        );

        // Attach online-presence flag to leaderboard participants
        const lbOnline = await getOnlineUsernames(pool, leaderboardResult.rows.map((r) => r.username));
        leaderboardResult.rows.forEach((r) => { r.isOnline = lbOnline.has(r.username); });

        res.render('challenges/index', {
            __: i18n.__,
            lang,
            currentChallenge,
            pastChallenges: pastResult.rows,
            leaderboard: leaderboardResult.rows,
            userSubmission,
            submissionCount,
        });
    } catch (err) {
        console.error('Challenges index error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// GET /compete/leaderboard — full leaderboard
router.get('/leaderboard', async (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    try {
        if (!(await hasChallengesTable())) {
            return res.render('challenges/leaderboard', {
                __: i18n.__, lang, leaderboard: [],
            });
        }

        const result = await pool.query(
            `SELECT cl.*, u.username, u.profile_picture
             FROM challenge_leaderboard cl
             JOIN users u ON cl.user_id = u.id
             ORDER BY cl.total_score DESC, cl.total_solved DESC`
        );

        // Attach online-presence flag to leaderboard participants
        const online = await getOnlineUsernames(pool, result.rows.map((r) => r.username));
        result.rows.forEach((r) => { r.isOnline = online.has(r.username); });

        res.render('challenges/leaderboard', {
            __: i18n.__, lang, leaderboard: result.rows,
        });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// GET /compete/:id — single challenge detail
router.get('/:id(\\d+)', async (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    try {
        if (!(await hasChallengesTable())) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }

        const challengeResult = await pool.query(
            `SELECT c.*, u.username AS author_name
             FROM challenges c
             LEFT JOIN users u ON c.created_by = u.id
             WHERE c.id = $1`,
            [req.params.id]
        );
        if (challengeResult.rows.length === 0) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }

        const challenge = challengeResult.rows[0];
        if (challenge.problem_statement) {
            challenge.problem_statement = parseMarkdown(challenge.problem_statement);
        }
        const now = new Date().toISOString().split('T')[0];
        const isExpired = challenge.week_end < now;

        const countResult = await pool.query(
            'SELECT COUNT(*) FROM challenge_submissions WHERE challenge_id = $1',
            [challenge.id]
        );
        const submissionCount = parseInt(countResult.rows[0].count);

        let userSubmission = null;
        if (req.session.userId) {
            const subResult = await pool.query(
                'SELECT * FROM challenge_submissions WHERE challenge_id = $1 AND user_id = $2',
                [challenge.id, req.session.userId]
            );
            userSubmission = subResult.rows[0] || null;
        }

        // If expired, show correct submissions
        let correctSubmissions = [];
        if (isExpired) {
            const csResult = await pool.query(
                `SELECT cs.content, cs.image_path, cs.submitted_at, u.username, u.profile_picture
                 FROM challenge_submissions cs
                 JOIN users u ON cs.user_id = u.id
                 WHERE cs.challenge_id = $1 AND cs.is_correct = true
                 ORDER BY cs.submitted_at ASC`,
                [challenge.id]
            );
            correctSubmissions = csResult.rows;

            // Attach online-presence flag to submission authors
            const online = await getOnlineUsernames(pool, correctSubmissions.map((s) => s.username));
            correctSubmissions.forEach((s) => { s.isOnline = online.has(s.username); });
        }

        res.render('challenges/show', {
            __: i18n.__, lang,
            challenge, isExpired, submissionCount,
            userSubmission, correctSubmissions,
        });
    } catch (err) {
        console.error('Challenge detail error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// POST /compete/:id/submit — submit solution
router.post('/:id(\\d+)/submit', requireAuth, async (req, res) => {
    try {
        if (!(await hasChallengesTable())) {
            return res.status(400).json({ error: 'Challenges not available' });
        }

        const challengeId = parseInt(req.params.id);
        const { content, imagePath } = req.body;

        if ((!content || !content.trim()) && !imagePath) {
            return res.status(400).json({ error: 'Submission content is required' });
        }

        // Check challenge exists and is active
        const challengeResult = await pool.query(
            'SELECT * FROM challenges WHERE id = $1',
            [challengeId]
        );
        if (challengeResult.rows.length === 0) {
            return res.status(404).json({ error: 'Challenge not found' });
        }

        const challenge = challengeResult.rows[0];
        const now = new Date().toISOString().split('T')[0];

        if (now < challenge.week_start || now > challenge.week_end) {
            return res.status(400).json({ error: 'This challenge is not currently active' });
        }

        // Upsert submission (one per user per challenge)
        const trimmedContent = content ? content.trim() : '';
        await pool.query(
            `INSERT INTO challenge_submissions (challenge_id, user_id, content, image_path, submitted_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (challenge_id, user_id)
             DO UPDATE SET content = $3, image_path = COALESCE($4, challenge_submissions.image_path), submitted_at = NOW()`,
            [challengeId, req.session.userId, trimmedContent, imagePath || null]
        );

        res.json({ success: true, message: 'Submission saved' });
    } catch (err) {
        console.error('Challenge submit error:', err);
        res.status(500).json({ error: 'Failed to save submission' });
    }
});

// POST /compete/:id/upload-image — upload handwritten solution photo
router.post('/:id(\\d+)/upload-image', requireAuth, challengeUpload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        if (!(await hasChallengesTable())) {
            return res.status(400).json({ error: 'Challenges not available' });
        }

        const challengeId = parseInt(req.params.id);

        const challengeResult = await pool.query(
            'SELECT week_start, week_end FROM challenges WHERE id = $1',
            [challengeId]
        );
        if (challengeResult.rows.length === 0) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Challenge not found' });
        }

        const challenge = challengeResult.rows[0];
        const now = new Date().toISOString().split('T')[0];
        if (now < challenge.week_start || now > challenge.week_end) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'This challenge is not currently active' });
        }

        const imagePath = `/img/challenges/${challengeId}/${req.file.filename}`;

        let width, height;
        try {
            const metadata = await sharp(req.file.path).metadata();
            width = metadata.width;
            height = metadata.height;
        } catch (_e) {
            width = null;
            height = null;
        }

        res.json({ success: true, imagePath, width, height });
    } catch (err) {
        console.error('Challenge image upload error:', err);
        res.status(500).json({ error: 'Failed to upload image' });
    }
});

// POST /compete/:id/remove-image — remove uploaded image from submission
router.post('/:id(\\d+)/remove-image', requireAuth, async (req, res) => {
    try {
        if (!(await hasChallengesTable())) {
            return res.status(400).json({ error: 'Challenges not available' });
        }

        const challengeId = parseInt(req.params.id);
        const subResult = await pool.query(
            'SELECT image_path FROM challenge_submissions WHERE challenge_id = $1 AND user_id = $2',
            [challengeId, req.session.userId]
        );

        if (subResult.rows.length > 0 && subResult.rows[0].image_path) {
            const filePath = path.join(__dirname, subResult.rows[0].image_path);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            await pool.query(
                'UPDATE challenge_submissions SET image_path = NULL WHERE challenge_id = $1 AND user_id = $2',
                [challengeId, req.session.userId]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Remove challenge image error:', err);
        res.status(500).json({ error: 'Failed to remove image' });
    }
});

// Helper: get current challenge for home page widget
async function getCurrentChallengeWidget() {
    try {
        if (!(await hasChallengesTable())) return null;

        const now = new Date().toISOString().split('T')[0];
        const result = await pool.query(
            `SELECT c.id, c.title, c.problem_statement, c.difficulty, c.week_end,
                    (SELECT COUNT(*) FROM challenge_submissions cs WHERE cs.challenge_id = c.id) AS submission_count
             FROM challenges c
             WHERE c.is_active = true AND c.week_start <= $1 AND c.week_end >= $1
             ORDER BY c.week_start DESC LIMIT 1`,
            [now]
        );
        return result.rows[0] || null;
    } catch (_err) {
        return null;
    }
}

// Helper: get challenge submissions for admin review
async function getChallengeSubmissionsForAdmin(challengeId) {
    try {
        if (!(await hasChallengesTable())) return [];
        const result = await pool.query(
            `SELECT cs.*, u.username, u.profile_picture
             FROM challenge_submissions cs
             JOIN users u ON cs.user_id = u.id
             WHERE cs.challenge_id = $1
             ORDER BY cs.submitted_at ASC`,
            [challengeId]
        );
        return result.rows;
    } catch (_err) {
        return [];
    }
}

// Helper: mark submission correct and update leaderboard
async function markSubmissionCorrect(submissionId, reviewerId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Mark as correct
        const subResult = await client.query(
            `UPDATE challenge_submissions
             SET is_correct = true, reviewed_by = $1, reviewed_at = NOW()
             WHERE id = $2
             RETURNING challenge_id, user_id`,
            [reviewerId, submissionId]
        );
        if (subResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return false;
        }

        const { challenge_id, user_id } = subResult.rows[0];

        // Get challenge week_end to compute streak
        const chalResult = await client.query(
            'SELECT week_end FROM challenges WHERE id = $1',
            [challenge_id]
        );

        // Upsert leaderboard entry
        await client.query(
            `INSERT INTO challenge_leaderboard (user_id, total_solved, current_streak, longest_streak, total_score)
             VALUES ($1, 1, 1, 1, 10)
             ON CONFLICT (user_id)
             DO UPDATE SET
                total_solved = challenge_leaderboard.total_solved + 1,
                total_score = challenge_leaderboard.total_score + 10`,
            [user_id]
        );

        // Update streak: check if user solved previous week's challenge
        const prevWeekResult = await client.query(
            `SELECT c.id FROM challenges c
             JOIN challenge_submissions cs ON cs.challenge_id = c.id
             WHERE cs.user_id = $1 AND cs.is_correct = true
               AND c.week_end = (
                 SELECT week_start - INTERVAL '1 day'
                 FROM challenges WHERE id = $2
               )`,
            [user_id, challenge_id]
        );

        if (prevWeekResult.rows.length > 0) {
            // Continuing streak
            await client.query(
                `UPDATE challenge_leaderboard
                 SET current_streak = current_streak + 1,
                     longest_streak = GREATEST(longest_streak, current_streak + 1)
                 WHERE user_id = $1`,
                [user_id]
            );
        } else {
            // Reset streak to 1
            await client.query(
                `UPDATE challenge_leaderboard
                 SET current_streak = 1,
                     longest_streak = GREATEST(longest_streak, 1)
                 WHERE user_id = $1`,
                [user_id]
            );
        }

        await client.query('COMMIT');
        return true;
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('markSubmissionCorrect error:', err);
        return false;
    } finally {
        client.release();
    }
}

// Helper: mark submission incorrect
async function markSubmissionIncorrect(submissionId, reviewerId) {
    try {
        await pool.query(
            `UPDATE challenge_submissions
             SET is_correct = false, reviewed_by = $1, reviewed_at = NOW()
             WHERE id = $2`,
            [reviewerId, submissionId]
        );
        return true;
    } catch (err) {
        console.error('markSubmissionIncorrect error:', err);
        return false;
    }
}

module.exports = {
    router,
    getCurrentChallengeWidget,
    getChallengeSubmissionsForAdmin,
    markSubmissionCorrect,
    markSubmissionIncorrect,
};
