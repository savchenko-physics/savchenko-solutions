// The design tokens: one set of values, written once, readable everywhere it matters.
//
// The CLAUDE.md palette, the --ss-* custom properties in css/design-system.css §1, Bootstrap's
// --bs-* variables (§2) and the data palettes in js/palettes.js describe the same colours four
// times. Before September 2026 they had drifted: 291 distinct hex colours on the site, the
// problem finder colouring Russian solutions orange while the grid coloured them green, and
// greys for real content as light as #999 (2.8:1 on white). This file pins the four copies to
// each other and pins the contrast a reader depends on:
//   1. the CLAUDE.md palette equals the tokens;
//   2. text, links and states meet WCAG AA (4.5:1) on the surfaces they sit on, navy included;
//   3. the Bootstrap bridge defines every variable Bootstrap components read, with token values;
//   4. the heat ramp and rank colours live only in js/palettes.js.
// Tokens are resolved with scripts/lib/design-tokens.js, the same helper other tests use.
// Not covered: whether a page actually uses the tokens — tests/design-rules.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readTokens, resolveVar } = require('../scripts/lib/design-tokens');
const Palettes = require('../js/palettes');

const ROOT = path.join(__dirname, '..');
const DS = fs.readFileSync(path.join(ROOT, 'css', 'design-system.css'), 'utf8');
const { base } = readTokens(DS);
const tok = (name) => resolveVar(`var(${name})`).trim().toLowerCase();

