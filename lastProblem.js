// lastProblem.js: «Последняя задача», a one-time prediction mini app inside the community chats.
//
// On 2026-09-15 emixter asked both community chats which problem will be solved last (#1958 RU,
// #1959 EN). astrosander answered "Можно начинать делать ставки на polymarket" (#1961), Valter
// put his on 5.8.9 ("только не решите теперь ее никто") and emixter on 7.2.11. This is that
// market, opened from a card in the chat the way a Telegram mini app opens from a bot message:
//
//   - the outcomes are the problems unsolved when the question was asked (lp_outcomes);
//   - every account gets 1000 quanta (ħ) once, a share of a problem pays 1 ħ if it is the last one
//     solved, and prices come from an LMSR market maker (js/lmsr.js), so any amount trades at
//     any time;
//   - a problem drops out when its solution appears (checked every two minutes: none of the four
//     routes that write posts/ has a hook, see syncSolved);
//   - quanta buy premium reactions (js/reactions.js), which is what makes predicting well worth
//     something;
//   - it opened with a seed (scripts/seed-last-problem.js): Laplace's demon, a house trader that
//     is not an account, spread 800 ħ over the ten problems a survival model over the solving
//     history ranks most likely to be last, and the two bets people named in the chat went in
//     at the moment they wrote them.
//
// Play money. It cannot be bought or cashed out, and nothing here writes a solution or a
// statement.
//
// What tests/last-problem.test.js covers is the pure part (lib/lastProblem.js, js/lmsr.js, the
// premium rules in js/reactions.js). The SQL here was checked against a scratch copy of the
// production schema before release; there is no test database.
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const i18n = require('i18n');
const { Pool } = require('pg');
const LMSR = require('./js/lmsr');
const Reactions = require('./js/reactions');
const LP = require('./lib/lastProblem');
const { getCopy, clientCopy } = require('./lastProblemCopy');
const { isCrossSite } = require('./lib/passwordReset');
const { ruPlural } = require('./lib/ruPlural');
const { ownedReactions } = require('./lib/reactionUnlocks');
const notifications = require('./notifications');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

// The kill switch: LAST_PROBLEM=off in the environment and a restart take the app, its card and
// its sync off the site without a deploy. Premium reactions people own keep working.
const ENABLED = String(process.env.LAST_PROBLEM || '').trim().toLowerCase() !== 'off';

const POSTS_DIR = path.join(__dirname, 'posts');
const SYNC_MS = 2 * 60 * 1000;
const PUBLIC_TTL_MS = 5 * 1000;
const NOTIFY_TYPE = 'last_problem';

const num = (v) => Number(v) || 0;
// Money leaves the market rounded down to 1/10000 ħ, never up.
const floor4 = (x) => Math.floor(x * 10000) / 10000;
const round2 = (x) => Math.round(x * 100) / 100;

function compareIds(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
}

const sectionOf = (id) => id.split('.').slice(0, 2).join('.');

function openQ(outcomes) {
    const q = {};
    for (const o of outcomes) if (o.status === 'open') q[o.problem_name] = num(o.q);
    return q;
}

// Six decimals are plenty for a chart and keep a snapshot of 32 prices under a kilobyte.
function snapshot(prices) {
    const out = {};
    for (const [k, v] of Object.entries(prices)) out[k] = Math.round(v * 1e6) / 1e6;
    return out;
}

// ── Static facts about the problems ───────────────────────────────────────────────────

/* Section titles in both languages and each section's problem count, from the CSVs the rest of
 * the site reads (the Russian one starts with a byte-order mark and has CRLF line ends). */
let sectionTitles = null;
function loadSectionTitles() {
    if (sectionTitles) return sectionTitles;
    const counts = new Map();
    const parse = (rel) => {
        const map = new Map();
        let text = '';
        try {
            text = fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/^﻿/, '');
        } catch (_err) {
            return map;
        }
        for (const line of text.split(/\r?\n/)) {
            const first = line.indexOf(',');
            const last = line.lastIndexOf(',');
            if (first <= 0 || last <= first) continue;
            const section = line.slice(0, first).trim();
            map.set(section, line.slice(first + 1, last).trim());
            const count = Number(line.slice(last + 1).trim());
            if (Number.isInteger(count) && count > 0) counts.set(section, count);
        }
        return map;
    };
    sectionTitles = { en: parse('src/database/sections.csv'), ru: parse('src/ru/database/sections.csv'), counts };
    return sectionTitles;
}

/* One of the book's 2,023 problems: a known section and a number within it. */
function isBookProblem(id) {
    if (!LP.isProblemId(id)) return false;
    const count = loadSectionTitles().counts.get(sectionOf(id));
    const n = Number(id.split('.')[2]);
    return !!count && n >= 1 && n <= count;
}

let metaCache = null;
async function problemMeta(ids) {
    if (metaCache && ids.every((id) => metaCache.has(id))) return metaCache;
    const { rows } = await pool.query(
        `SELECT s.problem_name, d.calibrated, bool_or(s.starred) AS starred
           FROM problem_statements s
           LEFT JOIN problem_difficulty d ON d.problem_name = s.problem_name
          WHERE s.problem_name = ANY($1)
          GROUP BY s.problem_name, d.calibrated`,
        [ids]
    );
    const map = metaCache || new Map();
    for (const id of ids) map.set(id, { difficulty: null, starred: false });
    for (const r of rows) map.set(r.problem_name, { difficulty: r.calibrated == null ? null : Number(r.calibrated), starred: !!r.starred });
    metaCache = map;
    return map;
}

