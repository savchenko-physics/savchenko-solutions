// Brainstorm Room — backend (Phase 1: data layer + API).
//
// A per-problem brainstorm channel, UNIFIED by problem_name only (all interface
// languages share one room per problem — see BRAINSTORM_DESIGN_NOTES.md §13).
// Patterns are deliberately copied from the existing chat (messages.js):
//   - AJAX polling for near-real-time (no sockets)
//   - emoji reaction toggle (same ALLOWED_REACTIONS as the chat)
//   - raw content stored; HTML-escaping + markdown happen at render time
// Reads are public; writes are auth-gated and (for posting) rate-limited.

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const i18n = require('i18n');
const notifications = require('./notifications');
const { getProblemBreadcrumbParts } = require('./parents');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const DEFAULT_PROFILE_AVATAR = '/img/profile_images/Default_placeholder.svg';

// Same six reactions the chat allows (messages.js). Reused verbatim so users see
// one consistent reaction vocabulary across the platform.
const ALLOWED_REACTIONS = ['\u{1F44D}', '\u{1F44E}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F622}', '\u{1F914}'];

const MAX_CONTENT_LENGTH = 4000;   // brainstorm messages are short; chat caps at 5000
const EDIT_WINDOW_HOURS = 24;      // matches the comment/chat edit window
const TOP_CACHE_TTL_MS = 60 * 1000;

// ─── Pure helpers (exported for unit tests) ──────────────────────────────────

// Match a Savchenko problem id like 7.3.6 / 14.5.24 (1–2 digits per part).
const PROBLEM_ID = '\\d{1,2}\\.\\d{1,2}\\.\\d{1,2}';

/**
 * Extract structured problem cross-links from a raw message body.
 *
 * Two syntaxes are recognised, descriptive first (the wiki-style priority):
 *   1. Descriptive:  [the relativistic Doppler trick](#7.3.6)
 *   2. Bare mention: #7.3.6      (auto-detected, link text defaults to "#7.3.6")
 *
 * Returns a de-duplicated array of { targetProblemName, linkText } in first-seen
 * order. target language is intentionally omitted (links are language-agnostic in
 * the unified room). Pure + synchronous so it is trivially unit-testable.
 */
function parseProblemLinks(content) {
    if (!content || typeof content !== 'string') return [];

    const out = [];
    const seen = new Set();
    const add = (target, text) => {
        const key = target + '\x00' + text;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ targetProblemName: target, linkText: text });
    };

    // One left-to-right pass over both syntaxes so links keep their true
    // first-seen order. The descriptive alternative is tried first at each
    // position, so the "#x.y.z" inside [text](#x.y.z) is consumed by the
    // descriptive match and never re-counted as a bare mention. The lookbehind
    // rejects "#" glued to a word char / slash / dot (e.g. issue12#1.2.3, /1.2.3).
    const re = new RegExp(
        '\\[([^\\]]+?)\\]\\(#(' + PROBLEM_ID + ')\\)' +   // 1=text, 2=target (descriptive)
        '|(?<![\\w#/.])#(' + PROBLEM_ID + ')\\b',          // 3=target (bare mention)
        'g'
    );
    let m;
    while ((m = re.exec(content)) !== null) {
        if (m[2] !== undefined) add(m[2], (m[1] || '').trim());
        else if (m[3] !== undefined) add(m[3], '#' + m[3]);
    }

    return out;
}

// Server-side HTML escape (no DOM available here, unlike the client formatter).
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Render a brainstorm message body to safe HTML for the server-rendered block.
 * Escapes first, protects math so the linkifier never reaches inside it, turns
 * descriptive + bare problem links into real <a> words (wiki-style) and @mentions
 * into profile links, then collapses newlines (the block shows a compact preview;
 * CSS line-clamps the height so we never truncate mid-LaTeX and break MathJax).
 */
