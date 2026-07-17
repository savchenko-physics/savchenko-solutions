const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');
const notifications = require('./notifications');
const { linkifyMessageContent } = require('./utils');
const { getOnlineUsernames } = require('./lib/presence');

const msgImageDir = path.join(__dirname, 'img', 'messages');
fs.mkdirSync(msgImageDir, { recursive: true });

const msgImageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, msgImageDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    },
});

// Images render inline; everything else on this allow-list renders as a
// downloadable file card. Deliberately excludes html/htm/svg/js/xml so an
// uploaded file can never be served as executable markup from our origin.
const MSG_IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
const MSG_FILE_EXT = /\.(jpe?g|png|gif|webp|pdf|txt|md|tex|csv|json|rtf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|zip|rar|7z)$/i;
const MSG_MAX_BYTES = 25 * 1024 * 1024;

const msgFileUpload = multer({
    storage: msgImageStorage,
    limits: { fileSize: MSG_MAX_BYTES },
    fileFilter: (req, file, cb) => {
        if (MSG_FILE_EXT.test(path.extname(file.originalname))) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed'));
        }
    },
});

// Wrap the upload so a rejected/oversized file returns a clean 400 instead of
// bubbling to the generic error handler (which would 500).
function msgUploadMiddleware(req, res, next) {
    msgFileUpload.single('file')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'File too large (max 25 MB)'
                : (err.message || 'Upload failed');
            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.status(400).json({ error: msg });
            }
            return res.status(400).send(msg);
        }
        next();
    });
}

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const GROUP_PALETTES = [
    ['#e74c3c', '#c0392b', '#f39c12', '#e67e22'],
    ['#3498db', '#2980b9', '#1abc9c', '#16a085'],
    ['#9b59b6', '#8e44ad', '#e74c3c', '#c0392b'],
    ['#2ecc71', '#27ae60', '#3498db', '#2980b9'],
    ['#e67e22', '#d35400', '#f1c40f', '#f39c12'],
    ['#1abc9c', '#16a085', '#9b59b6', '#8e44ad'],
    ['#34495e', '#2c3e50', '#3498db', '#2980b9'],
];

