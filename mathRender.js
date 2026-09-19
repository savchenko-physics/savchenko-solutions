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
        '\n\n/* An inline formula and the punctuation after it never split across lines. */\n' +
        '.mjx-nobr { white-space: nowrap; }\n' +
        '\n/* Glyphs the TeX font lacks (Cyrillic, µ, ², …): Computer Modern Unicode, laid out\n' +
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

// Formulas are sized in em, not in MathJax's ex. An ex follows whatever font is on screen, so
// while SS Text was still loading (its size-matched fallback has an x-height of 0.49 em against
// New Computer Modern's 0.431 em) every formula was drawn about 14% too large and shrank when the
// font arrived; tall inline fractions reflowed whole paragraphs (layout shift 0.15 on /ru/1.1.1
// with the fonts 0.4 s late, 0.005 after this). One ex of SS Text is exactly 0.431 em, so once the
// font is in the page looks as it did before, and nothing moves while it loads.
const EX_IN_EM = 0.431;
function emLength(v) {
    return `${Number((parseFloat(v) * EX_IN_EM).toFixed(3))}em`;
}
function exToEm(html) {
    return html.replace(/^(<mjx-container\b[^>]*>)(<svg\b[^>]*>)/, (all, container, svg) => container + svg
        .replace(/\b(width|height)="(-?[\d.]+)ex"/g, (m, attr, v) => `${attr}="${emLength(v)}"`)
        .replace(/vertical-align:\s*(-?[\d.]+)ex/g, (m, v) => `vertical-align: ${emLength(v)}`));
}

// ── Memory ─────────────────────────────────────────────────────────────────────
// From 2026-09-03, the day after this renderer went live, to 2026-09-19 the app died of
// "Ineffective mark-compacts near heap limit" every 10–20 hours (the box gives V8 a 470 MB heap),
// each death a 1.3 GB core dump on a 16 GB disk. Three causes, all in this function, found with a
// sampling heap profile of the live process and reproduced offline (tests/math-memory.test.js):
//  1. mathjax-full 3.2.2's textmacros package parses every \text{…} with a TextParser that the
//     base TexParser constructor pushes onto the package's own ParseOptions and that, unlike
//     TexParser, never pops itself in mml(); nothing clears that ParseOptions between conversions.
//     Every \text{} ever rendered stayed in memory together with its whole formula tree (the
//     parent chain of its nodes). Cleared after every conversion below.
//  2. A cache key was a slice of the page HTML, which V8 keeps as a pointer into the page string,
//     so each stored key pinned a whole rendered solution page (~200 KB). Keys are copied flat.
//  3. 20,000 SVG strings, two bytes a character because of the Cyrillic units, were ~370 MB of
//     heap on their own. An entry is now a UTF-8 buffer outside the heap, and the cache is bounded
//     by bytes (MATH_CACHE_MB, 32 by default), least recently used out first.
const CACHE_BYTES = Math.round((Number(process.env.MATH_CACHE_MB) || 32) * 1024 * 1024);
const formulaCache = new Map(); // flat key → { key, svg: Buffer | null }; least recently used first
let cacheBytes = 0;
let cacheHits = 0, cacheMisses = 0;
const textmacros = texInput.parseOptions.packageData.get('textmacros');

// A fresh flat string with the same code units: never a slice or a cons string over its source.
function flatString(s) {
    return Buffer.from(s, 'utf16le').toString('utf16le');
}
function entryBytes(entry) {
    return entry.key.length * 2 + (entry.svg ? entry.svg.length : 0);
}
function releaseTextParsers() {
    if (textmacros) textmacros.parseOptions.clear();
}

function tex2svg(tex, display) {
    const lookup = (display ? 'D|' : 'I|') + tex;
    const hit = formulaCache.get(lookup);
    if (hit !== undefined) {
        cacheHits++;
        formulaCache.delete(hit.key);
        formulaCache.set(hit.key, hit);   // most recently used last
        return hit.svg ? hit.svg.toString('utf8') : null;
    }
    cacheMisses++;
    let out;
    try {
        const node = mathDoc.convert(normalizeTex(decodeEntities(tex).trim()), { display });
        out = exToEm(adaptor.outerHTML(node));
    } catch (err) {
        out = null; // signal failure → keep the raw delimiters untouched
    } finally {
        releaseTextParsers();
    }
    const entry = { key: flatString(lookup), svg: out === null ? null : Buffer.from(out, 'utf8') };
    formulaCache.set(entry.key, entry);
    cacheBytes += entryBytes(entry);
    while (cacheBytes > CACHE_BYTES && formulaCache.size > 1) {
        const oldest = formulaCache.values().next().value;
        formulaCache.delete(oldest.key);
        cacheBytes -= entryBytes(oldest);
    }
    return out;
}

/** Cache size, what MathJax's text parsers still hold, and the budget: for tests and for
 *  reading the live process over the inspector. */
function memoryStats() {
    const held = textmacros ? textmacros.parseOptions.parsers.length
        + Object.values(textmacros.parseOptions.nodeLists).reduce((n, list) => n + list.length, 0) : 0;
    return { entries: formulaCache.size, bytes: cacheBytes, budget: CACHE_BYTES, hits: cacheHits, misses: cacheMisses, textParsersHeld: held };
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
                if (svg) {
                    // Punctuation right after a formula stays on its line: a break between the
                    // SVG and "." left lines starting with ". Определите" (/ru/1.1.1).
                    const punct = s.slice(close + 1).match(/^[.,;:!?)\]»…]+/);
                    if (punct) {
                        out += `<span class="mjx-nobr">${svg}${punct[0]}</span>`;
                        i = close + 1 + punct[0].length;
                    } else {
                        out += svg;
                        i = close + 1;
                    }
                    continue;
                }
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

module.exports = { renderMathInHtml, getMathCss, memoryStats, flatString, EX_IN_EM };
