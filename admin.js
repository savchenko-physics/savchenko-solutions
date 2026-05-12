const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const notifications = require('./notifications');
const { isValidSolutionLang, isValidSolutionProblemName } = require('./utils');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

let hasAdminActionsTableCache = null;
let hasBlockedIpsTableCache = null;

async function hasAdminActionsTable() {
    if (hasAdminActionsTableCache !== null) return hasAdminActionsTableCache;
    try {
        const result = await pool.query(
            `SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'admin_actions'
            ) AS exists`
        );
        hasAdminActionsTableCache = !!result.rows[0]?.exists;
    } catch (_err) {
        hasAdminActionsTableCache = false;
    }
    return hasAdminActionsTableCache;
}

async function hasBlockedIpsTable() {
    if (hasBlockedIpsTableCache !== null) return hasBlockedIpsTableCache;
    try {
        const result = await pool.query(
            `SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'blocked_ips'
            ) AS exists`
        );
        hasBlockedIpsTableCache = !!result.rows[0]?.exists;
    } catch (_err) {
        hasBlockedIpsTableCache = false;
    }
    return hasBlockedIpsTableCache;
}

// Admin middleware — only astrosander can access
function checkAdmin(req, res, next) {
    if (!req.session.userId || req.session.username !== 'astrosander') {
        return res.status(403).render('404', {
            __: req.__,
            pageUrl: req.originalUrl,
            lang: 'en',
        });
    }
    next();
}

router.use(checkAdmin);

// Helper to log admin actions
async function logAdminAction(adminUserId, actionType, targetType, targetId, details) {
    try {
        if (!(await hasAdminActionsTable())) return;
        await pool.query(
            `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, details)
             VALUES ($1, $2, $3, $4, $5)`,
            [adminUserId, actionType, targetType, targetId, details ? JSON.stringify(details) : null]
        );
    } catch (err) {
        console.error('Error logging admin action:', err);
    }
}

// ─── Overview / Dashboard ───────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const canReadActions = await hasAdminActionsTable();
        const [
            usersCount,
            pendingReports,
            flaggedEdits,
            contributionsToday,
            activeUsersWeek,
            recentActions,
            solutionsCount,
        ] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM users'),
            pool.query("SELECT COUNT(*) FROM solution_reports WHERE status = 'pending'"),
            pool.query('SELECT COUNT(*) FROM special_contributions'),
            pool.query("SELECT COUNT(*) FROM contributions WHERE edited_at > CURRENT_DATE"),
            pool.query("SELECT COUNT(DISTINCT user_id) FROM contributions WHERE edited_at > NOW() - INTERVAL '7 days'"),
            canReadActions
                ? pool.query(
                `SELECT a.*, u.username
                 FROM admin_actions a
                 LEFT JOIN users u ON a.admin_user_id = u.id
                 ORDER BY a.created_at DESC LIMIT 20`
            )
                : Promise.resolve({ rows: [] }),
            pool.query("SELECT COUNT(DISTINCT problem_name) FROM contributions"),
        ]);

        res.render('admin/dashboard', {
            __: req.__,
            lang: 'en',
            tab: 'overview',
            stats: {
                totalUsers: parseInt(usersCount.rows[0].count),
                totalSolutions: parseInt(solutionsCount.rows[0].count),
                pendingReports: parseInt(pendingReports.rows[0].count),
                flaggedEdits: parseInt(flaggedEdits.rows[0].count),
                contributionsToday: parseInt(contributionsToday.rows[0].count),
                activeUsersWeek: parseInt(activeUsersWeek.rows[0].count),
            },
            recentActions: recentActions.rows,
        });
    } catch (err) {
        console.error('Admin dashboard error:', err);
        res.status(500).send('Internal server error');
    }
});

// ─── Reports ────────────────────────────────────────────────────────────
router.get('/reports', async (req, res) => {
    try {
        const showAll = req.query.all === '1';
        const whereClause = showAll ? '' : "WHERE sr.status = 'pending'";
        const reports = await pool.query(
            `SELECT sr.*, u.username AS reporter_name
             FROM solution_reports sr
             LEFT JOIN users u ON sr.user_id = u.id
             ${whereClause}
             ORDER BY sr.created_at DESC`
        );
        const pendingCount = await pool.query("SELECT COUNT(*) FROM solution_reports WHERE status = 'pending'");

        res.render('admin/dashboard', {
            __: req.__,
            lang: 'en',
            tab: 'reports',
            reports: reports.rows,
            showAll,
            pendingReportsCount: parseInt(pendingCount.rows[0].count),
        });
    } catch (err) {
        console.error('Admin reports error:', err);
        res.status(500).send('Internal server error');
    }
});