function groupAvatarSVG(convId, name, size) {
    const s = size || 44;
    const seed = convId % 7;
    const pal = GROUP_PALETTES[seed];
    const pattern = convId % 4;
    const letter = (name || 'G').charAt(0).toUpperCase();
    let bg = '';

    if (pattern === 0) {
        bg = `<defs><linearGradient id="gg${convId}" x1="0%" y1="0%" x2="100%" y2="100%">` +
             `<stop offset="0%" stop-color="${pal[0]}"/>` +
             `<stop offset="100%" stop-color="${pal[1]}"/>` +
             `</linearGradient></defs>` +
             `<rect width="${s}" height="${s}" fill="url(#gg${convId})"/>` +
             `<circle cx="${s*0.7}" cy="${s*0.3}" r="${s*0.35}" fill="${pal[2]}" opacity="0.15"/>` +
             `<circle cx="${s*0.25}" cy="${s*0.75}" r="${s*0.25}" fill="${pal[3]}" opacity="0.12"/>` +
             `<line x1="${s*0.1}" y1="${s*0.6}" x2="${s*0.5}" y2="${s*0.2}" stroke="#fff" stroke-width="1" opacity="0.2"/>` +
             `<line x1="${s*0.5}" y1="${s*0.2}" x2="${s*0.9}" y2="${s*0.5}" stroke="#fff" stroke-width="1" opacity="0.2"/>`;
    } else if (pattern === 1) {
        bg = `<defs><linearGradient id="gg${convId}" x1="0%" y1="100%" x2="100%" y2="0%">` +
             `<stop offset="0%" stop-color="${pal[2]}"/>` +
             `<stop offset="100%" stop-color="${pal[3]}"/>` +
             `</linearGradient></defs>` +
             `<rect width="${s}" height="${s}" fill="url(#gg${convId})"/>` +
             `<ellipse cx="${s*0.5}" cy="${s*0.5}" rx="${s*0.38}" ry="${s*0.18}" fill="none" stroke="#fff" stroke-width="1.2" opacity="0.25" transform="rotate(-30 ${s*0.5} ${s*0.5})"/>` +
             `<ellipse cx="${s*0.5}" cy="${s*0.5}" rx="${s*0.38}" ry="${s*0.18}" fill="none" stroke="#fff" stroke-width="1.2" opacity="0.25" transform="rotate(30 ${s*0.5} ${s*0.5})"/>` +
             `<circle cx="${s*0.5}" cy="${s*0.5}" r="${s*0.06}" fill="#fff" opacity="0.35"/>`;
    } else if (pattern === 2) {
        bg = `<defs><linearGradient id="gg${convId}" x1="0%" y1="0%" x2="100%" y2="100%">` +
             `<stop offset="0%" stop-color="${pal[1]}"/>` +
             `<stop offset="50%" stop-color="${pal[0]}"/>` +
             `<stop offset="100%" stop-color="${pal[3]}"/>` +
             `</linearGradient></defs>` +
             `<rect width="${s}" height="${s}" fill="url(#gg${convId})"/>` +
             `<path d="M${s*0.1} ${s*0.7} Q${s*0.3} ${s*0.2} ${s*0.5} ${s*0.5} T${s*0.9} ${s*0.3}" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.2"/>` +
             `<path d="M${s*0.05} ${s*0.85} Q${s*0.3} ${s*0.35} ${s*0.5} ${s*0.65} T${s*0.95} ${s*0.15}" fill="none" stroke="#fff" stroke-width="1" opacity="0.15"/>` +
             `<circle cx="${s*0.2}" cy="${s*0.3}" r="${s*0.04}" fill="#fff" opacity="0.3"/>` +
             `<circle cx="${s*0.75}" cy="${s*0.65}" r="${s*0.03}" fill="#fff" opacity="0.3"/>`;
    } else {
        bg = `<defs><linearGradient id="gg${convId}" x1="100%" y1="0%" x2="0%" y2="100%">` +
             `<stop offset="0%" stop-color="${pal[0]}"/>` +
             `<stop offset="100%" stop-color="${pal[2]}"/>` +
             `</linearGradient></defs>` +
             `<rect width="${s}" height="${s}" fill="url(#gg${convId})"/>`;
        for (let i = 0; i < 3; i++) {
            const y = s * (0.25 + i * 0.25);
            bg += `<line x1="0" y1="${y}" x2="${s}" y2="${y - s*0.15}" stroke="#fff" stroke-width="0.8" opacity="0.15"/>`;
        }
        bg += `<polygon points="${s*0.5},${s*0.18} ${s*0.62},${s*0.42} ${s*0.38},${s*0.42}" fill="none" stroke="#fff" stroke-width="1.2" opacity="0.25"/>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">` +
           bg +
           `<text x="50%" y="52%" text-anchor="middle" dominant-baseline="central" ` +
           `fill="#fff" font-family="Inter,-apple-system,sans-serif" font-weight="600" ` +
           `font-size="${Math.round(s*0.38)}" opacity="0.9">${letter}</text></svg>`;
}

// Short, plain-text preview of a message being quoted in a reply.
function buildReplyPreview(content, imageUrl, fileName, deleted, lang) {
    if (deleted) return lang === 'ru' ? 'Удалённое сообщение' : 'Deleted message';
    const t = (content || '').trim();
    if (t) return t.length > 80 ? t.substring(0, 80) + '…' : t;
    if (fileName) return fileName;
    if (imageUrl) return lang === 'ru' ? 'Фото' : 'Photo';
    return '';
}

// Attach a `reply` object to each message row that quotes another message.
function attachReplyInfo(rows, userId, lang) {
    for (const m of rows) {
        if (m.reply_to_id) {
            m.reply = {
                id: m.reply_to_id,
                sender: m.reply_sender_username || (lang === 'ru' ? 'Пользователь' : 'User'),
                preview: buildReplyPreview(m.reply_content, m.reply_image, m.reply_file, m.reply_deleted, lang),
                mine: m.reply_sender_id === userId,
                isImage: !m.reply_content && !!m.reply_image && !m.reply_deleted,
                isFile: !m.reply_content && !!m.reply_file && !m.reply_deleted,
            };
        }
    }
}

async function getReactionsForMessages(messageIds, userId) {
    if (!messageIds.length) return {};
    const result = await pool.query(
        `SELECT message_id, emoji, COUNT(*)::int AS count,
                BOOL_OR(user_id = $2) AS me
         FROM message_reactions
         WHERE message_id = ANY($1)
         GROUP BY message_id, emoji
         ORDER BY message_id, MIN(created_at)`,
        [messageIds, userId]
    );
    const map = {};
    for (const r of result.rows) {
        if (!map[r.message_id]) map[r.message_id] = [];
        map[r.message_id].push({ emoji: r.emoji, count: r.count, me: r.me });
    }
    return map;
}

function checkAuth(req, res, next) {
    if (!req.session.userId) {
        return res.redirect(`/${req.session.lang || 'en'}/login`);
    }
    next();
}

router.use(checkAuth);

// Find or create a 1:1 conversation between two users
async function findOrCreateDM(userId1, userId2) {
    const existing = await pool.query(
        `SELECT c.id FROM conversations c
         JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = $1
         JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = $2
         WHERE c.is_group = FALSE
         LIMIT 1`,
        [userId1, userId2]
    );
    if (existing.rows.length > 0) {
        return existing.rows[0].id;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const conv = await client.query(
            `INSERT INTO conversations (is_group, created_by) VALUES (FALSE, $1) RETURNING id`,
            [userId1]
        );
        const convId = conv.rows[0].id;
        await client.query(
            `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
            [convId, userId1, userId2]
        );
        await client.query('COMMIT');
        return convId;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Find (or lazily create) a user's private "Saved Messages" self-chat. It is a
// non-group conversation with a single member (the user) marked via
// saved_for_user_id, so it can never be confused with a DM whose other member
// was later deleted.
async function findOrCreateSavedMessages(userId) {
    const existing = await pool.query(
        `SELECT id FROM conversations WHERE saved_for_user_id = $1 LIMIT 1`,
        [userId]
    );
    if (existing.rows.length > 0) {
        return existing.rows[0].id;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const conv = await client.query(
            `INSERT INTO conversations (is_group, created_by, saved_for_user_id)
             VALUES (FALSE, $1, $1) RETURNING id`,
            [userId]
        );
        const convId = conv.rows[0].id;
        await client.query(
            `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)`,
            [convId, userId]
        );
        await client.query('COMMIT');
        return convId;
    } catch (err) {
        await client.query('ROLLBACK');
        // A concurrent request may have created it first — fall back to a lookup.
        const retry = await pool.query(
            `SELECT id FROM conversations WHERE saved_for_user_id = $1 LIMIT 1`,
            [userId]
        );
        if (retry.rows.length > 0) return retry.rows[0].id;
        throw err;
    } finally {
        client.release();
    }
}

// Build the sidebar conversation list (ordered by most recent activity) for a
// user. Shared by the inbox, a single-conversation view, and the AJAX
// auto-update endpoint so all three stay in sync.
async function buildConversationList(userId, lang = 'en') {
    const conversations = await pool.query(
        `SELECT c.id, c.title, c.is_group, c.last_message_at, c.saved_for_user_id,
                m.content AS last_message_content,
                m.image_url AS last_message_image,
                m.file_name AS last_message_file,
                m.sender_id AS last_message_sender_id,
                sender.username AS last_message_sender,
                cm.last_read_at,
                (SELECT COUNT(*) FROM messages mx
                 WHERE mx.conversation_id = c.id AND mx.created_at > cm.last_read_at AND mx.sender_id != $1
                )::int AS unread_count
         FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
         LEFT JOIN LATERAL (
             SELECT content, sender_id, image_url, file_name FROM messages
             WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
         ) m ON TRUE
         LEFT JOIN users sender ON sender.id = m.sender_id
         WHERE EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id)
         ORDER BY c.last_message_at DESC`,
        [userId]
    );

    // For each 1:1 conversation, get the other user's info
    const convIds = conversations.rows.filter(c => !c.is_group).map(c => c.id);
    let memberMap = {};
    if (convIds.length > 0) {
        const members = await pool.query(
            `SELECT cm.conversation_id, u.id, u.username, u.full_name, u.profile_picture
             FROM conversation_members cm
             JOIN users u ON u.id = cm.user_id
             WHERE cm.conversation_id = ANY($1) AND cm.user_id != $2`,
            [convIds, userId]
        );
        for (const m of members.rows) {
            memberMap[m.conversation_id] = m;
        }
    }

    // For group conversations, get member counts
    const groupIds = conversations.rows.filter(c => c.is_group).map(c => c.id);
    let groupMemberCountMap = {};
    if (groupIds.length > 0) {
        const counts = await pool.query(
            `SELECT conversation_id, COUNT(*)::int AS member_count
             FROM conversation_members
             WHERE conversation_id = ANY($1)
             GROUP BY conversation_id`,
            [groupIds]
        );
        for (const r of counts.rows) {
            groupMemberCountMap[r.conversation_id] = r.member_count;
        }
    }

    const convList = conversations.rows.map(c => {
        const isSaved = c.saved_for_user_id === userId;
        const other = memberMap[c.id] || null;
        return {
            ...c,
            isSaved,
            otherUser: isSaved ? null : other,
            memberCount: groupMemberCountMap[c.id] || 0,
            displayName: isSaved
                ? (lang === 'ru' ? 'Избранное' : 'Saved Messages')
                : (c.is_group
                    ? (c.title || 'Group')
                    : (other ? (other.full_name || other.username) : 'Deleted User')),
            displayPicture: (isSaved || c.is_group)
                ? null
                : (other ? other.profile_picture : null),
        };
    });

    return { rows: conversations.rows, memberMap, groupMemberCountMap, convList };
}

// GET /messages — inbox (conversation list) or a specific conversation
router.get('/', async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = req.session.lang || 'en';

        const { convList } = await buildConversationList(userId, lang);

        // Attach online presence for the other user in each 1:1 conversation
        const presenceNames = convList
            .filter(c => !c.is_group && c.otherUser && c.otherUser.username)
            .map(c => c.otherUser.username);
        const online = await getOnlineUsernames(pool, presenceNames);
        for (const c of convList) {
            if (!c.is_group && c.otherUser && c.otherUser.username) {
                c.isOnline = online.has(c.otherUser.username);
            }
        }

        res.render('messages', {
            __: req.__,
            lang,
            conversations: convList,
            activeConversation: null,
            messages: [],
            userId,
            username: req.session.username,
            isAdmin: false,
            membersList: [],
            groupAvatarSVG,
        });
    } catch (err) {
        console.error('Messages inbox error:', err);
        res.status(500).send('Internal server error');
    }
});

// GET /messages/saved — open (creating on first use) the user's private
// Saved Messages self-chat, then redirect to the normal conversation view.
router.get('/saved', async (req, res) => {
    try {
        const convId = await findOrCreateSavedMessages(req.session.userId);
        res.redirect(`/messages/${convId}`);
    } catch (err) {
        console.error('Saved messages error:', err);
        res.status(500).send('Internal server error');
    }
});

// GET /messages/:id — view a specific conversation
router.get('/:id(\\d+)', async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = req.session.lang || 'en';
        const convId = parseInt(req.params.id);

        // Check membership
        const membership = await pool.query(
            `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        if (membership.rows.length === 0) {
            return res.redirect('/messages');
        }

        // Mark as read
        await pool.query(
            `UPDATE conversation_members SET last_read_at = NOW()
             WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );

        // Get conversation list (same as inbox)
        const { rows: convRows, memberMap, convList } = await buildConversationList(userId, lang);

        // Active conversation: get info and messages
        let activeConvRow = convRows.find(c => c.id === convId);
        let activeOther = memberMap[convId] || null;

        // If the active conversation is new (no messages), it won't be in the sidebar list — fetch it separately
        if (!activeConvRow) {
            const convResult = await pool.query(
                `SELECT id, title, is_group, last_message_at, saved_for_user_id FROM conversations WHERE id = $1`,
                [convId]
            );
            if (convResult.rows.length > 0) {
                activeConvRow = convResult.rows[0];
            }
        }
        if (!activeOther && activeConvRow && !activeConvRow.is_group) {
            const otherResult = await pool.query(
                `SELECT u.id, u.username, u.full_name, u.profile_picture
                 FROM conversation_members cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.conversation_id = $1 AND cm.user_id != $2
                 LIMIT 1`,
                [convId, userId]
            );
            if (otherResult.rows.length > 0) {
                activeOther = otherResult.rows[0];
            }
        }

        let activeMemberCount = 0;
        let isAdmin = false;
        let membersList = [];
        if (activeConvRow && activeConvRow.is_group) {
            const membersResult = await pool.query(
                `SELECT u.id, u.username, u.full_name, u.profile_picture, cm.role
                 FROM conversation_members cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.conversation_id = $1
                 ORDER BY cm.role DESC, cm.joined_at ASC`,
                [convId]
            );
            membersList = membersResult.rows;
            activeMemberCount = membersList.length;
            const myMembership = membersList.find(m => m.id === userId);
            if (myMembership && myMembership.role === 'admin') {
                isAdmin = true;
            }
        }

        const activeIsSaved = activeConvRow ? activeConvRow.saved_for_user_id === userId : false;
        const activeConversation = activeConvRow ? {
            id: convId,
            is_group: activeConvRow.is_group,
            isSaved: activeIsSaved,
            title: activeConvRow.title,
            displayName: activeIsSaved
                ? (lang === 'ru' ? 'Избранное' : 'Saved Messages')
                : (activeConvRow.is_group
                    ? (activeConvRow.title || 'Group')
                    : (activeOther ? (activeOther.full_name || activeOther.username) : 'Deleted User')),
            displayPicture: (activeIsSaved || activeConvRow.is_group) ? null : (activeOther ? activeOther.profile_picture : null),
            otherUser: activeIsSaved ? null : activeOther,
            memberCount: activeMemberCount,
        } : null;

        const messagesResult = await pool.query(
            `SELECT m.id, m.content, m.created_at, m.sender_id, m.edited_at, m.deleted_at, m.image_url,
                    m.file_url, m.file_name, m.file_size,
                    u.username AS sender_username, u.profile_picture AS sender_picture,
                    cm.role AS sender_role,
                    m.reply_to_id,
                    rm.content AS reply_content, rm.image_url AS reply_image, rm.file_name AS reply_file,
                    rm.deleted_at AS reply_deleted, rm.sender_id AS reply_sender_id,
                    ru.username AS reply_sender_username
             FROM messages m
             LEFT JOIN users u ON u.id = m.sender_id
             LEFT JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = m.sender_id
             LEFT JOIN messages rm ON rm.id = m.reply_to_id
             LEFT JOIN users ru ON ru.id = rm.sender_id
             WHERE m.conversation_id = $1
             ORDER BY m.created_at ASC`,
            [convId]
        );

        const msgIds = messagesResult.rows.map(m => m.id);
        const reactionsMap = await getReactionsForMessages(msgIds, userId);
        attachReplyInfo(messagesResult.rows, userId, lang);
        for (const m of messagesResult.rows) {
            m.reactions = reactionsMap[m.id] || [];
            if (m.content) {
                m.contentHtml = linkifyMessageContent(m.content, lang);
            }
        }

        // Force unread_count to 0 for active conversation in the list
        let updatedConvList = convList.map(c => {
            if (c.id === convId) return { ...c, unread_count: 0 };
            return c;
        });

        // If the active conversation is new (no messages), add it to the sidebar
        if (activeConversation && !updatedConvList.find(c => c.id === convId)) {
            updatedConvList.unshift({
                id: convId,
                title: activeConvRow.title,
                is_group: activeConvRow.is_group,
                last_message_at: activeConvRow.last_message_at,
                last_message_content: null,
                last_message_sender: null,
                unread_count: 0,
                otherUser: activeOther,
                memberCount: activeMemberCount,
                displayName: activeConversation.displayName,
                displayPicture: activeConversation.displayPicture,
            });
        }

        // Collect all OTHER usernames shown in the UI and resolve online status
        // in a single fresh presence lookup (privacy-aware, safe pre-migration).
        const presenceNames = new Set();
        for (const c of updatedConvList) {
            if (!c.is_group && c.otherUser && c.otherUser.username) presenceNames.add(c.otherUser.username);
        }
        if (activeConversation && activeConversation.otherUser && activeConversation.otherUser.username) {
            presenceNames.add(activeConversation.otherUser.username);
        }
        for (const mem of membersList) {
            if (mem.id !== userId && mem.username) presenceNames.add(mem.username);
        }
        for (const m of messagesResult.rows) {
            if (m.sender_id !== userId && m.sender_username) presenceNames.add(m.sender_username);
        }
        const online = await getOnlineUsernames(pool, [...presenceNames]);
        for (const c of updatedConvList) {
            if (!c.is_group && c.otherUser && c.otherUser.username) {
                c.isOnline = online.has(c.otherUser.username);
            }
        }
        if (activeConversation && activeConversation.otherUser && activeConversation.otherUser.username) {
            activeConversation.isOnline = online.has(activeConversation.otherUser.username);
        }
        for (const mem of membersList) {
            mem.isOnline = mem.id !== userId && online.has(mem.username);
        }
        for (const m of messagesResult.rows) {
            m.senderOnline = m.sender_id !== userId && !!m.sender_username && online.has(m.sender_username);
        }

        res.render('messages', {
            __: req.__,
            lang,
            conversations: updatedConvList,
            activeConversation,
            messages: messagesResult.rows,
            userId,
            username: req.session.username,
            isAdmin,
            membersList,
            groupAvatarSVG,
        });
    } catch (err) {
        console.error('Messages conversation error:', err);
        res.status(500).send('Internal server error');
    }
});

// POST /messages/new — start a new conversation (or find existing DM)
router.post('/new', async (req, res) => {
    try {
        const userId = req.session.userId;
        const { recipientId, recipientIds, title } = req.body;

        if (recipientIds && recipientIds.length > 1) {
            // Group conversation
            const userIds = [userId, ...recipientIds.map(id => parseInt(id))];
            const uniqueIds = [...new Set(userIds)];
            if (uniqueIds.length < 2) {
                return res.status(400).json({ error: 'Need at least 2 members' });
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const conv = await client.query(
                    `INSERT INTO conversations (is_group, title, created_by) VALUES (TRUE, $1, $2) RETURNING id`,
                    [title || null, userId]
                );
                const convId = conv.rows[0].id;
                const values = uniqueIds.map((uid, i) => `($1, $${i + 2})`).join(', ');
                await client.query(
                    `INSERT INTO conversation_members (conversation_id, user_id) VALUES ${values}`,
                    [convId, ...uniqueIds]
                );
                await client.query('COMMIT');
                return res.redirect(`/messages/${convId}`);
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }

        // 1:1 conversation
        const targetId = parseInt(recipientId);
        if (!targetId || targetId === userId) {
            return res.redirect('/messages');
        }

        const targetUser = await pool.query('SELECT id FROM users WHERE id = $1', [targetId]);
        if (targetUser.rows.length === 0) {
            return res.redirect('/messages');
        }

        const convId = await findOrCreateDM(userId, targetId);
        res.redirect(`/messages/${convId}`);
    } catch (err) {
        console.error('New conversation error:', err);
        res.status(500).send('Internal server error');
    }
});

// POST /messages/:id/send — send a message (with optional image or file)
router.post('/:id(\\d+)/send', msgUploadMiddleware, async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = req.session.lang || 'en';
        const convId = parseInt(req.params.id);
        const content = (req.body.content || '').trim().substring(0, 5000);

        // An uploaded attachment is an inline image or a downloadable file card.
        let imageUrl = null, fileUrl = null, fileName = null, fileSize = null;
        if (req.file) {
            const url = '/img/messages/' + req.file.filename;
            if (MSG_IMAGE_EXT.test(path.extname(req.file.originalname))) {
                imageUrl = url;
            } else {
                fileUrl = url;
                fileName = (req.file.originalname || 'file').substring(0, 255);
                fileSize = req.file.size;
            }
        }

        if (!content && !imageUrl && !fileUrl) {
            return res.redirect(`/messages/${convId}`);
        }

        // Check membership
        const membership = await pool.query(
            `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        if (membership.rows.length === 0) {
            return res.status(403).send('Not a member');
        }

        // Optional reply target — only honored if it's a message in this conversation.
        let replyToId = parseInt(req.body.reply_to_id) || null;
        let replyInfo = null;
        if (replyToId) {
            const r = await pool.query(
                `SELECT m.id, m.content, m.image_url, m.file_name, m.deleted_at, m.sender_id, u.username AS sender_username
                 FROM messages m LEFT JOIN users u ON u.id = m.sender_id
                 WHERE m.id = $1 AND m.conversation_id = $2`,
                [replyToId, convId]
            );
            if (r.rows.length === 0) {
                replyToId = null;
            } else {
                const rr = r.rows[0];
                replyInfo = {
                    id: rr.id,
                    sender: rr.sender_username || (lang === 'ru' ? 'Пользователь' : 'User'),
                    preview: buildReplyPreview(rr.content, rr.image_url, rr.file_name, rr.deleted_at, lang),
                    mine: rr.sender_id === userId,
                    isImage: !rr.content && !!rr.image_url && !rr.deleted_at,
                    isFile: !rr.content && !!rr.file_name && !rr.deleted_at,
                };
            }
        }

        // Insert message and update conversation timestamp
        const inserted = await pool.query(
            `INSERT INTO messages (conversation_id, sender_id, content, image_url, reply_to_id, file_url, file_name, file_size)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
            [convId, userId, content, imageUrl, replyToId, fileUrl, fileName, fileSize]
        );
        await pool.query(
            `UPDATE conversations SET last_message_at = NOW() WHERE id = $1`,
            [convId]
        );

        // Update sender's read timestamp
        await pool.query(
            `UPDATE conversation_members SET last_read_at = NOW()
             WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );

        // Notify other members
        let preview;
        if (fileUrl) preview = fileName || '[File]';
        else if (imageUrl && !content) preview = '[Image]';
        else preview = content.length > 80 ? content.substring(0, 80) + '...' : content;
        await notifications.createMessageNotifications(
            convId,
            userId,
            `New message from ${req.session.username}`,
            preview,
            `/messages/${convId}`
        );

        // If AJAX request, return JSON
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            const msg = inserted.rows[0];
            return res.json({
                ok: true, id: msg.id, created_at: msg.created_at,
                image_url: imageUrl, file_url: fileUrl, file_name: fileName, file_size: fileSize,
            });
        }
        res.redirect(`/messages/${convId}`);
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).send('Internal server error');
    }
});

