#!/usr/bin/env node
// Opens «Последняя задача» (lastProblem.js) the way it actually started, and undoes a mistaken
// elimination.
//
//   node scripts/seed-last-problem.js --dry-run         print the opening board, write nothing
//   node scripts/seed-last-problem.js --apply           open the market (refuses if it is open)
//   node scripts/seed-last-problem.js --revert 5.8.9    bring a problem back after a junk post
//
// What --apply writes, in one transaction, replayed in time order so the chart is the real story:
//
//   1. The market opens at emixter's question in the Russian community chat (#1958, 15 Sep,
//      13:40 UTC). Its outcomes are the book's problems that had no real solution then: no post in
//      either language, or only the untouched /create-problem template.
//   2. Laplace's demon, the house trader, spends 800 of its 1000 ħ on the ten problems a survival
//      model over the solving history ranks most likely to be solved last, in proportion to those
//      chances. The model: a weekly hazard regression on 36 weeks of history (13,226 problem-weeks,
//      512 first solutions; features: difficulty, ∗, estimated minutes, statement length, figure,
//      position in the section, how much of the section is solved, neighbours, 14-day momentum in
//      the section and chapter; held-out AUC 0.71), then 8,000 simulations of the remaining
//      problems with momentum updated as they fall, and 12 bootstrap refits for stability.
//   3. The two bets people named in the chat go in at the moment they wrote them, 100 ħ each from
//      their own 1000: Valter on 5.8.9 (#1962), emixter on 7.2.11 (#1965). Each can cancel it in the
//      app for a full refund; the activation step tells them so.
//   4. Every problem solved since the question drops out at the time its solution appeared.
//
// Needs migration 054. Reads PG_* from the repository's .env like the app.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { Pool } = require('pg');
const LMSR = require('../js/lmsr');
const LP = require('../lib/lastProblem');

const ROOT = path.join(__dirname, '..');
const B = 1000;
const DEMON_SEED = 800;
const QUESTION_MESSAGE = 1958;
// Seconds after the question at which the demon places each of its ten bets, in weight order.
// Uneven on purpose, and all before Valter's bet at 13:52:31: ten trades a second apart read as a
// script, not as someone weighing up each problem (the owner, 2026-09-15). Changing only the
// times, never the order, leaves every price and share the replay computes unchanged.
const DEMON_DELAYS = [29, 108, 200, 275, 353, 431, 478, 557, 603, 646];
const CHAT_BETS = [
    { message: 1962, username: 'Valter', problem: '5.8.9', amount: 100 },
    { message: 1965, username: 'emixter', problem: '7.2.11', amount: 100 },
];
// The demon's weights: P(last) of the top ten, normalised (the plan's table, 2026-09-15).
const WEIGHTS = {
    '7.2.13': 0.177, '6.6.27': 0.155, '14.3.27': 0.143, '7.2.12': 0.119, '14.3.8': 0.113,
    '5.8.9': 0.091, '14.3.26': 0.056, '5.3.11': 0.056, '7.2.14': 0.046, '8.2.32': 0.044,
};

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

function bookProblems() {
    const text = fs.readFileSync(path.join(ROOT, 'src', 'database', 'sections.csv'), 'utf8').replace(/^﻿/, '');
    const ids = [];
    for (const line of text.split(/\r?\n/)) {
        const first = line.indexOf(',');
        const last = line.lastIndexOf(',');
        if (first <= 0 || last <= first) continue;
        const n = Number(line.slice(last + 1));
        for (let i = 1; i <= n; i++) ids.push(`${line.slice(0, first)}.${i}`);
    }
    return ids;
}

function hasRealPost(id) {
    for (const lang of ['ru', 'en']) {
        try {
            if (!LP.isTemplatePost(fs.readFileSync(path.join(ROOT, 'posts', lang, `${id}.md`), 'utf8'))) return true;
        } catch (_err) { /* no file */ }
    }
    return false;
}

async function firstRealSolution(db, id) {
    const { rows } = await db.query(
        `SELECT user_id, edited_at, new_content FROM contributions
          WHERE problem_name = $1 AND COALESCE(length(new_content), 0) > 0
          ORDER BY edited_at ASC LIMIT 40`,
        [id]
    );
    for (const r of rows) if (!LP.isTemplatePost(r.new_content)) return { userId: r.user_id || null, at: new Date(r.edited_at) };
    return null;
}

const snapshot = (prices) => {
    const out = {};
    for (const [k, v] of Object.entries(prices)) out[k] = Math.round(v * 1e6) / 1e6;
    return out;
};

