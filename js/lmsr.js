/* The market maker behind «Последняя задача» (lastProblem.js): Hanson's logarithmic market
 * scoring rule, LMSR.
 *
 * Why this and not an order book like Polymarket's: a book needs someone on the other side of
 * every trade, and the community chat has a dozen regular voices. With LMSR the market itself
 * is always the counterparty, so any amount can be bought or sold at any moment, and the prices
 * of all outcomes always add up to exactly 100%.
 *
 *   q_i       shares of outcome i outstanding (bought minus sold back)
 *   C(q)      b * ln( sum_i exp(q_i / b) )            what the market has taken in so far
 *   price_i   exp(q_i / b) / sum_j exp(q_j / b)       the probability the market shows
 *   a trade   costs C(q after) - C(q before)
 *
 * b is the liquidity: how far one trade moves the price. With b = 1000 and 32 outcomes, 100 ħ on
 * a 3% problem takes it to about 12%.
 *
 * When a problem gets solved its term leaves the sum (eliminate), its shares are worth nothing, and
 * the market pays interest to everything still in play (solve, below). The prices above are then
 * relative weights, and what a share costs in quanta is scale × price: the scale starts at 1 and
 * shrinks at every solve by exactly what the interest paid out, so no price per share jumps.
 *
 * Plain numbers keyed by problem id, never user input as a key (the router validates ids first).
 * Log-sum-exp throughout: exp(q / b) overflows long before any realistic market does otherwise.
 * UMD like js/reactions.js: the server require()s it and the app previews trades with it.
 * No DOM, no fetch, no storage access.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LMSR = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function keysOf(q) {
        return Object.keys(q);
    }

    function logSumExp(xs) {
        let max = -Infinity;
        for (const x of xs) if (x > max) max = x;
        if (!Number.isFinite(max)) return max;
        let sum = 0;
        for (const x of xs) sum += Math.exp(x - max);
        return max + Math.log(sum);
    }

    /** C(q): the cost function. */
    function cost(q, b) {
        return b * logSumExp(keysOf(q).map((k) => q[k] / b));
    }

    /** Every outcome's price, summing to 1. */
    function prices(q, b) {
        const keys = keysOf(q);
        const out = {};
        if (!keys.length) return out;
        const xs = keys.map((k) => q[k] / b);
        let max = -Infinity;
        for (const x of xs) if (x > max) max = x;
        let sum = 0;
        const e = xs.map((x) => {
            const v = Math.exp(x - max);
            sum += v;
            return v;
        });
        keys.forEach((k, i) => { out[k] = e[i] / sum; });
        return out;
    }

    function priceOf(q, b, k) {
        return prices(q, b)[k];
    }

    function withDelta(q, k, delta) {
        const next = {};
        for (const key of keysOf(q)) next[key] = q[key];
        next[k] += delta;
        return next;
    }

    /** What buying `shares` of k costs now. Negative shares is a sale (a negative cost). */
    function tradeCost(q, b, k, shares) {
        return cost(withDelta(q, k, shares), b) - cost(q, b);
    }

    /* How many shares of k an amount buys at a given scale. Solving
     * scale × (C(q + x e_k) - C(q)) = amount for x gives
     *   x = b * ln( (exp(a) - 1 + p) / p ),   a = amount / (scale × b),  p the current price of k,
     * exact, so the buyer pays precisely what they typed. expm1 keeps small amounts precise, and a
     * large a (late in the market, when the scale is small) is taken in logs so it cannot overflow. */
    function sharesForAmount(q, b, k, amount, scale) {
        if (!(amount > 0)) return 0;
        const p = priceOf(q, b, k);
        const a = amount / ((scale > 0 ? scale : 1) * b);
        const top = a > 30 ? a + Math.log1p((p - 1) * Math.exp(-a)) : Math.log(Math.expm1(a) + p);
        return b * (top - Math.log(p));
    }

    /** What selling `shares` of k pays out now, in quanta. */
    function sellProceeds(q, b, k, shares, scale) {
        if (!(shares > 0)) return 0;
        return -tradeCost(q, b, k, -shares) * (scale > 0 ? scale : 1);
    }

    /* What a whole portfolio fetches if all of it is sold now: scale × (C(q) - C(q - h)), for
     * holdings h keyed like q (outcomes missing from q are worth nothing). Selling one position at
     * a time and adding up the proceeds undervalues a spread of bets, because each sale is priced
     * as if the others were still held; sold together, a complete set of x shares fetches exactly
     * scale × x. */
    function portfolioValue(q, b, holdings, scale) {
        let any = false;
        const after = {};
        for (const key of keysOf(q)) {
            const h = holdings && holdings[key] > 0 ? holdings[key] : 0;
            if (h > 0) any = true;
            after[key] = q[key] - h;
        }
        return any ? (cost(q, b) - cost(after, b)) * (scale > 0 ? scale : 1) : 0;
    }

    // The scale never reaches zero, even if a problem holding practically the whole market is
    // solved; below this the next trade's arithmetic would stop being meaningful.
    const MIN_SCALE = 1e-9;

    /* Problem k is solved: the rule the owner set on the evening the market opened, "conservation
     * of interest". Its shares are worth nothing, and every holding in the problems still open earns
     * interest at the rate p_k / (1 - p_k) on what it sells for right after (interestOn). The
     * scale shrinks by (1 - p_k), which keeps every other price per share where it was, and is
     * exactly what the interest can pay: a complete set of shares is worth the same before and
     * after, part of it now as quanta. So the later a problem is solved, the more interest its
     * shares have collected; the last one standing also keeps its full value. */
    function solve(q, b, scale, k) {
        const before = scale > 0 ? scale : 1;
        const share = priceOf(q, b, k);
        return {
            share,
            rate: share / (1 - share),
            q: eliminate(q, k),
            scaleBefore: before,
            scale: Math.max(before * (1 - share), MIN_SCALE),
        };
    }

    /* The interest one holder gets from a solve (the result of solve), for their holdings in the
     * problems still open. rate × scale after is share × scale before, written that way so it stays
     * finite when the solved problem held almost everything. */
    function interestOn(solved, b, holdings) {
        if (!solved || !(solved.share > 0)) return 0;
        const value = portfolioValue(solved.q, b, holdings, 1);
        return value > 0 ? solved.share * solved.scaleBefore * value : 0;
    }

    /** The market with outcome k removed: it was solved, so it can no longer be the last one. */
    function eliminate(q, k) {
        const next = {};
        for (const key of keysOf(q)) if (key !== k) next[key] = q[key];
        return next;
    }

    /* The q that opens a market at given probabilities (they need not sum to one). Only relative
     * values matter to LMSR, so the smallest is shifted to zero. */
    function qForPrices(probabilities, b) {
        const keys = keysOf(probabilities);
        const logs = keys.map((k) => b * Math.log(probabilities[k]));
        const min = Math.min(...logs);
        const q = {};
        keys.forEach((k, i) => { q[k] = logs[i] - min; });
        return q;
    }

    return { cost, prices, priceOf, tradeCost, sharesForAmount, sellProceeds, portfolioValue, eliminate, solve, interestOn, qForPrices, logSumExp, MIN_SCALE };
});
