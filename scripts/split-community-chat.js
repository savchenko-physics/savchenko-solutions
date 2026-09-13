/**
 * One-off: split the site-wide common chat into an English and a Russian community chat.
 *
 * WHY: since May 2026 every account joined one group chat, "Savchenko Solutions". By
 * September it held 253 messages: 215 Russian, 12 English, 3 bilingual announcements. The
 * people who write in English had nowhere to talk, and Russian speakers had started posting
 * English copies of their own messages (1835 and 1836 are the same text twice).
 *
 * WHAT (--apply), in one transaction:
 *   1. The existing chat becomes the Russian one (community_lang 'ru', migration 051).
 *   2. An English chat is created with every account in it, the same moderators, and
 *      last_read_at = now so nobody starts with a backlog.
 *   3. The 12 English messages move there (MOVE, reviewed by hand; a bare URL inside a
 *      Russian thread, 836, stays).
 *   4. The 3 bilingual announcements are split at the separators they already use: the
 *      Russian half stays in place, the English half is inserted into the English chat with
 *      the same author and time (SPLIT).
 *   5. Default mutes: the chat in a person's other language starts muted, unless they are a
 *      moderator or already write in that language (lib/communityChats.js).
 *
 * SAFETY: every read, the classification and the report happen before the transaction; the
 * transaction takes a row lock on the source chat with a 5 s lock_timeout, re-checks each
 * message's author and md5(content) against the values reviewed on 2026-09-12, and refuses
 * if anything differs or an English chat already exists. Before writing, the rows it will
 * change are saved to deploy-backups/community-split-<timestamp>.json, and --undo reverses
 * the split from that file. No notifications are created.
 *
 * Run (on the server, after `npm run migrate`):
 *   node scripts/split-community-chat.js                  report only, writes nothing
 *   node scripts/split-community-chat.js --apply          back up, then split
 *   node scripts/split-community-chat.js --top-up         add accounts missing from either chat
 *   node scripts/split-community-chat.js --undo <file>    reverse --apply
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { textLanguage } = require('../js/chat-language');
const {
    COMMUNITY_TITLES,
    classifyUserLanguage,
    writesLanguage,
    mutedByDefault,
} = require('../lib/communityChats');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});
pool.on('error', (err) => console.error('pg pool error:', err.message));

const SOURCE_TITLE = 'Savchenko Solutions';
const BACKUP_DIR = path.join(__dirname, '..', 'deploy-backups');

// The English messages, reviewed one by one from a dump of the chat on 2026-09-12.
// md5 is of COALESCE(content, '') at review time.
const MOVE = [
    { id: 49, sender: 2409, md5: '8d7746bcf48ccf556a702514bbfae978' },   // gaussisreal: "Hi people"
    { id: 50, sender: 2409, md5: 'c9cfcc78d7f30035d1b3e1021709e826' },   // "can I just start trying to solve problems"
    { id: 51, sender: 2409, md5: 'f81a6e40d4da8a4debca4c75ce46ba1f' },   // "and post the solution if my attempt is valid ?"
    { id: 52, sender: 232, md5: '9d00ef760fd95d26d7681a5261a82adc' },    // emixter: "Yes, you can post your solutions."
    { id: 98, sender: 176, md5: '0c4299eb1f63519ffffde5e22af06fb2' },    // igor: "Hi, an interesting discussion"
    { id: 448, sender: 232, md5: '499198e58ee7ec314178113115b4aabb' },   // emixter: horse-racing note on the contest
    { id: 723, sender: 759, md5: '178e16f1f5f26dc9af08dfc307ce0747' },   // jzmicer: formatting advice for new users
    { id: 724, sender: 759, md5: 'debc90f2a7cab88ab061818b3ccaeb0e' },   // "As example, before and after" + image
    { id: 725, sender: 759, md5: 'd41d8cd98f00b204e9800998ecf8427e' },   // the "after" image, no text
    { id: 726, sender: 759, md5: '62eab6eb69ace5548820e49595167d0a' },   // "Also, long problem statements..."
    { id: 758, sender: 158, md5: '8e028296b876b4f7151796646ee71fcb' },   // paul.tichisanu: "nice website revamp"
    { id: 1836, sender: 232, md5: '1fe230ccbef38c8ab2bc141bd4c61397' },  // emixter: English copy of 1835
];

/** Split at a separator that must occur exactly once. */
function splitOnce(content, separator) {
    const at = content.indexOf(separator);
    if (at < 0 || content.indexOf(separator, at + separator.length) >= 0) {
        throw new Error(`separator ${JSON.stringify(separator)} must occur exactly once`);
    }
    return { ru: content.slice(0, at).trim(), en: content.slice(at + separator.length).trim() };
}

