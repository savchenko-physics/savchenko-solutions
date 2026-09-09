// Regression tests for the glyphs MathJax's TeX font does not have — in practice the
// Cyrillic units and subscripts inside the maths of nearly every Russian solution
// ($10\,кОм$, $v_{ср}$: 1,674 of 1,740 Russian posts and 1,500 of 2,023 statements).
//
// The incident: on 2026-09-02 /ru/upload showed 8.3.3's "10 кОм" with half of the "м"
// missing. Server-side rendering (mathRender.js) emitted each letter as an SVG <text> in the
// visitor's default serif and, having no browser to measure with, guessed 0.6 em per letter.
// A real italic "м" is 0.74 em, so the last letter overran the SVG's box, and the upload page
// did not link /css/mathjax.css, whose `overflow: visible` would at least have let it show.
// The fix pins those glyphs to a self-hosted Computer Modern Unicode and lays them out from
// that font's own advance widths (lib/mathFallbackFont.json), so what the server measures is
// what the browser draws.
//
// Not covered: the browser itself. These tests check the SVG the server emits and the table
// it measures with. Whether the woff2 actually loads depends on the page linking the
// stylesheet, which the last block checks by reading the templates.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { renderMathInHtml, getMathCss } = require('../mathRender');
const table = require('../lib/mathFallbackFont.json');

const ROOT = path.join(__dirname, '..');
const FONT_DIR = path.join(ROOT, 'css', 'vendor', 'fonts', 'files');

// Every <text> MathJax emitted, with its attributes.
function textNodes(html) {
    const out = [];
    const re = /<text ([^>]*)>([^<]*)<\/text>/g;
    let m;
    while ((m = re.exec(html))) {
        const attrs = {};
        for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
        out.push({ attrs, char: m[2] });
    }
    return out;
}
// x offsets of the <g data-mml-node="mi"> wrappers, in MathJax's 1/1000 em units.
function miOffsets(html) {
    return [...html.matchAll(/<g data-mml-node="mi" transform="translate\((-?\d+),0\)"/g)].map((m) => Number(m[1]));
}
function viewBoxWidth(html) {
    return Number(html.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) [\d.]+"/)[1]);
}
const CYRILLIC = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';

// ── the table and the fonts it describes ────────────────────────────────────────────
test('every Cyrillic letter has a width in all four styles, and the fonts exist', () => {
    assert.deepStrictEqual(Object.keys(table.styles).sort(), ['bold', 'bold-italic', 'italic', 'normal']);
    for (const [variant, style] of Object.entries(table.styles)) {
        for (const ch of CYRILLIC) {
            const w = style.widths[ch.codePointAt(0)];
            assert.ok(typeof w === 'number' && w > 0.2 && w < 1.5, `${variant} lacks ${ch}`);
        }
        assert.ok(fs.existsSync(path.join(FONT_DIR, style.file)), `${style.file} missing`);
        assert.ok(fs.statSync(path.join(FONT_DIR, style.file)).size > 5000, `${style.file} is empty`);
    }
    // The size is what makes the glyphs 1:1 with MathJax's TeX font (CMU *is* Computer Modern).
    assert.strictEqual(table.size, 1000);
});

test('the widths are the real glyphs, not the 0.6 em guess', () => {
    // The three letters from the incident. A guess of 0.6 for every one is what clipped "м".
    const it = table.styles.italic.widths;
    assert.ok(it['м'.codePointAt(0)] > 0.7, 'italic м is wide');
    assert.ok(it['О'.codePointAt(0)] > 0.7, 'italic О is wide');
    assert.ok(it['к'.codePointAt(0)] < 0.6, 'italic к is narrow');
    assert.notStrictEqual(it['к'.codePointAt(0)], it['О'.codePointAt(0)]);
});

// ── what the server emits ────────────────────────────────────────────────────────────
test('8.3.3: each letter of кОм is set in the pinned font at 1:1 and laid out from the table', () => {
    const html = renderMathInHtml('<p>сопротивление $10 \\,кОм$.</p>');
    const texts = textNodes(html);
    assert.deepStrictEqual(texts.map((t) => t.char), ['к', 'О', 'м']);
    for (const t of texts) {
        assert.ok(t.attrs['font-family'].startsWith(table.family), t.attrs['font-family']);
        assert.strictEqual(t.attrs['font-size'], `${table.size}px`);
        assert.strictEqual(t.attrs['font-style'], 'italic');
    }
    const [xk, xO, xm] = miOffsets(html);
    const w = (ch) => table.styles.italic.widths[ch.codePointAt(0)] * table.size;
    assert.ok(Math.abs((xO - xk) - w('к')) <= 1, `О sits after к's real width (${xO - xk} vs ${w('к')})`);
    assert.ok(Math.abs((xm - xO) - w('О')) <= 1, `м sits after О's real width (${xm - xO} vs ${w('О')})`);
    // The clipping itself: the box must reach the end of the last glyph.
    assert.ok(viewBoxWidth(html) >= xm + w('м') - 1, 'the SVG box holds the whole м');
});