router.post('/reports/:id/resolve', async (req, res) => {
    try {
        // Get the report to find the reporter
        const reportResult = await pool.query(
            'SELECT user_id, problem_name FROM solution_reports WHERE id = $1',
            [req.params.id]
        );

        await pool.query(
            `UPDATE solution_reports SET status = 'resolved', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
            [req.session.userId, req.params.id]
        );
        await logAdminAction(req.session.userId, 'resolve_report', 'solution_report', parseInt(req.params.id), null);

        // Notify the reporter (if they were logged in when reporting)
        if (reportResult.rows.length > 0 && reportResult.rows[0].user_id) {
            const problemName = reportResult.rows[0].problem_name || '';
            try {
                await notifications.createNotification(
                    reportResult.rows[0].user_id,
                    'report_resolved',
                    'Your report has been resolved',
                    problemName ? `Report on problem ${problemName} was reviewed` : 'Your report was reviewed by a moderator',
                    problemName ? `/en/${problemName}` : null,
                    req.session.userId
                );
            } catch (notifErr) { console.error('Notification error (report):', notifErr); }
        }

        res.redirect('/admin/reports');
    } catch (err) {
        console.error('Error resolving report:', err);
        res.status(500).send('Internal server error');
    }
});

router.post('/reports/:id/dismiss', async (req, res) => {
    try {
        await pool.query(
            `UPDATE solution_reports SET status = 'dismissed', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
            [req.session.userId, req.params.id]
        );
        await logAdminAction(req.session.userId, 'dismiss_report', 'solution_report', parseInt(req.params.id), null);
        res.redirect('/admin/reports');
    } catch (err) {
        console.error('Error dismissing report:', err);
        res.status(500).send('Internal server error');
    }
});

// ─── Flagged Edits ──────────────────────────────────────────────────────
router.get('/flagged', async (req, res) => {
    try {
        const flagged = await pool.query(
            `SELECT sc.*, u.username AS editor_name
             FROM special_contributions sc
             LEFT JOIN users u ON sc.user_id = u.id
             ORDER BY sc.edited_at DESC`
        );

        res.render('admin/dashboard', {
            __: req.__,
            lang: 'en',
            tab: 'flagged',
            flagged: flagged.rows,
        });
    } catch (err) {
        console.error('Admin flagged error:', err);
        res.status(500).send('Internal server error');
    }
});

router.get('/flagged/:id/diff', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM special_contributions WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Not found' });
        }
        const entry = result.rows[0];
        res.json({
            oldContent: entry.old_content || '',
            newContent: entry.new_content || '',
            problemName: entry.problem_name,
            language: entry.language,
        });
    } catch (err) {
        console.error('Error fetching diff:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/flagged/:id/approve', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM special_contributions WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).send('Not found');
        }
        const entry = result.rows[0];

        // Validate language and problem name to prevent path traversal
        if (!isValidSolutionLang(entry.language) || !isValidSolutionProblemName(entry.problem_name)) {
            return res.status(400).send('Invalid problem name or language in flagged edit');
        }

        const filePath = path.join(__dirname, 'posts', entry.language, `${entry.problem_name}.md`);
        const resolvedPath = path.resolve(filePath);
        const postsDir = path.resolve(path.join(__dirname, 'posts'));
        if (!resolvedPath.startsWith(postsDir)) {
            return res.status(400).send('Invalid file path');
        }

        // Write the new content to the file
        await fs.promises.writeFile(filePath, entry.new_content, 'utf8');

        // Record in contributions table
        await pool.query(
            `INSERT INTO contributions (user_id, problem_name, language, edited_at, original_content, new_content, ip_address, content_changed)
             VALUES ($1, $2, $3, NOW(), $4, $5, $6, TRUE)`,
            [entry.user_id, entry.problem_name, entry.language, entry.old_content, entry.new_content, entry.ip_address]
        );

        // Delete from special_contributions
        await pool.query('DELETE FROM special_contributions WHERE id = $1', [req.params.id]);

        await logAdminAction(req.session.userId, 'approve_edit', 'special_contribution', parseInt(req.params.id), {
            problem: entry.problem_name,
            language: entry.language,
        });

        res.redirect('/admin/flagged');
    } catch (err) {
        console.error('Error approving flagged edit:', err);
        res.status(500).send('Internal server error');
    }
});