let chatIds = null;
async function communityChats() {
    if (chatIds) return chatIds;
    const { rows } = await pool.query('SELECT id, community_lang FROM conversations WHERE community_lang IS NOT NULL');
    const map = {};
    for (const r of rows) map[r.community_lang] = r.id;
    chatIds = map;
    return map;
}

function appLink(lang, chats) {
    return chats && chats[lang] ? `/${lang}/messages/${chats[lang]}?app=last-problem` : `/${lang}/apps/last-problem`;
}

// ── Notifications ─────────────────────────────────────────────────────────────────────
//
// One bell each, in the language of the community chat the person has not muted (Russian when
// both or neither are), linking to that chat with the app open. The type is not in
// notifications.js's email list, so nothing is emailed.

async function notifyUsers(userIds, build) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return;
    let chats = {};
    let unmuted = [];
    try {
        chats = await communityChats();
        const { rows } = await pool.query(
            `SELECT cm.user_id, c.community_lang
               FROM conversation_members cm
               JOIN conversations c ON c.id = cm.conversation_id
              WHERE c.community_lang IS NOT NULL AND NOT COALESCE(cm.muted, false) AND cm.user_id = ANY($1)`,
            [ids]
        );
        unmuted = rows;
    } catch (err) {
        console.error('last-problem notify (languages):', err.message);
    }
    const ru = new Set(unmuted.filter((r) => r.community_lang === 'ru').map((r) => r.user_id));
    const en = new Set(unmuted.filter((r) => r.community_lang === 'en').map((r) => r.user_id));
    for (const uid of ids) {
        const lang = en.has(uid) && !ru.has(uid) ? 'en' : 'ru';
        const { title, message } = build(getCopy(lang).notify, lang);
        await notifications.createNotification(uid, NOTIFY_TYPE, title, message, appLink(lang, chats), null);
    }
}

// ── Reading the market ────────────────────────────────────────────────────────────────

async function readMarket(db) {
    const m = await db.query('SELECT * FROM lp_market WHERE id = 1');
    if (!m.rows.length) return null;
    const o = await db.query(
        `SELECT o.problem_name, o.q, o.demon_shares, o.status, o.solved_at, o.solved_by, u.username AS solved_by_name
           FROM lp_outcomes o LEFT JOIN users u ON u.id = o.solved_by`
    );
    const outcomes = o.rows.sort((a, b) => compareIds(a.problem_name, b.problem_name));
    return { market: m.rows[0], outcomes, b: num(m.rows[0].b), q: openQ(outcomes) };
}

let publicCache = null;
function invalidate() {
    publicCache = null;
}

/* Everything that is the same for every viewer, cached for a few seconds and dropped on any
 * write. Usernames are still in it; stateFor() removes them for signed-out viewers. */
