/**
 * difficultyRating.js — Codeforces-style display rescale of the internal
 * 0-100 calibrated percentile.
 *
 * A raw "0" read as "this problem has no difficulty at all" rather than what
 * it actually means ("easiest in the book, still real physics"). Codeforces'
 * problem-rating convention avoids that: nothing ever reads as zero.
 *
 * This is a presentation-only transform. `problem_difficulty.calibrated`
 * stays 0-100 everywhere it's stored, sorted, and filtered — rescaling is
 * monotonic, so anything ordered by calibrated is already ordered by rating.
 *
 * The rescale is NOT linear. `calibrated` is a uniform percentile by
 * construction (scripts/score-difficulty.js deliberately flattens it so the
 * scale uses its full width) — mapping that linearly onto 800-3500 would
 * produce an artificially flat rating histogram, every bucket the same size.
 * Real Codeforces ratings aren't flat: a large low-end cluster, a broad mid
 * plateau, a long declining tail. So instead of a straight line, every
 * problem's percentile is quantile-mapped through Codeforces' own empirical
 * rating distribution (11,051 rated problems, scraped via the Codeforces API
 * into cf_problem_rating_distribution.json) — reshaping our uniform
 * percentile into the same silhouette a reader already recognizes.
 */

// [rating, problem count at that rating], Codeforces' own distribution.
const CF_HISTOGRAM = [
    [800, 1087], [900, 350], [1000, 402], [1100, 444], [1200, 455], [1300, 471],
    [1400, 460], [1500, 475], [1600, 522], [1700, 516], [1800, 491], [1900, 537],
    [2000, 494], [2100, 451], [2200, 472], [2300, 412], [2400, 462], [2500, 415],
    [2600, 340], [2700, 308], [2800, 254], [2900, 240], [3000, 198], [3100, 170],
    [3200, 159], [3300, 136], [3400, 90], [3500, 240],
];

const FLOOR = CF_HISTOGRAM[0][0];
const CEIL = CF_HISTOGRAM[CF_HISTOGRAM.length - 1][0];
const STEP = 100;

const CF_TOTAL = CF_HISTOGRAM.reduce((sum, [, n]) => sum + n, 0);

// Cumulative percentile (0-100) at which each rating bucket begins, built once.
const CF_CUMULATIVE = (() => {
    let running = 0;
    return CF_HISTOGRAM.map(([rating, count]) => {
        const from = (running / CF_TOTAL) * 100;
        running += count;
        return { rating, from };
    });
})();

/** calibrated (0-100 percentile) -> a Codeforces-shaped rating in [800, 3500]. */
function toRating(calibrated) {
    if (calibrated == null) return null;
    const p = Math.max(0, Math.min(100, calibrated));
    let rating = CF_CUMULATIVE[0].rating;
    for (const bucket of CF_CUMULATIVE) {
        if (p >= bucket.from) rating = bucket.rating; else break;
    }
    return rating;
}

/**
 * Inverse of toRating, for the difficulty slider: many percentiles map to one
 * rating bucket, so this returns the [loPercentile, hiPercentile) range that
 * bucket covers rather than a single value — a slider set to rating R should
 * filter calibrated >= this range's low end (as a floor) or <= its high end
 * (as a ceiling), matching "everything AT LEAST/AT MOST this rating."
 */
function ratingToPercentileRange(rating) {
    const idx = CF_CUMULATIVE.findIndex((b) => b.rating === rating);
    if (idx === -1) return [0, 100];
    const from = CF_CUMULATIVE[idx].from;
    const to = idx + 1 < CF_CUMULATIVE.length ? CF_CUMULATIVE[idx + 1].from : 100;
    return [from, to];
}

module.exports = { toRating, ratingToPercentileRange, FLOOR, CEIL, STEP, CF_HISTOGRAM };
