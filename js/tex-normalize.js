/* The one repair that must happen identically in the editor preview and on the page.
 *
 * The source double-escapes LaTeX and relies on marked halving `\\`→`\`, but brace
 * delimiters were over-escaped, leaving an invalid `\left\\{` (= `\left` followed by a
 * `\\` line break) that MathJax rejects. mathRender.js has repaired this server-side
 * since 2026-07-24; the editor preview did not, so a formula could look broken while you
 * wrote it and correct once published, or the reverse.
 *
 * That gap is the cheap half of a real cost: one contributor published a single problem
 * eleven times — "там LaTeX как то по разному в редакторе и на сайте отображался.
 * Поэтому я ту задачу 11 поправлял" — chasing a preview that disagreed with the page.
 *
 * Kept in its own file, with no dependencies, so mathRender.js (Node) and
 * views/edit_post.ejs (browser) share one definition rather than two that can drift.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TexNormalize = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const STRAY_DELIMITER = /\\(left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr)\\\\/g;

    function normalizeTex(tex) {
        if (typeof tex !== 'string') return '';
        return tex.replace(STRAY_DELIMITER, '\\$1\\');
    }

    return { normalizeTex: normalizeTex };
});