test('\\text{} is upright with upright widths; \\mathbf is bold with bold widths', () => {
    const upright = renderMathInHtml('<p>$\\text{кОм}$</p>');
    for (const t of textNodes(upright)) {
        assert.strictEqual(t.attrs['font-style'], undefined);
        assert.strictEqual(t.attrs['font-weight'], undefined);
    }
    const positions = [...upright.matchAll(/<text [^>]*transform="translate\((\d+),0\) scale/g)].map((m) => Number(m[1]));
    const w = table.styles.normal.widths;
    assert.deepStrictEqual(positions, [
        Math.round(w['к'.codePointAt(0)] * 1000),
        Math.round((w['к'.codePointAt(0)] + w['О'.codePointAt(0)]) * 1000),
    ]);

    const bold = renderMathInHtml('<p>$\\mathbf{м}x$</p>');
    const [t] = textNodes(bold);
    assert.strictEqual(t.attrs['font-weight'], 'bold');
    // The x that follows starts where the bold м ends.
    const xs = [...bold.matchAll(/data-mml-node="mi" transform="translate\((\d+),0\)"/g)].map((m) => Number(m[1]));
    assert.strictEqual(xs[xs.length - 1], Math.round(table.styles.bold.widths['м'.codePointAt(0)] * 1000));
});

test('a glyph outside the subset still renders and keeps MathJax\'s own estimate', () => {
    // CJK is not in the font; MathJax's Node adaptor allots it 1 em. It must not throw and
    // must not be measured with the Cyrillic table.
    const html = renderMathInHtml('<p>$一$</p>');
    assert.strictEqual(textNodes(html).length, 1);
    assert.strictEqual(viewBoxWidth(html), 1000);
});

test('the stylesheet carries the four @font-face rules, all self-hosted', () => {
    const css = getMathCss();
    assert.match(css, /mjx-container\[jax="SVG"\] > svg \{\s*overflow: visible/);
    assert.strictEqual(css.split('@font-face').length - 1, 4);
    for (const style of Object.values(table.styles)) {
        assert.ok(css.includes(`url(/css/vendor/fonts/files/${style.file})`), style.file);
    }
    assert.ok(css.includes(`unicode-range: ${table.unicodeRange}`));
    // tests/external-assets.test.js walks files on disk; this stylesheet is generated, so
    // the no-third-party-origin rule is checked here.
    assert.doesNotMatch(css, /https?:\/\//);
});

// ── must never change what it does not own ──────────────────────────────────────────
test('Latin, Greek and digits are still MathJax paths, never fallback text', () => {
    const html = renderMathInHtml('<p>$E = mc^2 + \\alpha \\sin\\theta$</p>');
    assert.strictEqual(textNodes(html).length, 0);
    assert.ok(html.includes('<mjx-container'));
});

test('the shapes of maths real solutions use still render', () => {
    for (const tex of [
        '$v_{ср} = \\frac{S}{t}$', '$F_{тр} = \\mu N$', '$10\\ \\text{кг}\\cdot\\text{м}/\\text{с}^2$',
        '$\\text{см}^2$', '$\\rho = 1{,}5\\,г/см^3$', '$P = 100\\,Вт$', '$U = 220\\,В$',
    ]) {
        const html = renderMathInHtml(`<p>${tex}</p>`);
        assert.ok(html.includes('<mjx-container'), `${tex} did not render`);
        assert.ok(!html.includes('data-mml-node="merror"'), `${tex} rendered an error`);
    }
});

// ── the pages: server-rendered maths is only whole with the stylesheet on the page ──────
test('every template that shows server-rendered maths links /css/mathjax.css', () => {
    const views = path.join(ROOT, 'views');
    const offenders = [];
    (function walk(dir) {
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            if (fs.statSync(p).isDirectory()) { walk(p); continue; }
            if (!name.endsWith('.ejs')) continue;
            const src = fs.readFileSync(p, 'utf8');
            // Pages that fetch a statement into the DOM, plus the two rendered with maths already inline.
            const shows = src.includes('/statement?lang=') || ['solution_post.ejs', 'index.ejs'].includes(name) && src.includes('ss-statement');
            if (shows && !src.includes('/css/mathjax.css')) offenders.push(path.relative(ROOT, p));
        }
    })(views);
    assert.deepStrictEqual(offenders, []);
    // The incident page, by name.
    for (const v of ['views/upload_page.ejs', 'views/eng_page.ejs', 'views/solution_post.ejs', 'views/problems/index.ejs']) {
        assert.ok(fs.readFileSync(path.join(ROOT, v), 'utf8').includes('/css/mathjax.css'), v);
    }
});
