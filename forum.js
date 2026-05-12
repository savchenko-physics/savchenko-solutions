const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const i18n = require('i18n');
const notifications = require('./notifications');
const { marked, Marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

// Helper: generate slug from title
function generateSlug(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 200);
}

// Helper: ensure unique topic slug within a category
async function uniqueTopicSlug(baseSlug, categoryId) {
    let slug = baseSlug;
    let suffix = 2;
    while (true) {
        const { rows } = await pool.query(
            'SELECT id FROM forum_topics WHERE slug = $1 AND category_id = $2',
            [slug, categoryId]
        );
        if (rows.length === 0) return slug;
        slug = `${baseSlug.slice(0, 196)}-${suffix}`;
        suffix++;
    }
}

// Helper: compute contribution score (same formula as homepage & contributors page)
async function getUserReputation(userId) {
    const { rows } = await pool.query(`
        WITH all_contributions AS (
            SELECT user_id, problem_name FROM contributions
            WHERE user_id = $1 AND content_changed = true AND invisible = false
            UNION ALL
            SELECT user_id, problem_name FROM github_contributions
            WHERE user_id = $1
        )
        SELECT CASE
            WHEN COUNT(*) = 0 OR COUNT(DISTINCT problem_name) = 0 THEN 0
            ELSE ROUND((19 * LN(COUNT(DISTINCT problem_name) * SQRT(COUNT(*))))::numeric, 0)::int
        END AS score
        FROM all_contributions
    `, [userId]);
    return parseInt(rows[0].score, 10) || 0;
}

// Codeforces-style rating tiers adapted to contribution scores
function getReputationBadge(score) {
    if (score >= 200) return { label: 'Legendary Grandmaster', color: '#FF0000' };
    if (score >= 160) return { label: 'International Grandmaster', color: '#FF0000' };
    if (score >= 130) return { label: 'Grandmaster', color: '#CC0000' };
    if (score >= 110) return { label: 'International Master', color: '#FF8C00' };
    if (score >= 90)  return { label: 'Master', color: '#FF8C00' };
    if (score >= 70)  return { label: 'Candidate Master', color: '#AA00AA' };
    if (score >= 50)  return { label: 'Expert', color: '#0000FF' };
    if (score >= 30)  return { label: 'Specialist', color: '#03A89E' };
    if (score >= 10)  return { label: 'Pupil', color: '#008000' };
    return { label: 'Newbie', color: '#808080' };
}

// Helper: relative time string
function timeAgo(date) {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
}

// Helper: render forum post content as markdown with auto-linked references
const forumMarked = new Marked({
    breaks: true,
    gfm: true,
    headerIds: false,
});

const FORUM_SANITIZE_OPTIONS = {
    allowedTags: [
        ...sanitizeHtml.defaults.allowedTags,
        'img', 'del', 'sup', 'sub', 'hr',
    ],
    allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        a: ['href', 'title', 'target', 'rel', 'class', 'style'],
        img: ['src', 'alt', 'width', 'height'],
        code: ['class'],
        pre: ['class'],
        span: ['class', 'style'],
    },
};

function autoLinkContent(text, lang = 'en') {
    let html = forumMarked.parse(text);
    html = sanitizeHtml(html, FORUM_SANITIZE_OPTIONS);
    html = html.replace(/#(\d{1,2}\.\d{1,2}\.\d{1,3})/g,
        `<a href="/${lang}/$1" class="problem-ref" style="color:#1a5276;font-weight:500;">#$1</a>`);
    html = html.replace(/@([a-zA-Z0-9_]{2,30})/g,
        '<a href="/user/$1" class="user-mention" style="color:#1a5276;font-weight:500;">@$1</a>');
    return html;
}

// Auth middleware for forum routes
function requireAuth(req, res, next) {
    if (req.session.userId) return next();
    const lang = req.session.lang || 'en';
    res.redirect(`/${lang}/login?error=Please log in to access this page`);
}