function rgb(color) {
    const c = color.trim().toLowerCase();
    let m = c.match(/^#([0-9a-f]{6})$/);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
    m = c.match(/^#([0-9a-f]{3})$/);
    if (m) return [...m[1]].map((h) => parseInt(h + h, 16)).concat(1);
    m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    throw new Error(`not a colour: ${color}`);
}
function over(fg, bg) {
    const [r, g, b, a] = rgb(fg);
    const [R, G, B] = rgb(bg);
    return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
}
function contrast(fg, bg) {
    const lum = ([r, g, b]) => {
        const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const l1 = lum(over(fg, bg));
    const l2 = lum(rgb(bg).slice(0, 3));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ── 1. CLAUDE.md and the tokens say the same thing ──────────────────────────────────────

test('the CLAUDE.md palette equals the tokens', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    const section = doc.slice(doc.indexOf('### Colors'), doc.indexOf('### Typography'));
    const pairs = {
        'Primary navy': '--ss-navy', 'Text': '--ss-text', 'Secondary text': '--ss-text-secondary', 'Links': '--ss-link',
        'Borders': '--ss-rule', 'Card backgrounds': '--ss-surface-alt', 'Page background': '--ss-surface',
        'Success': '--ss-success', 'Error': '--ss-error',
    };
    for (const [label, token] of Object.entries(pairs)) {
        const m = section.match(new RegExp(`- ${label}: (#[0-9a-fA-F]{6})`));
        assert.ok(m, `CLAUDE.md lists ${label}`);
        assert.equal(tok(token), m[1].toLowerCase(), `${label} ${m[1]} vs ${token}`);
    }
    const hover = section.match(/hover: (#[0-9a-fA-F]{6})/);
    assert.equal(tok('--ss-link-hover'), hover[1].toLowerCase());
});

// ── 2. Contrast a reader depends on ─────────────────────────────────────────────────────

test('text, links and state colours meet 4.5:1 on the surfaces they are used on', () => {
    const cases = [
        ['--ss-text', '--ss-surface'], ['--ss-text', '--ss-surface-alt'], ['--ss-text', '--ss-surface-hover'],
        ['--ss-text-secondary', '--ss-surface'],
        ['--ss-link', '--ss-surface'], ['--ss-link', '--ss-surface-alt'], ['--ss-link-hover', '--ss-surface'], ['--ss-link-visited', '--ss-surface'],
        ['--ss-heading', '--ss-surface'], ['--ss-success-strong', '--ss-surface'], ['--ss-success-strong', '--ss-success-soft'],
        ['--ss-error', '--ss-surface'], ['--ss-error', '--ss-error-soft'], ['--ss-warning', '--ss-surface'], ['--ss-warning', '--ss-warning-soft'],
        ['--ss-accent', '--ss-surface'], ['--ss-accent', '--ss-accent-soft'],
        ['--ss-on-navy', '--ss-navy'], ['--ss-on-navy-muted', '--ss-navy'], ['--ss-on-navy-link', '--ss-navy'],
        ['--ss-white', '--ss-success-strong'], ['--ss-white', '--ss-navy-hover'], ['--ss-white', '--ss-error'],
    ];
    for (const [fg, bg] of cases) {
        const ratio = contrast(tok(fg), tok(bg));
        assert.ok(ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
    }
    // The one known shortfall, both colours straight from the CLAUDE.md palette: secondary text
    // on the card background is 4.45:1. Pinned here so it cannot get any worse unnoticed; the
    // fix is the owner's call (#687078 would clear 4.5 on every surface).
    assert.ok(contrast(tok('--ss-text-secondary'), tok('--ss-surface-alt')) >= 4.44);
    // Tertiary is for placeholders, separators and icons only: non-text contrast, 3:1.
    assert.ok(contrast(tok('--ss-text-tertiary'), tok('--ss-surface')) >= 3);
    // And the documented exception really is one: #27ae60 is for fills, never text.
    assert.ok(contrast(tok('--ss-success'), tok('--ss-surface')) < 4.5);
});

test('the heat ramp puts readable ink on every step', () => {
    Palettes.HEAT.forEach((fill, i) => {
        const ratio = contrast(Palettes.HEAT_INK[i], fill);
        // The numerals the ramp carries are bold, and white ink on a step is held to the 3:1
        // of bold text: step 6 is white on the owner's judgement (js/palettes.js), 3.35:1.
        const floor = Palettes.HEAT_INK[i].toLowerCase() === '#ffffff' ? 3 : 4.5;
        assert.ok(ratio >= floor, `heat ${i + 1}: ${Palettes.HEAT_INK[i]} on ${fill} is ${ratio.toFixed(2)}:1`);
    });
    for (const [k, v] of Object.entries(Palettes.LANG)) {
        assert.ok(contrast(v.ink, v.fill) >= 4.5, `lang ${k}: ${v.ink} on ${v.fill}`);
    }
});

// ── 3. The Bootstrap bridge ─────────────────────────────────────────────────────────────

test('the Bootstrap bridge defines what Bootstrap components read, with token values', () => {
    const bridge = DS.slice(DS.indexOf('§2 BOOTSTRAP BRIDGE'), DS.indexOf('§3 BASE'));
    const vars = new Map([...bridge.matchAll(/(--bs-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().toLowerCase()]));
    const same = {
        '--bs-body-color': '--ss-text', '--bs-body-bg': '--ss-surface', '--bs-border-color': '--ss-rule',
        '--bs-link-color': '--ss-link', '--bs-link-hover-color': '--ss-link-hover', '--bs-primary': '--ss-navy',
        '--bs-secondary': '--ss-text-secondary', '--bs-success': '--ss-success-strong', '--bs-danger': '--ss-error',
        '--bs-warning': '--ss-warning', '--bs-dark': '--ss-navy', '--bs-light': '--ss-surface-alt',
        '--bs-heading-color': '--ss-heading', '--bs-border-radius': '--ss-radius', '--bs-border-radius-sm': '--ss-radius-sm',
        '--bs-border-radius-lg': '--ss-radius-lg', '--bs-box-shadow': '--ss-shadow',
    };
    for (const [bs, ss] of Object.entries(same)) {
        assert.ok(vars.has(bs), `${bs} missing from the bridge`);
        assert.equal(resolveVar(vars.get(bs)).replace(/\s+/g, ''), tok(ss).replace(/\s+/g, ''), `${bs} vs ${ss}`);
    }
    for (const name of ['primary', 'secondary', 'success', 'danger', 'warning', 'info', 'light', 'dark', 'body-color', 'link-color']) {
        const hex = resolveVar(vars.get(`--bs-${name}`) || '');
        const triplet = vars.get(`--bs-${name}-rgb`);
        assert.ok(triplet, `--bs-${name}-rgb missing`);
        assert.equal(triplet.replace(/\s+/g, ''), rgb(hex).slice(0, 3).join(','), `--bs-${name}-rgb`);
    }
    // No pill shapes and no radius above 8px, even through Bootstrap's own variables.
    for (const [k, v] of vars) if (/radius/.test(k)) assert.ok(parseFloat(resolveVar(v)) <= 8, `${k}: ${v}`);
    assert.ok(vars.get('--bs-body-font-family').includes('--ss-font-ui'));
});

// ── 4. One copy of the data palettes ────────────────────────────────────────────────────

test('the heat ramp and rank colours are written only in js/palettes.js', () => {
    const values = [...Palettes.HEAT, ...new Set(Palettes.RANKS.map((r) => r.color))]
        .filter((c) => !['#ff0000', '#0000ff', '#008000', '#808080'].includes(c.toLowerCase())); // too generic to police
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (!['node_modules', 'vendor', '.git', '.claude', 'posts', 'posts-old', 'img', 'pdf', 'public', 'deploy-backups'].includes(e.name)) walk(full); }
            else if (/\.(ejs|css|js)$/.test(e.name)) files.push(full);
        }
    };
    for (const d of ['views', 'css', 'js', 'lib']) walk(path.join(ROOT, d));
    for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.js')) files.push(path.join(ROOT, f));
    const offenders = [];
    for (const file of files) {
        const r = path.relative(ROOT, file);
        if (r === 'js/palettes.js' || r === 'css/bundle.css') continue;
        const src = fs.readFileSync(file, 'utf8').toLowerCase();
        for (const c of values) if (new RegExp(`${c.toLowerCase()}(?![0-9a-f])`).test(src)) offenders.push(`${r}: ${c}`);
    }
    assert.deepEqual(offenders, []);
    // And the generated CSS variables exist in the bundle.
    const bundle = fs.readFileSync(path.join(ROOT, 'css', 'bundle.css'), 'utf8');
    for (const [k, v] of Object.entries(Palettes.cssVariables())) assert.ok(bundle.includes(`${k}: ${v};`), k);
});

test('rankFor keeps the Codeforces tiers the community knows', () => {
    assert.equal(Palettes.rankFor(0).key, 'newbie');
    assert.equal(Palettes.rankFor(10).key, 'pupil');
    assert.equal(Palettes.rankFor(129).key, 'internationalMaster');
    assert.equal(Palettes.rankFor(130).key, 'grandmaster');
    assert.equal(Palettes.rankFor(10000).key, 'legendaryGrandmaster');
    assert.equal(Palettes.rankFor('not a number').key, 'newbie');
    assert.ok(base.has('--ss-navy'));
});