function formatBrainstormHtml(content, lang, opts) {
    opts = opts || {};
    let text = escapeHtml(content);

    // Protect $$…$$ then $…$ so '#', '@', etc. inside math are left untouched.
    const math = [];
    text = text.replace(/\$\$([\s\S]*?)\$\$/g, (m) => '\x00M' + (math.push(m) - 1) + '\x00');
    text = text.replace(/\$([^\$\n]+?)\$/g, (m) => '\x00M' + (math.push(m) - 1) + '\x00');

    const safeLang = lang === 'ru' ? 'ru' : 'en';

    // Descriptive [text](#x.y.z) and bare #x.y.z, left-to-right (same rules as
    // parseProblemLinks). The target is a validated problem id, so href is safe.
    const reLink = new RegExp(
        '\\[([^\\]]+?)\\]\\(#(' + PROBLEM_ID + ')\\)' +
        '|(?<![\\w#/.])#(' + PROBLEM_ID + ')\\b',
        'g'
    );
    text = text.replace(reLink, (full, dtext, dtarget, btarget) => {
        const target = dtarget || btarget;
        const label = dtarget != null ? dtext : '#' + btarget;
        return '<a href="/' + safeLang + '/' + target + '" class="bs-link">' + label + '</a>';
    });

    // @mentions → profile links.
    text = text.replace(/@(\w+)/g, '<a href="/user/$1" class="bs-link">@$1</a>');

    // Block ticker collapses to one line; the room preserves line breaks.
    text = opts.multiline
        ? text.replace(/\n/g, '<br>')
        : text.replace(/\s*\n\s*/g, ' ');

    // Restore protected math.
    text = text.replace(/\x00M(\d+)\x00/g, (_, i) => math[parseInt(i)]);
    return text;
}

// ─── Auth / permission helpers ───────────────────────────────────────────────

