// The design rules, checked on every declaration a live page carries.
//
// CLAUDE.md's Design System lists the rules (no gradients, one shadow, radius at most 8px, the
// palette), and in September 2026 the site broke nearly all of them: 110 font sizes, 23
// gradients, 28 heavy shadows, 55 radii above 8px, 34 inputs below 16px, pill-shaped buttons.
// The type unification moved every value onto the tokens in css/design-system.css, mostly by
// scripts/codemod-design-tokens.js. This file keeps it that way. It walks the same declarations
// the codemod does — every <style> block and style="" attribute of every live template, plus
// design-system.css and main_page.css, skipping the ss-codemod: off regions where the tokens
// themselves are defined — and checks:
//   1. font-family, font-size and font-weight are tokens (sizes: one of the ten), or allowlisted;
//   2. no gradients but hard-stop half fills; the one shadow; radius at most 8px or 50%;
//      no rounded-pill / rounded-4 in markup;
//   3. ratchets that can only go down: style attributes, !important, outline:none outside
//      :focus:not(:focus-visible), spacing off the 4px grid, non-standard breakpoints.
// When a ratchet fails because you removed some, lower the number in RATCHETS; when it fails
// because you added some, use a token or a class instead. Allowlist entries carry their reason.
// Not covered: whether the page looks right — scripts/qa/type_audit.py renders it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { processFile, liveFiles } = require('../scripts/codemod-design-tokens');
const { toPx, resolveVar } = require('../scripts/lib/design-tokens');

const ROOT = path.join(__dirname, '..');

// [file, selector regex, property, reason]
const ALLOW = [
    ['views/edit_post.ejs', /\.symbol-palette-item/, 'font-family', 'maths symbol palette shows STIX Two Math glyphs'],
    ['views/tools/latex.ejs', /\.(template|symbol)-btn/, 'font-family', 'maths symbol palette shows STIX Two Math glyphs'],
    ['views/contributor_page.ejs', /^body$/, 'font-size', 'printable contributor record, set in points for paper'],
    ['views/edit_post.ejs', /^\.CodeMirror$/, 'font-size', 'var(--font-size) is the editor\'s own token, = --ss-fs-14'],
    ['views/contributors_ranking.ejs', /\.geo-legend \.bar/, 'background', 'continuous colour scale of the map legend (data)'],
];

function allowed(d) {
    return ALLOW.some(([file, sel, prop]) => d.file === file && sel.test(d.selector.replace(/\s+/g, ' ').trim()) && d.prop === prop);
}

let cache = null;
function declarations() {
    if (cache) return cache;
    const out = [];
    for (const f of liveFiles()) processFile(f, { rules: [], visit: (d) => out.push(d) });
    cache = out.filter((d) => !d.off && !d.dynamic);
    return cache;
}
const bare = (v) => v.replace(/\s*!important\s*$/i, '').trim();
const where = (d) => `${d.file}:${d.line} ${d.selector.replace(/\s+/g, ' ').slice(0, 50)} { ${d.prop}: ${d.value.slice(0, 60)} }`;

// ── 1. Type ─────────────────────────────────────────────────────────────────────────────

test('every font-family is a family token', () => {
    const bad = declarations().filter((d) => d.prop === 'font-family' && !allowed(d)
        && !/^(var\(--ss-font-(text|ui|mono|display|wordmark)\)|inherit)$/.test(bare(d.value)));
    assert.deepEqual(bad.map(where), []);
});

test('every font-size is one of the ten sizes or a role token', () => {
    const bad = declarations().filter((d) => d.prop === 'font-size' && !allowed(d)
        && !/^(var\(--ss-fs-(12|13|14|16|18|20|24|28|32|40)\)|var\(--ss-text-[a-z0-9-]+\)|inherit)$/.test(bare(d.value)));
    assert.deepEqual(bad.map(where), []);
    // And the role tokens themselves resolve onto the scale, at both widths.
    const scale = new Set([12, 13, 14, 16, 18, 20, 24, 28, 32, 40]);
    const roles = ['label', 'meta', 'ui', 'body', 'input', 'lead', 'h3', 'h2', 'h1', 'display', 'title', 'prose', 'prose-small', 'wordmark'];
    for (const role of roles) {
        for (const wide of [false, true]) {
            const px = toPx(`var(--ss-text-${role})`, { wide });
            assert.ok(scale.has(px), `--ss-text-${role} = ${px}px ${wide ? '(≥768px)' : ''}`);
        }
    }
    assert.equal(toPx('var(--ss-text-input)'), 16, 'inputs stay at 16px, or iOS zooms on focus');
});

test('every font-weight is a weight the fonts actually have', () => {
    const bad = declarations().filter((d) => d.prop === 'font-weight' && !allowed(d)
        && !/^(var\(--ss-fw-(regular|strong|text-bold)\)|400|600|700|normal|inherit)$/.test(bare(d.value)));
    assert.deepEqual(bad.map(where), []);
});

// ── 2. Shape ────────────────────────────────────────────────────────────────────────────