async function publicState() {
    if (publicCache && Date.now() - publicCache.at < PUBLIC_TTL_MS) return publicCache.value;
    const data = await readMarket(pool);
    if (!data) return null;
    const { market, outcomes, b, q } = data;
    const prices = LMSR.prices(q, b);
    const ids = outcomes.map((o) => o.problem_name);
    const meta = await problemMeta(ids);
    const titles = loadSectionTitles();
    const statusOf = new Map(outcomes.map((o) => [o.problem_name, o.status]));

    const [ticksRes, positionsRes] = await Promise.all([
        pool.query(
            `SELECT t.id, t.kind, t.actor, t.user_id, u.username, t.problem_name, t.shares, t.amount,
                    t.prices, t.source, t.cancelled_at, t.created_at
               FROM lp_ticks t LEFT JOIN users u ON u.id = t.user_id
              ORDER BY t.created_at, t.id`
        ),
        pool.query(
            `SELECT p.user_id, u.username, u.profile_picture, p.problem_name, p.shares, p.spent, p.received
               FROM lp_positions p JOIN users u ON u.id = p.user_id`
        ),
    ]);
    const ticks = ticksRes.rows;

    // Each position carries what selling it alone fetches (the Sell button's figure); a person's
    // profit values everything they hold sold together (lib/lastProblem.js portfolioValueOf).
    const byUser = new Map();
    for (const r of positionsRes.rows) {
        let e = byUser.get(r.user_id);
        if (!e) {
            e = { userId: r.user_id, username: r.username, picture: r.profile_picture, spent: 0, received: 0, value: 0, positions: [] };
            byUser.set(r.user_id, e);
        }
        const shares = num(r.shares);
        const status = statusOf.get(r.problem_name);
        e.spent += num(r.spent);
        e.received += num(r.received);
        e.positions.push({
            problem: r.problem_name,
            shares,
            status,
            spent: num(r.spent),
            received: num(r.received),
            value: LP.positionValue(q, b, r.problem_name, shares, status),
        });
    }
    const people = [...byUser.values()].filter((e) => e.spent > 0 || e.received > 0);
    for (const e of people) {
        e.value = LP.portfolioValueOf(q, b, e.positions);
        e.profit = LP.profitOf(e);
    }

    const demon = {
        spent: num(market.demon_spent),
        received: num(market.demon_received),
        value: LP.portfolioValueOf(q, b, outcomes.map((o) => ({ problem: o.problem_name, shares: num(o.demon_shares), status: o.status }))),
    };
    demon.profit = LP.profitOf(demon);

    const leaderboard = people
        .map((e) => ({ userId: e.userId, username: e.username, picture: e.picture, profit: round2(e.profit) }))
        .concat([{ demon: true, profit: round2(demon.profit) }])
        .sort((a, b2) => (b2.profit - a.profit) || (a.demon ? 1 : 0) - (b2.demon ? 1 : 0));

    const list = outcomes.map((o) => {
        const id = o.problem_name;
        const m = meta.get(id) || {};
        return {
            id,
            status: o.status,
            price: o.status === 'open' ? prices[id] : (o.status === 'won' ? 1 : 0),
            solvedAt: o.solved_at,
            solvedBy: o.solved_by_name || null,
            title: { ru: titles.ru.get(sectionOf(id)) || '', en: titles.en.get(sectionOf(id)) || '' },
            difficulty: m.difficulty == null ? null : m.difficulty,
            starred: !!m.starred,
            demon: num(o.demon_shares) > LP.DUST,
        };
    });

    const open = list.filter((o) => o.status === 'open').sort((a, b2) => b2.price - a.price);
    const chartKeys = open.slice(0, 4).map((o) => o.id);
    const chart = LP.chartSeries(ticks.concat([{ created_at: new Date().toISOString(), prices }]), chartKeys);

    const feed = ticks
        .filter((t) => (t.kind === 'trade' && !String(t.source || '').startsWith('cancel:')) || t.kind === 'solved')
        .slice(-12)
        .reverse()
        .map((t) => ({
            kind: t.kind,
            actor: t.actor,
            username: t.username || null,
            problem: t.problem_name,
            amount: t.amount == null ? null : round2(Math.abs(num(t.amount))),
            side: num(t.shares) >= 0 ? 'buy' : 'sell',
            cancelled: !!t.cancelled_at,
            at: t.created_at,
        }));

    const value = {
        b,
        openedAt: market.opened_at,
        decidedAt: market.decided_at,
        resolvedAt: market.resolved_at,
        winner: market.winner,
        outcomes: list,
        openCount: open.length,
        chart,
        feed,
        leaderboard,
        traders: people.length,
        byUser,
    };
    publicCache = { at: Date.now(), value };
    return value;
}

function tradersLabel(n, lang) {
    const c = getCopy(lang);
    return lang === 'ru' ? `${n} ${ruPlural(n, ...c.traders)}` : `${n} ${n === 1 ? c.traders[0] : c.traders[1]}`;
}

/* One viewer's state: the public part in their language, names only for members, plus their
 * wallet, positions, cancellable chat bets and owned reactions. */
async function stateFor(userId, lang) {
    const pub = await publicState();
    if (!pub) return null;
    const signedIn = !!userId;
    const state = {
        b: pub.b,
        openedAt: pub.openedAt,
        decidedAt: pub.decidedAt,
        resolvedAt: pub.resolvedAt,
        winner: pub.winner,
        openCount: pub.openCount,
        traders: pub.traders,
        tradersLabel: tradersLabel(pub.traders, lang),
        chart: pub.chart,
        outcomes: pub.outcomes.map((o) => Object.assign({}, o, { title: o.title[lang] || o.title.en })),
        feed: pub.feed.map((f) => Object.assign({}, f, { username: signedIn ? f.username : null })),
        leaderboard: signedIn
            ? pub.leaderboard.slice(0, 20).map((e) => Object.assign({}, e, { you: e.userId === userId }))
            : null,
        me: null,
    };
    if (!signedIn) return state;

    const [wallet, chatBets, owned] = await Promise.all([
        pool.query('SELECT balance FROM quanta_wallets WHERE user_id = $1', [userId]),
        pool.query(
            `SELECT id, problem_name, shares, amount FROM lp_ticks
              WHERE user_id = $1 AND actor = 'chat' AND kind = 'trade' AND cancelled_at IS NULL AND shares > 0
              ORDER BY created_at`,
            [userId]
        ),
        ownedReactions(pool, userId),
    ]);
    const mine = pub.byUser.get(userId);
    const rank = pub.leaderboard.findIndex((e) => e.userId === userId);
    state.me = {
        balance: wallet.rows.length ? num(wallet.rows[0].balance) : null,
        positions: mine ? mine.positions.filter((p) => p.shares > LP.DUST).map((p) => Object.assign({}, p, {
            value: round2(p.value),
        })) : [],
        profit: mine && mine.profit !== undefined ? round2(mine.profit) : 0,
        rank: rank >= 0 ? rank + 1 : null,
        chatBets: chatBets.rows.map((r) => ({ id: Number(r.id), problem: r.problem_name, shares: num(r.shares), amount: num(r.amount) })),
        owned,
    };
    if (rank >= 20) state.leaderboard.push(Object.assign({}, pub.leaderboard[rank], { you: true }));
    return state;
}

