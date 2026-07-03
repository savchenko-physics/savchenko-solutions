const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const i18n = require('i18n');
const sanitizeHtml = require('sanitize-html');
const { getOnlineUsernames } = require('./lib/presence');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

// ─── Auth middleware ──────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.session.userId) return next();
    res.redirect('/en/login?error=Please+log+in+to+access+this+page');
}

// ─── Sanitize plain text ──────────────────────────────────────
function sanitizeText(str) {
    if (!str) return '';
    return sanitizeHtml(str, { allowedTags: [], allowedAttributes: {} }).trim();
}

// ─── All known topics (canonical list) ───────────────────────
const KNOWN_TOPICS = [
    'mechanics', 'thermodynamics', 'electrostatics', 'electrodynamics',
    'optics', 'relativity', 'quantum', 'waves', 'oscillations',
    'fluid-mechanics', 'rotational-dynamics', 'gravitation',
    'magnetism', 'nuclear', 'statistical-physics', 'astrophysics',
];

// ─── Problem of the Day cache ────────────────────────────────
let potdCache = { problem: null, date: null };

async function getProblemOfTheDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (potdCache.date === today && potdCache.problem) return potdCache.problem;

    try {
        // Deterministic daily pick: use date as seed via modulo
        const { rows: countRows } = await pool.query(
            'SELECT COUNT(*) FROM bank_problems WHERE reviewed = true'
        );
        const total = parseInt(countRows[0].count, 10);
        if (total === 0) return null;

        // Simple hash of date string to get a stable daily index
        const dateHash = today.split('').reduce((acc, c) => acc * 31 + c.charCodeAt(0), 0);
        const idx = Math.abs(dateHash) % total;

        const { rows } = await pool.query(
            `SELECT bp.*, bs.name AS source_name, bs.slug AS source_slug
             FROM bank_problems bp
             JOIN bank_sources bs ON bs.id = bp.source_id
             WHERE bp.reviewed = true
             ORDER BY bp.id
             LIMIT 1 OFFSET $1`,
            [idx]
        );
        potdCache = { problem: rows[0] || null, date: today };
        return potdCache.problem;
    } catch (err) {
        console.error('Problem of the Day error:', err);
        return null;
    }
}