/** 818: Russian body, English body, then a links tail written in both languages at once. */
function splitPracticum(content) {
    const parts = content.split('\n\n•••\n\n');
    if (parts.length !== 3) throw new Error(`818: expected 3 parts, found ${parts.length}`);
    const [ruBody, enBody, tail] = parts;
    const lines = tail.split('\n');
    const links = lines.filter((l) => /^https?:\/\//.test(l));
    const head = 'Подробности / Details (ENG · RUS · UKR):';
    const last = 'Полная информация в баннере на главной. Full info is in the homepage banner.';
    if (lines[0] !== head || lines[lines.length - 1] !== last || links.length !== 3) {
        throw new Error('818: links tail is not the reviewed text');
    }
    return {
        ru: [ruBody, '', 'Подробности (ENG · RUS · UKR):', ...links, '', 'Полная информация в баннере на главной.'].join('\n'),
        en: [enBody, '', 'Details (ENG · RUS · UKR):', ...links, '', 'Full info is in the homepage banner.'].join('\n'),
    };
}

// The bilingual announcements, all by astrosander. replyTo: the English half of 830 replies
// to the English half of 818, as the original reminder replied to the original post.
const SPLIT = [
    { id: 9, sender: 28, md5: 'cfd62fcbb3c1e1275af387a714dea2fd', split: (c) => splitOnce(c, '\n--\n') },
    { id: 818, sender: 28, md5: 'c2a1f5cca23f070b0e7f49db3a21b2f5', split: splitPracticum },
    { id: 830, sender: 28, md5: '96e9d9271957735707c9d9e3e254d5b8', split: (c) => splitOnce(c, '\n---\n'), replyTo: 818 },
];

const args = process.argv.slice(2);
const MODE = args.includes('--apply') ? 'apply'
    : args.includes('--top-up') ? 'top-up'
        : args.includes('--undo') ? 'undo'
            : 'dry-run';

function snippet(text, n = 70) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function requireColumn() {
    const col = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'conversations' AND column_name = 'community_lang'`
    );
    if (col.rowCount === 0) {
        throw new Error('conversations.community_lang is missing: run migration 051 first (npm run migrate).');
    }
}

/**
 * What the site knows about each account's language, keyed by user id. Group chats only:
 * DMs are private conversations and are not read for this.
 */
async function loadSignals() {
    const [users, chat, contrib, sessions] = await Promise.all([
        pool.query(`SELECT id, username, full_name, email, country_location, last_seen_at IS NOT NULL AS seen FROM users`),
        pool.query(
            `SELECT m.sender_id, m.content
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
             WHERE c.is_group AND c.saved_for_user_id IS NULL
               AND m.deleted_at IS NULL AND m.sender_id IS NOT NULL AND m.content <> ''`
        ),
        pool.query(`SELECT user_id, language, COUNT(*)::int AS n FROM contributions WHERE user_id IS NOT NULL GROUP BY 1, 2`),
        // json column, 1.6M rows, no index on the payload: about 3 s. The LIKE skips JSON
        // parsing for the anonymous majority.
        pool.query(
            `SELECT DISTINCT ON (uid) uid::int AS user_id, lang
             FROM (SELECT sess->>'userId' AS uid, sess->>'lang' AS lang, expire
                   FROM session WHERE sess::text LIKE '%"userId":%') s
             WHERE uid ~ '^[0-9]+$' AND lang IN ('en', 'ru')
             ORDER BY uid, expire DESC`
        ),
    ]);
    const byId = new Map();
    for (const u of users.rows) {
        byId.set(u.id, {
            user: u,
            signals: {
                groupChatRu: 0, groupChatEn: 0, contribRu: 0, contribEn: 0,
                name: `${u.full_name || ''} ${u.username || ''}`,
                country: u.country_location, email: u.email, sessionLang: null,
            },
        });
    }
    for (const m of chat.rows) {
        const entry = byId.get(m.sender_id);
        if (!entry) continue;
        const lang = textLanguage(m.content);
        if (lang === 'ru') entry.signals.groupChatRu++;
        if (lang === 'en') entry.signals.groupChatEn++;
    }
    for (const r of contrib.rows) {
        const entry = byId.get(r.user_id);
        if (!entry) continue;
        if (r.language === 'ru') entry.signals.contribRu += r.n;
        if (r.language === 'en') entry.signals.contribEn += r.n;
    }
    for (const r of sessions.rows) {
        const entry = byId.get(r.user_id);
        if (entry) entry.signals.sessionLang = r.lang;
    }
    return byId;
}

/** Default mute for one account in each community chat. */
function decide(entry, role) {
    const userLang = classifyUserLanguage(entry.signals);
    const isModerator = role === 'admin';
    return {
        userLang,
        mutedEn: !!mutedByDefault({ chatLang: 'en', userLang, isModerator, writesChatLang: writesLanguage(entry.signals, 'en') }),
        mutedRu: !!mutedByDefault({ chatLang: 'ru', userLang, isModerator, writesChatLang: writesLanguage(entry.signals, 'ru') }),
    };
}

async function findSourceChat() {
    const tagged = await pool.query(`SELECT * FROM conversations WHERE community_lang = 'ru'`);
    if (tagged.rowCount) return tagged.rows[0];
    const byTitle = await pool.query(
        `SELECT * FROM conversations WHERE title = $1 AND is_group = TRUE ORDER BY created_at ASC LIMIT 1`,
        [SOURCE_TITLE]
    );
    if (!byTitle.rowCount) throw new Error(`no group chat titled "${SOURCE_TITLE}" and none tagged 'ru'`);
    return byTitle.rows[0];
}

/** Every listed message must be exactly what was reviewed. Works on a pool or a client. */
async function checkGuards(db, sourceId) {
    const all = [...MOVE, ...SPLIT];
    const moved = new Set(MOVE.map((m) => m.id));
    const r = await db.query(
        `SELECT id, conversation_id, sender_id, reply_to_id, deleted_at, content,
                edited_at, created_at, md5(COALESCE(content, '')) AS md5
         FROM messages WHERE id = ANY($1)`,
        [all.map((m) => m.id)]
    );
    const rows = new Map(r.rows.map((row) => [row.id, row]));
    const problems = [];
    for (const m of all) {
        const row = rows.get(m.id);
        if (!row) { problems.push(`#${m.id} is gone`); continue; }
        if (row.conversation_id !== sourceId) problems.push(`#${m.id} is in conversation ${row.conversation_id}, not ${sourceId}`);
        if (row.sender_id !== m.sender) problems.push(`#${m.id} sender ${row.sender_id}, expected ${m.sender}`);
        if (row.md5 !== m.md5) problems.push(`#${m.id} content changed since review`);
        if (row.deleted_at) problems.push(`#${m.id} was deleted`);
        if (moved.has(m.id) && row.reply_to_id && !moved.has(row.reply_to_id)) {
            problems.push(`#${m.id} replies to #${row.reply_to_id}, which stays in the Russian chat`);
        }
    }
    // Nothing that stays behind may quote a message that moves.
    const quoting = await db.query(
        `SELECT id, reply_to_id FROM messages WHERE reply_to_id = ANY($1) AND NOT (id = ANY($1))`,
        [MOVE.map((m) => m.id)]
    );
    for (const q of quoting.rows) problems.push(`#${q.id} (staying) replies to #${q.reply_to_id} (moving)`);
    return { rows, problems };
}