// JSON-aware auth guard for these pure-AJAX endpoints (returns 401 rather than
// redirecting like the page-oriented checkAuthenticated middleware).
function requireUser(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

// Curators (who may pin) = the hardcoded admin OR any verified user.
async function canCurate(req) {
    if (!req.session || !req.session.userId) return false;
    if (req.session.username === 'astrosander') return true;
    try {
        const r = await pool.query('SELECT is_verified_user FROM users WHERE id = $1', [req.session.userId]);
        return r.rows.length > 0 && r.rows[0].is_verified_user === true;
    } catch (_err) {
        return false;
    }
}

function isAdmin(req) {
    return !!req.session && req.session.username === 'astrosander';
}

// Per-user posting limiter (mirrors editSaveLimiter's keying by userId).
const brainstormPostLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => String(req.session?.userId ?? 'anonymous'),
    message: { error: 'You are posting too fast. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ─── Small TTL cache for the hot top-N block ─────────────────────────────────
// The problem page is the most-visited page. The top-N is also server-rendered
// once per page view (Phase 2 calls getTopBrainstormMessages directly), so this
// keeps that to a single index scan at most once per minute per problem.
const topCache = new Map(); // `${problemName}|${limit}` -> { expires, data }
const relatedCache = new Map(); // problemName -> { expires, data } (Phase-4 related strip)
const RELATED_CACHE_TTL_MS = 5 * 60 * 1000;

function invalidateTop(problemName) {
    // Keys are `${problemName}|${limit}`; clear every cached limit for this problem.
    const prefix = problemName + '|';
    for (const key of topCache.keys()) {
        if (key.startsWith(prefix)) topCache.delete(key);
    }
    // The cross-reference strip can change when messages/links change, but it also
    // depends on OTHER problems' links (incoming), so clear it broadly to stay correct.
    relatedCache.clear();
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

function langTag(value, session) {
    if (value === 'ru' || value === 'en') return value;
    if (session && (session.lang === 'ru' || session.lang === 'en')) return session.lang;
    return 'en';
}

function mapAuthor(row) {
    return {
        userId: row.user_id,
        username: row.username,
        fullName: row.full_name,
        country: row.country_location || null,
        profilePicture: row.profile_picture || DEFAULT_PROFILE_AVATAR,
    };
}

// Fetch link rows for a set of message ids -> { [messageId]: [{ target, text }] }.
async function getLinksForMessages(ids) {
    if (!ids.length) return {};
    const r = await pool.query(
        `SELECT message_id, target_problem_name, target_language, link_text
         FROM brainstorm_message_links
         WHERE message_id = ANY($1)
         ORDER BY id ASC`,
        [ids]
    );
    const map = {};
    for (const row of r.rows) {
        (map[row.message_id] = map[row.message_id] || []).push({
            targetProblemName: row.target_problem_name,
            targetLanguage: row.target_language,
            linkText: row.link_text,
        });
    }
    return map;
}

// Aggregate reactions for a set of message ids -> { [messageId]: [{emoji,count,me}] }.
async function getReactionsForMessages(ids, userId) {
    if (!ids.length) return {};
    const r = await pool.query(
        `SELECT message_id, emoji, COUNT(*)::int AS count,
                BOOL_OR(user_id = $2) AS me
         FROM brainstorm_reactions
         WHERE message_id = ANY($1)
         GROUP BY message_id, emoji
         ORDER BY MIN(created_at)`,
        [ids, userId || 0]
    );
    const map = {};
    for (const row of r.rows) {
        (map[row.message_id] = map[row.message_id] || []).push({
            emoji: row.emoji,
            count: row.count,
            me: row.me === true,
        });
    }
    return map;
}

/**
 * Top-N most popular brainstorm messages for the rotating block.
 * Order: pinned first, then reaction_count, then most recent. Always returns
 * something (falls back to recent messages when nothing has reactions yet).
 * Cached for TOP_CACHE_TTL_MS per problem. Exported for the Phase-2 server render.
 */
async function getTopBrainstormMessages(problemName, limit = 5) {
    const lim = Math.min(Math.max(parseInt(limit) || 5, 1), 20);
    const cacheKey = `${problemName}|${lim}`;
    const cached = topCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.data;

    const r = await pool.query(
        // Phase-5 hook: a future detective/narrative treatment can prepend
        // `(m.narrative_role IS NOT NULL) DESC` (or order by a narrative sequence)
        // here to surface story-tagged messages first — no schema change needed.
        `SELECT m.id, m.content, m.language, m.is_pinned, m.reaction_count,
                m.created_at, m.user_id, m.narrative_role,
                u.username, u.full_name, u.profile_picture, u.country_location
         FROM brainstorm_messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.problem_name = $1 AND m.is_deleted = false
         ORDER BY m.is_pinned DESC, m.reaction_count DESC, m.created_at DESC
         LIMIT $2`,
        [problemName, lim]
    );

    const ids = r.rows.map((x) => x.id);
    const links = await getLinksForMessages(ids);
    const data = r.rows.map((row) => ({
        id: row.id,
        content: row.content,
        language: row.language,
        isPinned: row.is_pinned,
        reactionCount: row.reaction_count,
        createdAt: row.created_at,
        narrativeRole: row.narrative_role || null, // Phase-5 hook (unused for now)
        author: mapAuthor(row),
        links: links[row.id] || [],
    }));

    topCache.set(cacheKey, { expires: Date.now() + TOP_CACHE_TTL_MS, data });
    return data;
}

// Read a logged-in user's quiet-mode preference (block display mode).
// Returns 'rotate' (the default) when unset or unknown. Exported for the
// Phase-2 server render of the block.
async function getUserDisplayMode(userId) {
    if (!userId) return 'rotate';
    try {
        const r = await pool.query(
            'SELECT brainstorm_display_mode FROM user_preferences WHERE user_id = $1',
            [userId]
        );
        const mode = r.rows[0] && r.rows[0].brainstorm_display_mode;
        return mode === 'static' || mode === 'hidden' ? mode : 'rotate';
    } catch (_err) {
        return 'rotate';
    }
}

/**
 * Related-problems strip for the solved-problem ("Discussion & Insights") variant.
 * Uses the brainstorm cross-reference graph: problems this one's messages link TO
 * (outgoing) and problems whose messages link to this one (incoming). Returns
 * DESCRIPTIVE wiki-style phrases — never bare numbers: it prefers the stored
 * link_text, and falls back to the target's section title for bare mentions.
 * Cached (5 min) since it touches other problems' links and changes slowly.
 */
async function getRelatedBrainstormLinks(problemName, lang, limit = 6) {
    const cached = relatedCache.get(problemName);
    if (cached && cached.expires > Date.now()) return cached.data;

    let out = [];
    try {
        const r = await pool.query(
            `SELECT target, link_text, MAX(max_id) AS max_id FROM (
                 SELECT l.target_problem_name AS target, l.link_text, MAX(l.id) AS max_id
                 FROM brainstorm_message_links l
                 JOIN brainstorm_messages m ON m.id = l.message_id AND m.is_deleted = false
                 WHERE m.problem_name = $1 AND l.target_problem_name <> $1
                 GROUP BY l.target_problem_name, l.link_text
                 UNION ALL
                 SELECT m.problem_name AS target, l.link_text, MAX(l.id) AS max_id
                 FROM brainstorm_message_links l
                 JOIN brainstorm_messages m ON m.id = l.message_id AND m.is_deleted = false
                 WHERE l.target_problem_name = $1 AND m.problem_name <> $1
                 GROUP BY m.problem_name, l.link_text
             ) g
             GROUP BY target, link_text
             ORDER BY max_id DESC`,
            [problemName]
        );

        const byTarget = new Map();
        for (const row of r.rows) {
            const isDescriptive = row.link_text && !/^#/.test(row.link_text);
            const existing = byTarget.get(row.target);
            if (!existing) {
                byTarget.set(row.target, { target: row.target, linkText: row.link_text, descriptive: isDescriptive });
            } else if (!existing.descriptive && isDescriptive) {
                existing.linkText = row.link_text;
                existing.descriptive = true;
            }
        }

        for (const v of byTarget.values()) {
            let text = v.descriptive ? v.linkText : null;
            if (!text) {
                const bc = getProblemBreadcrumbParts(v.target, lang);
                text = bc ? bc.sectionTitle : v.target;
            }
            out.push({ targetProblemName: v.target, linkText: text });
            if (out.length >= limit) break;
        }
    } catch (_err) {
        out = [];
    }

    relatedCache.set(problemName, { expires: Date.now() + RELATED_CACHE_TTL_MS, data: out });
    return out;
}

/**
 * Fetch one newest-first page of the full room (used by the messages API and the
 * server-rendered room page). Returns serialized messages plus pagination cursors.
 */
async function fetchRoomMessages(problem, opts) {
    opts = opts || {};
    const limit = Math.min(Math.max(parseInt(opts.limit) || 30, 1), 100);
    const before = opts.before || null;
    const userId = opts.userId || null;

    const params = [problem];
    let beforeClause = '';
    if (before) {
        params.push(before);
        beforeClause = ` AND m.id < $${params.length}`;
    }
    params.push(limit);

    const r = await pool.query(
        `SELECT m.id, m.content, m.language, m.parent_id, m.is_pinned, m.reaction_count,
                m.created_at, m.updated_at, m.user_id,
                u.username, u.full_name, u.profile_picture, u.country_location
         FROM brainstorm_messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.problem_name = $1 AND m.is_deleted = false${beforeClause}
         ORDER BY m.id DESC
         LIMIT $${params.length}`,
        params
    );

    const ids = r.rows.map((x) => x.id);
    const [reactions, links] = await Promise.all([
        getReactionsForMessages(ids, userId),
        getLinksForMessages(ids),
    ]);

    return {
        messages: r.rows.map((row) => serializeMessage(row, reactions, links, userId)),
        hasMore: r.rows.length === limit,
        oldestId: ids.length ? ids[ids.length - 1] : null,
        newestId: ids.length ? ids[0] : null,
    };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/brainstorm/quiet-mode — persist the logged-in user's block display
// mode. Anonymous visitors persist client-side (localStorage) instead.
router.post('/quiet-mode', requireUser, async (req, res) => {
    try {
        const mode = req.body.mode;
        if (!['rotate', 'static', 'hidden'].includes(mode)) {
            return res.status(400).json({ error: 'Invalid mode' });
        }
        await pool.query(
            `INSERT INTO user_preferences (user_id, brainstorm_display_mode)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET brainstorm_display_mode = $2, updated_at = NOW()`,
            [req.session.userId, mode]
        );
        res.json({ ok: true, mode });
    } catch (err) {
        console.error('Brainstorm quiet-mode error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/brainstorm/:problem/top?limit=5 — rotating block source (public).
router.get('/:problem/top', async (req, res) => {
    try {
        const data = await getTopBrainstormMessages(req.params.problem, req.query.limit);
        res.json({ messages: data });
    } catch (err) {
        console.error('Brainstorm top error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/brainstorm/:problem/messages?before=<id>&limit=30 — full room, paginated.
// Returns newest-first; pass the oldest id you have as `before` to page backwards.
router.get('/:problem/messages', async (req, res) => {
    try {
        const result = await fetchRoomMessages(req.params.problem, {
            before: parseInt(req.query.before) || null,
            limit: Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100),
            userId: req.session.userId || null,
        });
        res.json(result);
    } catch (err) {
        console.error('Brainstorm messages error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/brainstorm/:problem/poll?after=<id>&since=<ts> — near-real-time updates.
// Same response shape as the chat poll: new messages + edits/deletes + reaction
// changes for messages the client already holds. No membership gate (public room).
router.get('/:problem/poll', async (req, res) => {
    try {
        const problem = req.params.problem;
        const afterId = parseInt(req.query.after) || 0;
        const since = req.query.since || null;
        const userId = req.session.userId || null;

        const fresh = await pool.query(
            `SELECT m.id, m.content, m.language, m.parent_id, m.is_pinned, m.reaction_count,
                    m.created_at, m.updated_at, m.user_id,
                    u.username, u.full_name, u.profile_picture, u.country_location
             FROM brainstorm_messages m
             JOIN users u ON u.id = m.user_id
             WHERE m.problem_name = $1 AND m.is_deleted = false AND m.id > $2
             ORDER BY m.id ASC`,
            [problem, afterId]
        );

        const ids = fresh.rows.map((x) => x.id);
        const [reactions, links] = await Promise.all([
            getReactionsForMessages(ids, userId),
            getLinksForMessages(ids),
        ]);
        const messages = fresh.rows.map((row) => serializeMessage(row, reactions, links, userId));

        // Edits / deletes / pin changes the client already has (id <= afterId).
        let updates = [];
        let reactionUpdates = [];
        if (since && afterId > 0) {
            const upd = await pool.query(
                `SELECT id, content, is_pinned, is_deleted, updated_at
                 FROM brainstorm_messages
                 WHERE problem_name = $1 AND id <= $2 AND updated_at > $3`,
                [problem, afterId, since]
            );
            updates = upd.rows.map((row) => ({
                id: row.id,
                content: row.is_deleted ? null : row.content,
                isPinned: row.is_pinned,
                isDeleted: row.is_deleted,
                updatedAt: row.updated_at,
            }));

            const changed = await pool.query(
                `SELECT DISTINCT mr.message_id
                 FROM brainstorm_reactions mr
                 JOIN brainstorm_messages m ON m.id = mr.message_id
                 WHERE m.problem_name = $1 AND mr.message_id <= $2 AND mr.created_at > $3`,
                [problem, afterId, since]
            );
            if (changed.rows.length) {
                const changedIds = changed.rows.map((x) => x.message_id);
                const reMap = await getReactionsForMessages(changedIds, userId);
                reactionUpdates = changedIds.map((id) => ({ messageId: id, reactions: reMap[id] || [] }));
            }
        }

        res.json({ messages, updates, reactionUpdates });
    } catch (err) {
        console.error('Brainstorm poll error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/brainstorm/:problem/messages — post a brainstorm message.
router.post('/:problem/messages', requireUser, brainstormPostLimiter, async (req, res) => {
    const client = await pool.connect();
    try {
        const problem = req.params.problem;
        const userId = req.session.userId;
        const content = (req.body.content || '').trim().slice(0, MAX_CONTENT_LENGTH);
        const language = langTag(req.body.lang, req.session);
        const parentId = parseInt(req.body.parentId) || null;

        if (!content) {
            client.release();
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        await client.query('BEGIN');

        // Validate parent (if any) belongs to the same room.
        if (parentId) {
            const parent = await client.query(
                'SELECT user_id, problem_name FROM brainstorm_messages WHERE id = $1 AND is_deleted = false',
                [parentId]
            );
            if (parent.rows.length === 0 || parent.rows[0].problem_name !== problem) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(400).json({ error: 'Invalid parent message' });
            }
        }

        const inserted = await client.query(
            `INSERT INTO brainstorm_messages (problem_name, language, user_id, content, parent_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, created_at, updated_at`,
            [problem, language, userId, content, parentId]
        );
        const messageId = inserted.rows[0].id;

        // Persist structured cross-links for the wiki graph.
        const linkRows = parseProblemLinks(content);
        for (const link of linkRows) {
            await client.query(
                `INSERT INTO brainstorm_message_links (message_id, target_problem_name, link_text)
                 VALUES ($1, $2, $3)`,
                [messageId, link.targetProblemName, link.linkText.slice(0, 255)]
            );
        }

        await client.query('COMMIT');
        client.release();
        invalidateTop(problem);

        // Notify the parent author of a reply (mirrors the comment system).
        if (parentId) {
            try {
                const parent = await pool.query(
                    'SELECT user_id FROM brainstorm_messages WHERE id = $1',
                    [parentId]
                );
                const recipientId = parent.rows[0]?.user_id;
                if (recipientId && recipientId !== userId) {
                    await notifications.createNotification(
                        recipientId,
                        'brainstorm_reply',
                        `${req.session.username} replied in the Brainstorm Room for ${problem}`,
                        content.length > 80 ? content.slice(0, 80) + '...' : content,
                        `/${language}/${problem}/brainstorm`,
                        userId
                    );
                }
            } catch (notifErr) {
                console.error('Brainstorm reply notification error:', notifErr);
            }
        }

        // Return the full serialized message so the client can append it directly.
        const full = await pool.query(
            `SELECT m.id, m.content, m.language, m.parent_id, m.is_pinned, m.reaction_count,
                    m.created_at, m.updated_at, m.user_id,
                    u.username, u.full_name, u.profile_picture, u.country_location
             FROM brainstorm_messages m JOIN users u ON u.id = m.user_id
             WHERE m.id = $1`,
            [messageId]
        );
        const links = await getLinksForMessages([messageId]);
        res.status(201).json({
            ok: true,
            message: serializeMessage(full.rows[0], {}, links, userId),
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        client.release();
        console.error('Brainstorm post error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/brainstorm/messages/:id/react — toggle a reaction.
router.post('/messages/:id(\\d+)/react', requireUser, async (req, res) => {
    try {
        const userId = req.session.userId;
        const messageId = parseInt(req.params.id);
        const { emoji } = req.body;

        if (!emoji || !ALLOWED_REACTIONS.includes(emoji)) {
            return res.status(400).json({ error: 'Invalid reaction' });
        }

        const msg = await pool.query(
            'SELECT problem_name FROM brainstorm_messages WHERE id = $1 AND is_deleted = false',
            [messageId]
        );
        if (msg.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found' });
        }
        const problem = msg.rows[0].problem_name;

        const existing = await pool.query(
            'SELECT id FROM brainstorm_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
            [messageId, userId, emoji]
        );
        if (existing.rows.length > 0) {
            await pool.query('DELETE FROM brainstorm_reactions WHERE id = $1', [existing.rows[0].id]);
        } else {
            await pool.query(
                'INSERT INTO brainstorm_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
                [messageId, userId, emoji]
            );
        }

        // Keep the denormalized popularity counter in sync (drives the hot top-N).
        await pool.query(
            `UPDATE brainstorm_messages
             SET reaction_count = (SELECT COUNT(*) FROM brainstorm_reactions WHERE message_id = $1)
             WHERE id = $1`,
            [messageId]
        );
        invalidateTop(problem);

        const reMap = await getReactionsForMessages([messageId], userId);
        res.json({ ok: true, reactions: reMap[messageId] || [] });
    } catch (err) {
        console.error('Brainstorm react error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/brainstorm/messages/:id/pin — toggle highlight (admins + verified users).
router.post('/messages/:id(\\d+)/pin', requireUser, async (req, res) => {
    try {
        if (!(await canCurate(req))) {
            return res.status(403).json({ error: 'Not allowed to pin' });
        }
        const messageId = parseInt(req.params.id);
        const r = await pool.query(
            `UPDATE brainstorm_messages
             SET is_pinned = NOT is_pinned, updated_at = NOW()
             WHERE id = $1 AND is_deleted = false
             RETURNING problem_name, is_pinned`,
            [messageId]
        );
        if (r.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found' });
        }
        invalidateTop(r.rows[0].problem_name);
        res.json({ ok: true, isPinned: r.rows[0].is_pinned });
    } catch (err) {
        console.error('Brainstorm pin error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/brainstorm/messages/:id — edit own message within the edit window.
router.put('/messages/:id(\\d+)', requireUser, async (req, res) => {
    const client = await pool.connect();
    try {
        const userId = req.session.userId;
        const messageId = parseInt(req.params.id);
        const content = (req.body.content || '').trim().slice(0, MAX_CONTENT_LENGTH);
        if (!content) {
            client.release();
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        const existing = await client.query(
            'SELECT user_id, problem_name, created_at FROM brainstorm_messages WHERE id = $1 AND is_deleted = false',
            [messageId]
        );
        if (existing.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: 'Message not found' });
        }
        const row = existing.rows[0];
        if (row.user_id !== userId) {
            client.release();
            return res.status(403).json({ error: 'Not your message' });
        }
        const hours = (Date.now() - new Date(row.created_at).getTime()) / 36e5;
        if (hours > EDIT_WINDOW_HOURS) {
            client.release();
            return res.status(403).json({ error: 'Edit window has closed' });
        }

        await client.query('BEGIN');
        await client.query(
            'UPDATE brainstorm_messages SET content = $1, updated_at = NOW() WHERE id = $2',
            [content, messageId]
        );
        // Re-derive structured links from the new content.
        await client.query('DELETE FROM brainstorm_message_links WHERE message_id = $1', [messageId]);
        for (const link of parseProblemLinks(content)) {
            await client.query(
                `INSERT INTO brainstorm_message_links (message_id, target_problem_name, link_text)
                 VALUES ($1, $2, $3)`,
                [messageId, link.targetProblemName, link.linkText.slice(0, 255)]
            );
        }
        await client.query('COMMIT');
        client.release();
        invalidateTop(row.problem_name);

        res.json({ ok: true });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        client.release();
        console.error('Brainstorm edit error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/brainstorm/messages/:id — soft delete (owner within window, or admin).
router.delete('/messages/:id(\\d+)', requireUser, async (req, res) => {
    try {
        const userId = req.session.userId;
        const messageId = parseInt(req.params.id);

        const existing = await pool.query(
            'SELECT user_id, problem_name, created_at FROM brainstorm_messages WHERE id = $1 AND is_deleted = false',
            [messageId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found' });
        }
        const row = existing.rows[0];
        const isOwner = row.user_id === userId;
        const hours = (Date.now() - new Date(row.created_at).getTime()) / 36e5;
        const ownerMayDelete = isOwner && hours <= EDIT_WINDOW_HOURS;

        if (!ownerMayDelete && !isAdmin(req)) {
            return res.status(403).json({ error: 'Not allowed to delete' });
        }

        await pool.query(
            'UPDATE brainstorm_messages SET is_deleted = true, updated_at = NOW() WHERE id = $1',
            [messageId]
        );
        invalidateTop(row.problem_name);
        res.json({ ok: true });
    } catch (err) {
        console.error('Brainstorm delete error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Serialize a joined message row for the client. Pin permission is a page-level
// capability (passed separately as isCurator), not a per-message flag, so it is
// intentionally absent here.
function serializeMessage(row, reactions, links, userId) {
    const isOwn = userId && row.user_id === userId;
    const hours = (Date.now() - new Date(row.created_at).getTime()) / 36e5;
    return {
        id: row.id,
        content: row.content,
        language: row.language,
        parentId: row.parent_id,
        isPinned: row.is_pinned,
        reactionCount: row.reaction_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        edited: row.updated_at && row.created_at &&
            new Date(row.updated_at).getTime() - new Date(row.created_at).getTime() > 1000,
        author: mapAuthor(row),
        reactions: (reactions && reactions[row.id]) || [],
        links: (links && links[row.id]) || [],
        isOwn: !!isOwn,
        isEditable: !!isOwn && hours <= EDIT_WINDOW_HOURS,
    };
}

/**
 * Render the full Brainstorm Room page for one problem.
 * The room is unified per problem (no language scoping); `lang` only controls the
 * surrounding UI chrome. Works for unsolved problems too (no solution file needed).
 */
async function renderRoom(req, res) {
    const { lang, name } = req.params;
    i18n.setLocale(res, lang);

    const breadcrumb = getProblemBreadcrumbParts(name, lang);
    if (!breadcrumb) {
        return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }

    const userId = req.session.userId || null;
    let page = { messages: [], hasMore: false, oldestId: null, newestId: null };
    let isCurator = false;
    try {
        [page, isCurator] = await Promise.all([
            fetchRoomMessages(name, { limit: 40, userId }),
            canCurate(req),
        ]);
    } catch (err) {
        console.error('Brainstorm room load error:', err);
    }

    // Server sends messages newest-first; the room displays oldest→newest.
    const initialMessages = page.messages.slice().reverse();

    res.render('brainstorm_room', {
        __: i18n.__,
        lang,
        name,
        breadcrumb,
        username: req.session.username || null,
        isCurator,
        reactions: ALLOWED_REACTIONS,
        initialMessages,
        hasMore: page.hasMore,
        oldestId: page.oldestId,
        newestId: page.newestId,
        title: (lang === 'ru' ? 'Комната мозгового штурма' : 'Brainstorm Room') + ' · ' + name,
    });
}

module.exports = {
    router,
    renderRoom,
    getTopBrainstormMessages,
    getRelatedBrainstormLinks,
    getUserDisplayMode,
    formatBrainstormHtml,
    invalidateTop,
    // exported for unit tests:
    parseProblemLinks,
    ALLOWED_REACTIONS,
};
