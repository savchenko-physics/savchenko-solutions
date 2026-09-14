// design-tokens.js — read the token system back out of css/design-system.css.
//
// The tokens are written once, as CSS custom properties in §1 of design-system.css; tests and
// scripts that need their values (contrast checks, "is this radius at most 8px?") resolve them
// here instead of keeping a second copy that could drift.
//
//   const { readTokens, resolveVar, toPx } = require('./scripts/lib/design-tokens');
//   resolveVar('var(--ss-radius-lg)')            → '8px'
//   toPx('var(--ss-text-prose)', { wide: true }) → 20
'use strict';

const fs = require('fs');
const path = require('path');

const DESIGN_SYSTEM = path.join(__dirname, '..', '..', 'css', 'design-system.css');

function declarations(block) {
    const out = new Map();
    const body = block.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
    return out;
}

/**
 * The §1 tokens: `base` from the first `:root { … }`, `wide` = base plus every
 * `@media (min-width: …) { :root { … } }` override in §1b (the roles that grow on wider screens).
 */
function readTokens(css) {
    const text = css === undefined ? fs.readFileSync(DESIGN_SYSTEM, 'utf8') : css;
    const start = text.search(/(^|\n):root\s*\{/);
    if (start < 0) throw new Error('design-system.css has no :root block');
    const open = text.indexOf('{', start);
    const close = text.indexOf('\n}', open);
    const base = declarations(text.slice(open + 1, close));
    const wide = new Map(base);
    const media = /@media\s*\(min-width:\s*(\d+)px\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/g;
    for (const m of text.slice(close).matchAll(media)) {
        for (const [k, v] of declarations(m[2])) wide.set(k, v);
    }
    return { base, wide };
}

let cached = null;
function tokens() {
    if (!cached) cached = readTokens();
    return cached;
}

/** Replace every var(--name[, fallback]) with its token value, recursively. Unknown names use the fallback. */
function resolveVar(value, opts = {}) {
    const map = opts.tokens || (opts.wide ? tokens().wide : tokens().base);
    let v = String(value);
    for (let guard = 0; guard < 20 && v.includes('var('); guard++) {
        v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (all, name, fallback) => {
            if (map.has(name)) return map.get(name);
            return fallback !== undefined ? fallback.trim() : all;
        });
    }
    return v;
}

/** A resolved length in px (rem and em at 16px), or NaN. */
function toPx(value, opts = {}) {
    const v = resolveVar(value, opts).trim();
    const m = v.match(/^(-?[\d.]+)(px|rem|em)?$/);
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n;
}

module.exports = { DESIGN_SYSTEM, readTokens, resolveVar, toPx };