async function plan(db) {
    const question = await db.query('SELECT created_at FROM messages WHERE id = $1', [QUESTION_MESSAGE]);
    if (!question.rows.length) throw new Error(`message #${QUESTION_MESSAGE} not found`);
    const openedAt = new Date(question.rows[0].created_at);

    // Outcomes: unsolved at the question. A problem with a real post now counts only if its first
    // real solution came after the question, and then it drops out at that moment.
    const outcomes = [];
    const solves = [];
    for (const id of bookProblems()) {
        if (!hasRealPost(id)) {
            outcomes.push(id);
            continue;
        }
        const first = await firstRealSolution(db, id);
        if (first && first.at > openedAt) {
            outcomes.push(id);
            solves.push({ type: 'solve', problem: id, at: first.at, userId: first.userId });
        }
    }
    for (const k of Object.keys(WEIGHTS)) if (!outcomes.includes(k)) throw new Error(`demon's pick ${k} was already solved at the question`);

    const users = await db.query('SELECT id, username FROM users WHERE username = ANY($1)', [CHAT_BETS.map((c) => c.username)]);
    const idOf = new Map(users.rows.map((r) => [r.username, r.id]));
    const events = [];
    const amounts = LP.allocate(DEMON_SEED, WEIGHTS);
    Object.keys(WEIGHTS).forEach((problem, i) => {
        events.push({ type: 'buy', actor: 'demon', problem, amount: amounts[problem], at: new Date(openedAt.getTime() + DEMON_DELAYS[i] * 1000) });
    });
    for (const bet of CHAT_BETS) {
        const msg = await db.query('SELECT created_at, sender_id, content FROM messages WHERE id = $1', [bet.message]);
        if (!msg.rows.length) throw new Error(`message #${bet.message} not found`);
        const row = msg.rows[0];
        if (row.sender_id !== idOf.get(bet.username) || !String(row.content).includes(bet.problem)) {
            throw new Error(`message #${bet.message} is not ${bet.username} naming ${bet.problem}`);
        }
        if (!outcomes.includes(bet.problem)) throw new Error(`${bet.problem} was already solved at the question`);
        events.push({ type: 'buy', actor: 'chat', problem: bet.problem, amount: bet.amount, at: new Date(row.created_at), userId: row.sender_id, source: `chat:${bet.message}` });
    }
    events.push(...solves);
    events.sort((a, b) => a.at - b.at);

    // Replay, keeping the q a solved problem had when it dropped out (the database keeps it, so a
    // revert restores its price).
    const { steps } = LP.replay(outcomes, B, events);
    const fullQ = Object.fromEntries(outcomes.map((k) => [k, 0]));
    const demonShares = Object.fromEntries(outcomes.map((k) => [k, 0]));
    const positions = new Map();
    for (const s of steps) {
        if (s.type !== 'buy') continue;
        fullQ[s.problem] += s.shares;
        if (s.actor === 'demon') demonShares[s.problem] += s.shares;
        else positions.set(`${s.userId}:${s.problem}`, { userId: s.userId, problem: s.problem, shares: s.shares, spent: s.amount });
    }
    const uniform = snapshot(LMSR.prices(Object.fromEntries(outcomes.map((k) => [k, 0])), B));
    return { openedAt, outcomes, steps, fullQ, demonShares, positions, uniform, solves };
}

function printBoard(p) {
    const last = p.steps.length ? p.steps[p.steps.length - 1].prices : p.uniform;
    const board = Object.entries(last).sort((a, b) => b[1] - a[1]);
    console.log(`opened ${p.openedAt.toISOString()} with ${p.outcomes.length} problems; ${p.solves.length} solved since`);
    for (const s of p.steps) {
        const what = s.type === 'buy' ? `${s.actor.padEnd(5)} buys ${s.problem.padEnd(8)} ${String(s.amount).padStart(4)} ħ -> ${s.shares.toFixed(1)} shares` : `${s.problem} solved`;
        console.log(`  ${s.at.toISOString()}  ${what}`);
    }
    console.log('board now:');
    for (const [k, v] of board.slice(0, 12)) console.log(`  ${k.padEnd(8)} ${(v * 100).toFixed(1).padStart(5)}%  ×${(1 / v).toFixed(1)}`);
    console.log(`  … ${board.length - 12} more at ${(board[board.length - 1][1] * 100).toFixed(1)}% or so`);
}

