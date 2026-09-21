const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const i18n = require('i18n');
const notifications = require('./notifications');
const { linkifyMessageContent, normalizeLang } = require('./utils');
const { langFromMessagesPath, preferredLang, langMessagesUrl, messagesPath } = require('./lib/messagesUrls');
const { alertKind, previewText } = require('./lib/pulse');
const { getOnlineUsernames } = require('./lib/presence');
const { communityAvatarSVG, otherLang } = require('./lib/communityChats');
const { isKnownReaction, isPremium, reactionAction } = require('./js/reactions');
const { ownsReaction } = require('./lib/reactionUnlocks');
const attachments = require('./lib/messageAttachments');
const { videoDimensions } = require('./lib/videoMeta');
const transcode = require('./lib/videoTranscode');
const { isPostingBlocked, isPermanent, blockedNotice, effectiveBlock, PERMANENT_YEAR } = require('./lib/chatRestrictions');
const { rankFor: userRankFor } = require('./lib/userRank');
const pollRules = require('./lib/polls');

// The end of a member's block on writing, account-wide and in one conversation combined
// (lib/chatRestrictions.js): null when they may write. `convId` may be null.
async function postingBlockFor(userId, convId) {
    const r = await pool.query(
        `SELECT u.posting_blocked_until AS account, cm.posting_blocked_until AS member
         FROM users u LEFT JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = $2
         WHERE u.id = $1`, [userId, convId]);
    if (!r.rows.length) return null;
    const until = effectiveBlock(r.rows[0].account, r.rows[0].member);
    return isPostingBlocked(until) ? until : null;
}

// "Delete chat" (one-to-one chats, migration 064) removes nothing: it stamps the member's own
// conversation_members.hidden_at, and every query that shows that member a chat's messages
// keeps only what arrived after the stamp. This is the WHERE fragment; `$n` is the viewer's id.
function afterHidden(userParam) {
    return `m.created_at > COALESCE((SELECT hidden_at FROM conversation_members
                WHERE conversation_id = m.conversation_id AND user_id = ${userParam}), '-infinity'::timestamptz)`;
}

// A one-to-one chat where the other member has blocked `userId` (user_blocks): the text they
// are shown, or null. `convId` may be null when the target is a person (a new DM).
async function dmBlockNotice(userId, { convId = null, otherId = null }, lang) {
    const r = otherId
        ? await pool.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [otherId, userId])
        : await pool.query(
            `SELECT 1 FROM user_blocks ub
             JOIN conversation_members cm ON cm.user_id = ub.blocker_id AND cm.conversation_id = $1
             JOIN conversations c ON c.id = cm.conversation_id AND c.is_group = FALSE AND c.saved_for_user_id IS NULL
             WHERE ub.blocked_id = $2`, [convId, userId]);
    if (!r.rows.length) return null;
    return lang === 'ru'
        ? 'Вы не можете писать этому пользователю.'
        : 'You cannot message this person.';
}

const msgImageDir = path.join(__dirname, 'img', 'messages');
fs.mkdirSync(msgImageDir, { recursive: true });

// Browsers send the file name in UTF-8 and busboy reads it as Latin-1, so "Савченко.pdf" arrived
// as "Ð¡Ð°Ð²ÑÐµÐ½ÐºÐ¾.pdf" (message 1181, 2026-08-14). Read the bytes back as UTF-8; a name that was
// really Latin-1 and does not survive the round trip is kept as it came.
function fixFileName(name) {
    const s = String(name || '');
    if (!/[\u0080-\u00ff]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
    const decoded = Buffer.from(s, 'latin1').toString('utf8');
    return decoded.includes('\ufffd') ? s : decoded;
}

const msgImageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, msgImageDir),
    filename: (req, file, cb) => {
        file.originalname = fixFileName(file.originalname);
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    },
});

// What may be attached, and how large, is stated once in lib/messageAttachments.js: images
// render inline, videos play inline, the rest is a download card. multer's own ceiling is the
// largest limit (a video's); a smaller file type over its own limit is refused once the file is
// on disk, in the send handler, since the type is only known when the part arrives.
function tooLarge(name) {
    return `File too large (max ${Math.round(attachments.limitFor(name) / 1048576)} MB)`;
}

const msgFileUpload = multer({
    storage: msgImageStorage,
    limits: { fileSize: attachments.VIDEO_MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        file.originalname = fixFileName(file.originalname);
        const limit = attachments.limitFor(file.originalname);
        if (!limit) return cb(new Error('File type not allowed'));
        // A request visibly larger than this type's limit is refused before the file is read.
        const declared = Number(req.headers['content-length']) || 0;
        if (declared > limit + 1024 * 1024) return cb(new Error(tooLarge(file.originalname)));
        cb(null, true);
    },
});

// A full disk takes the whole site down (the outage of 2026-08-06), and a video is a hundredth of
// what is free. No attachment is accepted while less than this is left on the disk that holds them.
const FREE_DISK_MIN_BYTES = 1024 * 1024 * 1024;
async function freeDiskBytes() {
    try {
        const st = await fs.promises.statfs(msgImageDir);
        return Number(st.bavail) * Number(st.bsize);
    } catch (err) {
        return Infinity;   // an unreadable statfs must not refuse every upload
    }
}

// The reader's time zone, which js/local-time.js keeps in a cookie, so the page is written in it
// from the start (times, day separators) rather than in UTC and rewritten after load. null until
// the first page of a visit has set the cookie; the page then keeps its times out of sight
// until its script has rewritten them.
function readerTimeZone(req) {
    const m = /(?:^|;\s*)ss_tz=([^;]+)/.exec(req.get('cookie') || '');
    if (!m) return null;
    let zone;
    try { zone = decodeURIComponent(m[1]); } catch (e) { return null; }
    if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(zone)) return null;
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch (e) { return null; }
    return zone;
}

// Wrap the upload so a rejected/oversized file returns a clean 400 instead of
// bubbling to the generic error handler (which would 500).
function msgUploadMiddleware(req, res, next) {
    const answer = (status, msg) => {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(status).json({ error: msg });
        }
        return res.status(status).send(msg);
    };
    const upload = () => msgFileUpload.single('file')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? `File too large (max ${Math.round(attachments.VIDEO_MAX_BYTES / 1048576)} MB)`
                : (err.message || 'Upload failed');
            return answer(400, msg);
        }
        next();
    });
    if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return upload();
    freeDiskBytes().then((free) => {
        if (free < FREE_DISK_MIN_BYTES) return answer(507, 'No room on the server for attachments right now');
        upload();
    });
}

const pool = require('./lib/db');

// ── Typing indicators ───────────────────────────────────────────────────
// Ephemeral in-memory state: conversationId -> Map<userId, {username, expires}>.
// Fine to lose on restart; assumes a single app instance (this deployment is a
// single pm2 fork). Would need Redis/DB to work across a cluster.
const typingState = new Map();
const TYPING_TTL_MS = 6000;

function setTyping(convId, userId, username) {
    let conv = typingState.get(convId);
    if (!conv) { conv = new Map(); typingState.set(convId, conv); }
    conv.set(userId, { username, expires: Date.now() + TYPING_TTL_MS });
}

function clearTyping(convId, userId) {
    const conv = typingState.get(convId);
    if (conv) {
        conv.delete(userId);
        if (conv.size === 0) typingState.delete(convId);
    }
}

// Usernames of OTHER members currently typing in a conversation (prunes expired).
function getTypingOthers(convId, userId) {
    const conv = typingState.get(convId);
    if (!conv) return [];
    const now = Date.now();
    const out = [];
    for (const [uid, info] of conv) {
        if (info.expires <= now) { conv.delete(uid); continue; }
        if (uid !== userId) out.push(info.username);
    }
    if (conv.size === 0) typingState.delete(convId);
    return out;
}

// ── Server-Sent Events (live push) ──────────────────────────────────────
// One long-lived stream per user (multiple tabs → multiple entries). Replaces
// the client polling loop; the POST endpoints publish events after mutating.
// In-memory, single-instance (same constraint as typing state).
const sseClients = new Map(); // userId -> Set<res>

function sseAdd(userId, res) {
    let set = sseClients.get(userId);
    if (!set) { set = new Set(); sseClients.set(userId, set); }
    set.add(res);
}

function sseRemove(userId, res) {
    const set = sseClients.get(userId);
    if (set) { set.delete(res); if (!set.size) sseClients.delete(userId); }
}

// Ends every live stream, for a process that is shutting down (index.js): an open stream would
// otherwise hold server.close() until the deadline. The pages reconnect on their own.
function closeStreams() {
    for (const set of sseClients.values()) {
        for (const res of set) { try { res.end(); } catch (e) { /* already gone */ } }
    }
    sseClients.clear();
}

function sseSend(userId, event, data) {
    const set = sseClients.get(userId);
    if (!set || !set.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
        try { res.write(payload); if (res.flush) res.flush(); } catch (e) { /* dead connection; cleaned up on close */ }
    }
}

// Push an event to every member of a conversation (optionally excluding one).
async function broadcastToConversation(convId, event, data, exceptUserId) {
    if (sseClients.size === 0) return; // nobody is connected
    const members = await pool.query(
        `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
        [convId]
    );
    for (const row of members.rows) {
        if (exceptUserId && row.user_id === exceptUserId) continue;
        sseSend(row.user_id, event, data);
    }
}

// Reactions carry a per-user "me" flag, so each connected member needs its own
// view — only queried for members that actually have an open stream.
async function broadcastReactions(convId, msgId, exceptUserId) {
    if (sseClients.size === 0) return;
    const members = await pool.query(
        `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
        [convId]
    );
    for (const row of members.rows) {
        if (exceptUserId && row.user_id === exceptUserId) continue;
        if (!sseClients.has(row.user_id)) continue;
        const r = await pool.query(
            `SELECT emoji, COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS me
             FROM message_reactions WHERE message_id = $1
             GROUP BY emoji ORDER BY MIN(created_at)`,
            [msgId, row.user_id]
        );
        sseSend(row.user_id, 'msg:react', { conversationId: convId, messageId: msgId, reactions: r.rows });
    }
}