// PUT /messages/:msgId/edit — edit a message (within 24h, sender only)
router.put('/:msgId(\\d+)/edit', async (req, res) => {
    try {
        const userId = req.session.userId;
        const msgId = parseInt(req.params.msgId);
        const { content } = req.body;

        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        const msg = await pool.query(
            `SELECT id, sender_id, created_at, deleted_at FROM messages WHERE id = $1`,
            [msgId]
        );
        if (msg.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found' });
        }
        const m = msg.rows[0];
        if (m.sender_id !== userId) {
            return res.status(403).json({ error: 'Not your message' });
        }
        if (m.deleted_at) {
            return res.status(400).json({ error: 'Message was deleted' });
        }
        const ageMs = Date.now() - new Date(m.created_at).getTime();
        if (ageMs > 24 * 60 * 60 * 1000) {
            return res.status(403).json({ error: 'Can only edit messages within 24 hours' });
        }

        const trimmed = content.trim().substring(0, 5000);
        await pool.query(
            `UPDATE messages SET content = $1, edited_at = NOW() WHERE id = $2`,
            [trimmed, msgId]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('Edit message error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /messages/:msgId/delete — delete a message (within 24h for sender, anytime for admin)
router.delete('/:msgId(\\d+)/delete', async (req, res) => {
    try {
        const userId = req.session.userId;
        const msgId = parseInt(req.params.msgId);

        const msg = await pool.query(
            `SELECT m.id, m.sender_id, m.conversation_id, m.created_at, m.deleted_at, m.content,
                    u.username AS sender_username, c.title AS conv_title
             FROM messages m
             LEFT JOIN users u ON u.id = m.sender_id
             LEFT JOIN conversations c ON c.id = m.conversation_id
             WHERE m.id = $1`,
            [msgId]
        );
        if (msg.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found' });
        }
        const m = msg.rows[0];
        if (m.deleted_at) {
            return res.status(400).json({ error: 'Already deleted' });
        }

        const roleResult = await pool.query(
            `SELECT user_id, role FROM conversation_members
             WHERE conversation_id = $1 AND user_id IN ($2, $3)`,
            [m.conversation_id, userId, m.sender_id]
        );
        const userRole = (roleResult.rows.find(r => r.user_id === userId) || {}).role || 'member';
        const senderRole = (roleResult.rows.find(r => r.user_id === m.sender_id) || {}).role || 'member';
        const isSender = m.sender_id === userId;

        if (senderRole === 'admin' && !isSender) {
            return res.status(403).json({ error: 'Cannot delete moderator messages' });
        }
        if (!isSender && userRole !== 'admin') {
            return res.status(403).json({ error: 'Not your message' });
        }
        if (isSender && userRole !== 'admin') {
            const ageMs = Date.now() - new Date(m.created_at).getTime();
            if (ageMs > 24 * 60 * 60 * 1000) {
                return res.status(403).json({ error: 'Can only delete messages within 24 hours' });
            }
        }

        await pool.query(
            `UPDATE messages SET deleted_at = NOW(), content = '' WHERE id = $1`,
            [msgId]
        );

        if (userRole === 'admin' && !isSender) {
            try {
                await pool.query(
                    `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, details)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [userId, 'chat_delete_message', 'message', msgId,
                     JSON.stringify({
                         conversation_id: m.conversation_id,
                         conversation_title: m.conv_title,
                         deleted_sender: m.sender_username,
                         content_preview: m.content.substring(0, 100),
                     })]
                );
            } catch (logErr) {
                console.error('Error logging mod action:', logErr);
            }
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('Delete message error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /messages/:msgId/react — toggle a reaction on a message
router.post('/:msgId(\\d+)/react', async (req, res) => {
    try {
        const userId = req.session.userId;
        const msgId = parseInt(req.params.msgId);
        const { emoji } = req.body;

        const ALLOWED_REACTIONS = ['\u{1F44D}', '\u{1F44E}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F622}', '\u{1F914}'];
        if (!emoji || !ALLOWED_REACTIONS.includes(emoji)) {
            return res.status(400).json({ error: 'Invalid reaction' });
        }

        const msg = await pool.query(
            `SELECT m.conversation_id FROM messages m
             JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
             WHERE m.id = $1 AND m.deleted_at IS NULL`,
            [msgId, userId]
        );
        if (msg.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found' });
        }

        const existing = await pool.query(
            `SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
            [msgId, userId, emoji]
        );

        if (existing.rows.length > 0) {
            await pool.query(`DELETE FROM message_reactions WHERE id = $1`, [existing.rows[0].id]);
        } else {
            await pool.query(
                `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)`,
                [msgId, userId, emoji]
            );
        }

        const reactions = await pool.query(
            `SELECT emoji, COUNT(*)::int AS count,
                    BOOL_OR(user_id = $2) AS me
             FROM message_reactions WHERE message_id = $1
             GROUP BY emoji ORDER BY MIN(created_at)`,
            [msgId, userId]
        );

        res.json({ ok: true, reactions: reactions.rows });
    } catch (err) {
        console.error('React error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /messages/:id/read — mark conversation as read (AJAX)
router.post('/:id(\\d+)/read', async (req, res) => {
    try {
        await pool.query(
            `UPDATE conversation_members SET last_read_at = NOW()
             WHERE conversation_id = $1 AND user_id = $2`,
            [parseInt(req.params.id), req.session.userId]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('Mark read error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /messages/list-data — conversation list JSON for the sidebar auto-update
// (reorders by most recent activity when a message is sent or received).
router.get('/list-data', async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = req.session.lang || 'en';
        const { convList } = await buildConversationList(userId, lang);
        const presenceNames = convList
            .filter(c => !c.is_group && c.otherUser && c.otherUser.username)
            .map(c => c.otherUser.username);
        const online = await getOnlineUsernames(pool, presenceNames);
        const conversations = convList.map(c => ({
            id: c.id,
            is_group: c.is_group,
            isSaved: !!c.isSaved,
            displayName: c.displayName,
            displayPicture: c.displayPicture,
            isOnline: !c.is_group && c.otherUser && c.otherUser.username
                ? online.has(c.otherUser.username)
                : false,
            groupAvatarSvg: c.is_group ? groupAvatarSVG(c.id, c.displayName, 44) : null,
            last_message_content: c.last_message_content,
            last_message_image: !!c.last_message_image,
            last_message_file: c.last_message_file || null,
            last_message_sender_id: c.last_message_sender_id,
            last_message_at: c.last_message_at ? new Date(c.last_message_at).toISOString() : null,
            unread_count: c.unread_count,
        }));
        res.json({ conversations });
    } catch (err) {
        console.error('Conversation list data error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /messages/:id/poll — poll for new messages (AJAX)
router.get('/:id(\\d+)/poll', async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = req.session.lang || 'en';
        const convId = parseInt(req.params.id);
        const afterId = parseInt(req.query.after) || 0;

        // Check membership
        const membership = await pool.query(
            `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        if (membership.rows.length === 0) {
            return res.status(403).json({ error: 'Not a member' });
        }

        const result = await pool.query(
            `SELECT m.id, m.content, m.created_at, m.sender_id, m.edited_at, m.deleted_at, m.image_url,
                    m.file_url, m.file_name, m.file_size,
                    u.username AS sender_username, u.profile_picture AS sender_picture,
                    cm.role AS sender_role,
                    m.reply_to_id,
                    rm.content AS reply_content, rm.image_url AS reply_image, rm.file_name AS reply_file,
                    rm.deleted_at AS reply_deleted, rm.sender_id AS reply_sender_id,
                    ru.username AS reply_sender_username
             FROM messages m
             LEFT JOIN users u ON u.id = m.sender_id
             LEFT JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = m.sender_id
             LEFT JOIN messages rm ON rm.id = m.reply_to_id
             LEFT JOIN users ru ON ru.id = rm.sender_id
             WHERE m.conversation_id = $1 AND m.id > $2
             ORDER BY m.created_at ASC`,
            [convId, afterId]
        );

        // Fetch recently edited/deleted messages the client already has
        const updatedSince = req.query.since;
        let updates = [];
        if (updatedSince && afterId > 0) {
            const updResult = await pool.query(
                `SELECT m.id, m.content, m.edited_at, m.deleted_at
                 FROM messages m
                 WHERE m.conversation_id = $1 AND m.id <= $2
                   AND (m.edited_at > $3 OR m.deleted_at > $3)`,
                [convId, afterId, updatedSince]
            );
            updates = updResult.rows;
        }

        // Attach reactions + reply info to new messages
        const newMsgIds = result.rows.map(m => m.id);
        const newReactions = await getReactionsForMessages(newMsgIds, userId);
        attachReplyInfo(result.rows, userId, lang);
        for (const m of result.rows) {
            m.reactions = newReactions[m.id] || [];
        }

        // Fetch reaction updates for messages the client already has
        let reactionUpdates = [];
        if (updatedSince && afterId > 0) {
            const reactResult = await pool.query(
                `SELECT DISTINCT mr.message_id
                 FROM message_reactions mr
                 JOIN messages m ON m.id = mr.message_id
                 WHERE m.conversation_id = $1 AND mr.message_id <= $2
                   AND mr.created_at > $3`,
                [convId, afterId, updatedSince]
            );
            if (reactResult.rows.length > 0) {
                const changedIds = reactResult.rows.map(r => r.message_id);
                const reactMap = await getReactionsForMessages(changedIds, userId);
                reactionUpdates = changedIds.map(id => ({ message_id: id, reactions: reactMap[id] || [] }));
            }
        }

        // Update read timestamp
        if (result.rows.length > 0) {
            await pool.query(
                `UPDATE conversation_members SET last_read_at = NOW()
                 WHERE conversation_id = $1 AND user_id = $2`,
                [convId, userId]
            );
        }

        res.json({ messages: result.rows, updates, reactionUpdates });
    } catch (err) {
        console.error('Poll messages error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /messages/search-users — search users for new conversation (AJAX)
router.get('/search-users', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 2) {
            return res.json({ users: [] });
        }
        const result = await pool.query(
            `SELECT id, username, full_name, profile_picture
             FROM users
             WHERE id != $1 AND (username ILIKE $2 OR full_name ILIKE $2)
             ORDER BY username
             LIMIT 10`,
            [req.session.userId, `%${q}%`]
        );
        res.json({ users: result.rows });
    } catch (err) {
        console.error('Search users error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /messages/unread-count — get total unread message count (AJAX, used by header)
router.get('/unread-count', async (req, res) => {
    try {
        const count = await getUnreadMessageCount(req.session.userId);
        res.json({ count });
    } catch (err) {
        console.error('Unread count error:', err);
        res.json({ count: 0 });
    }
});

// POST /messages/new-group — create a group conversation
router.post('/new-group', async (req, res) => {
    try {
        const userId = req.session.userId;
        const { memberIds, title } = req.body;

        if (!memberIds || !Array.isArray(memberIds) || memberIds.length < 1) {
            return res.status(400).json({ error: 'Need at least 1 other member' });
        }

        const userIds = [userId, ...memberIds.map(id => parseInt(id))];
        const uniqueIds = [...new Set(userIds)].filter(id => !isNaN(id));
        if (uniqueIds.length < 2) {
            return res.status(400).json({ error: 'Need at least 2 members' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const conv = await client.query(
                `INSERT INTO conversations (is_group, title, created_by) VALUES (TRUE, $1, $2) RETURNING id`,
                [title || null, userId]
            );
            const convId = conv.rows[0].id;
            for (const uid of uniqueIds) {
                await client.query(
                    `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)`,
                    [convId, uid]
                );
            }
            await client.query('COMMIT');

            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.json({ ok: true, conversationId: convId });
            }
            res.redirect(`/messages/${convId}`);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('New group error:', err);
        res.status(500).send('Internal server error');
    }
});

async function getUnreadMessageCount(userId) {
    try {
        const result = await pool.query(
            `SELECT COALESCE(SUM(
                (SELECT COUNT(*) FROM messages mx
                 WHERE mx.conversation_id = c.id
                   AND mx.created_at > cm.last_read_at
                   AND mx.sender_id != $1)
             ), 0)::int AS total
             FROM conversations c
             JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1`,
            [userId]
        );
        return result.rows[0]?.total || 0;
    } catch (err) {
        console.error('Unread message count error:', err);
        return 0;
    }
}

module.exports = { router, getUnreadMessageCount };