async function apply() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const exists = await client.query('SELECT 1 FROM lp_market WHERE id = 1');
        if (exists.rowCount) throw new Error('the market is already open; nothing written');
        const p = await plan(client);
        printBoard(p);

        await client.query(
            'INSERT INTO lp_market (id, b, opened_at, demon_spent) VALUES (1, $1, $2, $3)',
            [B, p.openedAt, DEMON_SEED]
        );
        const solvedAt = new Map(p.solves.map((s) => [s.problem, s]));
        for (const k of p.outcomes) {
            const s = solvedAt.get(k);
            await client.query(
                'INSERT INTO lp_outcomes (problem_name, q, demon_shares, status, solved_at, solved_by) VALUES ($1, $2, $3, $4, $5, $6)',
                [k, p.fullQ[k], p.demonShares[k], s ? 'solved' : 'open', s ? s.at : null, s ? s.userId : null]
            );
        }
        await client.query(
            "INSERT INTO lp_ticks (kind, actor, prices, source, created_at) VALUES ('open', 'system', $1, $2, $3)",
            [JSON.stringify(p.uniform), `chat:${QUESTION_MESSAGE}`, p.openedAt]
        );
        for (const s of p.steps) {
            if (s.type === 'buy') {
                await client.query(
                    `INSERT INTO lp_ticks (kind, actor, user_id, problem_name, shares, amount, prices, source, created_at)
                     VALUES ('trade', $1, $2, $3, $4, $5, $6, $7, $8)`,
                    [s.actor, s.userId || null, s.problem, s.shares, s.amount.toFixed(4), JSON.stringify(snapshot(s.prices)), s.source || null, s.at]
                );
            } else {
                await client.query(
                    `INSERT INTO lp_ticks (kind, actor, user_id, problem_name, prices, created_at)
                     VALUES ('solved', 'system', $1, $2, $3, $4)`,
                    [s.userId || null, s.problem, JSON.stringify(snapshot(s.prices)), s.at]
                );
            }
        }
        for (const pos of p.positions.values()) {
            const bet = p.steps.find((s) => s.type === 'buy' && s.userId === pos.userId && s.problem === pos.problem);
            await client.query(
                "INSERT INTO quanta_wallets (user_id, balance, created_at, updated_at) VALUES ($1, $2, $3, $3) ON CONFLICT (user_id) DO NOTHING",
                [pos.userId, LP.START_BALANCE, bet.at]
            );
            await client.query(
                "INSERT INTO quanta_ledger (user_id, delta, reason, created_at) VALUES ($1, $2, 'grant', $3)",
                [pos.userId, LP.START_BALANCE, bet.at]
            );
            await client.query('UPDATE quanta_wallets SET balance = balance - $2 WHERE user_id = $1', [pos.userId, pos.spent.toFixed(4)]);
            await client.query(
                "INSERT INTO quanta_ledger (user_id, delta, reason, ref, created_at) VALUES ($1, $2, 'buy', $3, $4)",
                [pos.userId, (-pos.spent).toFixed(4), pos.problem, bet.at]
            );
            await client.query(
                'INSERT INTO lp_positions (user_id, problem_name, shares, spent) VALUES ($1, $2, $3, $4)',
                [pos.userId, pos.problem, pos.shares, pos.spent.toFixed(4)]
            );
        }
        await client.query('COMMIT');
        console.log('market opened');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function revert(problem) {
    if (!LP.isProblemId(problem)) throw new Error('usage: --revert <problem>');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const m = await client.query('SELECT * FROM lp_market WHERE id = 1 FOR UPDATE');
        if (!m.rowCount) throw new Error('no market');
        if (m.rows[0].resolved_at) throw new Error('the market has already paid out; a revert would need the payouts undone by hand');
        const o = await client.query("UPDATE lp_outcomes SET status = 'open', solved_at = NULL, solved_by = NULL WHERE problem_name = $1 AND status = 'solved' RETURNING problem_name", [problem]);
        if (!o.rowCount) throw new Error(`${problem} is not a solved outcome`);
        const outs = await client.query("SELECT problem_name, q FROM lp_outcomes WHERE status = 'open'");
        const q = Object.fromEntries(outs.rows.map((r) => [r.problem_name, Number(r.q)]));
        await client.query(
            "INSERT INTO lp_ticks (kind, actor, problem_name, prices) VALUES ('reverted', 'system', $1, $2)",
            [problem, JSON.stringify(snapshot(LMSR.prices(q, Number(m.rows[0].b))))]
        );
        if (outs.rowCount > 1) await client.query('UPDATE lp_market SET decided_at = NULL WHERE id = 1');
        await client.query('COMMIT');
        console.log(`${problem} is back in the market (the sync will knock it out again while its post counts as a solution)`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

(async () => {
    const args = process.argv.slice(2);
    try {
        if (args[0] === '--dry-run') printBoard(await plan(pool));
        else if (args[0] === '--apply') await apply();
        else if (args[0] === '--revert') await revert(args[1]);
        else console.log('usage: --dry-run | --apply | --revert <problem>');
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