/* The shop: every premium reaction in registry order, with what the app needs to draw it. */
function shopList(lang, asset) {
    const urls = Reactions.emojiUrls(asset);
    const now = new Date();
    return Reactions.CUSTOM.filter((e) => Reactions.isPremium(e.id)).map((e) => ({
        id: e.id,
        name: lang === 'ru' ? e.ru : e.en,
        url: urls[e.id],
        price: Number.isFinite(e.price) ? e.price : null,
        never: !e.trophy && !Number.isFinite(e.price),
        trophy: !!e.trophy,
        sale: e.sale || null,
        inSeason: Reactions.inSeason(e, now),
    }));
}

// ── Writing ───────────────────────────────────────────────────────────────────────────

async function ensureWallet(client, userId) {
    const ins = await client.query(
        'INSERT INTO quanta_wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id',
        [userId, LP.START_BALANCE]
    );
    if (ins.rowCount) {
        await client.query("INSERT INTO quanta_ledger (user_id, delta, reason) VALUES ($1, $2, 'grant')", [userId, LP.START_BALANCE]);
    }
    return ins.rowCount > 0;
}

async function moveMoney(client, userId, delta, reason, ref) {
    await client.query(
        'UPDATE quanta_wallets SET balance = balance + $2, updated_at = NOW() WHERE user_id = $1',
        [userId, delta.toFixed(4)]
    );
    await client.query(
        'INSERT INTO quanta_ledger (user_id, delta, reason, ref) VALUES ($1, $2, $3, $4)',
        [userId, delta.toFixed(4), reason, ref || null]
    );
}

async function inTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        if (result && result.rollback) await client.query('ROLLBACK');
        else await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function claim(userId) {
    const granted = await inTransaction((client) => ensureWallet(client, userId));
    invalidate();
    return granted;
}

/* A buy or a sell, serialised on the market row: every trade sees the prices the previous one
 * left, and a double click cannot spend the same quanta twice. */
async function executeTrade(userId, body) {
    const result = await inTransaction(async (client) => {
        const m = await client.query('SELECT * FROM lp_market WHERE id = 1 FOR UPDATE');
        const market = m.rows[0];
        if (!market || market.decided_at || market.resolved_at) return { rollback: true, status: 409, error: 'not_open' };
        const b = num(market.b);
        const outs = await client.query('SELECT problem_name, q, status FROM lp_outcomes');
        const q = openQ(outs.rows);
        const open = new Set(Object.keys(q));

        await ensureWallet(client, userId);
        const w = await client.query('SELECT balance FROM quanta_wallets WHERE user_id = $1 FOR UPDATE', [userId]);
        const problem = LP.isProblemId(body.problem) ? body.problem : null;
        const pos = problem
            ? await client.query('SELECT shares FROM lp_positions WHERE user_id = $1 AND problem_name = $2 FOR UPDATE', [userId, problem])
            : { rows: [] };
        const held = pos.rows.length ? num(pos.rows[0].shares) : 0;
        const check = LP.validateTrade(body, { open, balance: num(w.rows[0].balance), held });
        if (!check.ok) return { rollback: true, status: 400, error: check.error };
        const v = check.value;

        let shares;
        let amount;
        if (v.side === 'buy') {
            shares = LMSR.sharesForAmount(q, b, v.problem, v.amount);
            amount = v.amount;
            await client.query('UPDATE lp_outcomes SET q = q + $2 WHERE problem_name = $1', [v.problem, shares]);
            await client.query(
                `INSERT INTO lp_positions (user_id, problem_name, shares, spent) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, problem_name)
                 DO UPDATE SET shares = lp_positions.shares + EXCLUDED.shares, spent = lp_positions.spent + EXCLUDED.spent`,
                [userId, v.problem, shares, amount.toFixed(4)]
            );
            await moveMoney(client, userId, -amount, 'buy', v.problem);
            q[v.problem] += shares;
        } else {
            shares = v.shares;
            const proceeds = floor4(LMSR.sellProceeds(q, b, v.problem, shares));
            const left = held - shares < LP.DUST ? 0 : held - shares;
            await client.query('UPDATE lp_outcomes SET q = q - $2 WHERE problem_name = $1', [v.problem, shares]);
            await client.query(
                'UPDATE lp_positions SET shares = $3, received = received + $4 WHERE user_id = $1 AND problem_name = $2',
                [userId, v.problem, left, proceeds.toFixed(4)]
            );
            await moveMoney(client, userId, proceeds, 'sell', v.problem);
            q[v.problem] -= shares;
            amount = -proceeds;
            shares = -shares;
        }
        await client.query(
            `INSERT INTO lp_ticks (kind, actor, user_id, problem_name, shares, amount, prices)
             VALUES ('trade', 'user', $1, $2, $3, $4, $5)`,
            [userId, v.problem, shares, amount.toFixed(4), JSON.stringify(snapshot(LMSR.prices(q, b)))]
        );
        return { status: 200, value: { side: v.side, problem: v.problem, shares: Math.abs(shares), amount: Math.abs(amount) } };
    });
    if (result.status === 200) invalidate();
    return result;
}

/* A bet placed from what someone wrote in the chat can be undone by that person, for every
 * quantum they were charged. The shares go back to the market; whatever the price did in the
 * meantime is the house's loss, not theirs. */
