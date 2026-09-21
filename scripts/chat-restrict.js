#!/usr/bin/env node
// Keeps one member from writing in one conversation for a while, or lifts that.
//
//   node scripts/chat-restrict.js --user 2621 --conversation 5 --hours 24            print what would change
//   node scripts/chat-restrict.js --user 2621 --conversation 5 --hours 24 --apply    set it and notify them
//   node scripts/chat-restrict.js --user 2621 --conversation 5 --lift --apply        let them write again
//
// Sets conversation_members.posting_blocked_until (migration 061); messages.js refuses their
// sends and forwards into that chat until then and shows them why in place of the composer
// (lib/chatRestrictions.js). --apply also leaves a bell notification saying until when and whom
// to ask. Reading is never restricted. First used on 2026-09-21 for Бека in the Russian chat.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { blockNotification } = require('../lib/chatRestrictions');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const userId = parseInt(opt('--user'), 10);
const convId = parseInt(opt('--conversation'), 10);
const hours = parseFloat(opt('--hours'));
const lift = args.includes('--lift');
const apply = args.includes('--apply');
if (!userId || !convId || (!lift && !(hours > 0))) {
    console.error('usage: chat-restrict.js --user <id> --conversation <id> (--hours <n> | --lift) [--apply]');
    process.exit(2);
}

const pool = new Pool({
    user: process.env.PG_USER, host: process.env.PG_HOST, database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD, port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

(async () => {
    const m = await pool.query(
        `SELECT u.username, c.title, c.community_lang, cm.posting_blocked_until
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.user_id = $1 AND cm.conversation_id = $2`, [userId, convId]);
    if (!m.rows.length) { console.error(`user ${userId} is not a member of conversation ${convId}`); process.exit(1); }
    const { username, title, community_lang: chatLang, posting_blocked_until: current } = m.rows[0];
    const until = lift ? null : new Date(Date.now() + hours * 3600 * 1000);
    console.log(`${username} in conversation ${convId} (${title || 'untitled'}): blocked until ${current ? current.toISOString() : 'never'} → ${until ? until.toISOString() : 'never'}`);
    const lang = chatLang === 'en' ? 'en' : 'ru';
    const note = until ? blockNotification(until, lang, title || (lang === 'ru' ? 'чат' : 'the chat')) : null;
    if (note) console.log(`notification: ${note.title} / ${note.message}`);
    if (!apply) { console.log('dry run, nothing written (--apply to write)'); await pool.end(); return; }

    await pool.query('BEGIN');
    await pool.query(`UPDATE conversation_members SET posting_blocked_until = $3 WHERE user_id = $1 AND conversation_id = $2`, [userId, convId, until]);
    if (note) {
        await pool.query(`INSERT INTO notifications (user_id, type, title, message, link) VALUES ($1, 'chat_restriction', $2, $3, $4)`,
            [userId, note.title, note.message, `/${lang}/messages/${convId}`]);
    }
    await pool.query('COMMIT');
    console.log('written');
    await pool.end();
})().catch(async (e) => { console.error(e); try { await pool.query('ROLLBACK'); } catch (_) {} process.exit(1); });