test('no gradients, except hard-stop half fills that mark a language', () => {
    const halfFill = /^linear-gradient\(to (right|bottom), (#[0-9a-f]{6}|var\([^)]+\)) 0 50%, (#[0-9a-f]{6}|var\([^)]+\)) 50% 100%\)$/i;
    const bad = declarations().filter((d) => /gradient\(/.test(d.value) && !allowed(d) && !halfFill.test(bare(d.value)));
    assert.deepEqual(bad.map(where), []);
});

test('the one shadow, or a focus ring', () => {
    const bad = declarations().filter((d) => d.prop === 'box-shadow' && !allowed(d)
        && !/^(none|var\(--ss-shadow\)|0 0 0 [\d.]+(px|rem) .+|inset .+)$/.test(bare(d.value)));
    assert.deepEqual(bad.map(where), []);
});

test('corner radius at most 8px, 50% for round things', () => {
    const bad = declarations().filter((d) => /radius$/.test(d.prop) && !allowed(d)).filter((d) => {
        const parts = resolveVar(bare(d.value)).split(/[\s/]+/).filter(Boolean);
        return parts.some((p) => !(p === '50%' || p === 'inherit' || p === '0' || toPx(p) <= 8));
    });
    assert.deepEqual(bad.map(where), []);
});

test('no pill or oversized Bootstrap rounding classes in markup', () => {
    const offenders = [];
    for (const f of liveFiles().filter((x) => x.endsWith('.ejs'))) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/class=["'][^"']*\b(rounded-pill|rounded-4|rounded-5)\b/g)) offenders.push(`${path.relative(ROOT, f)}: ${m[1]}`);
    }
    assert.deepEqual(offenders, []);
});

// ── 3. Ratchets ─────────────────────────────────────────────────────────────────────────

// Counts on 2026-09-14, when the type unification shipped (PRINT_RATCHETS=1 prints today's).
// Lower them as the work continues; never raise them. Before the unification the templates
// carried 688 style attributes, 28 heavy shadows and 23 gradients.
const RATCHETS = {
    styleAttributeDeclarations: 1094,
    important: 100,
    outlineNoneOutsideFocusVisible: 38,
    spacingOffGrid: 3,
    nonStandardBreakpoints: 27,
};

function measure() {
    const all = declarations();
    const counts = {};
    counts.styleAttributeDeclarations = all.filter((d) => d.inline).length;
    counts.important = all.filter((d) => /!important/i.test(d.value)).length;
    counts.outlineNoneOutsideFocusVisible = all.filter((d) => d.prop === 'outline' && /^(none|0)\b/.test(bare(d.value))
        && !/:focus:not\(:focus-visible\)/.test(d.selector)).length;
    counts.spacingOffGrid = all.filter((d) => /^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(d.prop)).filter((d) => {
        return bare(d.value).split(/\s+/).some((p) => {
            const m = p.match(/^(-?[\d.]+)px$/);
            if (!m) return false;
            const n = Math.abs(parseFloat(m[1]));
            return n > 3 && n % 4 !== 0;
        });
    }).length;
    const media = new Set();
    for (const d of all) if (d.media) media.add(`${d.file}|${d.media}`);
    counts.nonStandardBreakpoints = [...media].filter((k) => {
        const widths = [...k.matchAll(/(min|max)-width:\s*([\d.]+)px/g)].map((m) => [m[1], parseFloat(m[2])]);
        return widths.some(([kind, w]) => kind === 'min' ? ![576, 768, 992, 1200].includes(w) : ![575, 575.98, 767, 767.98, 768, 991, 991.98, 1199, 1199.98].includes(w));
    }).length;
    return counts;
}

test('ratchets: nothing grows back', () => {
    const now = measure();
    if (process.env.PRINT_RATCHETS) console.log(JSON.stringify(now));
    for (const [k, max] of Object.entries(RATCHETS)) assert.ok(now[k] <= max, `${k}: ${now[k]} > ${max}`);
});

// ── The rules themselves ────────────────────────────────────────────────────────────────

test('the checks catch what they are meant to catch, on real lines from before the unification', () => {
    const d = (prop, value, selector = '.x') => ({ file: 'views/x.ejs', line: 1, selector, prop, value, inline: false });
    const fam = (v) => /^(var\(--ss-font-(text|ui|mono|display|wordmark)\)|inherit)$/.test(bare(v));
    assert.equal(fam("'Roboto', sans-serif"), false);                     // 36 templates' body font
    assert.equal(fam('var(--ss-font-ui)'), true);
    const size = (v) => /^(var\(--ss-fs-(12|13|14|16|18|20|24|28|32|40)\)|var\(--ss-text-[a-z0-9-]+\)|inherit)$/.test(bare(v));
    assert.equal(size('15px'), false);
    assert.equal(size('var(--ss-fs-15)'), false);
    assert.equal(size('var(--ss-fs-14) !important'), true);
    const radiusOk = (v) => resolveVar(v).split(/[\s/]+/).every((p) => p === '50%' || p === '0' || toPx(p) <= 8);
    assert.equal(radiusOk('25px'), false);                               // the header's old search box
    assert.equal(radiusOk('var(--ss-radius) var(--ss-radius) 0 0'), true);
    assert.equal(radiusOk('50%'), true);
    assert.equal(allowed(d('font-family', "'STIX Two Math', serif", '.symbol-btn')), false, 'allowlist is per file');
});