async function cancelChatBet(userId, tickId) {
    const result = await inTransaction(async (client) => {
        const m = await client.query('SELECT * FROM lp_market WHERE id = 1 FOR UPDATE');
        const market = m.rows[0];
        if (!market || market.decided_at || market.resolved_at) return { rollback: true, status: 409, error: 'not_open' };
        const t = await client.query(
            `SELECT id, problem_name, shares, amount FROM lp_ticks
              WHERE id = $1 AND user_id = $2 AND actor = 'chat' AND kind = 'trade' AND cancelled_at IS NULL AND shares > 0
              FOR UPDATE`,
            [tickId, userId]
        );
        if (!t.rows.length) return { rollback: true, status: 404, error: 'closed' };
        const tick = t.rows[0];
        const outs = await client.query('SELECT problem_name, q, status FROM lp_outcomes');
        const q = openQ(outs.rows);
        if (!(tick.problem_name in q)) return { rollback: true, status: 409, error: 'closed' };
        const pos = await client.query(
            'SELECT shares FROM lp_positions WHERE user_id = $1 AND problem_name = $2 FOR UPDATE',
            [userId, tick.problem_name]
        );
        const held = pos.rows.length ? num(pos.rows[0].shares) : 0;
        const shares = num(tick.shares);
        const amount = num(tick.amount);
        if (held + LP.DUST < shares) return { rollback: true, status: 409, error: 'not_held' };

        await ensureWallet(client, userId);
        await client.query('UPDATE lp_outcomes SET q = q - $2 WHERE problem_name = $1', [tick.problem_name, shares]);
        await client.query(
            'UPDATE lp_positions SET shares = $3, spent = spent - $4 WHERE user_id = $1 AND problem_name = $2',
            [userId, tick.problem_name, held - shares < LP.DUST ? 0 : held - shares, amount.toFixed(4)]
        );
        await moveMoney(client, userId, amount, 'cancel', `tick:${tick.id}`);
        await client.query('UPDATE lp_ticks SET cancelled_at = NOW() WHERE id = $1', [tick.id]);
        q[tick.problem_name] -= shares;
        await client.query(
            `INSERT INTO lp_ticks (kind, actor, user_id, problem_name, shares, amount, prices, source)
             VALUES ('trade', 'chat', $1, $2, $3, $4, $5, $6)`,
            [userId, tick.problem_name, -shares, (-amount).toFixed(4), JSON.stringify(snapshot(LMSR.prices(q, num(market.b)))), `cancel:${tick.id}`]
        );
        return { status: 200, value: { problem: tick.problem_name, amount } };
    });
    if (result.status === 200) invalidate();
    return result;
}

async function unlockReaction(userId, emoji) {
    if (!Reactions.isPremium(emoji)) return { status: 400, error: 'not_premium' };
    const result = await inTransaction(async (client) => {
        await ensureWallet(client, userId);
        const w = await client.query('SELECT balance FROM quanta_wallets WHERE user_id = $1 FOR UPDATE', [userId]);
        const has = await client.query('SELECT 1 FROM reaction_unlocks WHERE user_id = $1 AND emoji = $2', [userId, emoji]);
        const check = Reactions.purchaseCheck(emoji, { owned: has.rowCount > 0, balance: num(w.rows[0].balance), now: new Date() });
        if (!check.ok) return { rollback: true, status: check.error === 'owned' ? 409 : 400, error: check.error };
        await client.query(
            "INSERT INTO reaction_unlocks (user_id, emoji, price, source) VALUES ($1, $2, $3, 'purchase')",
            [userId, emoji, check.price]
        );
        await moveMoney(client, userId, -check.price, 'unlock', emoji);
        return { status: 200, value: { emoji, price: check.price } };
    });
    if (result.status === 200) invalidate();
    return result;
}

// ── The sync: solved problems, the decision, the payout, the trophies ─────────────────

/* The text of a real solution for this problem, in either language, or null. A missing file
 * and the untouched /create-problem template both mean: not solved. */
function solutionText(id) {
    for (const lang of ['ru', 'en']) {
        try {
            const text = fs.readFileSync(path.join(POSTS_DIR, lang, `${id}.md`), 'utf8');
            if (!LP.isTemplatePost(text)) return text;
        } catch (_err) { /* no file in this language */ }
    }
    return null;
}

/* Who posted the first real solution, and when, from the contributions log. */
async function firstSolution(id) {
    const { rows } = await pool.query(
        `SELECT user_id, edited_at, new_content FROM contributions
          WHERE problem_name = $1 AND COALESCE(length(new_content), 0) > 0
          ORDER BY edited_at ASC LIMIT 40`,
        [id]
    );
    for (const r of rows) {
        if (!LP.isTemplatePost(r.new_content)) return { userId: r.user_id || null, at: r.edited_at };
    }
    return { userId: null, at: null };
}

