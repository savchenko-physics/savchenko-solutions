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

// ── Glyphs the TeX font lacks ──────────────────────────────────────────────────
// MathJax's TeX font has no Cyrillic, and units and subscripts sit inside the maths in
// nearly every Russian solution ($10\,кОм$, $v_{ср}$), so those letters become SVG <text>
// in a fallback font. In a browser MathJax measures that text; here the lite adaptor can
// only guess 0.6 em per character, in whatever serif the visitor has. Wide fonts overflowed
// the guessed box and, on a page without /css/mathjax.css (overflow: visible), the overflow
// was clipped: 8.3.3's "10 кОм" lost half of its "м" on /ru/upload (2026-09-02).
// So the fallback is pinned to a self-hosted Computer Modern Unicode — the same design as
// the TeX font, Latin widths identical to the unit — sized 1:1 with the TeX glyphs and laid
// out from its own advance widths. scripts/build-math-fallback-font.py builds the fonts and
// the table; getMathCss() ships the @font-face rules, so every page that shows
// server-rendered maths must link /css/mathjax.css (bump its ?v= when this file changes —
// the route serves it with a week of max-age and assetUrl() cannot hash a virtual file).
const fallbackFont = require('./lib/mathFallbackFont.json');
const FALLBACK_FAMILY = fallbackFont.family;

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const texInput = new TeX({ packages: AllPackages, processEscapes: true });
const svgOutput = new SVG({
    fontCache: 'local',
    // Becomes the font-family attribute of every fallback <text>. The stack behind the
    // pinned family only shows while the woff2 is still loading or the CSS is missing.
    unknownFamily: `${FALLBACK_FAMILY}, Times New Roman, Times, serif`,
});
const mathDoc = mathjax.document('', { InputJax: texInput, OutputJax: svgOutput });

function usesFallbackFont(node) {
    const family = adaptor.getAttribute(node, 'font-family');
    return typeof family === 'string' && family.startsWith(FALLBACK_FAMILY);
}
function fallbackWidths(node) {
    const italic = adaptor.getAttribute(node, 'font-style') === 'italic';
    const bold = adaptor.getAttribute(node, 'font-weight') === 'bold';
    const variant = bold ? (italic ? 'bold-italic' : 'bold') : (italic ? 'italic' : 'normal');
    return fallbackFont.styles[variant].widths;
}

// MathJax sizes unknown text to match an assumed x-height (0.884 of the em here). At 1:1
// the CMU glyphs *are* the TeX glyphs, so a Cyrillic "с" is exactly as big as a Latin "c".
const svgUnknownText = svgOutput.unknownText;
svgOutput.unknownText = function (text, variant) {
    const node = svgUnknownText.call(this, text, variant);
    if (usesFallbackFont(node)) this.adaptor.setAttribute(node, 'font-size', `${fallbackFont.size}px`);
    return node;
};

// The width MathJax lays the next glyph out from: the table instead of the 0.6 em guess.
// Same contract as the adaptor's own version — em units, so advance × font-size / em. A
// character outside the subset is drawn by the next font in the stack and keeps the guess.
const liteNodeSize = adaptor.nodeSize;
adaptor.nodeSize = function (node, em = 1, local = null) {
    if (!usesFallbackFont(node)) return liteNodeSize.call(this, node, em, local);
    const widths = fallbackWidths(node);
    const size = parseFloat(this.getAttribute(node, 'font-size')) || fallbackFont.size;
    let w = 0;
    for (const ch of this.textContent(node)) {
        const adv = widths[ch.codePointAt(0)];
        if (adv === undefined) return liteNodeSize.call(this, node, em, local);
        w += adv;
    }
    return [w * size / em, this.options.unknownCharHeight];
};

/**
 * Constant stylesheet for pages with server-rendered maths — MathJax's SVG rules (the
 * `overflow: visible` that lets a glyph show past its box) plus the @font-face for the
 * fallback glyphs. Served as /css/mathjax.css; link it once per page that has maths.
 */
function getMathCss() {
    const { family, unicodeRange, styles } = fallbackFont;
    const faces = Object.values(styles).map((s) =>
        `@font-face {\n  font-family: '${family}';\n  font-style: ${s.style};\n  font-weight: ${s.weight};\n` +
        `  font-display: swap;\n  src: url(/css/vendor/fonts/files/${s.file}) format('woff2');\n` +
        `  unicode-range: ${unicodeRange};\n}`).join('\n\n');
    return adaptor.textContent(svgOutput.styleSheet(mathDoc)) +
        '\n\n/* Glyphs the TeX font lacks (Cyrillic, µ, ², …): Computer Modern Unicode, laid out\n' +
        '   server-side from lib/mathFallbackFont.json (scripts/build-math-fallback-font.py). */\n' +
        faces + '\n';
}

// marked escapes <, >, & inside text (incl. inside math), but TeX needs the raw
// characters, so decode the handful of entities that can appear in a formula.
function decodeEntities(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

// Repair a systematic source-authoring bug: LaTeX is double-escaped and relies on
// marked halving `\\`→`\`, but brace delimiters were over-escaped, leaving an invalid
// `\left\\{` (= `\left` + a `\\` line break) that MathJax rejects. `\left\\`/`\right\\`
// (and the \big… variants) are never valid, so collapse the stray `\\` to a single `\`.
//
// Shared with the editor preview, which used to skip this and therefore disagreed with
// the published page about which formulas render. See js/tex-normalize.js.
const { normalizeTex } = require('./js/tex-normalize');

const formulaCache = new Map();
const CACHE_MAX = 20000;
function tex2svg(tex, display) {
    const key = (display ? 'D|' : 'I|') + tex;
    const hit = formulaCache.get(key);
    if (hit !== undefined) return hit;
    let out;
    try {
        const node = mathDoc.convert(normalizeTex(decodeEntities(tex).trim()), { display });
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

// Brace-aware inline `$...$` scan: a `$` inside `{...}` (e.g. `\text{см$^2$}` or
// `\fbox{$x$}`) is NOT a delimiter — same rule MathJax's own finder uses. A plain
// regex splits on that inner `$` and produces broken half-formulas.
function renderInlineDollar(s, render) {
    let out = '', i = 0;
    const n = s.length;
    while (i < n) {
        if (s[i] === '$' && s[i + 1] !== '$') {
            let j = i + 1, depth = 0, close = -1;
            while (j < n) {
                const cj = s[j];
                if (cj === '\n') break;                 // inline math is single-line
                else if (cj === '{') depth++;
                else if (cj === '}') { if (depth > 0) depth--; }
                else if (cj === '$' && depth === 0) { close = j; break; }
                j++;
            }
            if (close > i + 1) {
                const svg = render(s.slice(i + 1, close));
                if (svg) { out += svg; i = close + 1; continue; }
            }
        }
        out += s[i]; i++;
    }
    return out;
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
    s = renderInlineDollar(s, (tex) => I(tex));
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => I(tex) || m);

    return restore(s, store);
}

module.exports = { renderMathInHtml, getMathCss };