const GROUP_PALETTES = [
    ['#e74c3c', '#c0392b', '#f39c12', '#e67e22'],
    ['#3498db', '#2980b9', '#1abc9c', '#16a085'],
    ['#9b59b6', '#8e44ad', '#e74c3c', '#c0392b'],
    ['#2ecc71', '#27ae60', '#3498db', '#2980b9'],
    ['#e67e22', '#d35400', '#f1c40f', '#f39c12'],
    ['#1abc9c', '#16a085', '#9b59b6', '#8e44ad'],
    ['#34495e', '#2c3e50', '#3498db', '#2980b9'],
];

function groupAvatarSVG(convId, name, size, communityLang) {
    // The two community chats share a name, so their avatars carry the language instead.
    if (communityLang === 'en' || communityLang === 'ru') return communityAvatarSVG(communityLang, size);
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

// What a file attachment is called wherever a message is summarised: a video by kind, since its
// name is a phone's IMG_0042.MOV, any other file by name.
function attachmentLabel(fileName, lang) {
    if (!fileName) return fileName;
    const kind = attachments.kindOf(fileName);
    if (kind === 'video') return lang === 'ru' ? 'Видео' : 'Video';
    if (kind === 'audio') return lang === 'ru' ? 'Аудио' : 'Audio';
    return fileName;
}

// Short, plain-text preview of a message being quoted in a reply.
function buildReplyPreview(content, imageUrl, fileName, deleted, lang, pollQuestion) {
    if (deleted) return lang === 'ru' ? 'Удалённое сообщение' : 'Deleted message';
    const t = (content || '').trim() || (pollQuestion ? (lang === 'ru' ? 'Опрос: ' : 'Poll: ') + pollQuestion : '');
    if (t) return t.length > 80 ? t.substring(0, 80) + '…' : t;
    if (fileName) return attachmentLabel(fileName, lang);
    if (imageUrl) return lang === 'ru' ? 'Фото' : 'Photo';
    return '';
}

// A deleted message keeps its row (and an image or document keeps its file, as before), but a
// video or audio file is many times the size, so its file goes when the last live message showing
// it is deleted. Forwards share the file, hence the check for other messages.
async function removeVideoFile(fileUrl, fileName, messageId) {
    try {
        const kind = attachments.kindOf(fileName);
        if (!fileUrl || (kind !== 'video' && kind !== 'audio')) return;
        const base = path.basename(fileUrl);
        if (!fileUrl.startsWith('/img/messages/') || base !== fileUrl.slice('/img/messages/'.length)) return;
        const others = await pool.query(
            `SELECT 1 FROM messages WHERE file_url = $1 AND id <> $2 AND deleted_at IS NULL LIMIT 1`,
            [fileUrl, messageId]
        );
        if (others.rows.length) return;
        await fs.promises.unlink(path.join(msgImageDir, base));
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Removing a deleted video:', err);
    }
}

// ── Videos: made playable everywhere ──────────────────────────────────────────
// A video that is not already H.264 + AAC in an mp4 is converted after upload
// (lib/videoTranscode.js). Until then its message carries attachment_status 'converting' and
// shows a download card; when the playable file is ready every message with that upload (a
// forward shares the file) gets the new URL, size and box, and its members are told over SSE.
// VIDEO_CONVERT=off, or no ffmpeg on the box, leaves uploads as they are.
const conversionQueue = transcode.createQueue();
let conversionToolsPromise = null;
function conversionTools() {
    if (!conversionToolsPromise) {
        conversionToolsPromise = process.env.VIDEO_CONVERT === 'off' ? Promise.resolve(false) : transcode.toolsAvailable();
    }
    return conversionToolsPromise;
}

async function messagesForUrl(fileUrl) {
    const r = await pool.query(
        `SELECT m.conversation_id, c.community_lang, ${MESSAGE_COLUMNS} ${MESSAGE_JOINS}
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.file_url = $1 AND m.deleted_at IS NULL`,
        [fileUrl]
    );
    return r.rows;
}

// The page redraws the whole row from this (buildMessageRow), so it is the message as the
// list endpoints send it, with the reply quote attached; reactions stay as the page has them.
async function announceAttachment(rows) {
    for (const m of rows) {
        try {
            attachReplyInfo([m], null, m.community_lang || 'en');
            await broadcastToConversation(m.conversation_id, 'msg:update',
                Object.assign({ conversationId: m.conversation_id, reactions: [] }, m));
        } catch (e) { console.error('SSE broadcast (attachment) error:', e); }
    }
}

function scheduleConversion(fileUrl, srcPath, mode) {
    return conversionQueue.add(async () => {
        const dst = transcode.outputPathFor(srcPath, mode);
        try {
            const used = await transcode.convert(srcPath, dst, mode);
            const dims = mode === 'audio' ? null : videoDimensions(dst);
            const size = (await fs.promises.stat(dst)).size;
            const placeholder = mode === 'audio' ? null : await transcode.posterPlaceholder(dst);
            const newUrl = '/img/messages/' + path.basename(dst);
            const r = await pool.query(
                `UPDATE messages SET file_url = $1, file_size = $2, image_width = $3, image_height = $4,
                        image_placeholder = $5, attachment_status = NULL
                 WHERE file_url = $6 AND deleted_at IS NULL RETURNING id`,
                [newUrl, size, dims ? dims.width : null, dims ? dims.height : null, placeholder, fileUrl]
            );
            if (r.rows.length === 0) {           // every message with it was deleted meanwhile
                await fs.promises.unlink(dst).catch(() => {});
                return;
            }
            await fs.promises.unlink(srcPath).catch(() => {});
            console.log(`video ${used}: ${path.basename(srcPath)} → ${path.basename(dst)} (${Math.round(size / 1024)} KB)`);
            await announceAttachment(await messagesForUrl(newUrl));
        } catch (err) {
            console.error(`video conversion failed for ${path.basename(srcPath)}:`, err && err.message);
            await pool.query(
                `UPDATE messages SET attachment_status = 'failed' WHERE file_url = $1 AND attachment_status = 'converting'`,
                [fileUrl]
            ).catch((e) => console.error('marking a failed conversion:', e));
            await announceAttachment(await messagesForUrl(fileUrl).catch(() => []));
        }
    });
}

// At startup: whatever was converting when the process last stopped is converted now.
async function resumeConversions() {
    try {
        if (!(await conversionTools())) return;
        const r = await pool.query(
            `SELECT DISTINCT file_url, file_name FROM messages WHERE attachment_status = 'converting' AND deleted_at IS NULL`
        );
        for (const row of r.rows) {
            const src = path.join(msgImageDir, path.basename(row.file_url));
            if (!row.file_url.startsWith('/img/messages/') || !fs.existsSync(src)) {
                await pool.query(`UPDATE messages SET attachment_status = 'failed' WHERE file_url = $1`, [row.file_url]);
                continue;
            }
            const info = await transcode.probe(src);
            const mode = transcode.conversionNeeded(info, attachments.extensionOf(row.file_name));
            scheduleConversion(row.file_url, src, mode === 'none' ? 'remux' : mode);
        }
        if (r.rows.length) console.log(`video: resuming ${r.rows.length} conversion(s)`);
    } catch (err) {
        console.error('resuming video conversions:', err);
    }
}

// Attach a `reply` object to each message row that quotes another message.
function attachReplyInfo(rows, userId, lang) {
    for (const m of rows) {
        if (m.reply_to_id) {
            m.reply = {
                id: m.reply_to_id,
                sender: m.reply_sender_username || (lang === 'ru' ? 'Пользователь' : 'User'),
                preview: buildReplyPreview(m.reply_content, m.reply_image, m.reply_file, m.reply_deleted, lang, m.reply_poll_question),
                mine: m.reply_sender_id === userId,
                isImage: !m.reply_content && !!m.reply_image && !m.reply_deleted,
                isFile: !m.reply_content && !!m.reply_file && !m.reply_deleted,
            };
        }
    }
}

// ── Polls (lib/polls.js, migration 065) ─────────────────────────────────────────────────────
// Every message row with a poll_id gets `poll`: the state the viewer is shown. One query per
// table for all the polls in `rows`. A broadcast passes viewerId null: the counts are the same
// for everyone and each client keeps its own `mine`.
async function loadPollState(pollIds, viewerId, { managerOf = new Set() } = {}) {
    const ids = [...new Set(pollIds.filter(Boolean))];
    if (!ids.length) return {};
    const [polls, options, counts, voters, mine] = await Promise.all([
        pool.query('SELECT * FROM polls WHERE id = ANY($1)', [ids]),
        pool.query('SELECT id, poll_id, text FROM poll_options WHERE poll_id = ANY($1) ORDER BY poll_id, position', [ids]),
        pool.query('SELECT option_id, COUNT(*)::int AS n FROM poll_votes WHERE poll_id = ANY($1) GROUP BY option_id', [ids]),
        pool.query('SELECT poll_id, COUNT(DISTINCT user_id)::int AS n FROM poll_votes WHERE poll_id = ANY($1) GROUP BY poll_id', [ids]),
        viewerId ? pool.query('SELECT poll_id, option_id FROM poll_votes WHERE poll_id = ANY($1) AND user_id = $2', [ids, viewerId]) : Promise.resolve({ rows: [] }),
    ]);
    const countMap = {}; for (const r of counts.rows) countMap[r.option_id] = r.n;
    const voterMap = {}; for (const r of voters.rows) voterMap[r.poll_id] = r.n;
    const mineMap = {}; for (const r of mine.rows) (mineMap[r.poll_id] = mineMap[r.poll_id] || []).push(r.option_id);
    const optMap = {}; for (const o of options.rows) (optMap[o.poll_id] = optMap[o.poll_id] || []).push(o);
    const out = {};
    for (const poll of polls.rows) {
        const canManage = !!viewerId && (poll.created_by === viewerId || managerOf.has(poll.id));
        out[poll.id] = pollRules.pollState(poll, optMap[poll.id] || [], countMap, voterMap[poll.id] || 0, mineMap[poll.id] || [], viewerId, { canManage });
    }
    return out;
}

async function attachPolls(rows, viewerId, { isModerator = false } = {}) {
    const ids = rows.map((m) => m.poll_id).filter(Boolean);
    if (!ids.length) return;
    const managerOf = isModerator ? new Set(ids) : new Set();
    const states = await loadPollState(ids, viewerId, { managerOf });
    for (const m of rows) if (m.poll_id && states[m.poll_id]) m.poll = states[m.poll_id];
}

// Whether `userId` moderates `convId` (a group's admin role) or the site (astrosander).
async function moderatesConversation(convId, userId, username) {
    if (username === 'astrosander') return true;
    const r = await pool.query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, userId]);
    return r.rows.length > 0 && r.rows[0].role === 'admin';
}