router.post('/flagged/:id/reject', async (req, res) => {
    try {
        const result = await pool.query('SELECT problem_name, language FROM special_contributions WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).send('Flagged edit not found');
        }
        const entry = result.rows[0];

        await pool.query('DELETE FROM special_contributions WHERE id = $1', [req.params.id]);

        await logAdminAction(req.session.userId, 'reject_edit', 'special_contribution', parseInt(req.params.id), {
            problem: entry.problem_name,
            language: entry.language,
        });

        res.redirect('/admin/flagged');
    } catch (err) {
        console.error('Error rejecting flagged edit:', err);
        res.status(500).send('Internal server error');
    }
});

// ─── Users ──────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 50;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const sort = req.query.sort || 'id';
        const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

        const allowedSorts = ['id', 'username', 'full_name', 'email', 'country_location', 'is_verified_user', 'created_at', 'contribution_count'];
        const sortCol = allowedSorts.includes(sort) ? sort : 'id';

        let whereClause = '';
        const params = [];
        if (search) {
            whereClause = 'WHERE u.username ILIKE $1 OR u.email ILIKE $1';
            params.push(`%${search}%`);
        }

        const orderBy = sortCol === 'contribution_count'
            ? `ORDER BY contribution_count ${dir}`
            : `ORDER BY u.${sortCol} ${dir}`;

        const countResult = await pool.query(
            `SELECT COUNT(*) FROM users u ${whereClause}`,
            params
        );
        const totalUsers = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalUsers / limit);

        const usersResult = await pool.query(
            `SELECT u.id, u.username, u.full_name, u.email, u.country_location,
                    u.is_verified_user, u.created_at,
                    COUNT(c.id) AS contribution_count
             FROM users u
             LEFT JOIN contributions c ON c.user_id = u.id
             ${whereClause}
             GROUP BY u.id
             ${orderBy}
             LIMIT ${limit} OFFSET ${offset}`,
            params
        );

        res.render('admin/dashboard', {
            __: req.__,
            lang: 'en',
            tab: 'users',
            users: usersResult.rows,
            page,
            totalPages,
            totalUsers,
            search,
            sort: sortCol,
            dir: dir === 'DESC' ? 'desc' : 'asc',
        });
    } catch (err) {
        console.error('Admin users error:', err);
        res.status(500).send('Internal server error');
    }
});

router.post('/users/:id/verify', async (req, res) => {
    try {
        const result = await pool.query(
            'UPDATE users SET is_verified_user = NOT COALESCE(is_verified_user, FALSE) WHERE id = $1 RETURNING is_verified_user, username',
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).send('User not found');
        }
        await logAdminAction(req.session.userId, 'toggle_verify_user', 'user', parseInt(req.params.id), {
            username: result.rows[0].username,
            verified: result.rows[0].is_verified_user,
        });
        res.redirect(`/admin/users?${new URLSearchParams(req.query).toString()}`);
    } catch (err) {
        console.error('Error toggling user verification:', err);
        res.status(500).send('Internal server error');
    }
});

// ─── IP Blocklist ───────────────────────────────────────────────────────
router.get('/blocked-ips', async (req, res) => {
    try {
        if (!(await hasBlockedIpsTable())) {
            return res.render('admin/dashboard', {
                __: req.__,
                lang: 'en',
                tab: 'blocked-ips',
                blockedIps: [],
            });
        }
        const blocked = await pool.query(
            `SELECT bi.*, u.username AS blocked_by_name
             FROM blocked_ips bi
             LEFT JOIN users u ON bi.blocked_by = u.id
             ORDER BY bi.blocked_at DESC`
        );

        res.render('admin/dashboard', {
            __: req.__,
            lang: 'en',
            tab: 'blocked-ips',
            blockedIps: blocked.rows,
        });
    } catch (err) {
        console.error('Admin blocked IPs error:', err);
        res.status(500).send('Internal server error');
    }
});

