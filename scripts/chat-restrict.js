#!/usr/bin/env node
// Keeps one member from writing, in one conversation or everywhere, for a while or for good.
//
//   node scripts/chat-restrict.js --user 2621 --conversation 5 --hours 24 [--apply]   one chat, 24 h
//   node scripts/chat-restrict.js --user 2621 --hours 24 [--apply]                    every chat and DM, comments too
//   node scripts/chat-restrict.js --user 2621 --permanent [--apply]                   for good
//   node scripts/chat-restrict.js --user 2621 [--conversation 5] --lift [--apply]     let them write again
//
// Without --apply it prints what would change. A chat block is conversation_members
// .posting_blocked_until (migration 061), an account block users.posting_blocked_until
// (migration 062, 'infinity' for good); messages.js and the comments route refuse writes until
// then and show why (lib/chatRestrictions.js). --apply also leaves a bell notification saying
// until when and whom to ask. Reading and signing in are never restricted. First used on
// 2026-09-21 for one member of the Russian chat (24 h), then account-wide for good the same evening.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { blockNotification } = require('../lib/chatRestrictions');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const userId = parseInt(opt('--user'), 10);
const convId = opt('--conversation') ? parseInt(opt('--conversation'), 10) : null;
const hours = parseFloat(opt('--hours'));
const permanent = args.includes('--permanent');
const lift = args.includes('--lift');
const apply = args.includes('--apply');
if (!userId || (!lift && !permanent && !(hours > 0)) || (permanent && convId)) {
    console.error('usage: chat-restrict.js --user <id> [--conversation <id>] (--hours <n> | --permanent | --lift) [--apply]');
    console.error('       --permanent is account-wide only');
    process.exit(2);
}

const pool = new Pool({
    user: process.env.PG_USER, host: process.env.PG_HOST, database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD, port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const show = (v) => v === Infinity ? 'for good' : v ? new Date(v).toISOString() : 'never';

(async () => {
    const u = await pool.query('SELECT username, posting_blocked_until FROM users WHERE id = $1', [userId]);
    if (!u.rows.length) { console.error(`no user ${userId}`); process.exit(1); }
    const { username, posting_blocked_until: accountCurrent } = u.rows[0];
    let title = null, chatLang = 'ru', current = accountCurrent;
    if (convId) {
        const m = await pool.query(
            `SELECT c.title, c.community_lang, cm.posting_blocked_until
             FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
             WHERE cm.user_id = $1 AND cm.conversation_id = $2`, [userId, convId]);
        if (!m.rows.length) { console.error(`user ${userId} is not a member of conversation ${convId}`); process.exit(1); }
        title = m.rows[0].title || (m.rows[0].community_lang ? 'chat' : 'untitled');
        chatLang = m.rows[0].community_lang === 'en' ? 'en' : 'ru';
        current = m.rows[0].posting_blocked_until;
    }
    const until = lift ? null : permanent ? Infinity : new Date(Date.now() + hours * 3600 * 1000);
    console.log(`${username} ${convId ? `in conversation ${convId} (${title})` : 'account-wide'}: blocked ${show(current)} → ${show(until)}`);
    const note = until ? blockNotification(until, chatLang, title) : null;
    if (note) console.log(`notification: ${note.title} / ${note.message}`);
    if (!apply) { console.log('dry run, nothing written (--apply to write)'); await pool.end(); return; }

    const value = until === Infinity ? 'infinity' : until;
    await pool.query('BEGIN');
    if (convId) {
        await pool.query(`UPDATE conversation_members SET posting_blocked_until = $3 WHERE user_id = $1 AND conversation_id = $2`, [userId, convId, value]);
    } else {
        await pool.query(`UPDATE users SET posting_blocked_until = $2 WHERE id = $1`, [userId, value]);
    }
    if (note) {
        await pool.query(`INSERT INTO notifications (user_id, type, title, message, link) VALUES ($1, 'chat_restriction', $2, $3, $4)`,
            [userId, note.title, note.message, convId ? `/${chatLang}/messages/${convId}` : `/${chatLang}/messages`]);
    }
    await pool.query('COMMIT');
    console.log('written');
    await pool.end();
})().catch(async (e) => { console.error(e); try { await pool.query('ROLLBACK'); } catch (_) {} process.exit(1); });
