// The site's typefaces: generated files, the CSS that names them, and the stacks that use them.
//
// Until September 2026 the site named 39 font stacks and loaded Roboto, Inter, Noto Serif,
// JetBrains Mono and Latin Modern from five different places; weight 600 rendered as a fake bold
// and every italic was synthesised. scripts/build-fonts.py now produces four families (SS Text,
// SS Sans, SS Mono, SS Display) plus the wordmark and symbol subsets, as content-hashed WOFF2
// files served with a one-year immutable cache. That cache is exactly what makes a mistake
// expensive: a file whose name no longer matches its bytes is cached wrong for a year, and a
// preload pointing at a file no @font-face uses is a wasted download on every page view.
//
// This file checks that the three generated outputs (the files, css/vendor/fonts/site-fonts.css,
// lib/siteFonts.json) agree, that every family can set Russian and English, that the licences
// travel with the files, that the byte budget of a solution page holds, and that every stack
// still reads if a filter blocks the WOFF2 files. What it cannot check is how the glyphs look;
// that is scripts/qa/type_audit.py in a real browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveVar } = require('../scripts/lib/design-tokens');

const ROOT = path.join(__dirname, '..');
const H = path.join(ROOT, 'css', 'vendor', 'fonts', 'h');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'siteFonts.json'), 'utf8'));
const css = fs.readFileSync(path.join(ROOT, 'css', 'vendor', 'fonts', 'site-fonts.css'), 'utf8');

function parseRanges(spec) {
    const out = [];
    for (const part of String(spec).split(',')) {
        const p = part.trim().toUpperCase().replace('U+', '');
        if (!p) continue;
        const [a, b] = p.split('-');
        out.push([parseInt(a, 16), parseInt(b || a, 16)]);
    }
    return out;
}
const inRanges = (ranges, cp) => ranges.some(([a, b]) => cp >= a && cp <= b);

// ── The three outputs agree ─────────────────────────────────────────────────────────────

test('every face in lib/siteFonts.json is a real file whose name carries its own hash', () => {
    for (const face of manifest.faces) {
        const file = path.join(H, face.file);
        assert.ok(fs.existsSync(file), face.file);
        const bytes = fs.readFileSync(file);
        assert.equal(bytes.length, face.bytes, `${face.file} size`);
        const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 10);
        assert.match(face.file, new RegExp(`\\.${hash}\\.woff2$`), `${face.file} does not match its content`);
    }
    const onDisk = fs.readdirSync(H).filter((f) => f.endsWith('.woff2')).sort();
    assert.deepEqual(onDisk, manifest.faces.map((f) => f.file).sort(), 'stale or unlisted files in css/vendor/fonts/h');
});

test('site-fonts.css declares exactly the manifest faces, each with swap and its unicode-range', () => {
    const blocks = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]).filter((b) => /url\(h\//.test(b));
    assert.equal(blocks.length, manifest.faces.length);
    for (const face of manifest.faces) {
        const block = blocks.find((b) => b.includes(`url(h/${face.file})`));
        assert.ok(block, face.file);
        assert.match(block, /font-display:\s*swap;/, face.file);
        assert.ok(block.includes(`font-family: '${face.family}';`), face.file);
        assert.ok(block.includes(`unicode-range: ${face.unicodeRange};`), face.file);
    }
});