async function dryRunOrApply(apply) {
    await requireColumn();
    const existingEn = await pool.query(`SELECT id FROM conversations WHERE community_lang = 'en'`);
    if (existingEn.rowCount) {
        console.log(`Already applied: the English community chat exists (conversation ${existingEn.rows[0].id}). Nothing to do.`);
        return;
    }
    const source = await findSourceChat();
    const { rows, problems } = await checkGuards(pool, source.id);
    if (problems.length) throw new Error(`refusing to split:\n  ${problems.join('\n  ')}`);

    const splits = SPLIT.map((s) => ({ ...s, row: rows.get(s.id), halves: s.split(rows.get(s.id).content) }));
    const members = await pool.query(
        `SELECT user_id, role, joined_at, last_read_at, muted FROM conversation_members WHERE conversation_id = $1`,
        [source.id]
    );
    const memberOf = new Map(members.rows.map((m) => [m.user_id, m]));
    const signals = await loadSignals();

    const enMembers = [];
    const ruNewlyMuted = [];
    const tally = {};
    let seenRuMuted = 0;
    let seenEnMuted = 0;
    for (const [userId, entry] of signals) {
        const membership = memberOf.get(userId);
        const d = decide(entry, membership ? membership.role : 'member');
        const bucket = d.userLang || 'unknown';
        tally[bucket] = (tally[bucket] || 0) + 1;
        enMembers.push({
            userId,
            role: membership ? membership.role : 'member',
            joinedAt: membership ? membership.joined_at : new Date(),
            muted: d.mutedEn,
        });
        if (d.mutedEn && entry.user.seen) seenEnMuted++;
        if (membership && !membership.muted && d.mutedRu) {
            ruNewlyMuted.push({ userId, muted: membership.muted, lastReadAt: membership.last_read_at });
            if (entry.user.seen) seenRuMuted++;
        }
    }

    console.log(`Source chat: conversation ${source.id} "${source.title}", ${members.rowCount} members.\n`);
    console.log(`Move to the English chat (${MOVE.length}):`);
    for (const m of MOVE) {
        const row = rows.get(m.id);
        console.log(`  #${m.id}  u${row.sender_id}  ${row.content ? snippet(row.content) : '[image]'}`);
    }
    console.log(`\nSplit (${SPLIT.length}); Russian half stays, English half is inserted:`);
    for (const s of splits) {
        console.log(`\n  #${s.id} Russian half:\n${s.halves.ru.replace(/^/gm, '    | ')}`);
        console.log(`  #${s.id} English half${s.replyTo ? ` (reply to the English half of #${s.replyTo})` : ''}:\n${s.halves.en.replace(/^/gm, '    | ')}`);
    }
    const enMutedCount = enMembers.filter((m) => m.muted).length;
    console.log(`\nLanguage per account: ${JSON.stringify(tally)}`);
    console.log(`English chat: ${enMembers.length} members, ${enMutedCount} muted by default (${seenEnMuted} of them ever seen).`);
    console.log(`Russian chat: ${ruNewlyMuted.length} memberships newly muted (${seenRuMuted} ever seen); existing mutes are kept.`);

    if (!apply) {
        console.log('\nDry run: nothing written. Re-run with --apply to split.');
        return;
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `community-split-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const backup = {
        createdAt: new Date().toISOString(),
        sourceConvId: source.id,
        sourceTitle: source.title,
        sourceLastMessageAt: source.last_message_at,
        moved: MOVE.map((m) => m.id),
        splitOriginals: splits.map((s) => ({ id: s.id, content: s.row.content })),
        ruNewlyMuted,
    };
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`\nBackup written: ${backupPath}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(`SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, [source.id]);
        const raced = await client.query(`SELECT id FROM conversations WHERE community_lang = 'en'`);
        if (raced.rowCount) throw new Error('an English community chat appeared while preparing; nothing written');
        const recheck = await checkGuards(client, source.id);
        if (recheck.problems.length) throw new Error(`refusing to split:\n  ${recheck.problems.join('\n  ')}`);

        await client.query(
            `UPDATE conversations SET community_lang = 'ru', title = $2 WHERE id = $1`,
            [source.id, COMMUNITY_TITLES.ru]
        );
        const created = await client.query(
            `INSERT INTO conversations (is_group, title, created_by, created_at, last_message_at, community_lang)
             VALUES (TRUE, $1, $2, $3, NOW(), 'en') RETURNING id`,
            [COMMUNITY_TITLES.en, source.created_by, source.created_at]
        );
        const enId = created.rows[0].id;

        const added = await client.query(
            `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at, muted)
             SELECT $1, u.user_id, u.role, u.joined_at, NOW(), u.muted
             FROM unnest($2::int[], $3::text[], $4::timestamptz[], $5::boolean[]) AS u(user_id, role, joined_at, muted)
             ON CONFLICT DO NOTHING`,
            [enId, enMembers.map((m) => m.userId), enMembers.map((m) => m.role), enMembers.map((m) => m.joinedAt), enMembers.map((m) => m.muted)]
        );

        const moved = await client.query(
            `UPDATE messages SET conversation_id = $1 WHERE id = ANY($2) AND conversation_id = $3`,
            [enId, MOVE.map((m) => m.id), source.id]
        );
        if (moved.rowCount !== MOVE.length) throw new Error(`moved ${moved.rowCount} of ${MOVE.length} messages`);

        const insertedIds = {};
        for (const s of splits) {
            await client.query(`UPDATE messages SET content = $2 WHERE id = $1`, [s.id, s.halves.ru]);
            const ins = await client.query(
                `INSERT INTO messages (conversation_id, sender_id, content, created_at, edited_at, reply_to_id)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [enId, s.row.sender_id, s.halves.en, s.row.created_at, s.row.edited_at, s.replyTo ? insertedIds[s.replyTo] : null]
            );
            insertedIds[s.id] = ins.rows[0].id;
            // Whoever hid the original ("delete for me") doesn't want its English half either.
            await client.query(
                `INSERT INTO message_hidden (message_id, user_id, hidden_at)
                 SELECT $2, user_id, hidden_at FROM message_hidden WHERE message_id = $1
                 ON CONFLICT DO NOTHING`,
                [s.id, insertedIds[s.id]]
            );
        }

        // The English chat sorts by its newest message. The Russian chat keeps its own value:
        // every moved message is older than its latest one.
        await client.query(
            `UPDATE conversations SET last_message_at = (SELECT MAX(created_at) FROM messages WHERE conversation_id = $1)
             WHERE id = $1`,
            [enId]
        );

        // Also marks the Russian chat read for them: a months-old grey "99+" on a chat they
        // never followed is noise, not information.
        const muted = await client.query(
            `UPDATE conversation_members SET muted = TRUE, last_read_at = GREATEST(last_read_at, NOW())
             WHERE conversation_id = $1 AND user_id = ANY($2) AND muted = FALSE`,
            [source.id, ruNewlyMuted.map((m) => m.userId)]
        );

        await client.query('COMMIT');
        backup.enConvId = enId;
        backup.insertedIds = insertedIds;
        fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
        console.log(`\nDone. English chat = conversation ${enId}: ${added.rowCount} members, ${moved.rowCount} messages moved, ` +
            `halves ${JSON.stringify(insertedIds)}. Russian chat: ${muted.rowCount} memberships muted.`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** Accounts created after the split (or missing for any reason) join both chats. */
async function topUp() {
    await requireColumn();
    const chats = await pool.query(`SELECT id, community_lang FROM conversations WHERE community_lang IS NOT NULL`);
    if (chats.rowCount < 2) throw new Error('both community chats must exist: run --apply first');
    const missing = await pool.query(
        `SELECT c.id AS conversation_id, c.community_lang, u.id AS user_id
         FROM conversations c CROSS JOIN users u
         WHERE c.community_lang IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = u.id)`
    );
    if (!missing.rowCount) {
        console.log('Every account is already in both community chats.');
        return;
    }
    const signals = await loadSignals();
    let added = 0;
    for (const row of missing.rows) {
        const entry = signals.get(row.user_id);
        if (!entry) continue;
        const d = decide(entry, 'member');
        const muted = row.community_lang === 'en' ? d.mutedEn : d.mutedRu;
        const r = await pool.query(
            `INSERT INTO conversation_members (conversation_id, user_id, muted) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [row.conversation_id, row.user_id, muted]
        );
        added += r.rowCount;
        console.log(`  + u${row.user_id} (${entry.user.username}) → ${row.community_lang}${muted ? ', muted' : ''}`);
    }
    console.log(`Added ${added} membership(s).`);
}

async function undo() {
    const file = args[args.indexOf('--undo') + 1];
    if (!file || file.startsWith('--')) throw new Error('usage: --undo <deploy-backups/community-split-….json>');
    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!backup.enConvId || !backup.insertedIds) throw new Error('backup has no enConvId/insertedIds: the split never committed');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        const src = backup.sourceConvId;
        const en = backup.enConvId;
        const inserted = Object.values(backup.insertedIds);

        // Order matters: messages.conversation_id cascades, so everything worth keeping
        // leaves the English chat before the chat itself is deleted.
        const back = await client.query(
            `UPDATE messages SET conversation_id = $1 WHERE id = ANY($2) AND conversation_id = $3`,
            [src, backup.moved, en]
        );
        const halves = await client.query(`DELETE FROM messages WHERE id = ANY($1) AND conversation_id = $2`, [inserted, en]);
        for (const o of backup.splitOriginals) {
            await client.query(`UPDATE messages SET content = $2 WHERE id = $1`, [o.id, o.content]);
        }
        // Anything written in the English chat since the split is kept, in the old chat.
        const later = await client.query(`UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2`, [src, en]);
        await client.query(`DELETE FROM conversations WHERE id = $1 AND community_lang = 'en'`, [en]);
        for (const m of backup.ruNewlyMuted) {
            await client.query(
                `UPDATE conversation_members SET muted = $3, last_read_at = $4 WHERE conversation_id = $1 AND user_id = $2`,
                [src, m.userId, m.muted, m.lastReadAt]
            );
        }
        await client.query(
            `UPDATE conversations
             SET community_lang = NULL, title = $2,
                 last_message_at = GREATEST($3::timestamptz,
                     COALESCE((SELECT MAX(created_at) FROM messages WHERE conversation_id = $1), $3::timestamptz))
             WHERE id = $1`,
            [src, backup.sourceTitle, backup.sourceLastMessageAt]
        );
        await client.query('COMMIT');
        console.log(`Undone: ${back.rowCount} messages back in conversation ${src}, ${halves.rowCount} English halves removed, ` +
            `${later.rowCount} later English-chat messages kept in ${src}, conversation ${en} deleted, ` +
            `${backup.ruNewlyMuted.length} mutes restored.`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function main() {
    if (MODE === 'apply') return dryRunOrApply(true);
    if (MODE === 'top-up') return topUp();
    if (MODE === 'undo') return undo();
    return dryRunOrApply(false);
}

if (require.main === module) {
    main()
        .then(() => pool.end())
        .catch((err) => {
            console.error(err.message || err);
            pool.end();
            process.exit(1);
        });
}

module.exports = { MOVE, SPLIT, splitOnce, splitPracticum };