const PAGE_SIZE = 30; // messages loaded per page (initial view + each older page)

// Shared message projection used by the conversation view, poll, and history
// endpoints so all three return identically-shaped rows.
const MESSAGE_COLUMNS = `m.id, m.content, m.created_at, m.sender_id, m.edited_at, m.deleted_at, m.image_url,
        m.image_width, m.image_height, m.image_placeholder,
        m.file_url, m.file_name, m.file_size, m.attachment_status, m.pinned_at, m.forwarded_from_user_id,
        m.poll_id,
        u.username AS sender_username, u.profile_picture AS sender_picture,
        cm.role AS sender_role,
        (SELECT LEAST(b, TIMESTAMPTZ '${PERMANENT_YEAR}-12-31T00:00:00Z')
           FROM (SELECT GREATEST(cm.posting_blocked_until, u.posting_blocked_until) AS b) g
          WHERE b IS NOT NULL) AS sender_blocked_until,
        fu.username AS forwarded_from_username,
        m.reply_to_id,
        rm.content AS reply_content, rm.image_url AS reply_image, rm.file_name AS reply_file,
        rp.question AS reply_poll_question,
        rm.deleted_at AS reply_deleted, rm.sender_id AS reply_sender_id,
        ru.username AS reply_sender_username`;

const MESSAGE_JOINS = `FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        LEFT JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = m.sender_id
        LEFT JOIN messages rm ON rm.id = m.reply_to_id
        LEFT JOIN polls rp ON rp.id = rm.poll_id
        LEFT JOIN users ru ON ru.id = rm.sender_id
        LEFT JOIN users fu ON fu.id = m.forwarded_from_user_id`;

// Read-receipt cutoff: the earliest "last read" timestamp among the OTHER
// members. A sent message is "read" once its created_at is <= this. Returns
// null when there are no other members (a Saved Messages self-chat).
async function getReadCutoff(convId, userId) {
    const r = await pool.query(
        `SELECT MIN(last_read_at) AS cutoff FROM conversation_members
         WHERE conversation_id = $1 AND user_id <> $2`,
        [convId, userId]
    );
    return r.rows[0] ? r.rows[0].cutoff : null;
}

// The most recently pinned (non-deleted) message in a conversation, as a small
// summary for the pinned bar. Returns null when nothing is pinned.
async function getPinnedSummary(convId, lang) {
    const r = await pool.query(
        `SELECT m.id, m.content, m.image_url, m.file_name, m.deleted_at,
                u.username AS sender_username
         FROM messages m LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = $1 AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
         ORDER BY m.pinned_at DESC LIMIT 1`,
        [convId]
    );
    if (r.rows.length === 0) return null;
    const p = r.rows[0];
    return {
        id: p.id,
        sender: p.sender_username || (lang === 'ru' ? 'Пользователь' : 'User'),
        preview: buildReplyPreview(p.content, p.image_url, p.file_name, p.deleted_at, lang),
    };
}

// Read an uploaded image's dimensions and build a tiny blurred placeholder
// (LQIP data-URI) so the client can reserve the exact box and fade the image in.
async function processImageMeta(filePath) {
    try {
        const meta = await sharp(filePath).metadata();
        const width = meta.width || null;
        const height = meta.height || null;
        let placeholder = null;
        try {
            const buf = await sharp(filePath)
                .resize(24, 24, { fit: 'inside' })
                .blur(1.2)
                .jpeg({ quality: 40 })
                .toBuffer();
            placeholder = 'data:image/jpeg;base64,' + buf.toString('base64');
        } catch (e) { /* placeholder is optional */ }
        return { width, height, placeholder };
    } catch (e) {
        return { width: null, height: null, placeholder: null };
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
        return res.redirect(`/${normalizeLang(req.session.lang)}/login`);
    }
    next();
}

router.use(checkAuth);

/* The language of a messenger page is the /en or /ru in its address (lib/messagesUrls.js). A bare
 * /messages/... page address is answered with a redirect to the same page with the language in it,
 * and null tells the handler to stop. */
function pageLang(req, res) {
    const urlLang = langFromMessagesPath(req.originalUrl);
    if (!urlLang) {
        res.redirect(302, langMessagesUrl(req.originalUrl, preferredLang({
            sessionLang: req.session.lang,
            acceptLanguage: req.get('accept-language'),
        })));
        return null;
    }
    if (req.session.lang !== urlLang) req.session.lang = urlLang;
    return urlLang;
}

// ── Rate limiting (in-memory fixed window, per user + bucket) ────────────
const rateBuckets = new Map();
function rateLimit(bucket, max, windowMs) {
    return (req, res, next) => {
        const key = req.session.userId + ':' + bucket;
        const now = Date.now();
        let e = rateBuckets.get(key);
        if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; rateBuckets.set(key, e); }
        e.count++;
        if (e.count > max) {
            res.set('Retry-After', String(Math.ceil((e.resetAt - now) / 1000)));
            return res.status(429).json({ error: 'Too many requests — please slow down.' });
        }
        next();
    };
}
// Periodically drop expired buckets so the map can't grow unbounded.
setInterval(() => {
    const now = Date.now();
    for (const [k, e] of rateBuckets) if (e.resetAt <= now) rateBuckets.delete(k);
}, 60000).unref?.();

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
        `SELECT c.id, c.title, c.is_group, c.saved_for_user_id, c.community_lang,
                COALESCE(m.created_at, c.last_message_at) AS last_message_at,
                m.content AS last_message_content,
                m.poll_question,
                m.image_url AS last_message_image,
                m.file_name AS last_message_file,
                m.sender_id AS last_message_sender_id,
                sender.username AS last_message_sender,
                cm.last_read_at, cm.muted,
                (SELECT COUNT(*) FROM messages mx
                 WHERE mx.conversation_id = c.id AND mx.created_at > cm.last_read_at AND mx.sender_id != $1
                   AND mx.deleted_at IS NULL
                   AND (cm.hidden_at IS NULL OR mx.created_at > cm.hidden_at)
                )::int AS unread_count
         FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
         -- The newest message still there: a deleted one showed as an empty line and kept the
         -- chat at the top of the list (Dzmitrij's chat, 2026-09-19). A chat this member
         -- "deleted" (cm.hidden_at) counts only what came after.
         LEFT JOIN LATERAL (
             SELECT content, sender_id, image_url, file_name, created_at,
                    (SELECT question FROM polls WHERE polls.id = messages.poll_id) AS poll_question
             FROM messages
             WHERE conversation_id = c.id AND deleted_at IS NULL
               AND (cm.hidden_at IS NULL OR created_at > cm.hidden_at)
             ORDER BY created_at DESC LIMIT 1
         ) m ON TRUE
         LEFT JOIN users sender ON sender.id = m.sender_id
         WHERE EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id
                       AND (cm.hidden_at IS NULL OR created_at > cm.hidden_at))
         ORDER BY COALESCE(m.created_at, c.last_message_at) DESC`,
        [userId]
    );

    // The list shows a video as "Video", as the reply quote and the alert card do, not by file name.
    for (const c of conversations.rows) {
        c.last_message_file = attachmentLabel(c.last_message_file, lang);
        if (!c.last_message_content && c.poll_question) c.last_message_content = (lang === 'ru' ? 'Опрос: ' : 'Poll: ') + c.poll_question;
    }

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
                // A person by username (the owner, 2026-09-21; the full name is on the profile).
                : (c.is_group
                    ? (c.title || 'Group')
                    : (other ? other.username : 'Deleted User')),
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
        const lang = pageLang(req, res);
        if (!lang) return;
        // The shared site header translates through __(), which otherwise follows the
        // browser's Accept-Language while this page follows the session: a Russian chat
        // under an English menu. Same fix as feedback.js.
        i18n.setLocale(req, lang);

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
            attachmentRules: attachments.clientRules(),
            attachmentAccept: attachments.acceptAttribute(),
            timeZone: readerTimeZone(req),
            conversations: convList,
            activeConversation: null,
            messages: [],
            userId,
            username: req.session.username,
            isAdmin: false,
            membersList: [],
            groupAvatarSVG,
            muted: false,
            otherCommunity: null,
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
        const lang = pageLang(req, res);
        if (!lang) return;
        const convId = await findOrCreateSavedMessages(req.session.userId);
        res.redirect(messagesPath(lang, convId));
    } catch (err) {
        console.error('Saved messages error:', err);
        res.status(500).send('Internal server error');
    }
});

// GET /messages/stream — Server-Sent Events stream of live updates for this user
router.get('/stream', (req, res) => {
    const userId = req.session.userId;
    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // tell nginx not to buffer this response
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 3000\n\n');       // client reconnect backoff
    res.write('event: ready\ndata: {}\n\n');
    if (res.flush) res.flush();          // flush past compression if it's engaged
    sseAdd(userId, res);

    // Heartbeat under nginx's 60s idle timeout; also lets the client detect health.
    const hb = setInterval(() => {
        try { res.write('event: ping\ndata: {}\n\n'); if (res.flush) res.flush(); } catch (e) { /* closed */ }
    }, 20000);

    req.on('close', () => {
        clearInterval(hb);
        sseRemove(userId, res);
    });
});

