// The decisions behind «Последняя задача» (lastProblem.js), kept free of req/res and the pool so
// tests/last-problem.test.js can cover them without a database: which trades are valid, what
// counts as a solved problem, when the market is decided and when it pays, how a leaderboard
// profit is computed, and how a seed is replayed into prices.
//
// The market asks the question emixter put to both community chats on 2026-09-15 (#1958, #1959):
// which of the problems still unsolved will be solved last. Prices come from js/lmsr.js.
//
// It opened as winner takes all: a share paid 1 ħ if its problem was the very last one solved.
// That evening, before any problem had been solved, the owner changed the rule to "conservation of
// interest": every solve pays interest to everything still in play, so a problem solved near the
// end pays off even if it is not the last, one solved early loses, and quanta move after every
// solve rather than once in a year (settleSolve, js/lmsr.js solve).
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
// either language, or a post with nothing written in it (hasWrittenSolution), means nobody has
// solved it yet.
const TEMPLATE_MARKERS = Object.freeze([
    '[Здесь должно быть ваше решение]',
    '[Your solution should be placed here]',
]);

// What the site's templates leave for the author to replace: /create-problem (index.js) and /upload
// (upload.js), in both languages.
const PLACEHOLDER_RE = /\[(?:Вставьте|Insert|Здесь должно быть|Your solution)[^\]\n]*\]/giu;
const STATEMENT_SECTION_RE = /^#{1,6}[ \t]*(?:Условие|Statement)(?![\p{L}])[^\n]*\n[\s\S]*?(?=^#{1,6}[ \t]|(?![\s\S]))/imu;
const HEADING_LINE_RE = /^#{1,6}[ \t][^\n]*$/gmu;
// Letters and digits a text-only solution needs, once headings and placeholders are gone.
const MIN_SOLUTION_CHARS = 24;

/* Whether someone actually wrote a solution into a post: with the statement section, the headings
 * and the templates' placeholders taken out, an image (a scan is a solution), a formula, or at least
 * a sentence of text is left. On 2026-09-15, forty minutes after the market opened, 5.8.9 got the
 * /upload template with "asd" as its solution, and the market took the problem out. Checked against
 * every post on the server that day: of 2,736, only that one and an untouched upload fail. */
function hasWrittenSolution(content) {
    if (typeof content !== 'string') return false;
    const written = content.replace(STATEMENT_SECTION_RE, '').replace(HEADING_LINE_RE, '').replace(PLACEHOLDER_RE, '');
    if (/!\[[^\]]*\]\([^)]+\)|<img\b/i.test(written)) return true;
    if (/\$[^$]*\S[^$]*\$/.test(written)) return true;
    return (written.match(/[\p{L}\p{N}]/gu) || []).length >= MIN_SOLUTION_CHARS;
}