async function eliminate({ problem, solvedAt, userId }) {
    const done = await inTransaction(async (client) => {
        const m = await client.query('SELECT * FROM lp_market WHERE id = 1 FOR UPDATE');
        const market = m.rows[0];
        if (!market || market.resolved_at) return { rollback: true };
        const outs = await client.query('SELECT problem_name, q, status FROM lp_outcomes');
        const q = openQ(outs.rows);
        if (!(problem in q) || Object.keys(q).length <= 1) return { rollback: true };
        const last = await client.query('SELECT MAX(created_at) AS t FROM lp_ticks');
        const floor = Math.max(new Date(market.opened_at).getTime(), last.rows[0].t ? new Date(last.rows[0].t).getTime() : 0);
        const at = new Date(Math.min(Date.now(), Math.max(solvedAt ? new Date(solvedAt).getTime() : Date.now(), floor)));
        await client.query(
            "UPDATE lp_outcomes SET status = 'solved', solved_at = $2, solved_by = $3 WHERE problem_name = $1",
            [problem, at, userId]
        );
        const after = LMSR.eliminate(q, problem);
        await client.query(
            `INSERT INTO lp_ticks (kind, actor, user_id, problem_name, prices, created_at)
             VALUES ('solved', 'system', $1, $2, $3, $4)`,
            [userId, problem, JSON.stringify(snapshot(LMSR.prices(after, num(market.b)))), at]
        );
        return { ok: true };
    });
    if (!done || !done.ok) return false;
    invalidate();
    const holders = await pool.query('SELECT user_id FROM lp_positions WHERE problem_name = $1 AND shares > $2', [problem, LP.DUST]);
    let who = null;
    if (userId) {
        const u = await pool.query('SELECT username FROM users WHERE id = $1', [userId]).catch(() => ({ rows: [] }));
        who = u.rows[0] ? u.rows[0].username : null;
    }
    await notifyUsers(holders.rows.map((r) => r.user_id), (n) => ({ title: n.solvedTitle(problem), message: n.solved(problem, who) }));
    return true;
}

async function stepMarket() {
    const data = await readMarket(pool);
    if (!data) return;
    const openIds = Object.keys(data.q);
    const step = LP.marketStep({
        openCount: openIds.length,
        decidedAt: data.market.decided_at,
        resolvedAt: data.market.resolved_at,
        now: Date.now(),
    });
    if (step === 'decide') {
        await pool.query('UPDATE lp_market SET decided_at = NOW() WHERE id = 1 AND decided_at IS NULL');
        await pool.query(
            "INSERT INTO lp_ticks (kind, actor, problem_name, prices) VALUES ('decided', 'system', $1, $2)",
            [openIds[0], JSON.stringify({ [openIds[0]]: 1 })]
        );
        invalidate();
        const holders = await pool.query('SELECT DISTINCT user_id FROM lp_positions WHERE shares > $1', [LP.DUST]);
        await notifyUsers(holders.rows.map((r) => r.user_id), (n) => ({ title: n.decidedTitle(openIds[0]), message: n.decided }));
    } else if (step === 'undecide') {
        await pool.query('UPDATE lp_market SET decided_at = NULL WHERE id = 1');
        invalidate();
    } else if (step === 'pay') {
        await payOut(openIds[0]);
    }
}

async function payOut(winner) {
    const paid = await inTransaction(async (client) => {
        const m = await client.query('SELECT * FROM lp_market WHERE id = 1 FOR UPDATE');
        const market = m.rows[0];
        if (!market || market.resolved_at || !market.decided_at) return { rollback: true };
        const open = await client.query("SELECT problem_name, demon_shares FROM lp_outcomes WHERE status = 'open'");
        if (open.rows.length !== 1 || open.rows[0].problem_name !== winner) return { rollback: true };
        const holders = await client.query(
            'SELECT user_id, shares FROM lp_positions WHERE problem_name = $1 AND shares > $2 FOR UPDATE',
            [winner, LP.DUST]
        );
        const payouts = [];
        for (const h of holders.rows) {
            const amount = floor4(num(h.shares));
            if (!(amount > 0)) continue;
            await ensureWallet(client, h.user_id);
            await moveMoney(client, h.user_id, amount, 'payout', winner);
            await client.query(
                'UPDATE lp_positions SET received = received + $3 WHERE user_id = $1 AND problem_name = $2',
                [h.user_id, winner, amount.toFixed(4)]
            );
            payouts.push({ userId: h.user_id, amount });
        }
        await client.query("UPDATE lp_outcomes SET status = 'won' WHERE problem_name = $1", [winner]);
        await client.query(
            'UPDATE lp_market SET resolved_at = NOW(), winner = $1, demon_received = demon_received + $2 WHERE id = 1',
            [winner, floor4(num(open.rows[0].demon_shares)).toFixed(4)]
        );
        await client.query(
            "INSERT INTO lp_ticks (kind, actor, problem_name, prices) VALUES ('resolved', 'system', $1, $2)",
            [winner, JSON.stringify({ [winner]: 1 })]
        );
        return { ok: true, payouts };
    });
    if (!paid || !paid.ok) return;
    invalidate();
    for (const p of paid.payouts) {
        const amount = Math.floor(p.amount);
        await notifyUsers([p.userId], (n) => ({ title: n.payoutTitle(amount), message: n.payout(winner) }));
    }
}

async function awardTrophy(emoji, userId, message) {
    if (!userId) return false;
    const ins = await pool.query(
        `INSERT INTO reaction_unlocks (user_id, emoji, price, source) VALUES ($1, $2, 0, 'trophy')
         ON CONFLICT DO NOTHING RETURNING user_id`,
        [userId, emoji]
    );
    if (!ins.rowCount) return false;
    const entry = Reactions.premiumEntry(emoji);
    await notifyUsers([userId], (n, lang) => ({ title: n.trophyTitle(lang === 'ru' ? entry.ru : entry.en), message: n[message] }));
    return true;
}

/* :n2000: goes to whoever posted the 2000th solution: the problems that have a post, ordered by
 * when their first post appeared, the site's own count (either language, template or not, as on
 * the homepage). Checked until it has been given. */
