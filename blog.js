const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const i18n = require('i18n');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const fileUpload = require('express-fileupload');
const { parseMarkdown, autoLinkProblemRefs, linkifyBlogHtml } = require('./utils');
const { getOnlineUsernames } = require('./lib/presence');

router.use(fileUpload());

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

// Helper: transliterate Cyrillic to Latin for URL slugs
const CYRILLIC_MAP = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh',
    'з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o',
    'п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts',
    'ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
};

function transliterate(str) {
    return str.replace(/[а-яёА-ЯЁ]/g, (ch) => {
        const lower = ch.toLowerCase();
        const mapped = CYRILLIC_MAP[lower] || '';
        return ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    });
}

// Helper: generate slug from title
function generateSlug(title) {
    return transliterate(title)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100);
}

// Helper: ensure slug uniqueness
async function uniqueSlug(baseSlug, excludeId) {
    let slug = baseSlug;
    let suffix = 2;
    while (true) {
        const params = excludeId ? [slug, excludeId] : [slug];
        const where = excludeId ? 'slug = $1 AND id != $2' : 'slug = $1';
        const { rows } = await pool.query(`SELECT id FROM blog_posts WHERE ${where}`, params);
        if (rows.length === 0) return slug;
        slug = `${baseSlug.slice(0, 96)}-${suffix}`;
        suffix++;
    }
}

// Helper: strip HTML/markdown for excerpt
function stripForExcerpt(text, maxLen = 200) {
    const plain = text
        .replace(/#{1,6}\s+/g, '')
        .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[`~>]/g, '')
        .replace(/\n+/g, ' ')
        .trim();
    return plain.length > maxLen ? plain.slice(0, maxLen) + '...' : plain;
}

// Helper: check if user can create/edit posts
function canCreatePost(req) {
    if (!req.session.userId) return false;
    if (req.session.username === 'astrosander') return true;
    return req.session.isVerifiedUser === true;
}

// Middleware: load verified status into session if missing
async function loadVerifiedStatus(req, res, next) {
    if (req.session.userId && req.session.isVerifiedUser === undefined) {
        try {
            const { rows } = await pool.query(
                'SELECT is_verified_user FROM users WHERE id = $1',
                [req.session.userId]
            );
            req.session.isVerifiedUser = rows[0]?.is_verified_user || false;
        } catch {
            req.session.isVerifiedUser = false;
        }
    }
    next();
}

router.use(loadVerifiedStatus);

// ─── API: latest posts for home page widget ────────────────────
router.get('/api/posts', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 3, 10);
    const lang = req.session.lang || 'en';
    try {
        const { rows } = await pool.query(
            `SELECT bp.id, bp.title, bp.slug, bp.excerpt, bp.published_at, bp.tags,
                    u.username AS author_username
             FROM blog_posts bp
             JOIN users u ON u.id = bp.author_id
             WHERE bp.is_published = true AND bp.language = $2
             ORDER BY bp.published_at DESC
             LIMIT $1`,
            [limit, lang]
        );
        res.json(rows);
    } catch (err) {
        console.error('Blog API error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── POST /blog/upload-image — image upload for blog editor ────
router.post('/upload-image', async (req, res) => {
    if (!canCreatePost(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!req.files || !req.files.image) {
        return res.status(400).json({ error: 'No image provided' });
    }

    const file = req.files.image;
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
        return res.status(400).json({ error: 'File exceeds 5 MB limit' });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({ error: 'Only JPG, PNG, GIF, SVG, and WebP are allowed' });
    }

    try {
        const uploadDir = path.join(__dirname, 'img', 'blog');
        fs.mkdirSync(uploadDir, { recursive: true });

        const timestamp = Date.now();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const fileName = `${timestamp}_${safeName}`;
        const filePath = path.join(uploadDir, fileName);

        await sharp(file.data).toFile(filePath);

        if (/\.(jpg|jpeg|png)$/i.test(fileName)) {
            try {
                const webpPath = filePath.replace(/\.(jpg|jpeg|png)$/i, '.webp');
                await sharp(file.data).webp({ quality: 85 }).toFile(webpPath);
            } catch {}
        }

        const metadata = await sharp(filePath).metadata();
        res.json({
            success: true,
            url: `/img/blog/${fileName}`,
            width: metadata.width,
            height: metadata.height,
        });
    } catch (err) {
        console.error('Blog image upload error:', err);
        res.status(500).json({ error: 'Failed to upload image' });
    }
});

// ─── GET /blog — paginated list ────────────────────────────────
router.get('/', async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = 10;
    const offset = (page - 1) * perPage;
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        const [postsResult, countResult, tagsResult] = await Promise.all([
            pool.query(
                `SELECT bp.*, u.username AS author_username, u.profile_picture AS author_avatar
                 FROM blog_posts bp
                 JOIN users u ON u.id = bp.author_id
                 WHERE bp.is_published = true AND bp.language = $3
                 ORDER BY bp.published_at DESC
                 LIMIT $1 OFFSET $2`,
                [perPage, offset, lang]
            ),
            pool.query('SELECT COUNT(*) FROM blog_posts WHERE is_published = true AND language = $1', [lang]),
            pool.query(
                `SELECT DISTINCT unnest(tags) AS tag
                 FROM blog_posts
                 WHERE is_published = true AND language = $1
                 ORDER BY tag`,
                [lang]
            ),
        ]);

        const total = parseInt(countResult.rows[0].count, 10);
        const totalPages = Math.ceil(total / perPage);

        res.render('blog/list', {
            __: i18n.__,
            lang,
            posts: postsResult.rows,
            allTags: tagsResult.rows.map(r => r.tag),
            activeTag: null,
            page,
            totalPages,
            username: req.session.username || null,
            userId: req.session.userId || null,
            canPost: canCreatePost(req),
        });
    } catch (err) {
        console.error('Blog list error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── GET /blog/tag/:tag — filter by tag ────────────────────────
router.get('/tag/:tag', async (req, res) => {
    const tag = req.params.tag.toLowerCase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = 10;
    const offset = (page - 1) * perPage;
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        const [postsResult, countResult, tagsResult] = await Promise.all([
            pool.query(
                `SELECT bp.*, u.username AS author_username, u.profile_picture AS author_avatar
                 FROM blog_posts bp
                 JOIN users u ON u.id = bp.author_id
                 WHERE bp.is_published = true AND $1 = ANY(bp.tags) AND bp.language = $4
                 ORDER BY bp.published_at DESC
                 LIMIT $2 OFFSET $3`,
                [tag, perPage, offset, lang]
            ),
            pool.query(
                'SELECT COUNT(*) FROM blog_posts WHERE is_published = true AND $1 = ANY(tags) AND language = $2',
                [tag, lang]
            ),
            pool.query(
                `SELECT DISTINCT unnest(tags) AS tag
                 FROM blog_posts
                 WHERE is_published = true AND language = $1
                 ORDER BY tag`,
                [lang]
            ),
        ]);

        const total = parseInt(countResult.rows[0].count, 10);
        const totalPages = Math.ceil(total / perPage);

        res.render('blog/list', {
            __: i18n.__,
            lang,
            posts: postsResult.rows,
            allTags: tagsResult.rows.map(r => r.tag),
            activeTag: tag,
            page,
            totalPages,
            username: req.session.username || null,
            userId: req.session.userId || null,
            canPost: canCreatePost(req),
        });
    } catch (err) {
        console.error('Blog tag filter error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── GET /blog/new — editor (create) ──────────────────────────
router.get('/new', (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    if (!canCreatePost(req)) {
        return res.redirect(`/${lang}/login?error=You must be a verified user to create blog posts`);
    }

    res.render('blog/editor', {
        __: i18n.__,
        lang,
        post: null,
        username: req.session.username || null,
        userId: req.session.userId || null,
    });
});

// ─── POST /blog — create post ─────────────────────────────────
router.post('/', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    if (!canCreatePost(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { title, content, tags, language, action } = req.body;
    if (!title || !content) {
        return res.status(400).json({ error: 'Title and content are required' });
    }

    const isPublish = action === 'publish';
    const postLang = language || 'en';
    const tagArray = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];

    try {
        const slug = await uniqueSlug(generateSlug(title));
        const excerpt = req.body.excerpt || stripForExcerpt(content);

        const { rows } = await pool.query(
            `INSERT INTO blog_posts (author_id, title, slug, content, excerpt, language, tags, is_published, published_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                req.session.userId,
                title,
                slug,
                content,
                excerpt,
                postLang,
                tagArray,
                isPublish,
                isPublish ? new Date() : null,
            ]
        );

        res.json({ success: true, slug: rows[0].slug });
    } catch (err) {
        console.error('Blog create error:', err);
        res.status(500).json({ error: 'Failed to create post' });
    }
});