// GET /messages/:id — view a specific conversation
router.get('/:id(\\d+)', async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = pageLang(req, res);
        if (!lang) return;
        i18n.setLocale(req, lang); // header in the chat's language, see GET /
        const convId = parseInt(req.params.id);

        // Check membership (and capture read/mute state before marking read)
        const membership = await pool.query(
            `SELECT last_read_at, muted, posting_blocked_until FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        if (membership.rows.length === 0) {
            return res.redirect(messagesPath(lang));
        }
        const prevLastRead = membership.rows[0].last_read_at;
        const activeMuted = !!membership.rows[0].muted;
        // A member kept from writing here, or anywhere, sees a notice in place of the composer.
        const postingBlockedUntil = await postingBlockFor(userId, convId);
        let postingBlocked = postingBlockedUntil ? blockedNotice(postingBlockedUntil, lang, readerTimeZone(req)) : null;
        // A DM whose other member has blocked this one reads the same way (user_blocks).
        if (!postingBlocked) postingBlocked = await dmBlockNotice(userId, { convId }, lang);

        // Mark as read
        await pool.query(
            `UPDATE conversation_members SET last_read_at = NOW()
             WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        // Advance other members' read receipts (correct for DMs; groups ignore it).
        broadcastToConversation(convId, 'read',
            { conversationId: convId, readCutoff: new Date().toISOString() }, userId).catch(() => {});

        // Get conversation list (same as inbox)
        const { rows: convRows, memberMap, convList } = await buildConversationList(userId, lang);

        // Active conversation: get info and messages
        let activeConvRow = convRows.find(c => c.id === convId);
        let activeOther = memberMap[convId] || null;

        // If the active conversation is new (no messages), it won't be in the sidebar list — fetch it separately
        if (!activeConvRow) {
            const convResult = await pool.query(
                `SELECT id, title, is_group, last_message_at, saved_for_user_id, community_lang FROM conversations WHERE id = $1`,
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
            // A DM's header shows the username in its rank's colour, the full name under it.
            otherRank: (!activeIsSaved && !activeConvRow.is_group && activeOther) ? await userRankFor(activeOther.id) : null,
            // Whether this member has blocked the other (the info panel's Block / Unblock).
            blockedByMe: (!activeIsSaved && !activeConvRow.is_group && activeOther)
                ? (await pool.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, activeOther.id])).rows.length > 0
                : false,
            memberCount: activeMemberCount,
            communityLang: activeConvRow.community_lang || null,
        } : null;

        // In a community chat, the chat in the other language: the composer's language hint
        // links to it.
        let otherCommunity = null;
        if (activeConversation && activeConversation.communityLang) {
            const other = await pool.query(
                `SELECT c.id, c.title FROM conversations c
                 JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
                 WHERE c.community_lang = $1`,
                [otherLang(activeConversation.communityLang), userId]
            );
            otherCommunity = other.rows[0] || null;
        }

        // Load only the most recent page; older messages load on scroll-up.
        // Fetch one extra row to detect whether older history exists.
        const messagesResult = await pool.query(
            `SELECT * FROM (
                 SELECT ${MESSAGE_COLUMNS} ${MESSAGE_JOINS}
                 WHERE m.conversation_id = $1
                   AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = $3)
                   AND ${afterHidden('$3')}
                 ORDER BY m.created_at DESC, m.id DESC LIMIT $2
             ) sub ORDER BY created_at ASC, id ASC`,
            [convId, PAGE_SIZE + 1, userId]
        );
        let hasMoreHistory = false;
        if (messagesResult.rows.length > PAGE_SIZE) {
            hasMoreHistory = true;
            messagesResult.rows.shift(); // drop the probe row (only detects "more")
        }

        const msgIds = messagesResult.rows.map(m => m.id);
        const reactionsMap = await getReactionsForMessages(msgIds, userId);
        attachReplyInfo(messagesResult.rows, userId, lang);
        await attachPolls(messagesResult.rows, userId, { isModerator: isAdmin });
        for (const m of messagesResult.rows) {
            m.reactions = reactionsMap[m.id] || [];
            if (m.content) {
                m.contentHtml = linkifyMessageContent(m.content, lang);
            }
        }

        // First unread message (from someone else, after our previous read time)
        // — used to draw the "new messages" divider and scroll there.
        let firstUnreadId = null;
        if (prevLastRead) {
            const prev = new Date(prevLastRead).getTime();
            for (const mm of messagesResult.rows) {
                if (mm.sender_id !== userId && !mm.deleted_at && new Date(mm.created_at).getTime() > prev) {
                    firstUnreadId = mm.id;
                    break;
                }
            }
        }

        // Read receipts (DMs only — not groups or the Saved self-chat).
        const showReceipts = !!(activeConversation && !activeConversation.is_group && !activeConversation.isSaved);
        const readCutoffDate = showReceipts ? await getReadCutoff(convId, userId) : null;
        const readCutoff = readCutoffDate ? new Date(readCutoffDate).toISOString() : null;
        const pinnedMessage = activeConversation ? await getPinnedSummary(convId, lang) : null;

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
                community_lang: activeConversation.communityLang,
                muted: activeMuted,
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
            // Others see on a suspended member's messages that they cannot write here for now;
            // the member's own messages are on the "sent" side, which carries no sender line.
            m.senderSuspendedUntil = m.sender_id !== userId && isPostingBlocked(m.sender_blocked_until) ? m.sender_blocked_until : null;
            m.senderSuspendedForGood = !!m.senderSuspendedUntil && isPermanent(m.senderSuspendedUntil);
        }

        res.render('messages', {
            __: req.__,
            lang,
            attachmentRules: attachments.clientRules(),
            attachmentAccept: attachments.acceptAttribute(),
            timeZone: readerTimeZone(req),
            conversations: updatedConvList,
            activeConversation,
            messages: messagesResult.rows,
            userId,
            username: req.session.username,
            isAdmin,
            membersList,
            groupAvatarSVG,
            hasMoreHistory,
            showReceipts,
            readCutoff,
            pinnedMessage,
            firstUnreadId,
            muted: activeMuted,
            otherCommunity,
            postingBlocked,
        });
    } catch (err) {
        console.error('Messages conversation error:', err);
        res.status(500).send('Internal server error');
    }
});

// GET /messages/:id/history — older messages (pagination, scroll-up)
router.get('/:id(\\d+)/history', async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = normalizeLang(req.session.lang);
        const convId = parseInt(req.params.id);
        const beforeId = parseInt(req.query.before) || 0;
        if (!beforeId) return res.json({ messages: [], hasMore: false });

        const membership = await pool.query(
            `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        if (membership.rows.length === 0) {
            return res.status(403).json({ error: 'Not a member' });
        }

        // Page by (created_at, id), the order the chat is drawn in, not by id alone. Ids
        // and timestamps disagree for messages inserted after the fact: the English halves
        // of the split bilingual announcements got new ids but keep their original time,
        // and `id < before` would never return them on scroll-up.
        const result = await pool.query(
            `SELECT * FROM (
                 SELECT ${MESSAGE_COLUMNS} ${MESSAGE_JOINS}
                 WHERE m.conversation_id = $1
                   AND (m.created_at, m.id) < (SELECT cur.created_at, cur.id FROM messages cur WHERE cur.id = $2)
                   AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = $4)
                   AND ${afterHidden('$4')}
                 ORDER BY m.created_at DESC, m.id DESC LIMIT $3
             ) sub ORDER BY created_at ASC, id ASC`,
            [convId, beforeId, PAGE_SIZE + 1, userId]
        );
        let hasMore = false;
        if (result.rows.length > PAGE_SIZE) {
            hasMore = true;
            result.rows.shift();
        }

        const ids = result.rows.map(m => m.id);
        const reactionsMap = await getReactionsForMessages(ids, userId);
        attachReplyInfo(result.rows, userId, lang);
        await attachPolls(result.rows, userId, { isModerator: await moderatesConversation(convId, userId, req.session.username) });
        for (const m of result.rows) {
            m.reactions = reactionsMap[m.id] || [];
            if (m.content) m.contentHtml = linkifyMessageContent(m.content, lang);
        }

        res.json({ messages: result.rows, hasMore });
    } catch (err) {
        console.error('History error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /messages/new — start a new conversation (or find existing DM)
router.post('/new', rateLimit('new', 15, 60000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const { recipientId, recipientIds, title } = req.body;
        const newBlocked = await postingBlockFor(userId, null);
        if (newBlocked) return res.status(403).json({ error: blockedNotice(newBlocked, normalizeLang(req.session.lang), readerTimeZone(req)), blocked: true });
        if (recipientId && !(recipientIds && recipientIds.length > 1)) {
            const dmBlocked = await dmBlockNotice(userId, { otherId: parseInt(recipientId) }, normalizeLang(req.session.lang));
            if (dmBlocked) return res.status(403).json({ error: dmBlocked, blocked: true });
        }

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
                return res.redirect(messagesPath(normalizeLang(req.session.lang), convId));
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
            return res.redirect(messagesPath(normalizeLang(req.session.lang)));
        }

        const targetUser = await pool.query('SELECT id FROM users WHERE id = $1', [targetId]);
        if (targetUser.rows.length === 0) {
            return res.redirect(messagesPath(normalizeLang(req.session.lang)));
        }

        const convId = await findOrCreateDM(userId, targetId);
        res.redirect(messagesPath(normalizeLang(req.session.lang), convId));
    } catch (err) {
        console.error('New conversation error:', err);
        res.status(500).send('Internal server error');
    }
});

// POST /messages/:id/send — send a message (with optional image or file)
router.post('/:id(\\d+)/send', rateLimit('send', 25, 10000), msgUploadMiddleware, async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = normalizeLang(req.session.lang);
        const convId = parseInt(req.params.id);
        const content = (req.body.content || '').trim().substring(0, 5000);

        // An uploaded attachment is an inline image, an inline video or a downloadable file card.
        // A video keeps the file columns (name, size, download fallback) and puts its pixel size
        // in image_width / image_height, which are the attachment's box for either kind.
        let imageUrl = null, imageW = null, imageH = null, imagePlaceholder = null;
        let fileUrl = null, fileName = null, fileSize = null, attachmentStatus = null;
        let conversion = null;   // { mode } when the video must be converted before it can play
        if (req.file) {
            const kind = attachments.kindOf(req.file.originalname);
            if (req.file.size > attachments.limitFor(req.file.originalname)) {
                await fs.promises.unlink(req.file.path).catch(() => {});
                const msg = tooLarge(req.file.originalname);
                if (req.xhr || req.headers.accept?.includes('application/json')) return res.status(400).json({ error: msg });
                return res.status(400).send(msg);
            }
            const url = '/img/messages/' + req.file.filename;
            // "Send as a document": a picture, video or audio file shown as a download card, untouched.
            const asDocument = req.body.as_document === '1' && kind !== 'file';
            if (kind === 'image' && !asDocument) {
                imageUrl = url;
                const meta = await processImageMeta(req.file.path);
                imageW = meta.width; imageH = meta.height; imagePlaceholder = meta.placeholder;
            } else {
                fileUrl = url;
                fileName = (req.file.originalname || 'file').substring(0, 255);
                fileSize = req.file.size;
                if (asDocument) {
                    attachmentStatus = 'document';
                } else if (kind === 'video' || kind === 'audio') {
                    if (kind === 'video') {
                        const dims = videoDimensions(req.file.path);
                        if (dims) { imageW = dims.width; imageH = dims.height; }
                    }
                    if (await conversionTools()) {
                        const info = await transcode.probe(req.file.path);
                        const mode = transcode.conversionNeeded(info, attachments.extensionOf(fileName));
                        if (mode === 'none') { if (kind === 'video') imagePlaceholder = await transcode.posterPlaceholder(req.file.path); }
                        else { attachmentStatus = 'converting'; conversion = { mode }; }
                    }
                }
            }
        }

        if (!content && !imageUrl && !fileUrl) {
            return res.redirect(messagesPath(lang, convId));
        }

        // Check membership
        const membership = await pool.query(
            `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        if (membership.rows.length === 0) {
            return res.status(403).send('Not a member');
        }
        const blockedUntil = await postingBlockFor(userId, convId);
        if (blockedUntil) {
            if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
            return res.status(403).json({ error: blockedNotice(blockedUntil, lang, readerTimeZone(req)), blocked: true });
        }
        const dmBlocked = await dmBlockNotice(userId, { convId }, lang);
        if (dmBlocked) {
            if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
            return res.status(403).json({ error: dmBlocked, blocked: true });
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
            `INSERT INTO messages (conversation_id, sender_id, content, image_url, reply_to_id, file_url, file_name, file_size, image_width, image_height, image_placeholder, attachment_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, created_at`,
            [convId, userId, content, imageUrl, replyToId, fileUrl, fileName, fileSize, imageW, imageH, imagePlaceholder, attachmentStatus]
        );
        if (conversion) scheduleConversion(fileUrl, req.file.path, conversion.mode);
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

        // Sending implies they stopped typing.
        clearTyping(convId, userId);

        // Notify other members
        let preview;
        if (fileUrl) preview = attachments.kindOf(fileName) === 'video' ? '[Video]' : attachments.kindOf(fileName) === 'audio' ? '[Audio]' : (fileName || '[File]');
        else if (imageUrl && !content) preview = '[Image]';
        else preview = content.length > 80 ? content.substring(0, 80) + '...' : content;
        await notifications.createMessageNotifications(
            convId,
            userId,
            `New message from ${req.session.username}`,
            preview,
            `/messages/${convId}`,
            inserted.rows[0].id
        );

        // Live-push the new message to the other members (the sender's own tab
        // renders it optimistically, so exclude the sender to avoid a race).
        try {
            const full = await pool.query(
                `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_JOINS} WHERE m.id = $1`,
                [inserted.rows[0].id]
            );
            if (full.rows.length) {
                attachReplyInfo(full.rows, userId, lang);
                full.rows[0].reactions = [];
                await broadcastToConversation(convId, 'msg:new',
                    { conversationId: convId, message: full.rows[0] }, userId);
            }
        } catch (e) { console.error('SSE broadcast (send) error:', e); }

        // If AJAX request, return JSON
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            const msg = inserted.rows[0];
            return res.json({
                ok: true, id: msg.id, created_at: msg.created_at,
                image_url: imageUrl, file_url: fileUrl, file_name: fileName, file_size: fileSize,
                attachment_status: attachmentStatus,
            });
        }
        res.redirect(messagesPath(lang, convId));
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).send('Internal server error');
    }
});