router.post('/blocked-ips/add', async (req, res) => {
    try {
        if (!(await hasBlockedIpsTable())) {
            return res.redirect('/admin/blocked-ips');
        }
        const { ip_address, reason } = req.body;
        if (!ip_address || !ip_address.trim()) {
            return res.redirect('/admin/blocked-ips');
        }
        const result = await pool.query(
            'INSERT INTO blocked_ips (ip_address, reason, blocked_by) VALUES ($1, $2, $3) ON CONFLICT (ip_address) DO NOTHING RETURNING id',
            [ip_address.trim(), reason || null, req.session.userId]
        );
        if (result.rows.length > 0) {
            await logAdminAction(req.session.userId, 'block_ip', 'blocked_ip', result.rows[0].id, { ip: ip_address.trim(), reason });
        }
        res.redirect('/admin/blocked-ips');
    } catch (err) {
        console.error('Error blocking IP:', err);
        res.status(500).send('Internal server error');
    }
});

router.post('/blocked-ips/:id/remove', async (req, res) => {
    try {
        if (!(await hasBlockedIpsTable())) {
            return res.redirect('/admin/blocked-ips');
        }
        const result = await pool.query('DELETE FROM blocked_ips WHERE id = $1 RETURNING ip_address', [req.params.id]);
        if (result.rows.length > 0) {
            await logAdminAction(req.session.userId, 'unblock_ip', 'blocked_ip', parseInt(req.params.id), { ip: result.rows[0].ip_address });
        }
        res.redirect('/admin/blocked-ips');
    } catch (err) {
        console.error('Error removing blocked IP:', err);
        res.status(500).send('Internal server error');
    }
});