// ─── GET /blog/:slug/edit — editor (edit) ─────────────────────
router.get('/:slug/edit', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    if (!req.session.userId) {
        return res.redirect(`/${lang}/login?error=Please log in to edit blog posts`);
    }

    try {
        const { rows } = await pool.query('SELECT * FROM blog_posts WHERE slug = $1', [req.params.slug]);
        if (rows.length === 0) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }

        const post = rows[0];
        // Only author or astrosander can edit
        if (post.author_id !== req.session.userId && req.session.username !== 'astrosander') {
            return res.status(403).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }

        res.render('blog/editor', {
            __: i18n.__,
            lang,
            post,
            username: req.session.username || null,
            userId: req.session.userId || null,
        });
    } catch (err) {
        console.error('Blog edit page error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

// ─── POST /blog/:slug — update post ──────────────────────────
router.post('/:slug', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { rows: existing } = await pool.query('SELECT * FROM blog_posts WHERE slug = $1', [req.params.slug]);
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const post = existing[0];
        if (post.author_id !== req.session.userId && req.session.username !== 'astrosander') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { title, content, tags, language, action } = req.body;
        if (!title || !content) {
            return res.status(400).json({ error: 'Title and content are required' });
        }

        const isPublish = action === 'publish';
        const postLang = language || post.language;
        const tagArray = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];
        const newSlug = await uniqueSlug(generateSlug(title), post.id);
        const excerpt = req.body.excerpt || stripForExcerpt(content);

        // If publishing for the first time, set published_at
        const publishedAt = isPublish
            ? (post.published_at || new Date())
            : post.published_at;

        await pool.query(
            `UPDATE blog_posts
             SET title = $1, slug = $2, content = $3, excerpt = $4, language = $5,
                 tags = $6, is_published = $7, published_at = $8, updated_at = NOW()
             WHERE id = $9`,
            [title, newSlug, content, excerpt, postLang, tagArray, isPublish, publishedAt, post.id]
        );

        res.json({ success: true, slug: newSlug });
    } catch (err) {
        console.error('Blog update error:', err);
        res.status(500).json({ error: 'Failed to update post' });
    }
});