// ─── GET /bank — Landing page ────────────────────────────────
router.get('/', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        const [sourcesResult, statsResult, recentResult, topicsResult] = await Promise.all([
            pool.query(
                `SELECT bs.*, COUNT(bp.id) AS problem_count
                 FROM bank_sources bs
                 LEFT JOIN bank_problems bp ON bp.source_id = bs.id AND bp.reviewed = true
                 GROUP BY bs.id
                 ORDER BY bs.sort_order`
            ),
            pool.query(
                'SELECT COUNT(*) AS total FROM bank_problems WHERE reviewed = true'
            ),
            pool.query(
                `SELECT bp.id, bp.title, bp.difficulty, bp.topics, bs.name AS source_name, bs.slug AS source_slug
                 FROM bank_problems bp
                 JOIN bank_sources bs ON bs.id = bp.source_id
                 WHERE bp.reviewed = true
                 ORDER BY bp.created_at DESC
                 LIMIT 6`
            ),
            pool.query(
                `SELECT DISTINCT unnest(topics) AS topic
                 FROM bank_problems
                 WHERE reviewed = true
                 ORDER BY topic`
            ),
        ]);

        const potd = await getProblemOfTheDay();

        res.render('bank/index', {
            __: i18n.__,
            lang,
            sources: sourcesResult.rows,
            totalProblems: parseInt(statsResult.rows[0].total, 10),
            recentProblems: recentResult.rows,
            allTopics: topicsResult.rows.map(r => r.topic),
            potd,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (err) {
        console.error('Bank index error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── GET /bank/source/:slug — problems by source ────────────
router.get('/source/:slug', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);
    const { slug } = req.params;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = 20;
    const offset = (page - 1) * perPage;

    try {
        const sourceResult = await pool.query('SELECT * FROM bank_sources WHERE slug = $1', [slug]);
        if (sourceResult.rows.length === 0) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }
        const source = sourceResult.rows[0];

        const [problemsResult, countResult] = await Promise.all([
            pool.query(
                `SELECT bp.*, bs.name AS source_name, bs.slug AS source_slug
                 FROM bank_problems bp
                 JOIN bank_sources bs ON bs.id = bp.source_id
                 WHERE bp.source_id = $1 AND bp.reviewed = true
                 ORDER BY bp.year DESC NULLS LAST, bp.problem_number
                 LIMIT $2 OFFSET $3`,
                [source.id, perPage, offset]
            ),
            pool.query(
                'SELECT COUNT(*) FROM bank_problems WHERE source_id = $1 AND reviewed = true',
                [source.id]
            ),
        ]);

        const total = parseInt(countResult.rows[0].count, 10);

        res.render('bank/source', {
            __: i18n.__,
            lang,
            source,
            problems: problemsResult.rows,
            page,
            totalPages: Math.ceil(total / perPage),
            totalProblems: total,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (err) {
        console.error('Bank source error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── GET /bank/topic/:topic — problems by topic ─────────────
router.get('/topic/:topic', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);
    const topic = req.params.topic.toLowerCase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = 20;
    const offset = (page - 1) * perPage;

    try {
        const [problemsResult, countResult] = await Promise.all([
            pool.query(
                `SELECT bp.*, bs.name AS source_name, bs.slug AS source_slug
                 FROM bank_problems bp
                 JOIN bank_sources bs ON bs.id = bp.source_id
                 WHERE $1 = ANY(bp.topics) AND bp.reviewed = true
                 ORDER BY bp.difficulty DESC NULLS LAST, bp.year DESC NULLS LAST
                 LIMIT $2 OFFSET $3`,
                [topic, perPage, offset]
            ),
            pool.query(
                'SELECT COUNT(*) FROM bank_problems WHERE $1 = ANY(topics) AND reviewed = true',
                [topic]
            ),
        ]);

        const total = parseInt(countResult.rows[0].count, 10);

        res.render('bank/topic', {
            __: i18n.__,
            lang,
            topic,
            problems: problemsResult.rows,
            page,
            totalPages: Math.ceil(total / perPage),
            totalProblems: total,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (err) {
        console.error('Bank topic error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── GET /bank/random — redirect to random problem ──────────
router.get('/random', async (req, res) => {
    try {
        const conditions = ['bp.reviewed = true'];
        const params = [];
        let paramIdx = 1;

        if (req.query.difficulty) {
            const diff = parseInt(req.query.difficulty, 10);
            if (diff >= 1 && diff <= 10) {
                conditions.push(`bp.difficulty = $${paramIdx++}`);
                params.push(diff);
            }
        }
        if (req.query.topic) {
            conditions.push(`$${paramIdx++} = ANY(bp.topics)`);
            params.push(req.query.topic.toLowerCase());
        }

        const { rows } = await pool.query(
            `SELECT bp.id FROM bank_problems bp
             WHERE ${conditions.join(' AND ')}
             ORDER BY RANDOM()
             LIMIT 1`,
            params
        );

        if (rows.length === 0) return res.redirect('/bank');
        res.redirect(`/bank/problem/${rows[0].id}`);
    } catch (err) {
        console.error('Bank random error:', err);
        res.redirect('/bank');
    }
});

// ─── GET /bank/problem/:id — single problem page ────────────
router.get('/problem/:id', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);
    const problemId = parseInt(req.params.id, 10);
    if (isNaN(problemId)) {
        return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }

    try {
        const { rows } = await pool.query(
            `SELECT bp.*, bs.name AS source_name, bs.slug AS source_slug, bs.country AS source_country,
                    u.username AS submitter_username
             FROM bank_problems bp
             JOIN bank_sources bs ON bs.id = bp.source_id
             LEFT JOIN users u ON u.id = bp.submitted_by
             WHERE bp.id = $1`,
            [problemId]
        );

        if (rows.length === 0) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }
        const problem = rows[0];

        // Increment view count
        pool.query('UPDATE bank_problems SET view_count = view_count + 1 WHERE id = $1', [problemId]);

        // Load comments, user attempt, difficulty vote, and related problems in parallel
        const [commentsResult, attemptResult, voteResult, avgDiffResult, relatedResult] = await Promise.all([
            pool.query(
                `SELECT bc.*, u.username, u.profile_picture
                 FROM bank_comments bc
                 LEFT JOIN users u ON u.id = bc.user_id
                 WHERE bc.problem_id = $1
                 ORDER BY bc.created_at`,
                [problemId]
            ),
            req.session.userId
                ? pool.query('SELECT status FROM bank_attempts WHERE user_id = $1 AND problem_id = $2', [req.session.userId, problemId])
                : { rows: [] },
            req.session.userId
                ? pool.query('SELECT difficulty FROM bank_difficulty_votes WHERE user_id = $1 AND problem_id = $2', [req.session.userId, problemId])
                : { rows: [] },
            pool.query('SELECT AVG(difficulty)::numeric(3,1) AS avg_diff, COUNT(*) AS vote_count FROM bank_difficulty_votes WHERE problem_id = $1', [problemId]),
            pool.query(
                `SELECT bp.id, bp.title, bp.difficulty, bs.name AS source_name, bs.slug AS source_slug
                 FROM bank_problems bp
                 JOIN bank_sources bs ON bs.id = bp.source_id
                 WHERE bp.id != $1 AND bp.reviewed = true AND bp.topics && $2
                 ORDER BY RANDOM()
                 LIMIT 3`,
                [problemId, problem.topics || []]
            ),
        ]);

        // Online-presence dots for other users' commenter avatars (fresh,
        // privacy-respecting). Skip the current logged-in user's own avatar.
        const currentUsername = req.session.username || null;
        const commentUsernames = commentsResult.rows.map(c => c.username).filter(Boolean);
        const onlineUsers = await getOnlineUsernames(pool, commentUsernames);
        for (const c of commentsResult.rows) {
            c.is_online = onlineUsers.has(c.username) && c.username !== currentUsername;
        }

        // Map bank topics to Savchenko chapter ranges for cross-linking
        const topicToChapters = {
            mechanics: [1, 2, 4],
            kinematics: [1],
            dynamics: [2],
            oscillations: [3],
            waves: [3],
            thermodynamics: [5],
            electrostatics: [6],
            electromagnetism: [9, 10, 11],
            optics: [13],
            relativity: [14],
        };
        let relatedSavchenko = [];
        const topics = problem.topics || [];
        const chapters = [...new Set(topics.flatMap(t => topicToChapters[t] || []))];
        if (chapters.length > 0) {
            try {
                const fs = require('fs');
                const postsDir = require('path').join(__dirname, 'posts', lang);
                if (fs.existsSync(postsDir)) {
                    const files = fs.readdirSync(postsDir).filter(f => f.endsWith('.md'));
                    const matching = files
                        .map(f => f.replace('.md', ''))
                        .filter(name => {
                            const ch = parseInt(name.split('.')[0], 10);
                            return chapters.includes(ch);
                        });
                    // Pick up to 5 random matches
                    const shuffled = matching.sort(() => Math.random() - 0.5);
                    relatedSavchenko = shuffled.slice(0, 5).map(name => ({
                        name,
                        url: `/${lang}/${name}`,
                    }));
                }
            } catch { /* skip if filesystem read fails */ }
        }

        res.render('bank/problem', {
            __: i18n.__,
            lang,
            problem,
            comments: commentsResult.rows,
            userAttempt: attemptResult.rows[0]?.status || null,
            userVote: voteResult.rows[0]?.difficulty || null,
            avgDifficulty: avgDiffResult.rows[0]?.avg_diff || problem.difficulty,
            voteCount: parseInt(avgDiffResult.rows[0]?.vote_count, 10) || 0,
            relatedProblems: relatedResult.rows,
            relatedSavchenko,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (err) {
        console.error('Bank problem error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── GET /bank/submit — submission form ──────────────────────
router.get('/submit', requireAuth, (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);
    res.render('bank/submit', {
        __: i18n.__,
        lang,
        knownTopics: KNOWN_TOPICS,
        username: req.session.username || null,
        userId: req.session.userId || null,
    });
});

// ─── POST /bank/submit — create problem ─────────────────────
router.post('/submit', requireAuth, async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        const {
            source_id, year, problem_number, title,
            statement_en, statement_ru, solution_en, solution_ru,
            difficulty, topics,
        } = req.body;

        const sourceId = parseInt(source_id, 10);
        const diff = parseInt(difficulty, 10);
        const yr = year ? parseInt(year, 10) : null;

        if (!sourceId || !title || (!statement_en && !statement_ru)) {
            return res.status(400).render('bank/submit', {
                __: i18n.__,
                lang,
                knownTopics: KNOWN_TOPICS,
                username: req.session.username || null,
                userId: req.session.userId || null,
                error: lang === 'ru' ? 'Заполните обязательные поля (источник, название, условие).' : 'Please fill in required fields (source, title, statement).',
            });
        }

        // Parse topics: comma-separated string or array
        let parsedTopics = [];
        if (typeof topics === 'string') {
            parsedTopics = topics.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        } else if (Array.isArray(topics)) {
            parsedTopics = topics.map(t => String(t).trim().toLowerCase()).filter(Boolean);
        }

        const { rows } = await pool.query(
            `INSERT INTO bank_problems
                (source_id, year, problem_number, title,
                 statement_en, statement_ru, solution_en, solution_ru,
                 difficulty, topics, submitted_by, reviewed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)
             RETURNING id`,
            [
                sourceId, yr, sanitizeText(problem_number), sanitizeText(title),
                statement_en || null, statement_ru || null,
                solution_en || null, solution_ru || null,
                (diff >= 1 && diff <= 10) ? diff : null,
                parsedTopics,
                req.session.userId,
            ]
        );

        res.redirect(`/bank/problem/${rows[0].id}`);
    } catch (err) {
        console.error('Bank submit error:', err);
        res.status(500).render('bank/submit', {
            __: i18n.__,
            lang,
            knownTopics: KNOWN_TOPICS,
            username: req.session.username || null,
            userId: req.session.userId || null,
            error: lang === 'ru' ? 'Произошла ошибка. Попробуйте снова.' : 'An error occurred. Please try again.',
        });
    }
});

// ─── POST /bank/problem/:id/attempt — mark attempt status ───
router.post('/problem/:id/attempt', requireAuth, async (req, res) => {
    const problemId = parseInt(req.params.id, 10);
    const { status } = req.body;

    if (!['attempted', 'solved', 'gave_up'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        await pool.query(
            `INSERT INTO bank_attempts (user_id, problem_id, status)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, problem_id) DO UPDATE SET status = $3, created_at = NOW()`,
            [req.session.userId, problemId, status]
        );
        res.json({ ok: true, status });
    } catch (err) {
        console.error('Bank attempt error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── POST /bank/problem/:id/difficulty — vote on difficulty ──
router.post('/problem/:id/difficulty', requireAuth, async (req, res) => {
    const problemId = parseInt(req.params.id, 10);
    const diff = parseInt(req.body.difficulty, 10);

    if (isNaN(diff) || diff < 1 || diff > 10) {
        return res.status(400).json({ error: 'Difficulty must be 1-10' });
    }

    try {
        await pool.query(
            `INSERT INTO bank_difficulty_votes (user_id, problem_id, difficulty)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, problem_id) DO UPDATE SET difficulty = $3`,
            [req.session.userId, problemId, diff]
        );

        const { rows } = await pool.query(
            'SELECT AVG(difficulty)::numeric(3,1) AS avg_diff, COUNT(*) AS vote_count FROM bank_difficulty_votes WHERE problem_id = $1',
            [problemId]
        );

        res.json({ ok: true, avgDifficulty: rows[0].avg_diff, voteCount: parseInt(rows[0].vote_count, 10) });
    } catch (err) {
        console.error('Bank difficulty vote error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── POST /bank/problem/:id/comments — add comment ──────────
router.post('/problem/:id/comments', requireAuth, async (req, res) => {
    const problemId = parseInt(req.params.id, 10);
    const content = sanitizeText(req.body.content);
    const parentId = req.body.parent_id ? parseInt(req.body.parent_id, 10) : null;

    if (!content) {
        return res.status(400).json({ error: 'Comment cannot be empty' });
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO bank_comments (problem_id, user_id, content, parent_id)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [problemId, req.session.userId, content, parentId]
        );

        const comment = rows[0];

        // Fetch user info for the response
        const userResult = await pool.query(
            'SELECT username, profile_picture FROM users WHERE id = $1',
            [req.session.userId]
        );
        comment.username = userResult.rows[0]?.username;
        comment.profile_picture = userResult.rows[0]?.profile_picture;

        res.json({ ok: true, comment });
    } catch (err) {
        console.error('Bank comment error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── GET /bank/api/search — JSON search ─────────────────────
router.get('/api/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    const difficulty = req.query.difficulty ? parseInt(req.query.difficulty, 10) : null;
    const source = req.query.source || null;
    const topic = req.query.topic || null;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = 20;
    const offset = (page - 1) * perPage;

    const conditions = ['bp.reviewed = true'];
    const params = [];
    let idx = 1;

    if (q) {
        conditions.push(`(bp.title ILIKE $${idx} OR bp.statement_en ILIKE $${idx} OR bp.statement_ru ILIKE $${idx} OR bp.problem_number ILIKE $${idx})`);
        params.push(`%${q}%`);
        idx++;
    }
    if (difficulty && difficulty >= 1 && difficulty <= 10) {
        conditions.push(`bp.difficulty = $${idx++}`);
        params.push(difficulty);
    }
    if (source) {
        conditions.push(`bs.slug = $${idx++}`);
        params.push(source);
    }
    if (topic) {
        conditions.push(`$${idx++} = ANY(bp.topics)`);
        params.push(topic.toLowerCase());
    }

    try {
        const [problemsResult, countResult] = await Promise.all([
            pool.query(
                `SELECT bp.id, bp.title, bp.difficulty, bp.year, bp.problem_number, bp.topics,
                        bs.name AS source_name, bs.slug AS source_slug
                 FROM bank_problems bp
                 JOIN bank_sources bs ON bs.id = bp.source_id
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY bp.created_at DESC
                 LIMIT $${idx++} OFFSET $${idx++}`,
                [...params, perPage, offset]
            ),
            pool.query(
                `SELECT COUNT(*)
                 FROM bank_problems bp
                 JOIN bank_sources bs ON bs.id = bp.source_id
                 WHERE ${conditions.join(' AND ')}`,
                params
            ),
        ]);

        const total = parseInt(countResult.rows[0].count, 10);

        res.json({
            problems: problemsResult.rows,
            total,
            page,
            totalPages: Math.ceil(total / perPage),
        });
    } catch (err) {
        console.error('Bank search error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
