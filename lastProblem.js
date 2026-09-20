// lastProblem.js: «Последняя задача», a one-time prediction mini app inside the community chats.
//
// On 2026-09-15 emixter asked both community chats which problem will be solved last (#1958 RU,
// #1959 EN). astrosander answered "Можно начинать делать ставки на polymarket" (#1961), Valter
// put his on 5.8.9 ("только не решите теперь ее никто") and emixter on 7.2.11. This is that
// market, opened from a card in the chat the way a Telegram mini app opens from a bot message:
//
//   - the outcomes are the problems unsolved when the question was asked (lp_outcomes);
//   - every account gets 1000 quanta (ħ) once, and prices come from an LMSR market maker
//     (js/lmsr.js), so any amount trades at any time;
//   - a problem drops out when its solution appears (checked every two minutes: none of the four
//     routes that write posts/ has a hook, see syncSolved), and then "conservation of interest",
//     the owner's rule since the evening it opened: the solved problem's shares are worth nothing
//     and everything still in play earns interest at p / (1 - p) of its price p, so a problem
//     solved near the end pays off even if it is not the last (eliminate, lib/lastProblem.js
//     settleSolve). The last one standing pays its full value after 72 hours;
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
const LMSR = require('./js/lmsr');
const Reactions = require('./js/reactions');
const LP = require('./lib/lastProblem');
const { getCopy, clientCopy } = require('./lastProblemCopy');
const { isCrossSite } = require('./lib/passwordReset');
const { ruPlural } = require('./lib/ruPlural');
const { ownedReactions } = require('./lib/reactionUnlocks');
const { isBookProblem } = require('./lib/bookProblems');
const notifications = require('./notifications');

const pool = require('./lib/db');

// The kill switch: LAST_PROBLEM=off in the environment and a restart take the app, its card and
// its sync off the site without a deploy. Premium reactions people own keep working.
const ENABLED = String(process.env.LAST_PROBLEM || '').trim().toLowerCase() !== 'off';

const POSTS_DIR = path.join(__dirname, 'posts');
const SYNC_MS = 2 * 60 * 1000;
const PUBLIC_TTL_MS = 5 * 1000;
const NOTIFY_TYPE = 'last_problem';

const num = (v) => Number(v) || 0;
// Money leaves the market rounded down to 1/10000 ħ, never up.
const { floor4 } = LP;
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

/* Section titles in both languages, from the CSVs the rest of the site reads (the Russian one
 * starts with a byte-order mark and has CRLF line ends). */
let sectionTitles = null;
function loadSectionTitles() {
    if (sectionTitles) return sectionTitles;
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
            map.set(line.slice(0, first).trim(), line.slice(first + 1, last).trim());
        }
        return map;
    };
    sectionTitles = { en: parse('src/database/sections.csv'), ru: parse('src/ru/database/sections.csv') };
    return sectionTitles;
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

/* The demon's forecast (scripts/last-problem-forecast.py writes data/lp-forecast.json): for each
 * open problem the chance it is solved within 7 days and the market's fair weight under
 * conservation of interest. Read again when the file changes; a missing or broken file means no
 * forecast is shown, nothing else. */
const FORECAST_PATH = path.join(__dirname, 'data', 'lp-forecast.json');
let forecastCache = { mtime: 0, value: null };
function forecast() {
    try {
        const mtime = fs.statSync(FORECAST_PATH).mtimeMs;
        if (mtime !== forecastCache.mtime) {
            const raw = JSON.parse(fs.readFileSync(FORECAST_PATH, 'utf8'));
            const byProblem = new Map();
            for (const p of raw.problems || []) {
                if (LP.isProblemId(p.problem) && p.p7 >= 0 && p.p7 <= 1) byProblem.set(p.problem, { p7: p.p7, fair: p.fair });
            }
            forecastCache = { mtime, value: { generated: raw.generated || null, byProblem } };
        }
    } catch (_err) {
        forecastCache = { mtime: 0, value: null };
    }
    return forecastCache.value;
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

// A bet placed from the chat can be taken back for every quantum only until the first solve after
// it: from then on it has earned interest, or been lost, and it is an ordinary position to sell. A
// solve that was reverted (cancelled_at set by scripts/seed-last-problem.js --revert) does not
// count. A fixed fragment over lp_ticks t, no input in it.
const NO_SOLVE_SINCE = "NOT EXISTS (SELECT 1 FROM lp_ticks s WHERE s.kind = 'solved' AND s.cancelled_at IS NULL AND s.created_at >= t.created_at)";

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
    return { market: m.rows[0], outcomes, b: num(m.rows[0].b), scale: scaleOf(m.rows[0]), q: openQ(outcomes) };
}

