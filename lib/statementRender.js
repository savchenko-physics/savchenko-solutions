/**
 * statementRender.js — render a problem statement to display-ready HTML, with a shared
 * bounded cache.
 *
 * Extracted from index.js's GET /api/problem/:name/statement so the problem finder's batch
 * endpoint reuses the same cache rather than keeping a second copy of the same SVG. Statement
 * SVG runs to tens of kilobytes and there are 4,046 of them, so two independent caches would
 * be real duplicated memory on a process that is already large.
 *
 * The cache is bounded and has a TTL rather than being permanent: statements do change under
 * a running server when scripts/repair-ru-latex.js re-typesets a row, and a cache that never
 * expires would serve the flattened version until the next restart.
 */

const { parseMarkdown, transformImageMarkdown } = require('../utils');
const { renderMathInHtml } = require('../mathRender');

const CACHE_MAX = 600;
const CACHE_TTL = 30 * 60 * 1000;
const cache = new Map();

/**
 * @returns {Promise<{name,lang,html,figures,starred,needsReview}|null>} null when there is
 * no statement on record for that problem/language.
 */
async function getStatement(pool, name, lang) {
    const key = `${name}:${lang}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.payload;

    const { rows } = await pool.query(
        `SELECT statement_tex, figures, starred, source, needs_review
           FROM problem_statements WHERE problem_name = $1 AND lang = $2`,
        [name, lang]
    );
    if (!rows.length) return null;
    const row = rows[0];

    // Order matters and matches post.js — transformImageMarkdown consumes the site's
    // "![alt|WxH,scale%](…)" syntax, so it has to see the raw markdown; run it after
    // marked() and the dimensions end up as literal text in the alt attribute. It emits
    // "../../img/…", which only resolves from a two-segment URL like /en/1.1.1, so the
    // paths are made absolute for callers mounted elsewhere.
    let html = parseMarkdown(transformImageMarkdown(row.statement_tex))
        .replace(/(src|srcset)="\.\.\/\.\.\/img\//g, '$1="/img/');
    html = renderMathInHtml(html);

    // Statements recovered from the book carry no image markdown, but many do have a figure
    // on disk that nothing references. Attach it when the text did not already bring one.
    if (!/<img/i.test(html) && row.figures.length) {
        html += row.figures
            .map((src) => `<figure><img src="${src}" alt="" loading="lazy" /></figure>`)
            .join('');
    }

    const payload = {
        name,
        lang,
        html,
        figures: row.figures,
        starred: row.starred,
        // Statements recovered from the printed book still have flattened maths; the UI
        // says so rather than presenting them as clean.
        needsReview: row.needs_review,
    };

    // Map preserves insertion order, so the oldest key is the first one it yields.
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), payload });
    return payload;
}

/**
 * Same as getStatement but for many problems at once, in a single round trip to Postgres.
 *
 * Calling getStatement in a loop would issue one query per problem (a classic N+1) — for a
 * 20-card page that is 20 sequential DB round trips, which dominates the response on a cold
 * cache. This fetches every uncached row with one `= ANY(...)` query and renders from that.
 *
 * @returns {Promise<Object<string,string>>} problem name -> HTML, omitting any with no
 * statement on record.
 */
async function getStatements(pool, names, lang) {
    const out = {};
    const missing = [];

    for (const name of names) {
        const hit = cache.get(`${name}:${lang}`);
        if (hit && Date.now() - hit.at < CACHE_TTL) out[name] = hit.payload.html;
        else missing.push(name);
    }
    if (!missing.length) return out;

    const { rows } = await pool.query(
        `SELECT problem_name, statement_tex, figures, starred, needs_review
           FROM problem_statements WHERE problem_name = ANY($1) AND lang = $2`,
        [missing, lang]
    );

    for (const row of rows) {
        let html = parseMarkdown(transformImageMarkdown(row.statement_tex))
            .replace(/(src|srcset)="\.\.\/\.\.\/img\//g, '$1="/img/');
        html = renderMathInHtml(html);
        if (!/<img/i.test(html) && row.figures.length) {
            html += row.figures
                .map((src) => `<figure><img src="${src}" alt="" loading="lazy" /></figure>`)
                .join('');
        }
        const payload = {
            name: row.problem_name,
            lang,
            html,
            figures: row.figures,
            starred: row.starred,
            needsReview: row.needs_review,
        };
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(`${row.problem_name}:${lang}`, { at: Date.now(), payload });
        out[row.problem_name] = html;
    }
    return out;
}

module.exports = { getStatement, getStatements, CACHE_MAX, CACHE_TTL };