// ─── Platform Stats (JSON API for Chart.js) ─────────────────────────────
router.get('/stats', async (req, res) => {
    try {
        res.render('admin/dashboard', {
            __: req.__,
            lang: 'en',
            tab: 'stats',
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).send('Internal server error');
    }
});

router.get('/stats/data', async (req, res) => {
    try {
        const [
            dailyContributions,
            weeklyRegistrations,
            dailyPageViews,
            topProblems,
            langDistribution,
            topIps,
        ] = await Promise.all([
            // Daily contributions last 30 days
            pool.query(
                `SELECT DATE(edited_at) AS day, COUNT(*) AS count
                 FROM contributions
                 WHERE edited_at > NOW() - INTERVAL '30 days'
                 GROUP BY DATE(edited_at)
                 ORDER BY day`
            ),
            // Weekly registrations last 3 months
            pool.query(
                `SELECT DATE_TRUNC('week', created_at) AS week, COUNT(*) AS count
                 FROM users
                 WHERE created_at > NOW() - INTERVAL '3 months'
                 GROUP BY DATE_TRUNC('week', created_at)
                 ORDER BY week`
            ),
            // Daily page views last 30 days
            pool.query(
                `SELECT DATE(date) AS day, COALESCE(SUM(views), 0)::bigint AS count
                 FROM page_views
                 WHERE date > NOW() - INTERVAL '30 days'
                 GROUP BY DATE(date)
                 ORDER BY day`
            ),
            // Top 10 most viewed problems
            pool.query(
                `SELECT problem_name, COALESCE(SUM(views), 0)::bigint AS views
                 FROM page_views
                 GROUP BY problem_name
                 ORDER BY views DESC
                 LIMIT 10`
            ),
            // Language distribution
            pool.query(
                `SELECT language, COUNT(*) AS count
                 FROM contributions
                 WHERE language IN ('en', 'ru')
                 GROUP BY language`
            ),
            // Top 10 IPs by edit count
            pool.query(
                `SELECT ip_address, COUNT(*) AS edit_count
                 FROM contributions
                 WHERE ip_address IS NOT NULL
                 GROUP BY ip_address
                 ORDER BY edit_count DESC
                 LIMIT 10`
            ),
        ]);

        res.json({
            dailyContributions: dailyContributions.rows,
            weeklyRegistrations: weeklyRegistrations.rows,
            dailyPageViews: dailyPageViews.rows,
            topProblems: topProblems.rows,
            langDistribution: langDistribution.rows,
            topIps: topIps.rows,
        });
    } catch (err) {
        console.error('Stats data error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Challenges Management ──────────────────────────────────────────────
let hasChallengesTableCache = null;
async function hasChallengesTableAdmin() {
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

router.get('/challenges', async (req, res) => {
    try {
        let challengesList = [];
        if (await hasChallengesTableAdmin()) {
            const result = await pool.query(
                `SELECT c.*,
                        (SELECT COUNT(*) FROM challenge_submissions cs WHERE cs.challenge_id = c.id) AS submission_count
                 FROM challenges c
                 ORDER BY c.week_start DESC`
            );
            challengesList = result.rows;
        }
        res.render('admin/dashboard', {
            __: req.__, lang: 'en', tab: 'challenges',
            challengesList,
        });
    } catch (err) {
        console.error('Admin challenges error:', err);
        res.status(500).send('Internal server error');
    }
});

router.get('/challenges/:id', async (req, res) => {
    try {
        let challengesList = [];
        let reviewChallenge = null;
        let challengeSubmissions = [];

        if (await hasChallengesTableAdmin()) {
            const listResult = await pool.query(
                `SELECT c.*,
                        (SELECT COUNT(*) FROM challenge_submissions cs WHERE cs.challenge_id = c.id) AS submission_count
                 FROM challenges c
                 ORDER BY c.week_start DESC`
            );
            challengesList = listResult.rows;

            const chalResult = await pool.query('SELECT * FROM challenges WHERE id = $1', [req.params.id]);
            if (chalResult.rows.length === 0) {
                return res.status(404).send('Challenge not found');
            }
            reviewChallenge = chalResult.rows[0];

            if (reviewChallenge) {
                const subResult = await pool.query(
                    `SELECT cs.*, u.username, u.profile_picture
                     FROM challenge_submissions cs
                     JOIN users u ON cs.user_id = u.id
                     WHERE cs.challenge_id = $1
                     ORDER BY cs.submitted_at ASC`,
                    [req.params.id]
                );
                challengeSubmissions = subResult.rows;
            }
        }

        res.render('admin/dashboard', {
            __: req.__, lang: 'en', tab: 'challenges',
            challengesList, reviewChallenge, challengeSubmissions,
        });
    } catch (err) {
        console.error('Admin challenge review error:', err);
        res.status(500).send('Internal server error');
    }
});

router.post('/challenges/:challengeId/review/:submissionId', async (req, res) => {
    try {
        if (!(await hasChallengesTableAdmin())) {
            return res.redirect('/admin/challenges');
        }

        const { verdict } = req.body;
        const submissionId = parseInt(req.params.submissionId);
        const challengeId = parseInt(req.params.challengeId);

        if (verdict === 'correct') {
            // Mark correct + update leaderboard
            const subResult = await pool.query(
                `UPDATE challenge_submissions
                 SET is_correct = true, reviewed_by = $1, reviewed_at = NOW()
                 WHERE id = $2
                 RETURNING user_id`,
                [req.session.userId, submissionId]
            );
            if (subResult.rows.length > 0) {
                const userId = subResult.rows[0].user_id;
                await pool.query(
                    `INSERT INTO challenge_leaderboard (user_id, total_solved, current_streak, longest_streak, total_score)
                     VALUES ($1, 1, 1, 1, 10)
                     ON CONFLICT (user_id)
                     DO UPDATE SET
                        total_solved = challenge_leaderboard.total_solved + 1,
                        total_score = challenge_leaderboard.total_score + 10`,
                    [userId]
                );
            }
            await logAdminAction(req.session.userId, 'challenge_review', 'challenge_submission', submissionId, { verdict: 'correct' });
        } else {
            await pool.query(
                `UPDATE challenge_submissions
                 SET is_correct = false, reviewed_by = $1, reviewed_at = NOW()
                 WHERE id = $2`,
                [req.session.userId, submissionId]
            );
            await logAdminAction(req.session.userId, 'challenge_review', 'challenge_submission', submissionId, { verdict: 'incorrect' });
        }

        res.redirect('/admin/challenges/' + challengeId);
    } catch (err) {
        console.error('Admin challenge review POST error:', err);
        res.status(500).send('Internal server error');
    }
});

// Export the router and the IP-check helper
async function isIpBlocked(ip) {
    try {
        if (!(await hasBlockedIpsTable())) return false;
        const result = await pool.query('SELECT 1 FROM blocked_ips WHERE ip_address = $1', [ip]);
        return result.rows.length > 0;
    } catch (err) {
        console.error('Error checking blocked IP:', err);
        return false;
    }
}

module.exports = { router, isIpBlocked };
