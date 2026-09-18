#!/usr/bin/env node
// Laplace's demon trades «Последняя задача» (lastProblem.js) towards its forecast.
//
//   node scripts/last-problem-demon.js --dry-run [--budget 400]    the plan and the weights after it
//   node scripts/last-problem-demon.js --apply   [--budget 400]    trade, a minute or two apart
//   (--pause <seconds> sets a fixed gap instead, 0 for a rehearsal on a scratch database)
//
// The demon is the house trader of the market, not an account: its money is lp_market's
// demon_spent / demon_received / demon_interest and its shares lp_outcomes.demon_shares. It opened
// the market with 800 ħ over ten problems. On 18 Sep, three days and fourteen solves later, the
// market's weights had drifted far from any forecast (one 350 ħ bet had put 7.2.14 at 54%, which
// the refit model prices at about 5%), so the demon rebalances against data/lp-forecast.json
// (scripts/last-problem-forecast.py):
//
//   1. it sells what it holds in problems the market prices well above their fair weight;
//   2. it spends up to --budget ħ of its own quanta on the problems priced below it, in
//      proportion to how far below, planned in rounds so each purchase sees the others' effect;
//   3. one trade per problem, each in its own transaction on the locked market row exactly as a
//      member's trade, at the prices of that moment (people may trade in between), and a minute or
//      two apart, because ten trades in the same second read as a script (the owner, 15 Sep).
//
// It never spends more than it has, and it moves no one else's shares or quanta.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { Pool } = require('pg');
const LMSR = require('../js/lmsr');
const LP = require('../lib/lastProblem');

const FORECAST = path.join(__dirname, '..', 'data', 'lp-forecast.json');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const num = (v) => Number(v) || 0;
const pct = (p) => `${(p * 100).toFixed(1)}%`;
const top = (prices, n = 9) => Object.entries(prices).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${pct(v)}`).join(', ');
const snapshot = (prices) => Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));

function scaleOf(market) {
    const s = Number(market.scale);
    return s > 0 ? s : 1;
}

async function readState(db) {
    const m = (await db.query('SELECT * FROM lp_market WHERE id = 1')).rows[0];
    if (!m) throw new Error('no market');
    if (m.decided_at || m.resolved_at) throw new Error('the market is decided; nothing to trade');
    const outs = (await db.query("SELECT problem_name, q, demon_shares FROM lp_outcomes WHERE status = 'open'")).rows;
    return {
        b: num(m.b),
        scale: scaleOf(m),
        cash: 1000 - num(m.demon_spent) + num(m.demon_received) + num(m.demon_interest),
        q: Object.fromEntries(outs.map((o) => [o.problem_name, num(o.q)])),
        held: Object.fromEntries(outs.map((o) => [o.problem_name, num(o.demon_shares)])),
    };
}

/* One trade on the live market, as lastProblem.js executeTrade does it. */
async function trade(problem, shares) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const m = (await client.query('SELECT * FROM lp_market WHERE id = 1 FOR UPDATE')).rows[0];
        if (!m || m.decided_at || m.resolved_at) throw new Error('the market closed');
        const b = num(m.b);
        const scale = scaleOf(m);
        const outs = (await client.query("SELECT problem_name, q, demon_shares FROM lp_outcomes WHERE status = 'open' FOR UPDATE")).rows;
        const q = Object.fromEntries(outs.map((o) => [o.problem_name, num(o.q)]));
        const row = outs.find((o) => o.problem_name === problem);
        if (!row) {
            await client.query('ROLLBACK');
            return { skipped: `${problem} is no longer open` };
        }
        let s = shares;
        let amount;
        if (s < 0) {
            s = -Math.min(-s, num(row.demon_shares));
            if (!(s < 0)) {
                await client.query('ROLLBACK');
                return { skipped: `nothing of ${problem} left to sell` };
            }
            amount = -LP.floor4(LMSR.sellProceeds(q, b, problem, -s, scale));
            await client.query('UPDATE lp_market SET demon_received = demon_received + $1 WHERE id = 1', [(-amount).toFixed(4)]);
        } else {
            const cash = 1000 - num(m.demon_spent) + num(m.demon_received) + num(m.demon_interest);
            amount = Math.ceil(LMSR.tradeCost(q, b, problem, s) * scale * 10000) / 10000;
            if (amount > cash + 1e-9) {
                await client.query('ROLLBACK');
                return { skipped: `${problem} would cost ${amount.toFixed(2)} ħ, the demon has ${cash.toFixed(2)}` };
            }
            await client.query('UPDATE lp_market SET demon_spent = demon_spent + $1 WHERE id = 1', [amount.toFixed(4)]);
        }
        await client.query('UPDATE lp_outcomes SET q = q + $2, demon_shares = demon_shares + $2 WHERE problem_name = $1', [problem, s]);
        q[problem] += s;
        await client.query(
            `INSERT INTO lp_ticks (kind, actor, problem_name, shares, amount, prices)
             VALUES ('trade', 'demon', $1, $2, $3, $4)`,
            [problem, s, amount.toFixed(4), JSON.stringify(snapshot(LMSR.prices(q, b)))]
        );
        await client.query('COMMIT');
        return { amount, shares: s };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const args = process.argv.slice(2);
    const budgetAt = args.indexOf('--budget');
    const budget = budgetAt >= 0 ? Number(args[budgetAt + 1]) : 400;
    const apply = args.includes('--apply');
    const pauseAt = args.indexOf('--pause');
    const pause = pauseAt >= 0 ? Number(args[pauseAt + 1]) * 1000 : null;
    if (!apply && !args.includes('--dry-run')) {
        console.log('usage: --dry-run | --apply [--budget <ħ>] [--pause <seconds>]');
        return;
    }
    if (!(budget >= 0)) throw new Error('--budget must be a number of quanta');
    try {
        const raw = JSON.parse(fs.readFileSync(FORECAST, 'utf8'));
        const fair = Object.fromEntries(raw.problems.map((p) => [p.problem, p.fair]));
        const state = await readState(pool);
        // The plan itself is lib/lastProblem.js rebalancePlan, where the tests can reach it.
        const { trades, after } = LP.rebalancePlan(state, fair, budget);
        console.log(`forecast of ${raw.generated}; demon cash ${state.cash.toFixed(1)} ħ, budget ${budget} ħ, market depth ${(state.b * state.scale).toFixed(0)} ħ`);
        console.log(`weights now   ${top(LMSR.prices(state.q, state.b))}`);
        console.log(`fair          ${top(fair)}`);
        console.log(`after the plan ${top(after)}`);
        for (const t of trades) console.log(`  ${t.shares < 0 ? 'sell' : 'buy '} ${t.problem.padEnd(8)} ${Math.abs(t.shares).toFixed(1)} shares`);
        if (!apply) return;
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            const r = await trade(t.problem, t.shares);
            console.log(`${new Date().toISOString()} ${r.skipped ? `skipped, ${r.skipped}` : `${r.shares < 0 ? 'sold' : 'bought'} ${t.problem} for ${Math.abs(r.amount).toFixed(2)} ħ`}`);
            if (i < trades.length - 1) await sleep(pause != null && pause >= 0 ? pause : 40000 + Math.random() * 110000);
        }
        const final = await readState(pool);
        console.log(`weights after ${top(LMSR.prices(final.q, final.b))}; demon cash ${final.cash.toFixed(1)} ħ`);
    } finally {
        await pool.end();
    }
})().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