function isTemplatePost(content) {
    if (typeof content !== 'string') return true;
    const text = content.trim();
    if (!text) return true;
    if (TEMPLATE_MARKERS.some((marker) => text.includes(marker))) return true;
    return !hasWrittenSolution(text);
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

/* A leaderboard profit: what came back (sales, interest, payouts) minus what went in, plus what
 * the open shares would fetch if sold right now. Valued at the sale price rather than shares ×
 * price, so a fresh buy shows zero instead of a paper gain the market would not pay. */
function positionValue(q, b, problem, shares, status, scale = 1) {
    if (status !== 'open' || !(shares > DUST) || !(problem in q)) return 0;
    return LMSR.sellProceeds(q, b, problem, shares, scale);
}

function holdingsMap(q, holdings) {
    const h = {};
    for (const x of holdings) {
        if (x.status === 'open' && x.shares > DUST && x.problem in q) h[x.problem] = (h[x.problem] || 0) + x.shares;
    }
    return h;
}

/* The same for everything someone holds, sold together (js/lmsr.js portfolioValue): the fair
 * figure for a leaderboard, where the demon's ten bets would otherwise each be priced as if the
 * other nine were still held. `holdings` is [{ problem, shares, status }]. */
function portfolioValueOf(q, b, holdings, scale = 1) {
    return LMSR.portfolioValue(q, b, holdingsMap(q, holdings), scale);
}

function profitOf({ spent = 0, received = 0, interest = 0, value = 0 }) {
    return (Number(received) || 0) + (Number(interest) || 0) - (Number(spent) || 0) + (Number(value) || 0);
}

// Money leaves the market rounded down to 1/10000 ħ, never up.
const floor4 = (x) => Math.floor(x * 10000 + 1e-7) / 10000;

/* A solve, settled: `problem` is solved while the market stands at q (open problems only) and
 * scale; `holders` is [{ key, holdings: [{ problem, shares }] }], the demon included. Each holder
 * gets interest on what their shares in the problems still open fetch together right after
 * (js/lmsr.js solve, interestOn), rounded down; the amount is split over their positions in
 * proportion to each one's worth at the new prices, so a position always shows what it earned.
 * The solved problem's shares earn nothing. */
function settleSolve({ q, b, scale = 1, problem, holders }) {
    if (!(problem in q)) throw new Error(`settleSolve: ${problem} is not open`);
    const solved = LMSR.solve(q, b, scale, problem);
    const after = LMSR.prices(solved.q, b);
    const payments = [];
    for (const holder of holders || []) {
        const h = holdingsMap(solved.q, (holder.holdings || []).map((x) => Object.assign({ status: 'open' }, x)));
        const keys = Object.keys(h);
        if (!keys.length) continue;
        const total = floor4(LMSR.interestOn(solved, b, h));
        if (!(total > 0)) continue;
        const weight = keys.map((k) => h[k] * after[k]);
        const sum = weight.reduce((acc, w) => acc + w, 0);
        const byProblem = {};
        let paid = 0;
        keys.forEach((k, i) => {
            const part = floor4(sum > 0 ? (total * weight[i]) / sum : 0);
            if (part > 0) {
                byProblem[k] = part;
                paid += part;
            }
        });
        if (paid > 0) payments.push({ key: holder.key, total: floor4(paid), byProblem });
    }
    return { share: solved.share, rate: solved.rate, q: solved.q, scale: solved.scale, prices: after, payments };
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

/* Replays a sequence of buys and solves from an empty market: the shares each buy got, the
 * interest each solve paid (to `e.userId`, or the actor, for every buy before it) and the prices
 * after every step. The seed script writes exactly these rows, and the tests check the opening
 * board against it. */
function replay(outcomes, b, events) {
    let q = {};
    for (const k of outcomes) q[k] = 0;
    let scale = 1;
    const held = new Map();
    const steps = [];
    for (const e of events) {
        if (e.type === 'buy') {
            if (!(e.problem in q)) throw new Error(`replay: ${e.problem} is not open`);
            const shares = LMSR.sharesForAmount(q, b, e.problem, e.amount, scale);
            q = Object.assign({}, q, { [e.problem]: q[e.problem] + shares });
            const key = String(e.userId || e.actor || 'user');
            const mine = held.get(key) || {};
            mine[e.problem] = (mine[e.problem] || 0) + shares;
            held.set(key, mine);
            steps.push(Object.assign({}, e, { shares, scale, prices: LMSR.prices(q, b) }));
        } else if (e.type === 'solve') {
            if (!(e.problem in q)) throw new Error(`replay: ${e.problem} is not open`);
            const holders = [...held.entries()].map(([key, mine]) => ({
                key,
                holdings: Object.entries(mine).map(([problem, shares]) => ({ problem, shares })),
            }));
            const s = settleSolve({ q, b, scale, problem: e.problem, holders });
            q = s.q;
            scale = s.scale;
            steps.push(Object.assign({}, e, { rate: s.rate, scale, payments: s.payments, prices: s.prices }));
        } else {
            throw new Error(`replay: unknown event ${e.type}`);
        }
    }
    return { q, scale, steps };
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
    hasWrittenSolution,
    isProblemId,
    parseAmount,
    validateTrade,
    marketStep,
    eliminationsFor,
    positionValue,
    portfolioValueOf,
    profitOf,
    floor4,
    settleSolve,
    allocate,
    replay,
    chartSeries,
};
