// The decisions behind «Последняя задача» (lastProblem.js), kept free of req/res and the pool so
// tests/last-problem.test.js can cover them without a database: which trades are valid, what
// counts as a solved problem, when the market is decided and when it pays, how a leaderboard
// profit is computed, and how a seed is replayed into prices.
//
// The market asks the question emixter put to both community chats on 2026-09-15 (#1958, #1959):
// which of the problems still unsolved will be solved last. One share of a problem pays 1 ħ if
// it is. Prices come from js/lmsr.js.
'use strict';

const LMSR = require('../js/lmsr');

const PROBLEM_RE = /^\d{1,2}\.\d{1,2}\.\d{1,3}$/;
const START_BALANCE = 1000;
// A sanity ceiling, far above any balance the market can produce.
const MAX_TRADE = 1000000;
// Between the moment one problem is left and the payout. A junk post that knocked out an outcome
// can be reverted in this window (scripts/seed-last-problem.js --revert); after it, shares pay.
const GRACE_MS = 72 * 60 * 60 * 1000;
// Shares are floats; anything smaller than this is dust from rounding, not a position.
const DUST = 1e-6;

// /create-problem writes a template and the site counts that file as solved from then on
// (index.js, POST /create-problem). The market does not: an untouched solution placeholder in
// either language means nobody has solved it yet.
const TEMPLATE_MARKERS = Object.freeze([
    '[Здесь должно быть ваше решение]',
    '[Your solution should be placed here]',
]);

function isTemplatePost(content) {
    if (typeof content !== 'string') return true;
    const text = content.trim();
    if (!text) return true;
    return TEMPLATE_MARKERS.some((marker) => text.includes(marker));
}

function isProblemId(value) {
    return typeof value === 'string' && PROBLEM_RE.test(value);
}

// Whole quanta only, typed or sent as a number. "1e3", "10.5", " 7" with junk, negatives: no.
function parseAmount(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) ? value : NaN;
    if (typeof value === 'string' && /^\s*\d{1,9}\s*$/.test(value)) return Number(value.trim());
    return NaN;
}

/* One trade request against the viewer's state.
 *   input: { problem, side: 'buy' | 'sell', amount (whole ħ, buys), shares (number or 'all', sells) }
 *   ctx:   { open: Set of open problem ids, balance: ħ available, held: shares of that problem }
 * Returns { ok: true, value } or { ok: false, error }. */
function validateTrade(input, ctx) {
    const inp = input || {};
    const c = ctx || {};
    if (!isProblemId(inp.problem)) return { ok: false, error: 'problem' };
    if (!(c.open instanceof Set) || !c.open.has(inp.problem)) return { ok: false, error: 'closed' };

    if (inp.side === 'buy') {
        const amount = parseAmount(inp.amount);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_TRADE) return { ok: false, error: 'amount' };
        // A balance that is a hair under a whole number after a sale still buys that number.
        if (amount > Math.floor((Number(c.balance) || 0) + DUST)) return { ok: false, error: 'insufficient' };
        return { ok: true, value: { problem: inp.problem, side: 'buy', amount } };
    }

    if (inp.side === 'sell') {
        const held = Number(c.held) || 0;
        if (!(held > DUST)) return { ok: false, error: 'not_held' };
        let shares;
        if (inp.shares === 'all') {
            shares = held;
        } else {
            shares = typeof inp.shares === 'number' ? inp.shares : (typeof inp.shares === 'string' ? Number(inp.shares) : NaN);
            if (!Number.isFinite(shares) || shares <= 0) return { ok: false, error: 'shares' };
            if (shares > held + DUST) return { ok: false, error: 'not_held' };
            // Selling all but a speck sells everything, so no position is left holding dust.
            if (held - shares < DUST) shares = held;
        }
        return { ok: true, value: { problem: inp.problem, side: 'sell', shares } };
    }

    return { ok: false, error: 'side' };
}

/* What the sync does next with the market as a whole.
 *   open      more than one problem left: trading goes on
 *   decide    exactly one left and not marked yet: mark the moment
 *   wait      one left, inside the grace period
 *   pay       one left and the grace period is over: pay the winner's shares
 *   undecide  marked decided, but a revert brought an outcome back
 *   resolved  already paid; nothing more to do */
function marketStep({ openCount, decidedAt, resolvedAt, now, graceMs = GRACE_MS }) {
    if (resolvedAt) return 'resolved';
    if (openCount > 1) return decidedAt ? 'undecide' : 'open';
    if (openCount === 1) {
        if (!decidedAt) return 'decide';
        return now - new Date(decidedAt).getTime() >= graceMs ? 'pay' : 'wait';
    }
    return 'wait';
}