async function checkN2000() {
    const given = await pool.query("SELECT 1 FROM reaction_unlocks WHERE emoji = ':n2000:' AND source = 'trophy'");
    if (given.rowCount) return;
    const solved = new Set();
    for (const lang of ['en', 'ru']) {
        let files = [];
        try {
            files = fs.readdirSync(path.join(POSTS_DIR, lang));
        } catch (_err) { /* no folder */ }
        for (const f of files) {
            if (!f.endsWith('.md')) continue;
            const id = f.slice(0, -3);
            if (isBookProblem(id)) solved.add(id);
        }
    }
    if (solved.size < 2000) return;
    const { rows } = await pool.query(
        `SELECT problem_name, MIN(edited_at) AS t FROM (
             SELECT problem_name, edited_at FROM contributions
              WHERE COALESCE(length(original_content), 0) = 0 AND COALESCE(length(new_content), 0) > 0
             UNION ALL
             SELECT problem_name, edited_at FROM github_contributions
              WHERE COALESCE(length(original_content), 0) = 0 AND COALESCE(length(new_content), 0) > 0
         ) x GROUP BY problem_name`
    );
    const firstSeen = new Map(rows.map((r) => [r.problem_name, new Date(r.t).getTime()]));
    const ordered = [...solved].sort((a, b) => ((firstSeen.get(a) ?? -Infinity) - (firstSeen.get(b) ?? -Infinity)) || compareIds(a, b));
    const theOne = ordered[1999];
    const { userId } = await firstSolution(theOne);
    if (await awardTrophy(':n2000:', userId, 'trophyN2000')) {
        console.log(`last-problem: :n2000: awarded for ${theOne} to user ${userId}`);
    }
}

/* :last: goes to whoever solves the winning problem, whenever that happens. */
async function checkLastTrophy(market) {
    if (!market || !market.winner) return;
    const given = await pool.query("SELECT 1 FROM reaction_unlocks WHERE emoji = ':last:' AND source = 'trophy'");
    if (given.rowCount || !solutionText(market.winner)) return;
    const { userId } = await firstSolution(market.winner);
    await awardTrophy(':last:', userId, 'trophyLast');
}

let syncing = false;
async function syncSolved() {
    if (!ENABLED || syncing) return;
    syncing = true;
    try {
        const data = await readMarket(pool).catch((err) => {
            // Before migration 054 the tables do not exist: nothing to do, and nothing to shout about.
            if (err && err.code === '42P01') return null;
            throw err;
        });
        if (!data) return;
        if (!data.market.resolved_at) {
            const openIds = Object.keys(data.q);
            const solvedNow = [];
            for (const id of openIds) {
                if (!solutionText(id)) continue;
                const first = await firstSolution(id);
                solvedNow.push({ problem: id, solvedAt: first.at || new Date(), userId: first.userId });
            }
            for (const e of LP.eliminationsFor(openIds, solvedNow)) {
                if (await eliminate(e)) console.log(`last-problem: ${e.problem} solved, out of the market`);
            }
            await stepMarket();
        } else {
            await checkLastTrophy(data.market);
        }
        await checkN2000();
    } catch (err) {
        console.error('last-problem sync:', err);
    } finally {
        syncing = false;
    }
}

function start() {
    if (!ENABLED) return;
    setTimeout(syncSolved, 20 * 1000).unref();
    setInterval(syncSolved, SYNC_MS).unref();
}

// ── Routes ────────────────────────────────────────────────────────────────────────────

const userKey = (prefix) => (req) => `${prefix}:${req.session && req.session.userId ? `u${req.session.userId}` : ipKeyGenerator(req.ip)}`;
const limiter = (prefix, max) => rateLimit({
    windowMs: 60 * 1000,
    max,
    keyGenerator: userKey(prefix),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
});
const writeLimiter = limiter('lpw', 40);
const readLimiter = limiter('lpr', 180);

function guardWrite(req, res, next) {
    if (!ENABLED) return res.status(404).json({ error: 'not_found' });
    // Money moves here, so a form on another site must not be able to spend a member's quanta
    // (there is no CSRF token anywhere on the site; see CLAUDE.md, Security).
    if (isCrossSite({ fetchSite: req.get('sec-fetch-site'), origin: req.get('origin'), host: req.get('host') })) {
        return res.status(403).json({ error: 'cross_site' });
    }
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'auth' });
    next();
}

const langOf = (req) => {
    if (req.params.lang) return req.params.lang === 'ru' ? 'ru' : 'en';
    if (req.query.lang) return req.query.lang === 'ru' ? 'ru' : 'en';
    return req.session && req.session.lang === 'ru' ? 'ru' : 'en';
};

const pageRouter = express.Router({ mergeParams: true });

