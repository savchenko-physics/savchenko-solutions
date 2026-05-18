const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const notifications = require('./notifications');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

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

// GET /messages — inbox (conversation list) or a specific conversation
router.get('/', async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = req.session.lang || 'en';

        const conversations = await pool.query(
            `SELECT c.id, c.title, c.is_group, c.last_message_at,
                    m.content AS last_message_content,
                    m.sender_id AS last_message_sender_id,
                    sender.username AS last_message_sender,
                    cm.last_read_at,
                    (SELECT COUNT(*) FROM messages mx
                     WHERE mx.conversation_id = c.id AND mx.created_at > cm.last_read_at AND mx.sender_id != $1
                    )::int AS unread_count
             FROM conversations c
             JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
             LEFT JOIN LATERAL (
                 SELECT content, sender_id FROM messages
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
            const other = memberMap[c.id] || null;
            return {
                ...c,
                otherUser: other,
                memberCount: groupMemberCountMap[c.id] || 0,
                displayName: c.is_group
                    ? (c.title || 'Group')
                    : (other ? (other.full_name || other.username) : 'Deleted User'),
                displayPicture: c.is_group
                    ? null
                    : (other ? other.profile_picture : null),
            };
        });

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
        });
    } catch (err) {
        console.error('Messages inbox error:', err);
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
        const conversations = await pool.query(
            `SELECT c.id, c.title, c.is_group, c.last_message_at,
                    m.content AS last_message_content,
                    m.sender_id AS last_message_sender_id,
                    sender.username AS last_message_sender,
                    cm.last_read_at,
                    (SELECT COUNT(*) FROM messages mx
                     WHERE mx.conversation_id = c.id AND mx.created_at > cm.last_read_at AND mx.sender_id != $1
                    )::int AS unread_count
             FROM conversations c
             JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
             LEFT JOIN LATERAL (
                 SELECT content, sender_id FROM messages
                 WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
             ) m ON TRUE
             LEFT JOIN users sender ON sender.id = m.sender_id
             WHERE EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id)
             ORDER BY c.last_message_at DESC`,
            [userId]
        );

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
            const other = memberMap[c.id] || null;
            return {
                ...c,
                otherUser: other,
                memberCount: groupMemberCountMap[c.id] || 0,
                displayName: c.is_group
                    ? (c.title || 'Group')
                    : (other ? (other.full_name || other.username) : 'Deleted User'),
                displayPicture: c.is_group
                    ? null
                    : (other ? other.profile_picture : null),
            };
        });

        // Active conversation: get info and messages
        let activeConvRow = conversations.rows.find(c => c.id === convId);
        let activeOther = memberMap[convId] || null;

        // If the active conversation is new (no messages), it won't be in the sidebar list — fetch it separately
        if (!activeConvRow) {
            const convResult = await pool.query(
                `SELECT id, title, is_group, last_message_at FROM conversations WHERE id = $1`,
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

        const activeConversation = activeConvRow ? {
            id: convId,
            is_group: activeConvRow.is_group,
            title: activeConvRow.title,
            displayName: activeConvRow.is_group
                ? (activeConvRow.title || 'Group')
                : (activeOther ? (activeOther.full_name || activeOther.username) : 'Deleted User'),
            displayPicture: activeConvRow.is_group ? null : (activeOther ? activeOther.profile_picture : null),
            otherUser: activeOther,
            memberCount: activeMemberCount,
        } : null;

        const messagesResult = await pool.query(
            `SELECT m.id, m.content, m.created_at, m.sender_id, m.edited_at, m.deleted_at,
                    u.username AS sender_username, u.profile_picture AS sender_picture,
                    cm.role AS sender_role
             FROM messages m
             LEFT JOIN users u ON u.id = m.sender_id
             LEFT JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = m.sender_id
             WHERE m.conversation_id = $1
             ORDER BY m.created_at ASC`,
            [convId]
        );

        const msgIds = messagesResult.rows.map(m => m.id);
        const reactionsMap = await getReactionsForMessages(msgIds, userId);
        for (const m of messagesResult.rows) {
            m.reactions = reactionsMap[m.id] || [];
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

// POST /messages/:id/send — send a message
router.post('/:id(\\d+)/send', async (req, res) => {
    try {
        const userId = req.session.userId;
        const convId = parseInt(req.params.id);
        const { content } = req.body;

        if (!content || !content.trim()) {
            return res.redirect(`/messages/${convId}`);
        }

        const trimmed = content.trim().substring(0, 5000);

        // Check membership
        const membership = await pool.query(
            `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        if (membership.rows.length === 0) {
            return res.status(403).send('Not a member');
        }

        // Insert message and update conversation timestamp
        await pool.query(
            `INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)`,
            [convId, userId, trimmed]
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
        const otherMembers = await pool.query(
            `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2`,
            [convId, userId]
        );
        const preview = trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed;
        for (const member of otherMembers.rows) {
            try {
                await notifications.createNotification(
                    member.user_id,
                    'new_message',
                    `New message from ${req.session.username}`,
                    preview,
                    `/messages/${convId}`,
                    userId
                );
            } catch (notifErr) {
                console.error('Message notification error:', notifErr);
            }
        }

        // If AJAX request, return JSON
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({ ok: true });
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

// GET /messages/:id/poll — poll for new messages (AJAX)
router.get('/:id(\\d+)/poll', async (req, res) => {
    try {
        const userId = req.session.userId;
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
            `SELECT m.id, m.content, m.created_at, m.sender_id, m.edited_at, m.deleted_at,
                    u.username AS sender_username, u.profile_picture AS sender_picture,
                    cm.role AS sender_role
             FROM messages m
             LEFT JOIN users u ON u.id = m.sender_id
             LEFT JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = m.sender_id
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

        // Attach reactions to new messages
        const newMsgIds = result.rows.map(m => m.id);
        const newReactions = await getReactionsForMessages(newMsgIds, userId);
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