test('bundle.css carries the font faces with URLs rebased to css/', () => {
    const bundle = fs.readFileSync(path.join(ROOT, 'css', 'bundle.css'), 'utf8');
    for (const face of manifest.faces) assert.ok(bundle.includes(`url(vendor/fonts/h/${face.file})`), face.file);
    assert.doesNotMatch(bundle, /url\(h\//);
});

// ── Coverage ────────────────────────────────────────────────────────────────────────────

test('every text family sets both Russian and English in every style it has', () => {
    const groups = new Map();
    for (const f of manifest.faces) {
        if (!['SS Text', 'SS Sans', 'SS Mono', 'SS Display'].includes(f.family)) continue;
        const key = `${f.family} ${f.weight} ${f.style}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(...parseRanges(f.unicodeRange));
    }
    assert.ok(groups.size >= 9, [...groups.keys()].join(', '));
    const probe = 'AZaz09.,«»—№ ЁёЖжЩщЯя';
    for (const [key, ranges] of groups) {
        for (const ch of probe) assert.ok(inRanges(ranges, ch.codePointAt(0)), `${key} lacks ${ch}`);
    }
});

test('no two faces of the same family, weight and style claim the same character', () => {
    const groups = new Map();
    for (const f of manifest.faces) {
        const key = `${f.family} ${f.weight} ${f.style}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push([f.subset, parseRanges(f.unicodeRange)]);
    }
    for (const [key, subsets] of groups) {
        for (let i = 0; i < subsets.length; i++) {
            for (let j = i + 1; j < subsets.length; j++) {
                for (const [a1, b1] of subsets[i][1]) {
                    for (const [a2, b2] of subsets[j][1]) {
                        assert.ok(b1 < a2 || b2 < a1, `${key}: ${subsets[i][0]} and ${subsets[j][0]} overlap at U+${Math.max(a1, a2).toString(16)}`);
                    }
                }
            }
        }
    }
});

test('the wordmark subset covers both locale titles', () => {
    const wm = manifest.faces.find((f) => f.family === 'SS Wordmark');
    assert.ok(wm);
    const ranges = parseRanges(wm.unicodeRange);
    for (const loc of ['en', 'ru']) {
        const { title } = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${loc}.json`), 'utf8'));
        for (const ch of title) assert.ok(inRanges(ranges, ch.codePointAt(0)), `${loc} title "${title}" needs ${ch}`);
    }
    assert.ok(wm.bytes < 8 * 1024, `wordmark is ${wm.bytes} bytes; it is preloaded on every page`);
});

test('SS Symbols carries Savchenko\'s star and is second in every stack', () => {
    const sym = manifest.faces.find((f) => f.family === 'SS Symbols');
    assert.ok(sym && inRanges(parseRanges(sym.unicodeRange), 0x2217), 'U+2217 ∗');
    assert.equal(sym.weight, '100 900', 'one face for every weight, never a synthesised bold');
    for (const token of ['--ss-font-ui', '--ss-font-text', '--ss-font-mono']) {
        const stack = resolveVar(`var(${token})`).split(',').map((s) => s.trim().replace(/['"]/g, ''));
        assert.equal(stack[1], 'SS Symbols', token);
    }
});

// ── Licences ────────────────────────────────────────────────────────────────────────────

test('the licences travel with the files, and Plex keeps its reserved name', () => {
    for (const f of ['LICENSE-NewCM.txt', 'LICENSE-IBMPlexSans-OFL.txt', 'LICENSE-IBMPlexMono-OFL.txt', 'LICENSE-CMU-OFL.txt']) {
        assert.ok(fs.existsSync(path.join(H, f)), f);
    }
    assert.match(fs.readFileSync(path.join(H, 'LICENSE-IBMPlexSans-OFL.txt'), 'utf8'), /Reserved Font Name "Plex"/);
    // Plex may not be modified under that name: those faces must be IBM's own split files.
    for (const f of manifest.faces.filter((x) => x.family === 'SS Sans' || x.family === 'SS Mono')) {
        assert.match(f.source || '', /^IBMPlex(Sans|Mono)-[A-Za-z]+-(Latin1|Latin2|Latin3|Cyrillic|Greek|Pi)\.woff2$/, f.file);
    }
    assert.match(fs.readFileSync(path.join(H, 'LICENSE-NewCM.txt'), 'utf8'), /MODIFIED versions/);
});

// ── Budget and preloads ─────────────────────────────────────────────────────────────────

test('a cold Russian solution page needs at most 220 KB of text fonts', () => {
    const pick = (family, weight, style, subset) => {
        const f = manifest.faces.find((x) => x.family === family && x.weight === weight && x.style === style && x.subset === subset);
        assert.ok(f, `${family} ${weight} ${style} ${subset}`);
        return f.bytes;
    };
    // Interface regular and semibold, prose regular and bold (title, problem number), wordmark.
    const total = pick('SS Sans', 400, 'normal', 'latin1') + pick('SS Sans', 400, 'normal', 'cyrillic')
        + pick('SS Sans', 600, 'normal', 'latin1') + pick('SS Sans', 600, 'normal', 'cyrillic')
        + pick('SS Text', 400, 'normal', 'latin') + pick('SS Text', 400, 'normal', 'cyrillic')
        + pick('SS Text', 700, 'normal', 'latin') + pick('SS Text', 700, 'normal', 'cyrillic')
        + manifest.faces.find((x) => x.family === 'SS Wordmark').bytes;
    assert.ok(total <= 220 * 1024, `${Math.round(total / 1024)} KB`);
    for (const f of manifest.faces) assert.ok(f.bytes <= 45 * 1024, `${f.file} is ${Math.round(f.bytes / 1024)} KB`);
});

test('preloads name real faces, and the partial sends them with crossorigin', () => {
    const urls = new Set(manifest.faces.map((f) => manifest.urlPrefix + f.file));
    for (const [k, list] of Object.entries(manifest.preload)) {
        assert.ok(list.length > 0 && list.length <= 3, k);
        for (const u of list) assert.ok(urls.has(u), `${k}: ${u}`);
    }
    const partial = fs.readFileSync(path.join(ROOT, 'views', 'default', 'site_styles.ejs'), 'utf8');
    assert.match(partial, /<link rel="preload" href="<%= href %>" as="font" type="font\/woff2" crossorigin>/);
});

test('the hashed files are served immutable for a year, before the general /css mount', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    const mount = index.indexOf('app.use("/css/vendor/fonts/h"');
    assert.ok(mount > 0);
    assert.match(index.slice(mount, mount + 400), /immutable: true, maxAge: '365d'/);
    // A file that is not there is a 404 from this prefix, not the error handler's 500.
    assert.match(index, /app\.use\("\/css\/vendor\/fonts\/h", \(req, res\) => res\.sendStatus\(404\)\);/);
    assert.ok(mount < index.indexOf('app.use("/css", express.static'), 'the general mount would answer first with a 7-day cache');
});

// ── Must never leave a reader without text ──────────────────────────────────────────────

test('every stack ends in a Windows system font and a generic family', () => {
    const want = {
        '--ss-font-text': [/Georgia|Times New Roman/, 'serif'],
        '--ss-font-ui': [/Segoe UI|Arial/, 'sans-serif'],
        '--ss-font-mono': [/Consolas|Courier New/, 'monospace'],
        '--ss-font-display': [/Arial/, 'sans-serif'],
    };
    for (const [token, [system, generic]] of Object.entries(want)) {
        const stack = resolveVar(`var(${token})`).split(',').map((s) => s.trim().replace(/['"]/g, ''));
        assert.equal(stack[stack.length - 1], generic, token);
        assert.ok(stack.some((s) => system.test(s)), `${token} has no system font: ${stack.join(', ')}`);
        assert.ok(stack.some((s) => / Fallback$/.test(s)), `${token} has no size-adjusted fallback face`);
    }
    for (const fb of manifest.fallbacks) {
        assert.ok(css.includes(`font-family: '${fb.family}';`), fb.family);
        assert.ok(fb.sizeAdjust > 80 && fb.sizeAdjust < 120, `${fb.family} size-adjust ${fb.sizeAdjust}%`);
    }
});