// Before migration 055 there is no column, and the scale was 1.
function scaleOf(market) {
    const s = Number(market && market.scale);
    return s > 0 ? s : 1;
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
    const { market, outcomes, b, scale, q } = data;
    const prices = LMSR.prices(q, b);
    const ids = outcomes.map((o) => o.problem_name);
    const meta = await problemMeta(ids);
    const titles = loadSectionTitles();
    const statusOf = new Map(outcomes.map((o) => [o.problem_name, o.status]));

    const [ticksRes, positionsRes, bountyRes] = await Promise.all([
        pool.query(
            `SELECT t.id, t.kind, t.actor, t.user_id, u.username, t.problem_name, t.shares, t.amount,
                    t.rate, t.prices, t.source, t.cancelled_at, t.created_at
               FROM lp_ticks t LEFT JOIN users u ON u.id = t.user_id
              ORDER BY t.created_at, t.id`
        ),
        pool.query(
            `SELECT p.user_id, u.username, u.profile_picture, p.problem_name, p.shares, p.spent, p.received, p.interest
               FROM lp_positions p JOIN users u ON u.id = p.user_id`
        ),
        // Bounties for solving, net of any a revert took back (scripts/seed-last-problem.js).
        pool.query(
            `SELECT l.user_id, u.username, u.profile_picture, SUM(l.delta) AS bounty
               FROM quanta_ledger l JOIN users u ON u.id = l.user_id
              WHERE l.reason = 'bounty' OR (l.reason = 'clawback' AND l.ref LIKE 'revert:%:bounty')
              GROUP BY l.user_id, u.username, u.profile_picture`
        ),
    ]);
    const ticks = ticksRes.rows;

    // Each position carries what selling it alone fetches (the Sell button's figure); a person's
    // profit values everything they hold sold together (lib/lastProblem.js portfolioValueOf).
    const byUser = new Map();
    const entryFor = (r) => {
        let e = byUser.get(r.user_id);
        if (!e) {
            e = { userId: r.user_id, username: r.username, picture: r.profile_picture, spent: 0, received: 0, interest: 0, bounty: 0, value: 0, positions: [] };
            byUser.set(r.user_id, e);
        }
        return e;
    };
    for (const r of positionsRes.rows) {
        const e = entryFor(r);
        const shares = num(r.shares);
        const status = statusOf.get(r.problem_name);
        e.spent += num(r.spent);
        e.received += num(r.received);
        e.interest += num(r.interest);
        e.positions.push({
            problem: r.problem_name,
            shares,
            status,
            spent: num(r.spent),
            received: num(r.received),
            interest: num(r.interest),
            value: LP.positionValue(q, b, r.problem_name, shares, status, scale),
        });
    }
    // Someone who solved a problem but never traded is on the board too.
    for (const r of bountyRes.rows) entryFor(r).bounty = num(r.bounty);
    const people = [...byUser.values()].filter((e) => e.spent > 0 || e.received > 0 || e.interest > 0 || e.bounty > 0);
    for (const e of people) {
        e.value = LP.portfolioValueOf(q, b, e.positions, scale);
        e.profit = LP.profitOf(e);
        e.earned = LP.earnedOf(e);
    }

    const demon = {
        spent: num(market.demon_spent),
        received: num(market.demon_received),
        interest: num(market.demon_interest),
        value: LP.portfolioValueOf(q, b, outcomes.map((o) => ({ problem: o.problem_name, shares: num(o.demon_shares), status: o.status })), scale),
    };
    demon.profit = LP.profitOf(demon);

    // People only, by what they earned (lib/lastProblem.js rankBoard); the demon is the benchmark,
    // shown apart, since it trades by the model with the house's money.
    const leaderboard = LP.rankBoard(people.map((e) => ({
        userId: e.userId, username: e.username, picture: e.picture, earned: round2(e.earned), profit: round2(e.profit),
    })));
    const benchmark = { earned: round2(demon.profit) };

    const fc = forecast();
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
            soon: o.status === 'open' && fc && fc.byProblem.has(id) ? fc.byProblem.get(id).p7 : null,
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
            rate: t.kind === 'solved' && t.rate != null ? Number(t.rate) : null,
            side: num(t.shares) >= 0 ? 'buy' : 'sell',
            cancelled: !!t.cancelled_at,
            at: t.created_at,
        }));

    const value = {
        b,
        scale,
        openedAt: market.opened_at,
        decidedAt: market.decided_at,
        resolvedAt: market.resolved_at,
        winner: market.winner,
        outcomes: list,
        openCount: open.length,
        chart,
        feed,
        leaderboard,
        benchmark,
        traders: people.length,
        solvedCount: outcomes.filter((o) => o.status === 'solved').length,
        total: outcomes.length,
        bounty: LP.SOLVER_BOUNTY,
        forecastAt: fc ? fc.generated : null,
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
        scale: pub.scale,
        openedAt: pub.openedAt,
        decidedAt: pub.decidedAt,
        resolvedAt: pub.resolvedAt,
        winner: pub.winner,
        openCount: pub.openCount,
        traders: pub.traders,
        tradersLabel: tradersLabel(pub.traders, lang),
        solvedCount: pub.solvedCount,
        total: pub.total,
        bounty: pub.bounty,
        forecastAt: pub.forecastAt,
        chart: pub.chart,
        outcomes: pub.outcomes.map((o) => Object.assign({}, o, { title: o.title[lang] || o.title.en })),
        feed: pub.feed.map((f) => Object.assign({}, f, { username: signedIn ? f.username : null })),
        leaderboard: signedIn
            ? pub.leaderboard.slice(0, 20).map((e) => Object.assign({}, e, { you: e.userId === userId }))
            : null,
        benchmark: signedIn ? pub.benchmark : null,
        me: null,
    };
    if (!signedIn) return state;

    const [wallet, chatBets, owned] = await Promise.all([
        pool.query('SELECT balance FROM quanta_wallets WHERE user_id = $1', [userId]),
        pool.query(
            `SELECT t.id, t.problem_name, t.shares, t.amount FROM lp_ticks t
              WHERE t.user_id = $1 AND t.actor = 'chat' AND t.kind = 'trade' AND t.cancelled_at IS NULL AND t.shares > 0
                AND ${NO_SOLVE_SINCE}
              ORDER BY t.created_at`,
            [userId]
        ),
        ownedReactions(pool, userId),
    ]);
    const mine = pub.byUser.get(userId);
    const rank = pub.leaderboard.findIndex((e) => e.userId === userId);
    state.me = {
        balance: wallet.rows.length ? num(wallet.rows[0].balance) : null,
        positions: mine ? mine.positions.filter((p) => p.shares > LP.DUST || p.interest > 0).map((p) => Object.assign({}, p, {
            value: round2(p.value),
            interest: round2(p.interest),
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
        const scale = scaleOf(market);
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
            shares = LMSR.sharesForAmount(q, b, v.problem, v.amount, scale);
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
            const proceeds = floor4(LMSR.sellProceeds(q, b, v.problem, shares, scale));
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
 * quantum they were charged, until the first solve after it (NO_SOLVE_SINCE). The shares go back
 * to the market; whatever the price did in the meantime is the house's loss, not theirs. */
async function cancelChatBet(userId, tickId) {
    const result = await inTransaction(async (client) => {
        const m = await client.query('SELECT * FROM lp_market WHERE id = 1 FOR UPDATE');
        const market = m.rows[0];
        if (!market || market.decided_at || market.resolved_at) return { rollback: true, status: 409, error: 'not_open' };
        const t = await client.query(
            `SELECT t.id, t.problem_name, t.shares, t.amount FROM lp_ticks t
              WHERE t.id = $1 AND t.user_id = $2 AND t.actor = 'chat' AND t.kind = 'trade' AND t.cancelled_at IS NULL AND t.shares > 0
                AND ${NO_SOLVE_SINCE}
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

/* A problem is solved: it leaves the market, and everyone holding problems still in play is paid
 * interest on them in the same transaction (lib/lastProblem.js settleSolve), the demon included.
 * Each position's interest is its own ledger row, ref solved:<tick>:<problem>, so a revert
 * (scripts/seed-last-problem.js) can take back exactly what this paid. */
async function eliminate({ problem, solvedAt, userId }) {
    const done = await inTransaction(async (client) => {
        const m = await client.query('SELECT * FROM lp_market WHERE id = 1 FOR UPDATE');
        const market = m.rows[0];
        if (!market || market.resolved_at) return { rollback: true };
        const outs = await client.query('SELECT problem_name, q, status, demon_shares FROM lp_outcomes');
        const q = openQ(outs.rows);
        if (!(problem in q) || Object.keys(q).length <= 1) return { rollback: true };
        const last = await client.query('SELECT MAX(created_at) AS t FROM lp_ticks');
        const floor = Math.max(new Date(market.opened_at).getTime(), last.rows[0].t ? new Date(last.rows[0].t).getTime() : 0);
        const at = new Date(Math.min(Date.now(), Math.max(solvedAt ? new Date(solvedAt).getTime() : Date.now(), floor)));

        const pos = await client.query(
            'SELECT user_id, problem_name, shares FROM lp_positions WHERE shares > $1 FOR UPDATE',
            [LP.DUST]
        );
        const byUser = new Map();
        for (const r of pos.rows) {
            if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
            byUser.get(r.user_id).push({ problem: r.problem_name, shares: num(r.shares) });
        }
        const holders = [...byUser.entries()].map(([uid, holdings]) => ({ key: `u${uid}`, holdings }));
        holders.push({
            key: 'demon',
            holdings: outs.rows.filter((o) => o.status === 'open').map((o) => ({ problem: o.problem_name, shares: num(o.demon_shares) })),
        });
        const s = LP.settleSolve({ q, b: num(market.b), scale: scaleOf(market), problem, holders });
        const total = s.payments.reduce((acc, p) => acc + p.total, 0);

        await client.query(
            "UPDATE lp_outcomes SET status = 'solved', solved_at = $2, solved_by = $3 WHERE problem_name = $1",
            [problem, at, userId]
        );
        const tick = await client.query(
            `INSERT INTO lp_ticks (kind, actor, user_id, problem_name, amount, rate, prices, created_at)
             VALUES ('solved', 'system', $1, $2, $3, $4, $5, $6) RETURNING id`,
            [userId, problem, floor4(total).toFixed(4), s.rate, JSON.stringify(snapshot(s.prices)), at]
        );
        const tickId = tick.rows[0].id;
        const paid = [];
        for (const p of s.payments) {
            if (p.key === 'demon') {
                await client.query('UPDATE lp_market SET demon_interest = demon_interest + $1 WHERE id = 1', [p.total.toFixed(4)]);
                continue;
            }
            const uid = Number(p.key.slice(1));
            await ensureWallet(client, uid);
            for (const [k, amount] of Object.entries(p.byProblem)) {
                await moveMoney(client, uid, amount, 'interest', `solved:${tickId}:${k}`);
                await client.query(
                    'UPDATE lp_positions SET interest = interest + $3 WHERE user_id = $1 AND problem_name = $2',
                    [uid, k, amount.toFixed(4)]
                );
            }
            paid.push({ userId: uid, amount: p.total });
        }
        await client.query('UPDATE lp_market SET scale = $1 WHERE id = 1', [s.scale]);
        await keepDepth(client, { b: num(market.b), scale: s.scale });
        const lost = pos.rows.filter((r) => r.problem_name === problem).map((r) => r.user_id);
        return { ok: true, rate: s.rate, paid, lost };
    });
    if (!done || !done.ok) return false;
    invalidate();

    let who = null;
    if (userId) {
        const u = await pool.query('SELECT username FROM users WHERE id = $1', [userId]).catch(() => ({ rows: [] }));
        who = u.rows[0] ? u.rows[0].username : null;
    }
    // One bell per person: the interest they got (a whole quantum or more), and whether this
    // solve took a position of theirs with it.
    const gain = new Map(done.paid.map((p) => [p.userId, Math.floor(p.amount)]));
    const lost = new Set(done.lost);
    const people = [...new Set([...lost, ...[...gain.keys()].filter((uid) => gain.get(uid) >= 1)])];
    for (const uid of people) {
        await notifyUsers([uid], (n, lang) => {
            const rate = ratePercent(done.rate, lang);
            const interest = gain.get(uid) || 0;
            return interest >= 1
                ? { title: n.interestTitle(interest), message: n.interest(problem, rate, lost.has(uid)) }
                : { title: n.solvedTitle(problem), message: n.solvedLost(problem, who) };
        });
    }
    return true;
}

/* Back to LP.MARKET_DEPTH quanta of liquidity (lib/lastProblem.js deepen), inside the caller's
 * transaction with the market row locked. Prices do not move, so no tick is written. */
async function keepDepth(client, { b, scale }) {
    const outs = await client.query('SELECT problem_name, q FROM lp_outcomes');
    const q = Object.fromEntries(outs.rows.map((r) => [r.problem_name, num(r.q)]));
    const d = LP.deepen({ b, scale, q });
    if (!d) return null;
    await client.query('UPDATE lp_market SET b = $1 WHERE id = 1', [d.b]);
    await client.query('UPDATE lp_outcomes SET q = q * $1', [d.factor]);
    return d.factor;
}

/* The same outside a solve: the sync calls it, so a market thinned before this rule existed is
 * deepened once, on the first pass after the deploy. */
async function deepenMarket() {
    const factor = await inTransaction(async (client) => {
        const m = await client.query('SELECT * FROM lp_market WHERE id = 1 FOR UPDATE');
        const market = m.rows[0];
        if (!market || market.resolved_at || market.decided_at) return { rollback: true };
        const f = await keepDepth(client, { b: num(market.b), scale: scaleOf(market) });
        return f ? { factor: f } : { rollback: true };
    });
    if (factor && factor.factor) {
        invalidate();
        console.log(`last-problem: market deepened ×${factor.factor.toFixed(3)} to ${LP.MARKET_DEPTH} ħ`);
    }
}

/* The bounty for every solve still standing that has not had one: whoever posted the first real
 * solution of a market problem gets LP.SOLVER_BOUNTY, once, ref solved:<tick> (a revert takes it
 * back). Run by every sync, so a new solve is paid within two minutes, and the solves before the
 * bounty existed (2026-09-15 to 18) were paid by the first sync after it shipped. One bell per
 * person for whatever this pass paid them. */
async function payBounties() {
    const due = await pool.query(
        `SELECT t.id, t.user_id, t.problem_name FROM lp_ticks t
          WHERE t.kind = 'solved' AND t.cancelled_at IS NULL AND t.user_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM quanta_ledger l WHERE l.reason = 'bounty' AND l.ref = 'solved:' || t.id)
          ORDER BY t.created_at, t.id`
    );
    const paid = new Map();
    for (const row of due.rows) {
        const ok = await inTransaction(async (client) => {
            // The tick row is the lock: two passes cannot pay the same solve twice.
            const t = await client.query(
                "SELECT id FROM lp_ticks WHERE id = $1 AND cancelled_at IS NULL FOR UPDATE", [row.id]
            );
            if (!t.rowCount) return { rollback: true };
            const again = await client.query(
                "SELECT 1 FROM quanta_ledger WHERE reason = 'bounty' AND ref = $1", [`solved:${row.id}`]
            );
            if (again.rowCount) return { rollback: true };
            await ensureWallet(client, row.user_id);
            await moveMoney(client, row.user_id, LP.SOLVER_BOUNTY, 'bounty', `solved:${row.id}`);
            return { ok: true };
        });
        if (!ok || !ok.ok) continue;
        if (!paid.has(row.user_id)) paid.set(row.user_id, []);
        paid.get(row.user_id).push(row.problem_name);
    }
    if (!paid.size) return 0;
    invalidate();
    for (const [uid, problems] of paid) {
        await notifyUsers([uid], (n, lang) => ({
            title: n.bountyTitle(problems.length * LP.SOLVER_BOUNTY, problems.length),
            message: n.bounty(listProblems(problems, lang), LP.SOLVER_BOUNTY, problems.length),
        }));
    }
    return paid.size;
}

/* "7.2.10, 7.2.11 и 5.3.11" / "7.2.10, 7.2.11 and 5.3.11". */
function listProblems(ids, lang) {
    if (ids.length <= 1) return ids.join('');
    return `${ids.slice(0, -1).join(', ')} ${lang === 'ru' ? 'и' : 'and'} ${ids[ids.length - 1]}`;
}

/* A rate as the app shows it: "+2,9%", "+25%". */
function ratePercent(rate, lang) {
    const v = Math.max(0, rate) * 100;
    const nf = new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', { maximumFractionDigits: v < 10 ? 1 : 0 });
    return `+${nf.format(v)}%`;
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
        // With one problem left a share is worth exactly the scale, which is what it pays.
        const scale = scaleOf(market);
        const holders = await client.query(
            'SELECT user_id, shares FROM lp_positions WHERE problem_name = $1 AND shares > $2 FOR UPDATE',
            [winner, LP.DUST]
        );
        const payouts = [];
        for (const h of holders.rows) {
            const amount = floor4(num(h.shares) * scale);
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
            [winner, floor4(num(open.rows[0].demon_shares) * scale).toFixed(4)]
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
            await payBounties();
            await deepenMarket();
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
            ? pub.leaderboard.filter((e) => e.earned > 0).slice(0, 3).map((e) => ({ username: e.username, earned: e.earned }))
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
            progress: c.card.progress.replace('{solved}', String(pub.solvedCount)).replace('{total}', String(pub.total)),
            bountyLine: pub.resolvedAt || pub.decidedAt ? null : c.card.bounty.replace('{amount}', String(pub.bounty)),
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