// PUT /messages/:msgId/edit — edit a message (within 24h, sender only)
router.put('/:msgId(\\d+)/edit', rateLimit('edit', 30, 10000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const msgId = parseInt(req.params.msgId);
        const { content } = req.body;

        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        const msg = await pool.query(
            `SELECT id, sender_id, conversation_id, created_at, deleted_at, poll_id FROM messages WHERE id = $1`,
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
        // A poll is not editable (as on Telegram): the bubble is its options, not text.
        if (m.poll_id) return res.status(400).json({ error: 'A poll cannot be edited' });
        const ageMs = Date.now() - new Date(m.created_at).getTime();
        if (ageMs > 24 * 60 * 60 * 1000) {
            return res.status(403).json({ error: 'Can only edit messages within 24 hours' });
        }

        const trimmed = content.trim().substring(0, 5000);
        await pool.query(
            `UPDATE messages SET content = $1, edited_at = NOW() WHERE id = $2`,
            [trimmed, msgId]
        );
        broadcastToConversation(m.conversation_id, 'msg:edit',
            { conversationId: m.conversation_id, id: msgId, content: trimmed, edited_at: new Date().toISOString() },
            userId).catch(() => {});
        res.json({ ok: true });
    } catch (err) {
        console.error('Edit message error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /messages/:msgId/delete — delete a message (within 24h for sender, anytime for admin)
router.delete('/:msgId(\\d+)/delete', rateLimit('edit', 30, 10000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const msgId = parseInt(req.params.msgId);

        const msg = await pool.query(
            `SELECT m.id, m.sender_id, m.conversation_id, m.created_at, m.deleted_at, m.content,
                    m.file_url, m.file_name,
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
        // The bell rows this message put in other people's headers go with it (a moderator
        // deleting a spree used to leave every member 32 "New message from" entries, 2026-09-21).
        await notifications.removeForMessage(msgId);
        await pool.query(
            `UPDATE conversations c SET last_message_at = COALESCE(
                 (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL), c.created_at)
             WHERE c.id = $1`,
            [m.conversation_id]
        );
        await removeVideoFile(m.file_url, m.file_name, msgId);

        broadcastToConversation(m.conversation_id, 'msg:delete',
            { conversationId: m.conversation_id, id: msgId }, userId).catch(() => {});

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
router.post('/:msgId(\\d+)/react', rateLimit('react', 40, 10000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const reactBlocked = await postingBlockFor(userId, null);
        if (reactBlocked) return res.status(403).json({ error: blockedNotice(reactBlocked, normalizeLang(req.session.lang), readerTimeZone(req)), blocked: true });
        const msgId = parseInt(req.params.msgId);
        const { emoji } = req.body;

        // One vocabulary for the whole site (js/reactions.js): the six Unicode emoji and the
        // community's :shortcode: set. Anything else never reaches the database.
        if (!isKnownReaction(emoji)) {
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

        // Taking a reaction back always works; adding a retired emoji does not, and a premium
        // one (bought with quanta in lastProblem.js) needs to be owned.
        const alreadyHas = existing.rows.length > 0;
        const owned = !alreadyHas && isPremium(emoji) ? await ownsReaction(pool, userId, emoji) : false;
        const action = reactionAction(emoji, alreadyHas, owned);
        if (action === 'locked') {
            return res.status(403).json({ error: 'locked' });
        }
        if (action === 'reject') {
            return res.status(400).json({ error: 'Invalid reaction' });
        }
        if (action === 'remove') {
            await pool.query(`DELETE FROM message_reactions WHERE id = $1`, [existing.rows[0].id]);
        } else {
            // A double click sends two adds; without ON CONFLICT the second hit the UNIQUE
            // constraint and answered 500.
            await pool.query(
                `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
                 ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
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

        broadcastReactions(msg.rows[0].conversation_id, msgId, userId).catch(() => {});
        res.json({ ok: true, reactions: reactions.rows });
    } catch (err) {
        console.error('React error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /messages/:msgId/pin — toggle a message's pinned state
router.post('/:msgId(\\d+)/pin', rateLimit('pin', 30, 10000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = normalizeLang(req.session.lang);
        const msgId = parseInt(req.params.msgId);

        const msg = await pool.query(
            `SELECT m.id, m.conversation_id, m.pinned_at, m.deleted_at, c.is_group
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
             WHERE m.id = $1`,
            [msgId]
        );
        if (msg.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
        const m = msg.rows[0];
        if (m.deleted_at) return res.status(400).json({ error: 'Message was deleted' });

        // Must be a member; in groups, only admins may pin/unpin.
        const mem = await pool.query(
            `SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
            [m.conversation_id, userId]
        );
        if (mem.rows.length === 0) return res.status(403).json({ error: 'Not a member' });
        if (m.is_group && mem.rows[0].role !== 'admin') {
            return res.status(403).json({ error: 'Only moderators can pin messages' });
        }

        const nowPinned = !m.pinned_at;
        if (nowPinned) {
            await pool.query(`UPDATE messages SET pinned_at = NOW(), pinned_by = $2 WHERE id = $1`, [msgId, userId]);
        } else {
            await pool.query(`UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1`, [msgId]);
        }

        const pinnedMessage = await getPinnedSummary(m.conversation_id, lang);
        broadcastToConversation(m.conversation_id, 'pin',
            { conversationId: m.conversation_id, pinnedMessage }, userId).catch(() => {});
        res.json({ ok: true, pinned: nowPinned, pinnedMessage });
    } catch (err) {
        console.error('Pin error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /messages/forward — forward a message into another conversation
router.post('/forward', rateLimit('forward', 20, 10000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const messageId = parseInt(req.body.messageId);
        const toConversationId = req.body.toConversationId ? parseInt(req.body.toConversationId) : null;
        const toUserId = req.body.toUserId ? parseInt(req.body.toUserId) : null;
        const toSaved = req.body.toSaved === true || req.body.toSaved === 'true';

        if (!messageId) return res.status(400).json({ error: 'Missing message' });

        // Source must be readable by the user (member of its conversation).
        const src = await pool.query(
            `SELECT m.id, m.sender_id, m.content, m.image_url, m.image_width, m.image_height,
                    m.image_placeholder, m.file_url, m.file_name, m.attachment_status,
                    m.file_size, m.forwarded_from_user_id, m.deleted_at, m.poll_id
             FROM messages m
             JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
             WHERE m.id = $1`,
            [messageId, userId]
        );
        if (src.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
        const s = src.rows[0];
        if (s.deleted_at) return res.status(400).json({ error: 'Message was deleted' });

        // Resolve the target conversation.
        let targetId;
        if (toSaved) {
            targetId = await findOrCreateSavedMessages(userId);
        } else if (toConversationId) {
            const t = await pool.query(
                `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
                [toConversationId, userId]
            );
            if (t.rows.length === 0) return res.status(403).json({ error: 'Not a member of target' });
            targetId = toConversationId;
        } else if (toUserId) {
            if (toUserId === userId) {
                targetId = await findOrCreateSavedMessages(userId);
            } else {
                const u = await pool.query('SELECT id FROM users WHERE id = $1', [toUserId]);
                if (u.rows.length === 0) return res.status(404).json({ error: 'User not found' });
                targetId = await findOrCreateDM(userId, toUserId);
            }
        } else {
            return res.status(400).json({ error: 'No target' });
        }

        const fwdBlocked = await postingBlockFor(userId, targetId);
        if (fwdBlocked) {
            return res.status(403).json({ error: blockedNotice(fwdBlocked, normalizeLang(req.session.lang), readerTimeZone(req)), blocked: true });
        }
        const fwdDmBlocked = await dmBlockNotice(userId, { convId: targetId }, normalizeLang(req.session.lang));
        if (fwdDmBlocked) return res.status(403).json({ error: fwdDmBlocked, blocked: true });

        // Preserve the original author across forward chains.
        const origin = s.forwarded_from_user_id || s.sender_id;

        const fwd = await pool.query(
            `INSERT INTO messages (conversation_id, sender_id, content, image_url, file_url, file_name, file_size, forwarded_from_user_id, image_width, image_height, image_placeholder, attachment_status, poll_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
            [targetId, userId, s.content, s.image_url, s.file_url, s.file_name, s.file_size, origin, s.image_width, s.image_height, s.image_placeholder, s.attachment_status, s.poll_id || null]
        );
        await pool.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1`, [targetId]);
        await pool.query(
            `UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2`,
            [targetId, userId]
        );

        const preview = s.file_url ? (s.file_name || '[File]')
            : (s.image_url && !s.content ? '[Image]' : (s.content || '').substring(0, 80));
        await notifications.createMessageNotifications(
            targetId, userId, `New message from ${req.session.username}`, preview, `/messages/${targetId}`, fwd.rows[0].id
        );

        // Live-push into the target conversation (the forwarder gets it on nav).
        try {
            const lang = normalizeLang(req.session.lang);
            const full = await pool.query(
                `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_JOINS} WHERE m.id = $1`,
                [fwd.rows[0].id]
            );
            if (full.rows.length) {
                attachReplyInfo(full.rows, userId, lang);
                await attachPolls(full.rows, null);
                full.rows[0].reactions = [];
                await broadcastToConversation(targetId, 'msg:new',
                    { conversationId: targetId, message: full.rows[0] }, userId);
            }
        } catch (e) { console.error('SSE broadcast (forward) error:', e); }

        res.json({ ok: true, conversationId: targetId });
    } catch (err) {
        console.error('Forward error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /messages/:id/typing — record that the user is typing (ephemeral)
router.post('/:id(\\d+)/typing', rateLimit('typing', 25, 10000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const convId = parseInt(req.params.id);
        const membership = await pool.query(
            `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        if (membership.rows.length === 0) return res.status(403).json({ error: 'Not a member' });
        setTyping(convId, userId, req.session.username);

        // Push each connected member their own "who's typing" view (excludes self).
        try {
            const members = await pool.query(
                `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
                [convId]
            );
            for (const row of members.rows) {
                if (row.user_id === userId || !sseClients.has(row.user_id)) continue;
                sseSend(row.user_id, 'typing',
                    { conversationId: convId, names: getTypingOthers(convId, row.user_id) });
            }
        } catch (e) { /* non-fatal */ }

        res.json({ ok: true });
    } catch (err) {
        console.error('Typing error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Group management ────────────────────────────────────────────────────
async function requireGroupAdmin(convId, userId) {
    const r = await pool.query(
        `SELECT c.is_group, cm.role FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
         WHERE c.id = $1`,
        [convId, userId]
    );
    if (r.rows.length === 0) return { ok: false, code: 403, error: 'Not a member' };
    if (!r.rows[0].is_group) return { ok: false, code: 400, error: 'Not a group' };
    if (r.rows[0].role !== 'admin') return { ok: false, code: 403, error: 'Admins only' };
    return { ok: true };
}

// POST /:id/group/rename
router.post('/:id(\\d+)/group/rename', rateLimit('group', 20, 60000), async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const chk = await requireGroupAdmin(convId, req.session.userId);
        if (!chk.ok) return res.status(chk.code).json({ error: chk.error });
        const title = (req.body.title || '').trim().substring(0, 100);
        if (!title) return res.status(400).json({ error: 'Title required' });
        await pool.query(`UPDATE conversations SET title = $1 WHERE id = $2`, [title, convId]);
        res.json({ ok: true, title });
    } catch (e) { console.error('Group rename error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /:id/group/add  { userIds: [...] }
router.post('/:id(\\d+)/group/add', rateLimit('group', 20, 60000), async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const chk = await requireGroupAdmin(convId, req.session.userId);
        if (!chk.ok) return res.status(chk.code).json({ error: chk.error });
        const ids = (Array.isArray(req.body.userIds) ? req.body.userIds : []).map(x => parseInt(x)).filter(Boolean);
        if (!ids.length) return res.status(400).json({ error: 'No users' });
        for (const uid of ids) {
            await pool.query(
                `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)
                 ON CONFLICT (conversation_id, user_id) DO NOTHING`,
                [convId, uid]
            );
        }
        res.json({ ok: true });
    } catch (e) { console.error('Group add error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /:id/group/remove  { userId }
router.post('/:id(\\d+)/group/remove', rateLimit('group', 20, 60000), async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const chk = await requireGroupAdmin(convId, req.session.userId);
        if (!chk.ok) return res.status(chk.code).json({ error: chk.error });
        const target = parseInt(req.body.userId);
        if (!target) return res.status(400).json({ error: 'No user' });
        if (target === req.session.userId) return res.status(400).json({ error: 'Use leave instead' });
        await pool.query(`DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [convId, target]);
        res.json({ ok: true });
    } catch (e) { console.error('Group remove error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /:id/group/role  { userId, role }
router.post('/:id(\\d+)/group/role', rateLimit('group', 20, 60000), async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const chk = await requireGroupAdmin(convId, req.session.userId);
        if (!chk.ok) return res.status(chk.code).json({ error: chk.error });
        const target = parseInt(req.body.userId);
        const role = req.body.role === 'admin' ? 'admin' : 'member';
        if (!target) return res.status(400).json({ error: 'No user' });
        await pool.query(`UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2`, [convId, target, role]);
        res.json({ ok: true });
    } catch (e) { console.error('Group role error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /:id/group/leave
router.post('/:id(\\d+)/group/leave', rateLimit('group', 20, 60000), async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const userId = req.session.userId;
        const r = await pool.query(
            `SELECT c.is_group, c.community_lang FROM conversations c
             JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
             WHERE c.id = $1`,
            [convId, userId]
        );
        if (r.rows.length === 0) return res.status(403).json({ error: 'Not a member' });
        if (!r.rows[0].is_group) return res.status(400).json({ error: 'Not a group' });
        // Nothing can add a person back to a community chat once they leave, so the way to
        // quiet one is the mute button, which is reversible.
        if (r.rows[0].community_lang) return res.status(400).json({ error: 'Mute this chat instead of leaving it' });
        await pool.query(`DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [convId, userId]);
        // If the group lost its last admin, promote the earliest remaining member.
        const admins = await pool.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND role = 'admin' LIMIT 1`, [convId]);
        if (admins.rows.length === 0) {
            await pool.query(
                `UPDATE conversation_members SET role = 'admin'
                 WHERE conversation_id = $1 AND user_id = (
                     SELECT user_id FROM conversation_members WHERE conversation_id = $1 ORDER BY joined_at ASC LIMIT 1
                 )`,
                [convId]
            );
        }
        res.json({ ok: true });
    } catch (e) { console.error('Group leave error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /:id/mute — toggle mute for the current member
// ── Polls ───────────────────────────────────────────────────────────────────────────────────
// POST /messages/:id/poll — a new poll in a conversation (JSON body, lib/polls.js validates).
router.post('/:id(\\d+)/poll', rateLimit('send', 25, 10000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = normalizeLang(req.session.lang);
        const convId = parseInt(req.params.id);
        const membership = await pool.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, userId]);
        if (!membership.rows.length) return res.status(403).json({ error: 'Not a member' });
        const blockedUntil = await postingBlockFor(userId, convId);
        if (blockedUntil) return res.status(403).json({ error: blockedNotice(blockedUntil, lang, readerTimeZone(req)), blocked: true });
        const dmBlocked = await dmBlockNotice(userId, { convId }, lang);
        if (dmBlocked) return res.status(403).json({ error: dmBlocked, blocked: true });

        const v = pollRules.validatePollInput(req.body);
        if (!v.ok) return res.status(400).json({ error: v.error });
        const p = v.poll;

        const client = await pool.connect();
        let pollId, inserted;
        try {
            await client.query('BEGIN');
            const created = await client.query(
                `INSERT INTO polls (created_by, question, anonymous, multiple, revote, shuffle, quiz, closes_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                [userId, p.question, p.anonymous, p.multiple, p.revote, p.shuffle, p.quiz, p.closesAt]);
            pollId = created.rows[0].id;
            const optionIds = [];
            for (let i = 0; i < p.options.length; i++) {
                const o = await client.query('INSERT INTO poll_options (poll_id, position, text) VALUES ($1, $2, $3) RETURNING id', [pollId, i, p.options[i]]);
                optionIds.push(o.rows[0].id);
            }
            if (p.quiz) await client.query('UPDATE polls SET correct_option_id = $2 WHERE id = $1', [pollId, optionIds[p.correctIndex]]);
            inserted = await client.query(
                `INSERT INTO messages (conversation_id, sender_id, content, poll_id) VALUES ($1, $2, '', $3) RETURNING id, created_at`,
                [convId, userId, pollId]);
            await client.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [convId]);
            await client.query('UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2', [convId, userId]);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
        clearTyping(convId, userId);
        await notifications.createMessageNotifications(convId, userId, `New message from ${req.session.username}`,
            (lang === 'ru' ? 'Опрос: ' : 'Poll: ') + p.question.substring(0, 80), `/messages/${convId}`, inserted.rows[0].id);

        const full = await pool.query(`SELECT ${MESSAGE_COLUMNS} ${MESSAGE_JOINS} WHERE m.id = $1`, [inserted.rows[0].id]);
        attachReplyInfo(full.rows, userId, lang);
        full.rows[0].reactions = [];
        try {
            const forOthers = { ...full.rows[0] };
            await attachPolls([forOthers], null);
            await broadcastToConversation(convId, 'msg:new', { conversationId: convId, message: forOthers }, userId);
        } catch (e) { console.error('SSE broadcast (poll) error:', e); }
        await attachPolls(full.rows, userId, { isModerator: await moderatesConversation(convId, userId, req.session.username) });
        res.json({ ok: true, message: full.rows[0] });
    } catch (err) {
        console.error('Create poll error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// The poll and the conversation a member reaches it through (the newest message showing it).
async function pollForMember(pollId, userId) {
    const r = await pool.query(
        `SELECT p.*, m.conversation_id, m.id AS message_id FROM polls p
         JOIN messages m ON m.poll_id = p.id AND m.deleted_at IS NULL
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
         WHERE p.id = $1 ORDER BY m.id DESC LIMIT 1`, [pollId, userId]);
    return r.rows[0] || null;
}

// Every message showing the poll, in every chat it was forwarded to, gets the new counts.
async function announcePoll(pollId) {
    const msgs = await pool.query('SELECT id, conversation_id FROM messages WHERE poll_id = $1 AND deleted_at IS NULL', [pollId]);
    const state = (await loadPollState([pollId], null))[pollId];
    if (!state) return;
    delete state.mine; delete state.voted; delete state.canRetract; delete state.canClose;
    for (const m of msgs.rows) {
        await broadcastToConversation(m.conversation_id, 'poll:update', { conversationId: m.conversation_id, messageId: m.id, poll: state }).catch(() => {});
    }
}

async function respondPoll(res, poll, userId, username) {
    const isModerator = await moderatesConversation(poll.conversation_id, userId, username);
    const state = (await loadPollState([poll.id], userId, { managerOf: isModerator ? new Set([poll.id]) : new Set() }))[poll.id];
    res.json({ ok: true, poll: state });
}

// POST /messages/poll/:pollId/vote — { optionIds: [] }
router.post('/poll/:pollId(\\d+)/vote', rateLimit('react', 40, 10000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const poll = await pollForMember(parseInt(req.params.pollId), userId);
        if (!poll) return res.status(404).json({ error: 'Poll not found' });
        const blockedUntil = await postingBlockFor(userId, poll.conversation_id);
        if (blockedUntil) return res.status(403).json({ error: blockedNotice(blockedUntil, normalizeLang(req.session.lang), readerTimeZone(req)), blocked: true });
        const [mine, options] = await Promise.all([
            pool.query('SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [poll.id, userId]),
            pool.query('SELECT id FROM poll_options WHERE poll_id = $1', [poll.id]),
        ]);
        const v = pollRules.canVote(poll, mine.rows.map((r) => r.option_id), req.body.optionIds, { optionIdsInPoll: options.rows.map((o) => o.id) });
        if (!v.ok) return res.status(v.error === 'closed' ? 409 : 400).json({ error: v.error });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [poll.id, userId]);
            for (const id of v.ids) await client.query('INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES ($1, $2, $3)', [poll.id, id, userId]);
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
        announcePoll(poll.id).catch(() => {});
        await respondPoll(res, poll, userId, req.session.username);
    } catch (err) {
        console.error('Poll vote error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /messages/poll/:pollId/retract — take one's vote back (revoting allowed, still open)
router.post('/poll/:pollId(\\d+)/retract', rateLimit('react', 40, 10000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const poll = await pollForMember(parseInt(req.params.pollId), userId);
        if (!poll) return res.status(404).json({ error: 'Poll not found' });
        const mine = await pool.query('SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [poll.id, userId]);
        const v = pollRules.canRetract(poll, mine.rows.map((r) => r.option_id));
        if (!v.ok) return res.status(400).json({ error: v.error });
        await pool.query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [poll.id, userId]);
        announcePoll(poll.id).catch(() => {});
        await respondPoll(res, poll, userId, req.session.username);
    } catch (err) {
        console.error('Poll retract error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /messages/poll/:pollId/close — the creator or a moderator ends it
router.post('/poll/:pollId(\\d+)/close', rateLimit('react', 40, 10000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const poll = await pollForMember(parseInt(req.params.pollId), userId);
        if (!poll) return res.status(404).json({ error: 'Poll not found' });
        const isModerator = await moderatesConversation(poll.conversation_id, userId, req.session.username);
        const v = pollRules.canClose(poll, userId, { isModerator });
        if (!v.ok) return res.status(v.error === 'owner' ? 403 : 400).json({ error: v.error });
        await pool.query('UPDATE polls SET closed_at = NOW() WHERE id = $1', [poll.id]);
        poll.closed_at = new Date();
        announcePoll(poll.id).catch(() => {});
        await respondPoll(res, poll, userId, req.session.username);
    } catch (err) {
        console.error('Poll close error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /messages/poll/:pollId/voters?option= — who chose an option, in a public poll only
router.get('/poll/:pollId(\\d+)/voters', async (req, res) => {
    try {
        const userId = req.session.userId;
        const poll = await pollForMember(parseInt(req.params.pollId), userId);
        if (!poll) return res.status(404).json({ error: 'Poll not found' });
        if (poll.anonymous) return res.status(403).json({ error: 'anonymous' });
        const optionId = parseInt(req.query.option) || null;
        const r = await pool.query(
            `SELECT pv.option_id, u.username, u.profile_picture FROM poll_votes pv JOIN users u ON u.id = pv.user_id
             WHERE pv.poll_id = $1 ${optionId ? 'AND pv.option_id = $2' : ''} ORDER BY pv.created_at LIMIT 200`,
            optionId ? [poll.id, optionId] : [poll.id]);
        res.json({ voters: r.rows });
    } catch (err) {
        console.error('Poll voters error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /messages/block/:userId and /unblock/:userId — user_blocks (migration 064). The
// blocked person can no longer write to this one; nothing about the messages changes.
router.post('/block/:userId(\\d+)', rateLimit('block', 20, 60000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const otherId = parseInt(req.params.userId);
        if (otherId === userId) return res.status(400).json({ error: 'Cannot block yourself' });
        const u = await pool.query('SELECT 1 FROM users WHERE id = $1', [otherId]);
        if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
        await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, otherId]);
        res.json({ ok: true, blocked: true });
    } catch (err) {
        console.error('Block error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/unblock/:userId(\\d+)', rateLimit('block', 20, 60000), async (req, res) => {
    try {
        await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.session.userId, parseInt(req.params.userId)]);
        res.json({ ok: true, blocked: false });
    } catch (err) {
        console.error('Unblock error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /messages/:id/delete-chat — a one-to-one chat leaves this member's view: their own
// membership row is stamped (hidden_at), nothing is deleted, the other member sees everything.
router.post('/:id(\\d+)/delete-chat', rateLimit('block', 20, 60000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const convId = parseInt(req.params.id);
        const c = await pool.query(
            `SELECT c.is_group, c.saved_for_user_id FROM conversations c
             JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
             WHERE c.id = $1`, [convId, userId]);
        if (!c.rows.length) return res.status(403).json({ error: 'Not a member' });
        if (c.rows[0].is_group || c.rows[0].saved_for_user_id) return res.status(400).json({ error: 'Only a one-to-one chat can be deleted' });
        await pool.query('UPDATE conversation_members SET hidden_at = NOW(), last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2', [convId, userId]);
        res.json({ ok: true, redirect: messagesPath(normalizeLang(req.session.lang)) });
    } catch (err) {
        console.error('Delete chat error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:id(\\d+)/mute', async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const r = await pool.query(
            `UPDATE conversation_members SET muted = NOT muted
             WHERE conversation_id = $1 AND user_id = $2 RETURNING muted`,
            [convId, req.session.userId]
        );
        if (r.rows.length === 0) return res.status(403).json({ error: 'Not a member' });
        res.json({ ok: true, muted: r.rows[0].muted });
    } catch (e) { console.error('Mute error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ── The chat's info panel (Telegram's "profile" of a chat) ─────────────────────────────
// GET /messages/:id/info — who is in it and how much it holds: photos, videos, files, audio and
// links, counted with the same extension lists the uploads use (lib/messageAttachments.js).
// GET /messages/:id/media?kind=photos|videos|files|audio|links&before=<id> — one list, newest
// first, 60 at a time, for the panel's sub-views. Both only for members.
const extRegex = (list) => `\\.(${list.join('|')})$`;
const MEDIA_WHERE = {
    photos: `m.image_url IS NOT NULL`,
    videos: `m.file_url IS NOT NULL AND m.file_name ~* '${extRegex(attachments.VIDEO_EXTENSIONS)}' AND m.attachment_status IS NULL`,
    audio: `m.file_url IS NOT NULL AND m.file_name ~* '${extRegex(attachments.AUDIO_EXTENSIONS)}' AND m.attachment_status IS NULL`,
    files: `m.file_url IS NOT NULL AND (m.file_name !~* '${extRegex([...attachments.VIDEO_EXTENSIONS, ...attachments.AUDIO_EXTENSIONS])}' OR m.attachment_status IS NOT NULL)`,
    links: `m.content ~ 'https?://'`,
};

async function isMember(convId, userId) {
    const r = await pool.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, userId]);
    return r.rows.length > 0;
}

router.get('/:id(\\d+)/info', async (req, res) => {
    try {
        const userId = req.session.userId;
        const convId = parseInt(req.params.id);
        if (!(await isMember(convId, userId))) return res.status(403).json({ error: 'Not a member' });
        const counts = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE ${MEDIA_WHERE.photos})::int AS photos,
                    COUNT(*) FILTER (WHERE ${MEDIA_WHERE.videos})::int AS videos,
                    COUNT(*) FILTER (WHERE ${MEDIA_WHERE.files})::int AS files,
                    COUNT(*) FILTER (WHERE ${MEDIA_WHERE.audio})::int AS audio,
                    COUNT(*) FILTER (WHERE ${MEDIA_WHERE.links})::int AS links
             FROM messages m WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND ${afterHidden('$2')}`,
            [convId, userId]
        );
        const members = await membersPage(convId, 0);
        const total = await pool.query('SELECT COUNT(*)::int AS n FROM conversation_members WHERE conversation_id = $1', [convId]);
        res.json({ counts: counts.rows[0], memberCount: total.rows[0].n, members });
    } catch (e) { console.error('Chat info error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// The members, MEMBERS_PAGE at a time (the Russian community chat has over a thousand): the
// moderators first, then by when they joined. GET /messages/:id/members?offset=N pages on.
const MEMBERS_PAGE = 50;
async function membersPage(convId, offset) {
    const r = await pool.query(
        `SELECT u.id, u.username, u.full_name, u.profile_picture, cm.role
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.conversation_id = $1
         ORDER BY cm.role DESC, cm.joined_at ASC, u.id ASC LIMIT $2 OFFSET $3`,
        [convId, MEMBERS_PAGE, offset]
    );
    const online = await getOnlineUsernames(pool, r.rows.map((m) => m.username).filter(Boolean));
    return r.rows.map((m) => ({ ...m, isOnline: online.has(m.username) }));
}

router.get('/:id(\\d+)/members', async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        if (!(await isMember(convId, req.session.userId))) return res.status(403).json({ error: 'Not a member' });
        const offset = Math.max(0, parseInt(req.query.offset) || 0);
        const members = await membersPage(convId, offset);
        res.json({ members, more: members.length === MEMBERS_PAGE });
    } catch (e) { console.error('Chat members error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/:id(\\d+)/media', async (req, res) => {
    try {
        const userId = req.session.userId;
        const convId = parseInt(req.params.id);
        const kind = String(req.query.kind || '');
        if (!MEDIA_WHERE[kind]) return res.status(400).json({ error: 'Unknown kind' });
        if (!(await isMember(convId, userId))) return res.status(403).json({ error: 'Not a member' });
        const before = parseInt(req.query.before) || null;
        const r = await pool.query(
            `SELECT m.id, m.created_at, m.content, m.image_url, m.image_width, m.image_height, m.image_placeholder,
                    m.file_url, m.file_name, m.file_size, m.attachment_status, u.username AS sender_username
             FROM messages m LEFT JOIN users u ON u.id = m.sender_id
             WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND ${MEDIA_WHERE[kind]}
               AND ${afterHidden('$2')}
               ${before ? 'AND m.id < $3' : ''}
             ORDER BY m.created_at DESC, m.id DESC LIMIT 60`,
            before ? [convId, userId, before] : [convId, userId]
        );
        res.json({ kind, items: r.rows, more: r.rows.length === 60 });
    } catch (e) { console.error('Chat media error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /:msgId/hide — "delete for me" (hide a message for the current user only)
router.post('/:msgId(\\d+)/hide', async (req, res) => {
    try {
        const userId = req.session.userId;
        const msgId = parseInt(req.params.msgId);
        const m = await pool.query(
            `SELECT 1 FROM messages msg
             JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id AND cm.user_id = $2
             WHERE msg.id = $1`,
            [msgId, userId]
        );
        if (m.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
        await pool.query(
            `INSERT INTO message_hidden (message_id, user_id) VALUES ($1, $2)
             ON CONFLICT (message_id, user_id) DO NOTHING`,
            [msgId, userId]
        );
        res.json({ ok: true });
    } catch (e) { console.error('Hide error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /:msgId/report — report a message to moderators
router.post('/:msgId(\\d+)/report', rateLimit('report', 10, 60000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const msgId = parseInt(req.params.msgId);
        const reason = (req.body.reason || '').trim().substring(0, 500);
        const m = await pool.query(
            `SELECT msg.sender_id FROM messages msg
             JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id AND cm.user_id = $2
             WHERE msg.id = $1 AND msg.deleted_at IS NULL`,
            [msgId, userId]
        );
        if (m.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
        if (m.rows[0].sender_id === userId) return res.status(400).json({ error: 'Cannot report your own message' });
        await pool.query(
            `INSERT INTO message_reports (message_id, reporter_id, reason) VALUES ($1, $2, $3)
             ON CONFLICT (message_id, reporter_id) DO NOTHING`,
            [msgId, userId, reason || null]
        );
        res.json({ ok: true });
    } catch (e) { console.error('Report error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /:id/search?q= — search messages within a conversation
router.get('/:id(\\d+)/search', async (req, res) => {
    try {
        const userId = req.session.userId;
        const convId = parseInt(req.params.id);
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.json({ results: [] });
        const membership = await pool.query(
            `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        if (membership.rows.length === 0) return res.status(403).json({ error: 'Not a member' });
        const r = await pool.query(
            `SELECT m.id, m.content, m.created_at, u.username AS sender_username
             FROM messages m LEFT JOIN users u ON u.id = m.sender_id
             WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND m.content ILIKE $2
               AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = $3)
               AND ${afterHidden('$3')}
             ORDER BY m.created_at DESC LIMIT 30`,
            [convId, '%' + q + '%', userId]
        );
        res.json({ results: r.rows });
    } catch (e) { console.error('Message search error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /messages/:id/read — mark conversation as read (AJAX)
router.post('/:id(\\d+)/read', async (req, res) => {
    try {
        const convId = parseInt(req.params.id);
        const userId = req.session.userId;
        await pool.query(
            `UPDATE conversation_members SET last_read_at = NOW()
             WHERE conversation_id = $1 AND user_id = $2`,
            [convId, userId]
        );
        // Let other members' read receipts advance (correct for DMs; groups ignore it).
        broadcastToConversation(convId, 'read',
            { conversationId: convId, readCutoff: new Date().toISOString() }, userId).catch(() => {});
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
        const lang = normalizeLang(req.session.lang);
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
            groupAvatarSvg: c.is_group ? groupAvatarSVG(c.id, c.displayName, 44, c.community_lang) : null,
            community_lang: c.community_lang || null,
            muted: !!c.muted,
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
        const lang = normalizeLang(req.session.lang);
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
            `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_JOINS}
             WHERE m.conversation_id = $1 AND m.id > $2
               AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = $3)
               AND ${afterHidden('$3')}
             ORDER BY m.created_at ASC, m.id ASC`,
            [convId, afterId, userId]
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
        await attachPolls(result.rows, userId, { isModerator: await moderatesConversation(convId, userId, req.session.username) });
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

        // Read-receipt progress + current pinned message, so both update live.
        const readCutoffDate = await getReadCutoff(convId, userId);
        const readCutoff = readCutoffDate ? new Date(readCutoffDate).toISOString() : null;
        const pinnedMessage = await getPinnedSummary(convId, lang);
        const typing = getTypingOthers(convId, userId);

        res.json({ messages: result.rows, updates, reactionUpdates, readCutoff, pinnedMessage, typing });
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

// GET /messages/pulse?since=<message id> — what the header on any page needs to stay current
// (js/pulse.js): both unread counts, and the messages newer than `since` that deserve a live alert
// for this person (lib/pulse.js). Without `since` it only answers the cursor to start from, so a
// fresh page never alerts about messages that were already there.
router.get('/pulse', rateLimit('pulse', 20, 60000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const lang = normalizeLang(req.session.lang);
        const since = Number.parseInt(req.query.since, 10);
        const [maxRow, unreadMessages, unreadNotifications] = await Promise.all([
            pool.query('SELECT COALESCE(MAX(id), 0)::int AS id FROM messages'),
            getUnreadMessageCount(userId),
            notifications.getUnreadCount(userId),
        ]);
        const cursor = maxRow.rows[0].id;
        let items = [];
        if (Number.isSafeInteger(since) && since > 0 && since < cursor) {
            const { rows } = await pool.query(
                `SELECT m.id, m.conversation_id, m.sender_id, m.content, m.image_url, m.file_name,
                        u.username AS sender_username, u.profile_picture AS sender_picture,
                        c.is_group, c.title, c.saved_for_user_id, cm.muted,
                        r.sender_id AS reply_to_sender_id,
                        (SELECT count(*)::int FROM conversation_members x WHERE x.conversation_id = m.conversation_id) AS member_count
                   FROM messages m
                   JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
                   JOIN conversations c ON c.id = m.conversation_id
                   LEFT JOIN users u ON u.id = m.sender_id
                   LEFT JOIN messages r ON r.id = m.reply_to_id
                  WHERE m.id > $2 AND m.id <= $3 AND m.sender_id <> $1 AND m.deleted_at IS NULL
                  ORDER BY m.id DESC
                  LIMIT 50`,
                [userId, since, cursor]
            );
            const viewer = { userId, username: req.session.username };
            items = rows
                .map((row) => ({
                    row,
                    kind: alertKind({
                        senderId: row.sender_id,
                        isGroup: row.is_group,
                        memberCount: row.member_count,
                        muted: row.muted,
                        replyToSenderId: row.reply_to_sender_id,
                        content: row.content,
                        isSaved: row.saved_for_user_id != null,
                    }, viewer),
                }))
                .filter((x) => x.kind)
                .slice(0, 5)
                .map(({ row, kind }) => ({
                    id: row.id,
                    kind,
                    sender: row.sender_username || '',
                    picture: row.sender_picture || '/img/profile_images/Default_placeholder.svg',
                    chat: row.is_group ? (row.title || '') : '',
                    preview: previewText(row.content, { imageUrl: row.image_url, fileName: row.file_name, lang }),
                    url: `${messagesPath(lang, row.conversation_id)}#msg-${row.id}`,
                }));
        }
        res.set('Cache-Control', 'no-store').json({ cursor, unreadMessages, unreadNotifications, items });
    } catch (err) {
        console.error('Pulse error:', err);
        res.status(500).json({ error: 'server' });
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
router.post('/new-group', rateLimit('new', 15, 60000), async (req, res) => {
    try {
        const userId = req.session.userId;
        const { memberIds, title } = req.body;
        const newBlocked = await postingBlockFor(userId, null);
        if (newBlocked) return res.status(403).json({ error: blockedNotice(newBlocked, normalizeLang(req.session.lang), readerTimeZone(req)), blocked: true });

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
            res.redirect(messagesPath(normalizeLang(req.session.lang), convId));
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

// The number on the header's Messages icon. Muted conversations don't add to it, as in any
// messenger: the community chat in a person's other language starts muted, and a Russian
// chat nobody asked to follow must not keep an English reader's badge at 99+.
async function getUnreadMessageCount(userId) {
    try {
        const result = await pool.query(
            `SELECT COALESCE(SUM(
                (SELECT COUNT(*) FROM messages mx
                 WHERE mx.conversation_id = c.id
                   AND mx.created_at > cm.last_read_at
                   AND mx.sender_id != $1
                   AND mx.deleted_at IS NULL
                   AND (cm.hidden_at IS NULL OR mx.created_at > cm.hidden_at))
             ), 0)::int AS total
             FROM conversations c
             JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
             WHERE cm.muted = FALSE`,
            [userId]
        );
        return result.rows[0]?.total || 0;
    } catch (err) {
        console.error('Unread message count error:', err);
        return 0;
    }
}

module.exports = { router, getUnreadMessageCount, closeStreams, resumeConversions };