// ─── GET /discuss — forum home ────────────────────────────────
router.get('/', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        const { rows: categories } = await pool.query(`
            SELECT fc.*,
                (SELECT COUNT(*) FROM forum_topics ft WHERE ft.category_id = fc.id) AS topic_count,
                (SELECT COUNT(*) FROM forum_posts fp
                    JOIN forum_topics ft2 ON fp.topic_id = ft2.id
                    WHERE ft2.category_id = fc.id) AS post_count
            FROM forum_categories fc
            ORDER BY fc.sort_order
        `);

        // Get latest topic per category
        for (const cat of categories) {
            const { rows } = await pool.query(`
                SELECT ft.id, ft.title, ft.slug, ft.created_at, ft.last_reply_at,
                       u.username AS author_username
                FROM forum_topics ft
                JOIN users u ON ft.user_id = u.id
                WHERE ft.category_id = $1
                ORDER BY COALESCE(ft.last_reply_at, ft.created_at) DESC
                LIMIT 1
            `, [cat.id]);
            cat.latest_topic = rows[0] || null;
        }

        res.render('forum/index', {
            __: i18n.__,
            lang,
            categories,
            timeAgo,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (err) {
        console.error('Forum home error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── GET /discuss/new — new topic form ────────────────────────
router.get('/new', requireAuth, async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        const { rows: categories } = await pool.query(
            'SELECT id, name, slug FROM forum_categories ORDER BY sort_order'
        );

        res.render('forum/new_topic', {
            __: i18n.__,
            lang,
            categories,
            selectedCategory: req.query.category || null,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (err) {
        console.error('Forum new topic error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── POST /discuss — create topic + first post ───────────────
router.post('/', requireAuth, async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    const { title, content, category_id } = req.body;
    if (!title || !title.trim() || !content || !content.trim()) {
        return res.status(400).json({ error: 'Title and content are required' });
    }
    if (!category_id) {
        return res.status(400).json({ error: 'Category is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify category exists
        const { rows: catRows } = await client.query(
            'SELECT id, slug FROM forum_categories WHERE id = $1', [category_id]
        );
        if (catRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid category' });
        }

        const slug = await uniqueTopicSlug(generateSlug(title.trim()), category_id);

        const { rows: topicRows } = await client.query(
            `INSERT INTO forum_topics (category_id, user_id, title, slug, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             RETURNING *`,
            [category_id, req.session.userId, title.trim(), slug]
        );
        const topic = topicRows[0];

        await client.query(
            `INSERT INTO forum_posts (topic_id, user_id, content, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())`,
            [topic.id, req.session.userId, content.trim()]
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            redirect: `/discuss/${catRows[0].slug}/${topic.id}-${slug}`
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Forum create topic error:', err);
        res.status(500).json({ error: 'Failed to create topic' });
    } finally {
        client.release();
    }
});

// ─── GET /discuss/:categorySlug — topic list ─────────────────
router.get('/:categorySlug', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        const { rows: catRows } = await pool.query(
            'SELECT * FROM forum_categories WHERE slug = $1', [req.params.categorySlug]
        );
        if (catRows.length === 0) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }
        const category = catRows[0];

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const perPage = 20;
        const offset = (page - 1) * perPage;

        const [topicsResult, countResult] = await Promise.all([
            pool.query(`
                SELECT ft.*,
                    u.username AS author_username,
                    u.profile_picture AS author_avatar,
                    lr.username AS last_reply_username,
                    (SELECT COUNT(*) > 0 FROM forum_posts fp WHERE fp.topic_id = ft.id AND fp.is_solution = true) AS has_solution
                FROM forum_topics ft
                JOIN users u ON ft.user_id = u.id
                LEFT JOIN users lr ON ft.last_reply_by = lr.id
                WHERE ft.category_id = $1
                ORDER BY ft.is_pinned DESC, COALESCE(ft.last_reply_at, ft.created_at) DESC
                LIMIT $2 OFFSET $3
            `, [category.id, perPage, offset]),
            pool.query(
                'SELECT COUNT(*) FROM forum_topics WHERE category_id = $1',
                [category.id]
            )
        ]);

        const total = parseInt(countResult.rows[0].count, 10);
        const totalPages = Math.ceil(total / perPage);

        res.render('forum/category', {
            __: i18n.__,
            lang,
            category,
            topics: topicsResult.rows,
            page,
            totalPages,
            timeAgo,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (err) {
        console.error('Forum category error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── POST /discuss/:topicId/reply — add reply ────────────────
router.post('/:topicId/reply', requireAuth, async (req, res) => {
    const topicId = parseInt(req.params.topicId, 10);
    const { content } = req.body;

    if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Reply content is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: topicRows } = await client.query(
            'SELECT id, is_locked FROM forum_topics WHERE id = $1', [topicId]
        );
        if (topicRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Topic not found' });
        }
        if (topicRows[0].is_locked) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'This topic is locked' });
        }

        await client.query(
            `INSERT INTO forum_posts (topic_id, user_id, content, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())`,
            [topicId, req.session.userId, content.trim()]
        );

        await client.query(
            `UPDATE forum_topics
             SET reply_count = reply_count + 1,
                 last_reply_at = NOW(),
                 last_reply_by = $1
             WHERE id = $2`,
            [req.session.userId, topicId]
        );

        await client.query('COMMIT');

        // Notify topic author about the reply
        try {
            const { rows: topicInfo } = await pool.query(
                `SELECT ft.user_id, ft.title, ft.slug, fc.slug AS category_slug
                 FROM forum_topics ft
                 JOIN forum_categories fc ON ft.category_id = fc.id
                 WHERE ft.id = $1`,
                [topicId]
            );
            if (topicInfo.length > 0 && topicInfo[0].user_id) {
                const replierResult = await pool.query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
                const replierName = replierResult.rows[0]?.username || 'Someone';
                await notifications.createNotification(
                    topicInfo[0].user_id,
                    'forum_reply',
                    `${replierName} replied to your topic`,
                    topicInfo[0].title.slice(0, 100),
                    `/discuss/${topicInfo[0].category_slug}/${topicId}-${topicInfo[0].slug}`,
                    req.session.userId
                );
            }
        } catch (notifErr) { console.error('Notification error (forum reply):', notifErr); }

        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Forum reply error:', err);
        res.status(500).json({ error: 'Failed to post reply' });
    } finally {
        client.release();
    }
});

// ─── POST /discuss/posts/:postId/vote — upvote/downvote ──────
router.post('/posts/:postId/vote', requireAuth, async (req, res) => {
    const postId = parseInt(req.params.postId, 10);
    const vote = parseInt(req.body.vote, 10);

    if (vote !== 1 && vote !== -1) {
        return res.status(400).json({ error: 'Vote must be 1 or -1' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check post exists and user isn't voting on their own post
        const { rows: postRows } = await client.query(
            'SELECT id, user_id, upvotes, downvotes FROM forum_posts WHERE id = $1', [postId]
        );
        if (postRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Post not found' });
        }
        if (postRows[0].user_id === req.session.userId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Cannot vote on your own post' });
        }

        // Check existing vote
        const { rows: existingVote } = await client.query(
            'SELECT vote FROM forum_post_votes WHERE user_id = $1 AND post_id = $2',
            [req.session.userId, postId]
        );

        if (existingVote.length > 0) {
            const oldVote = existingVote[0].vote;
            if (oldVote === vote) {
                // Remove vote (toggle off)
                await client.query(
                    'DELETE FROM forum_post_votes WHERE user_id = $1 AND post_id = $2',
                    [req.session.userId, postId]
                );
                const upDelta = oldVote === 1 ? -1 : 0;
                const downDelta = oldVote === -1 ? -1 : 0;
                await client.query(
                    'UPDATE forum_posts SET upvotes = upvotes + $1, downvotes = downvotes + $2 WHERE id = $3',
                    [upDelta, downDelta, postId]
                );
            } else {
                // Change vote
                await client.query(
                    'UPDATE forum_post_votes SET vote = $1, created_at = NOW() WHERE user_id = $2 AND post_id = $3',
                    [vote, req.session.userId, postId]
                );
                if (vote === 1) {
                    await client.query(
                        'UPDATE forum_posts SET upvotes = upvotes + 1, downvotes = downvotes - 1 WHERE id = $1',
                        [postId]
                    );
                } else {
                    await client.query(
                        'UPDATE forum_posts SET upvotes = upvotes - 1, downvotes = downvotes + 1 WHERE id = $1',
                        [postId]
                    );
                }
            }
        } else {
            // New vote
            await client.query(
                'INSERT INTO forum_post_votes (user_id, post_id, vote, created_at) VALUES ($1, $2, $3, NOW())',
                [req.session.userId, postId, vote]
            );
            if (vote === 1) {
                await client.query('UPDATE forum_posts SET upvotes = upvotes + 1 WHERE id = $1', [postId]);
            } else {
                await client.query('UPDATE forum_posts SET downvotes = downvotes + 1 WHERE id = $1', [postId]);
            }
        }

        await client.query('COMMIT');

        // Return updated counts
        const { rows: updated } = await pool.query(
            'SELECT upvotes, downvotes FROM forum_posts WHERE id = $1', [postId]
        );
        const { rows: userVoteRows } = await pool.query(
            'SELECT vote FROM forum_post_votes WHERE user_id = $1 AND post_id = $2',
            [req.session.userId, postId]
        );

        res.json({
            success: true,
            upvotes: updated[0]?.upvotes || 0,
            downvotes: updated[0]?.downvotes || 0,
            userVote: userVoteRows[0]?.vote || 0
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Forum vote error:', err);
        res.status(500).json({ error: 'Failed to vote' });
    } finally {
        client.release();
    }
});

// ─── POST /discuss/:topicId/solution/:postId — mark solution ─
router.post('/:topicId/solution/:postId', requireAuth, async (req, res) => {
    const topicId = parseInt(req.params.topicId, 10);
    const postId = parseInt(req.params.postId, 10);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify topic exists and user is the topic author
        const { rows: topicRows } = await client.query(
            'SELECT id, user_id FROM forum_topics WHERE id = $1', [topicId]
        );
        if (topicRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Topic not found' });
        }
        if (topicRows[0].user_id !== req.session.userId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Only the topic author can mark a solution' });
        }

        // Verify post belongs to this topic and isn't the first post
        const { rows: postRows } = await client.query(
            'SELECT id FROM forum_posts WHERE id = $1 AND topic_id = $2', [postId, topicId]
        );
        if (postRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Post not found in this topic' });
        }

        // Unmark any existing solution in this topic
        await client.query(
            'UPDATE forum_posts SET is_solution = false WHERE topic_id = $1 AND is_solution = true',
            [topicId]
        );

        // Mark this post as solution
        await client.query(
            'UPDATE forum_posts SET is_solution = true WHERE id = $1',
            [postId]
        );

        await client.query('COMMIT');

        // Notify the post author that their answer was marked as solution
        try {
            const { rows: postAuthor } = await pool.query(
                'SELECT user_id FROM forum_posts WHERE id = $1', [postId]
            );
            if (postAuthor.length > 0 && postAuthor[0].user_id) {
                const { rows: topicInfo } = await pool.query(
                    `SELECT ft.title, ft.slug, fc.slug AS category_slug
                     FROM forum_topics ft
                     JOIN forum_categories fc ON ft.category_id = fc.id
                     WHERE ft.id = $1`,
                    [topicId]
                );
                const topicTitle = topicInfo[0]?.title || 'a topic';
                const link = topicInfo.length > 0
                    ? `/discuss/${topicInfo[0].category_slug}/${topicId}-${topicInfo[0].slug}`
                    : `/discuss`;
                await notifications.createNotification(
                    postAuthor[0].user_id,
                    'forum_solution',
                    'Your answer was marked as the solution',
                    topicTitle.slice(0, 100),
                    link,
                    req.session.userId
                );
            }
        } catch (notifErr) { console.error('Notification error (forum solution):', notifErr); }

        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Forum mark solution error:', err);
        res.status(500).json({ error: 'Failed to mark solution' });
    } finally {
        client.release();
    }
});

// ─── GET /discuss/:categorySlug/:topicId-:topicSlug — topic page
router.get('/:categorySlug/:topicParam', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    // Parse topicId from "123-some-slug" format
    const match = req.params.topicParam.match(/^(\d+)-/);
    if (!match) {
        return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
    const topicId = parseInt(match[1], 10);

    try {
        // Verify category
        const { rows: catRows } = await pool.query(
            'SELECT * FROM forum_categories WHERE slug = $1', [req.params.categorySlug]
        );
        if (catRows.length === 0) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }
        const category = catRows[0];

        // Get topic
        const { rows: topicRows } = await pool.query(
            `SELECT ft.*, u.username AS author_username
             FROM forum_topics ft
             JOIN users u ON ft.user_id = u.id
             WHERE ft.id = $1 AND ft.category_id = $2`,
            [topicId, category.id]
        );
        if (topicRows.length === 0) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }
        const topic = topicRows[0];

        // Increment view count (fire and forget)
        pool.query('UPDATE forum_topics SET view_count = view_count + 1 WHERE id = $1', [topicId]).catch(() => {});

        // Get all posts with author info
        const { rows: posts } = await pool.query(`
            SELECT fp.*,
                u.username,
                u.profile_picture,
                COALESCE(u.created_at,
                    (SELECT MIN(edited_at) FROM contributions WHERE user_id = u.id),
                    (SELECT MIN(edited_at) FROM github_contributions WHERE user_id = u.id),
                    fp.created_at
                ) AS user_joined
            FROM forum_posts fp
            JOIN users u ON fp.user_id = u.id
            WHERE fp.topic_id = $1
            ORDER BY fp.created_at ASC
        `, [topicId]);

        // Compute reputation for each unique poster
        const userIds = [...new Set(posts.map(p => p.user_id))];
        const reputations = {};
        for (const uid of userIds) {
            const rep = await getUserReputation(uid);
            reputations[uid] = { score: rep, ...getReputationBadge(rep) };
        }

        // Get current user's votes on these posts
        let userVotes = {};
        if (req.session.userId) {
            const postIds = posts.map(p => p.id);
            if (postIds.length > 0) {
                const { rows: votes } = await pool.query(
                    'SELECT post_id, vote FROM forum_post_votes WHERE user_id = $1 AND post_id = ANY($2)',
                    [req.session.userId, postIds]
                );
                for (const v of votes) {
                    userVotes[v.post_id] = v.vote;
                }
            }
        }

        res.render('forum/topic', {
            __: i18n.__,
            lang,
            category,
            topic,
            posts,
            reputations,
            userVotes,
            timeAgo,
            autoLinkContent,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (err) {
        console.error('Forum topic error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

module.exports = router;