/* Which newly solved problems to knock out, in the order they were solved. The last problem
 * standing is never knocked out: if the final two are solved in the same pass, the one solved
 * later is, by definition, the one solved last. */
function eliminationsFor(openIds, solvedNow) {
    const open = new Set(openIds);
    const solved = solvedNow
        .filter((s) => open.has(s.problem))
        .sort((a, b) => (new Date(a.solvedAt) - new Date(b.solvedAt)) || (a.problem < b.problem ? -1 : 1));
    const out = [];
    let left = open.size;
    for (const s of solved) {
        if (left <= 1) break;
        out.push(s);
        left -= 1;
    }
    return out;
}

/* A leaderboard profit: what came back (sales, payouts) minus what went in, plus what the
 * open shares would fetch if sold right now. Valued at the sale price rather than shares ×
 * price, so a fresh buy shows zero instead of a paper gain the market would not pay. */
function positionValue(q, b, problem, shares, status) {
    if (status !== 'open' || !(shares > DUST) || !(problem in q)) return 0;
    return LMSR.sellProceeds(q, b, problem, shares);
}

/* The same for everything someone holds, sold together (js/lmsr.js portfolioValue): the fair
 * figure for a leaderboard, where the demon's ten bets would otherwise each be priced as if the
 * other nine were still held. `holdings` is [{ problem, shares, status }]. */
function portfolioValueOf(q, b, holdings) {
    const h = {};
    for (const x of holdings) {
        if (x.status === 'open' && x.shares > DUST && x.problem in q) h[x.problem] = (h[x.problem] || 0) + x.shares;
    }
    return LMSR.portfolioValue(q, b, h);
}

function profitOf({ spent = 0, received = 0, value = 0 }) {
    return (Number(received) || 0) - (Number(spent) || 0) + (Number(value) || 0);
}

/* Whole quanta summing exactly to `total`, split by weight (largest remainder). */
function allocate(total, weights) {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    const sum = entries.reduce((acc, [, w]) => acc + w, 0);
    if (!entries.length || !(sum > 0) || !(total > 0)) return {};
    const out = {};
    let used = 0;
    const rema = entries.map(([k, w]) => {
        const exact = (total * w) / sum;
        out[k] = Math.floor(exact);
        used += out[k];
        return [k, exact - out[k]];
    });
    rema.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    for (let i = 0; i < total - used; i++) out[rema[i][0]] += 1;
    return out;
}

/* Replays a sequence of buys and solves from an empty market: the shares each buy got and the
 * prices after every step. The seed script writes exactly these rows, and the tests check the
 * opening board against it. */
function replay(outcomes, b, events) {
    let q = {};
    for (const k of outcomes) q[k] = 0;
    const steps = [];
    for (const e of events) {
        if (e.type === 'buy') {
            if (!(e.problem in q)) throw new Error(`replay: ${e.problem} is not open`);
            const shares = LMSR.sharesForAmount(q, b, e.problem, e.amount);
            q = Object.assign({}, q, { [e.problem]: q[e.problem] + shares });
            steps.push(Object.assign({}, e, { shares, prices: LMSR.prices(q, b) }));
        } else if (e.type === 'solve') {
            if (!(e.problem in q)) throw new Error(`replay: ${e.problem} is not open`);
            q = LMSR.eliminate(q, e.problem);
            steps.push(Object.assign({}, e, { prices: LMSR.prices(q, b) }));
        } else {
            throw new Error(`replay: unknown event ${e.type}`);
        }
    }
    return { q, steps };
}

/* The chart: one line per chosen problem across every snapshot, a problem missing from a
 * snapshot (solved) reading as zero. At most `maxPoints` points, always keeping the first and
 * the last, so a long market does not ship thousands of points to a phone. */
function chartSeries(ticks, keys, maxPoints = 240) {
    const n = ticks.length;
    let idx = ticks.map((_, i) => i);
    if (n > maxPoints) {
        const stride = (n - 1) / (maxPoints - 1);
        idx = Array.from({ length: maxPoints }, (_, i) => Math.round(i * stride));
    }
    const t = idx.map((i) => new Date(ticks[i].created_at).getTime());
    return {
        t,
        series: keys.map((k) => ({
            key: k,
            p: idx.map((i) => {
                const v = ticks[i].prices && ticks[i].prices[k];
                return typeof v === 'number' ? Math.round(v * 10000) / 10000 : 0;
            }),
        })),
    };
}

module.exports = {
    PROBLEM_RE,
    START_BALANCE,
    MAX_TRADE,
    GRACE_MS,
    DUST,
    TEMPLATE_MARKERS,
    isTemplatePost,
    isProblemId,
    parseAmount,
    validateTrade,
    marketStep,
    eliminationsFor,
    positionValue,
    portfolioValueOf,
    profitOf,
    allocate,
    replay,
    chartSeries,
};