// ─── POST /blog/:slug/comments — add comment ─────────────────
router.post('/:slug/comments', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Please log in to comment' });
    }

    const { content, parent_id } = req.body;
    if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Comment cannot be empty' });
    }

    try {
        const { rows: postRows } = await pool.query(
            'SELECT id FROM blog_posts WHERE slug = $1 AND is_published = true',
            [req.params.slug]
        );
        if (postRows.length === 0) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const parentId = parent_id ? parseInt(parent_id, 10) : null;
        if (parentId) {
            const { rows: parentRows } = await pool.query(
                'SELECT id FROM blog_comments WHERE id = $1 AND post_id = $2',
                [parentId, postRows[0].id]
            );
            if (parentRows.length === 0) {
                return res.status(400).json({ error: 'Parent comment not found' });
            }
        }

        const { rows } = await pool.query(
            `INSERT INTO blog_comments (post_id, user_id, content, parent_id)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [postRows[0].id, req.session.userId, content.trim(), parentId]
        );

        // Fetch user info for response
        const { rows: userRows } = await pool.query(
            'SELECT username, profile_picture FROM users WHERE id = $1',
            [req.session.userId]
        );

        res.json({
            success: true,
            comment: {
                ...rows[0],
                username: userRows[0]?.username,
                profile_picture: userRows[0]?.profile_picture,
            },
        });
    } catch (err) {
        console.error('Blog comment error:', err);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

// ─── GET /blog/:slug — single post ───────────────────────────
router.get('/:slug', async (req, res) => {
    const lang = req.session.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        const { rows } = await pool.query(
            `SELECT bp.*, u.username AS author_username, u.profile_picture AS author_avatar
             FROM blog_posts bp
             JOIN users u ON u.id = bp.author_id
             WHERE bp.slug = $1 AND bp.is_published = true`,
            [req.params.slug]
        );

        if (rows.length === 0) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }

        const post = rows[0];

        // Increment view count
        pool.query('UPDATE blog_posts SET view_count = view_count + 1 WHERE id = $1', [post.id]).catch(() => {});

        // Fetch comments with user info
        const { rows: comments } = await pool.query(
            `SELECT bc.*, u.username, u.profile_picture
             FROM blog_comments bc
             JOIN users u ON u.id = bc.user_id
             WHERE bc.post_id = $1
             ORDER BY bc.created_at ASC`,
            [post.id]
        );

        // Prev/next posts
        const [prevResult, nextResult] = await Promise.all([
            pool.query(
                `SELECT title, slug FROM blog_posts
                 WHERE is_published = true AND published_at < $1
                 ORDER BY published_at DESC LIMIT 1`,
                [post.published_at]
            ),
            pool.query(
                `SELECT title, slug FROM blog_posts
                 WHERE is_published = true AND published_at > $1
                 ORDER BY published_at ASC LIMIT 1`,
                [post.published_at]
            ),
        ]);

        // Reading time
        const wordCount = post.content.split(/\s+/).length;
        const readingTime = Math.max(1, Math.round(wordCount / 200));

        // Online-presence dots for other users' avatars (fresh, privacy-respecting).
        // Skip the current logged-in user's own avatar.
        const currentUsername = req.session.username || null;
        const presenceUsernames = [post.author_username, ...comments.map(c => c.username)];
        const onlineUsers = await getOnlineUsernames(pool, presenceUsernames);
        post.author_is_online = onlineUsers.has(post.author_username) && post.author_username !== currentUsername;
        for (const c of comments) {
            c.is_online = onlineUsers.has(c.username) && c.username !== currentUsername;
        }

        // Build threaded comments
        const topLevel = [];
        const childMap = {};
        for (const c of comments) {
            if (c.parent_id) {
                if (!childMap[c.parent_id]) childMap[c.parent_id] = [];
                childMap[c.parent_id].push(c);
            } else {
                topLevel.push(c);
            }
        }

        res.render('blog/post', {
            __: i18n.__,
            lang,
            post,
            comments: topLevel,
            childMap,
            prevPost: prevResult.rows[0] || null,
            nextPost: nextResult.rows[0] || null,
            readingTime,
            username: req.session.username || null,
            userId: req.session.userId || null,
            renderMarkdown: (content) => linkifyBlogHtml(parseMarkdown(content), lang),
        });
    } catch (err) {
        console.error('Blog post error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
});

module.exports = router;
