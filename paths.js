const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const i18n = require('i18n');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

let hasPathsTableCache = null;

async function hasPathsTable() {
    if (hasPathsTableCache !== null) return hasPathsTableCache;
    try {
        const result = await pool.query(
            `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'study_paths'
            ) AS exists`
        );
        hasPathsTableCache = !!result.rows[0]?.exists;
    } catch (_err) {
        hasPathsTableCache = false;
    }
    return hasPathsTableCache;
}

function generateSlug(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100);
}

function getLang(req) {
    return req.session.lang || 'en';
}

function requireAuth(req, res, next) {
    const lang = getLang(req);
    if (!req.session.userId) {
        return res.redirect(`/${lang}/login?error=Please log in to access this page`);
    }
    next();
}

function canCreatePath(req) {
    if (!req.session.userId) return false;
    if (req.session.username === 'astrosander') return true;
    return req.session.isVerifiedUser === true;
}

// GET /paths — list all published paths
router.get('/', async (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    try {
        if (!(await hasPathsTable())) {
            return res.render('paths/index', {
                __: i18n.__, lang, paths: [], userProgress: {},
            });
        }

        const pathsResult = await pool.query(
            `SELECT sp.*, u.username AS author_name
             FROM study_paths sp
             LEFT JOIN users u ON sp.author_id = u.id
             WHERE sp.is_published = true
             ORDER BY sp.created_at ASC`
        );

        // If logged in, get progress per path
        let userProgress = {};
        if (req.session.userId) {
            const progressResult = await pool.query(
                `SELECT path_id,
                        COUNT(*) FILTER (WHERE status = 'solved') AS solved,
                        COUNT(*) FILTER (WHERE status = 'attempted') AS attempted,
                        COUNT(*) AS total
                 FROM user_path_progress
                 WHERE user_id = $1
                 GROUP BY path_id`,
                [req.session.userId]
            );
            for (const row of progressResult.rows) {
                userProgress[row.path_id] = row;
            }
        }

        res.render('paths/index', {
            __: i18n.__, lang,
            paths: pathsResult.rows,
            userProgress,
        });
    } catch (err) {
        console.error('Paths index error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// GET /paths/new — create new path form
router.get('/new', requireAuth, (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    if (!canCreatePath(req)) {
        return res.status(403).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
    res.render('paths/new', { __: i18n.__, lang });
});

// POST /paths — create path
router.post('/', requireAuth, async (req, res) => {
    try {
        if (!canCreatePath(req)) {
            return res.status(403).json({ error: 'Not authorized to create paths' });
        }
        if (!(await hasPathsTable())) {
            return res.status(400).json({ error: 'Paths not available' });
        }

        const { title, description, difficulty_start, difficulty_end, estimated_hours, problems } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Title is required' });
        }

        const slug = generateSlug(title.trim());
        // Check slug uniqueness
        const existing = await pool.query('SELECT id FROM study_paths WHERE slug = $1', [slug]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'A path with a similar title already exists' });
        }

        let parsedProblems = [];
        if (problems) {
            try {
                parsedProblems = typeof problems === 'string' ? JSON.parse(problems) : problems;
            } catch (e) {
                return res.status(400).json({ error: 'Invalid problems JSON' });
            }
            if (!Array.isArray(parsedProblems) || !parsedProblems.every(p => p && typeof p.ref === 'string')) {
                return res.status(400).json({ error: 'Problems must be an array of objects with a ref field' });
            }
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const pathResult = await client.query(
                `INSERT INTO study_paths (title, slug, description, author_id, difficulty_start, difficulty_end, estimated_hours, problem_count, is_published)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
                 RETURNING *`,
                [title.trim(), slug, description || null,
                 req.session.userId,
                 parseInt(difficulty_start) || null,
                 parseInt(difficulty_end) || null,
                 parseInt(estimated_hours) || null,
                 parsedProblems.length]
            );

            const pathId = pathResult.rows[0].id;

            for (let i = 0; i < parsedProblems.length; i++) {
                const p = parsedProblems[i];
                await client.query(
                    `INSERT INTO path_problems (path_id, problem_type, problem_ref, sort_order, notes)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [pathId, p.type || 'savchenko', p.ref, i + 1, p.notes || null]
                );
            }

            await client.query('COMMIT');
            res.json({ success: true, slug });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Create path error:', err);
        res.status(500).json({ error: 'Failed to create path' });
    }
});

// GET /paths/:slug — single path with progress
router.get('/:slug', async (req, res) => {
    const lang = getLang(req);
    i18n.setLocale(res, lang);
    try {
        if (!(await hasPathsTable())) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }

        const pathResult = await pool.query(
            `SELECT sp.*, u.username AS author_name
             FROM study_paths sp
             LEFT JOIN users u ON sp.author_id = u.id
             WHERE sp.slug = $1`,
            [req.params.slug]
        );
        if (pathResult.rows.length === 0) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }

        const studyPath = pathResult.rows[0];

        // Get problems in order
        const problemsResult = await pool.query(
            `SELECT * FROM path_problems WHERE path_id = $1 ORDER BY sort_order ASC`,
            [studyPath.id]
        );

        // Get user progress if logged in
        let progressMap = {};
        if (req.session.userId) {
            const progressResult = await pool.query(
                `SELECT problem_ref, status, completed_at
                 FROM user_path_progress
                 WHERE user_id = $1 AND path_id = $2`,
                [req.session.userId, studyPath.id]
            );
            for (const row of progressResult.rows) {
                progressMap[row.problem_ref] = row;
            }
        }

        res.render('paths/show', {
            __: i18n.__, lang,
            studyPath,
            problems: problemsResult.rows,
            progressMap,
        });
    } catch (err) {
        console.error('Path detail error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// POST /paths/:slug/progress — update progress on a problem
router.post('/:slug/progress', requireAuth, async (req, res) => {
    try {
        if (!(await hasPathsTable())) {
            return res.status(400).json({ error: 'Paths not available' });
        }

        const { problem_ref, status } = req.body;
        const validStatuses = ['not_started', 'attempted', 'solved'];
        if (!problem_ref || !validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid problem_ref or status' });
        }

        // Get path id from slug
        const pathResult = await pool.query(
            'SELECT id FROM study_paths WHERE slug = $1',
            [req.params.slug]
        );
        if (pathResult.rows.length === 0) {
            return res.status(404).json({ error: 'Path not found' });
        }

        const pathId = pathResult.rows[0].id;
        const completedAt = status === 'solved' ? new Date() : null;

        await pool.query(
            `INSERT INTO user_path_progress (user_id, path_id, problem_ref, status, completed_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, path_id, problem_ref)
             DO UPDATE SET status = $4, completed_at = $5`,
            [req.session.userId, pathId, problem_ref, status, completedAt]
        );

        res.json({ success: true, status });
    } catch (err) {
        console.error('Update progress error:', err);
        res.status(500).json({ error: 'Failed to update progress' });
    }
});

// Helper: get paths containing a specific problem (for solution page sidebar)
async function getPathsForProblem(problemRef) {
    try {
        if (!(await hasPathsTable())) return [];
        const result = await pool.query(
            `SELECT sp.title, sp.slug
             FROM path_problems pp
             JOIN study_paths sp ON pp.path_id = sp.id
             WHERE pp.problem_ref = $1 AND sp.is_published = true
             ORDER BY sp.title ASC`,
            [problemRef]
        );
        return result.rows;
    } catch (_err) {
        return [];
    }
}

module.exports = { router, getPathsForProblem };
