/**
 * solutionFigures.js — the registry of interactive figures that belong to a
 * particular solution page.
 *
 * Why this exists rather than the figure living in the markdown: `posts/` on the
 * server is the contributors' authoritative copy, and the repo's copy lags behind
 * it (see CLAUDE.md, and the "Revert post edits" commit). A figure written into a
 * post file would be at the mercy of the next editor save and of any script that
 * touches posts/. It also could not work: sanitizeParsedMarkdownHtml (utils.js)
 * discards <canvas>, <svg>, <script>, <button>, <input> and every data-* attribute
 * from markdown, so a post file can carry a container div and nothing else.
 *
 * So a figure is registered here, injected by the route (post.js), and ships with
 * a deploy. Adding one for another problem is one entry in FIGURES plus a partial
 * under views/partials/figures/.
 */

/**
 * problem name -> figure descriptor.
 *   partial : EJS partial path, relative to views/
 *   script  : page script, loaded deferred only on pages that register a figure
 *   css     : stylesheet, linked only on pages that register a figure
 */
const FIGURES = {
    "6.6.15": {
        id: "precipitator",
        partial: "partials/figures/precipitator",
        script: "/js/figure-precipitator.js",
        css: "/css/figures.css",
    },
};

/** The figure registered for a problem, or null. Never throws on odd input. */
function getFigure(name) {
    if (!name || typeof name !== "string") return null;
    return Object.prototype.hasOwnProperty.call(FIGURES, name) ? FIGURES[name] : null;
}

/*
 * The rendered solution body is one HTML string (post.js:109). A figure belongs
 * where a figure belongs — right under the "Решение" / "Solution" heading, which is
 * exactly where 6.6.16.md and its neighbours put their ![…]() image — so the body is
 * split there and the partial rendered into the seam.
 *
 * marked runs with headerIds:false, so the heading arrives as a bare <h3>Решение</h3>,
 * but the level and any future attributes are matched permissively. A heading-lookalike
 * inside a fenced block cannot false-positive: marked escapes it to &lt;h3&gt; first.
 */
const SOLUTION_HEADING = /<h([1-6])\b[^>]*>\s*(?:Решение|Solution)\s*:?\s*<\/h\1>/i;

/**
 * Split a rendered solution body just after its "Решение" / "Solution" heading.
 * With no such heading the whole body comes back as `before`, so a caller that
 * concatenates before + figure + after still renders the solution intact and simply
 * puts the figure at the end.
 */
function splitAtSolutionHeading(html) {
    if (typeof html !== "string") return { before: "", after: "" };
    const match = SOLUTION_HEADING.exec(html);
    if (!match) return { before: html, after: "" };
    const cut = match.index + match[0].length;
    return { before: html.slice(0, cut), after: html.slice(cut) };
}

module.exports = { FIGURES, getFigure, splitAtSolutionHeading };
