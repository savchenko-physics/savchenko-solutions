// Server-side LaTeX rendering. Converts $...$, $$...$$, \(...\) and \[...\] in a
// rendered HTML page to self-contained inline SVG using the same MathJax engine the
// client used, so output matches — but formulas arrive final (no layout jump), work
// with JS disabled, and MathJax isn't downloaded on the solution body.
//
// The scanner works on the HTML string, so it must NOT touch:
//   - tag markup / attributes (e.g. <img alt=" ... $\alpha$ ..."> — rendering that
//     would inject SVG into the tag and corrupt it), and
//   - inline tags that marked's "breaks" mode drops inside a $$...$$ block (<br>).
// So we first replace every tag (and pre/code/script/style block, and escaped \$)
// with a placeholder; scan the remaining text for math; and inside each formula any
// leftover placeholder (a <br>) becomes a space. Each formula is rendered
// individually and cached by its TeX, so the ~100% hit rate survives dynamic pages.

const { mathjax } = require('mathjax-full/js/mathjax.js');
const { TeX } = require('mathjax-full/js/input/tex.js');
const { SVG } = require('mathjax-full/js/output/svg.js');
const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');
const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js');

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const texInput = new TeX({ packages: AllPackages, processEscapes: true });
const svgOutput = new SVG({ fontCache: 'local' });
const mathDoc = mathjax.document('', { InputJax: texInput, OutputJax: svgOutput });

/** Constant SVG-container stylesheet — include once per page that has math. */
function getMathCss() {
    return adaptor.textContent(svgOutput.styleSheet(mathDoc));
}

// marked escapes <, >, & inside text (incl. inside math), but TeX needs the raw
// characters, so decode the handful of entities that can appear in a formula.
function decodeEntities(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

const formulaCache = new Map();
const CACHE_MAX = 20000;
function tex2svg(tex, display) {
    const key = (display ? 'D|' : 'I|') + tex;
    const hit = formulaCache.get(key);
    if (hit !== undefined) return hit;
    let out;
    try {
        const node = mathDoc.convert(decodeEntities(tex).trim(), { display });
        out = adaptor.outerHTML(node);
    } catch (err) {
        out = null; // signal failure → keep the raw delimiters untouched
    }
    if (formulaCache.size >= CACHE_MAX) formulaCache.delete(formulaCache.keys().next().value);
    formulaCache.set(key, out);
    return out;
}

const S = '\x01MJX'; // placeholder sentinel — cannot occur in real page text
const PLACEHOLDER_G = new RegExp(S + '(\\d+)' + S, 'g');

function protect(html, store) {
    // Whole blocks whose contents must never be scanned.
    html = html.replace(/<(pre|code|script|style|textarea)\b[\s\S]*?<\/\1>/gi, (m) => {
        const t = S + store.length + S; store.push(m); return t;
    });
    // Escaped literal dollar → keep as a literal $.
    html = html.replace(/\\\$/g, () => {
        const t = S + store.length + S; store.push('$'); return t;
    });
    // Every remaining tag: hides attributes (e.g. img alt) and turns inline tags
    // (<br>) that sit inside a formula into a placeholder we drop later.
    html = html.replace(/<[^>]+>/g, (m) => {
        const t = S + store.length + S; store.push(m); return t;
    });
    return html;
}
function restore(html, store) {
    return html.replace(PLACEHOLDER_G, (m, i) => store[+i]);
}
// A placeholder left inside a formula is a stray tag (a <br>): make it a space.
function cleanTex(tex) {
    return tex.replace(PLACEHOLDER_G, ' ');
}

/** Render every math span on an HTML page to inline SVG. Idempotent. */
function renderMathInHtml(html) {
    if (!html) return html;
    if (html.indexOf('$') === -1 && html.indexOf('\\(') === -1 && html.indexOf('\\[') === -1) return html;

    const store = [];
    let s = protect(html, store);
    const D = (tex) => tex2svg(cleanTex(tex), true);
    const I = (tex) => tex2svg(cleanTex(tex), false);

    // Display first (so $$ isn't split by the inline $ pass), then inline.
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => D(tex) || m);
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => D(tex) || m);
    s = s.replace(/\$([^$\n]+?)\$/g, (m, tex) => I(tex) || m);
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => I(tex) || m);

    return restore(s, store);
}

module.exports = { renderMathInHtml, getMathCss };