pageRouter.get('/', async (req, res) => {
    const lang = langOf(req);
    i18n.setLocale(req, lang);
    const notFound = () => res.status(404).render('404', { __: req.__, pageUrl: req.originalUrl, lang });
    if (!ENABLED) return notFound();
    try {
        const userId = (req.session && req.session.userId) || null;
        const state = await stateFor(userId, lang);
        if (!state) return notFound();
        const chats = await communityChats().catch(() => ({}));
        const asset = req.app.locals.asset;
        const tab = ['market', 'top', 'shop'].includes(req.query.tab) ? req.query.tab : 'market';
        const embed = req.query.embed === '1';
        res.render('apps/last_problem', {
            lang,
            pageLang: lang,
            embed,
            copy: getCopy(lang),
            boot: {
                lang,
                embed,
                tab,
                rx: Reactions.isPremium(req.query.rx) ? req.query.rx : null,
                signedIn: !!userId,
                state,
                copy: clientCopy(lang),
                shop: shopList(lang, asset),
                art: {
                    coin: asset('/img/apps/last-problem/coin.svg'),
                    coinBack: asset('/img/apps/last-problem/coin-back.svg'),
                    demon: asset('/img/apps/last-problem/demon.svg'),
                },
                loginUrl: `/${lang}/login`,
                chatUrl: chats[lang] ? `/${lang}/messages/${chats[lang]}?app=last-problem` : null,
                chatMessageUrl: chats[lang] ? `/${lang}/messages/${chats[lang]}` : null,
                api: '/api/last-problem',
            },
        });
    } catch (err) {
        console.error('last-problem page:', err);
        res.status(500).render('404', { __: req.__, pageUrl: req.originalUrl, lang });
    }
});

const api = express.Router();

api.get('/state', readLimiter, async (req, res) => {
    if (!ENABLED) return res.status(404).json({ error: 'not_found' });
    try {
        const state = await stateFor((req.session && req.session.userId) || null, langOf(req));
        if (!state) return res.status(404).json({ error: 'not_found' });
        res.set('Cache-Control', 'no-store').json(state);
    } catch (err) {
        console.error('last-problem state:', err);
        res.status(500).json({ error: 'server' });
    }
});

// What the card under the announcement in the chat shows: the question, the top three problems,
// the best three predictors.
api.get('/card', readLimiter, async (req, res) => {
    if (!ENABLED) return res.status(404).json({ error: 'not_found' });
    const lang = langOf(req);
    try {
        const userId = (req.session && req.session.userId) || null;
        const pub = await publicState();
        if (!pub) return res.status(404).json({ error: 'not_found' });
        const c = getCopy(lang);
        const top = pub.outcomes
            .filter((o) => o.status === 'open')
            .sort((a, b) => b.price - a.price)
            .slice(0, 3)
            .map((o) => ({ id: o.id, price: o.price }));
        const leaders = userId
            ? pub.leaderboard.filter((e) => !e.demon && e.profit > 0).slice(0, 3).map((e) => ({ username: e.username, profit: e.profit }))
            : [];
        res.set('Cache-Control', 'no-store').json({
            title: c.appName,
            kind: c.appKind,
            question: c.question,
            open: c.card.open,
            leadersLabel: c.card.leaders,
            top,
            leaders,
            traders: tradersLabel(pub.traders, lang),
            winner: pub.winner,
            url: `/${lang}/apps/last-problem`,
            coin: req.app.locals.asset('/img/apps/last-problem/coin.svg'),
            demon: req.app.locals.asset('/img/apps/last-problem/demon.svg'),
        });
    } catch (err) {
        console.error('last-problem card:', err);
        res.status(500).json({ error: 'server' });
    }
});

const respond = (res, result) => {
    if (result.status === 200) return res.json(Object.assign({ ok: true }, result.value));
    return res.status(result.status).json({ error: result.error });
};

api.post('/claim', writeLimiter, guardWrite, async (req, res) => {
    try {
        const granted = await claim(req.session.userId);
        res.json({ ok: true, granted });
    } catch (err) {
        console.error('last-problem claim:', err);
        res.status(500).json({ error: 'server' });
    }
});

api.post('/trade', writeLimiter, guardWrite, async (req, res) => {
    try {
        respond(res, await executeTrade(req.session.userId, req.body || {}));
    } catch (err) {
        console.error('last-problem trade:', err);
        res.status(500).json({ error: 'server' });
    }
});

api.post('/cancel-chat-bet', writeLimiter, guardWrite, async (req, res) => {
    const tickId = Number(req.body && req.body.id);
    if (!Number.isSafeInteger(tickId) || tickId <= 0) return res.status(400).json({ error: 'closed' });
    try {
        respond(res, await cancelChatBet(req.session.userId, tickId));
    } catch (err) {
        console.error('last-problem cancel:', err);
        res.status(500).json({ error: 'server' });
    }
});

api.post('/unlock', writeLimiter, guardWrite, async (req, res) => {
    try {
        respond(res, await unlockReaction(req.session.userId, req.body && req.body.emoji));
    } catch (err) {
        console.error('last-problem unlock:', err);
        res.status(500).json({ error: 'server' });
    }
});

// Which premium reactions this member owns, for the pickers in the chat and under solutions.
const reactionsApi = express.Router();
reactionsApi.get('/owned', readLimiter, async (req, res) => {
    const userId = (req.session && req.session.userId) || null;
    res.set('Cache-Control', 'no-store').json({ owned: await ownedReactions(pool, userId) });
});

module.exports = {
    pageRouter,
    api,
    reactionsApi,
    start,
    syncSolved,
    pool,
    ENABLED,
    // for scripts/seed-last-problem.js
    isBookProblem,
    readMarket,
    solutionText,
    firstSolution,
    communityChats,
    notifyUsers,
    invalidate,
};
