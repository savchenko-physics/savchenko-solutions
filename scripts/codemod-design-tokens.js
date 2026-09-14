#!/usr/bin/env node
// codemod-design-tokens.js — move literal style values onto the design tokens.
//
// Why: in September 2026 the site's CSS lived in ~64 inline <style> blocks and 688 style=""
// attributes across the templates, with 39 font stacks, 110 font sizes and 291 colours. Hand
// editing that is how it drifted in the first place, so the migration is mechanical and
// reviewable: this script finds every declaration, asks scripts/lib/design-token-rules.js what
// token the literal becomes, and either prints the plan (default) or applies it (--write).
//
//   node scripts/codemod-design-tokens.js                      dry run over all live styles
//   node scripts/codemod-design-tokens.js --rules=family,size  only some rule families
//   node scripts/codemod-design-tokens.js --write views/x.ejs  apply to named files
//   node scripts/codemod-design-tokens.js --check              exit 1 if governed literals remain
//   node scripts/codemod-design-tokens.js --review             print the declarations left for a person
//
// Never touched: selectors; :root and custom-property definitions; anything between
// /* ss-codemod: off */ and /* ss-codemod: on */; declarations that contain EJS tags or ${…}.
// Running it twice changes nothing.

'use strict';

const fs = require('fs');
const path = require('path');
const R = require('./lib/design-token-rules');

const ROOT = path.join(__dirname, '..');
const DEAD = new Set(['eng_page_old', 'post_en', 'post_ru', 'solutions_post', 'search_results', 'add_markdown', 'post', 'profile',
    'default/modern_header', 'default/header_mobile', 'default/footer_en', 'default/footer_ru', 'partials/brainstorm_block']);
const ALL_RULES = ['family', 'size', 'weight', 'color', 'radius', 'shadow', 'spacing'];

function liveFiles() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.ejs')) {
                const rel = path.relative(path.join(ROOT, 'views'), full).replace(/\.ejs$/, '');
                if (!DEAD.has(rel)) out.push(full);
            }
        }
    };
    walk(path.join(ROOT, 'views'));
    out.push(path.join(ROOT, 'css', 'design-system.css'), path.join(ROOT, 'css', 'main_page.css'));
    return out;
}

// Replace EJS tags with same-length filler so offsets stay valid and nothing inside them is parsed.
function maskEjs(text) {
    return text.replace(/<%[\s\S]*?%>/g, (m) => ''.repeat(m.length));
}

function ruleFor(prop) {
    const p = prop.toLowerCase();
    if (p === 'font-family') return 'family';
    if (p === 'font-size') return 'size';
    if (p === 'font-weight') return 'weight';
    if (/^(color|background|background-color|border|border-color|border-(top|right|bottom|left)|border-(top|right|bottom|left)-color|outline|outline-color|fill|stroke|caret-color|text-decoration-color|-webkit-text-fill-color)$/.test(p)) return 'color';
    if (/^border(-(top|bottom)-(left|right))?-radius$/.test(p)) return 'radius';
    if (p === 'box-shadow') return 'shadow';
    if (/^(padding|margin)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(gap|row-gap|column-gap)$/.test(p)) return 'spacing';
    return null;
}

function decide(rule, prop, value, selector) {
    switch (rule) {
        case 'family': { const v = R.mapFontFamily(value); return v ? { value: v } : null; }
        case 'size': { const v = R.mapFontSize(value, selector); return v ? { value: v } : null; }
        case 'weight': { const v = R.mapFontWeight(value, selector); return v ? { value: v } : null; }
        case 'color': return R.mapColorValue(value, prop, selector);
        case 'radius': return R.mapRadius(value, selector);
        case 'shadow': return R.mapShadow(value);
        case 'spacing': return R.mapSpacing(value);
        default: return null;
    }
}

// Walk a CSS text (block or inline declaration list) and collect edits.
function scanCss(css, masked, baseOffset, opts, ctx, inlineSelector = null) {
    const edits = [];
    const reviews = [];
    const n = css.length;
    let i = 0;
    const stack = [];            // preludes of open blocks
    let segStart = 0;
    let off = false;
    const inline = inlineSelector !== null;
    const pushDecl = (start, end) => {
        const raw = css.slice(start, end);
        const mraw = masked.slice(start, end);
        const colon = mraw.indexOf(':');
        if (colon < 0) return;
        const prop = raw.slice(0, colon).trim();
        if (!prop || prop.startsWith('--') || /[^a-zA-Z-]/.test(prop)) return;
        const prelude = inline ? inlineSelector : (stack.filter((s) => !s.startsWith('@')).pop() || '');
        // Every declaration, for tests/design-rules.test.js: what is written, where, and whether it
        // sits inside an ss-codemod: off region (the system's own definitions).
        if (opts.visit) {
            opts.visit({
                file: ctx.file, line: lineOf(ctx.text, baseOffset + start), selector: prelude, prop: prop.toLowerCase(),
                value: css.slice(start + colon + 1, end).trim(), inline, off,
                media: stack.filter((s) => s.startsWith('@media')).join(' '),
                dynamic: /\u0001/.test(masked.slice(start + colon + 1, end)) || /\$\{/.test(raw),
            });
        }
        const rule = ruleFor(prop);
        if (!rule || !opts.rules.includes(rule)) return;
        if (!inline && /(^|,)\s*(:root|\[data-bs-theme)/.test(prelude)) return;
        if (off) return;
        const valueStart = start + colon + 1;
        let value = css.slice(valueStart, end);
        const mvalue = masked.slice(valueStart, end);
        if (//.test(mvalue) || /\$\{/.test(value) || /'\s*\+|\+\s*'/.test(value)) {
            reviews.push({ ...ctx, line: lineOf(ctx.text, baseOffset + start), selector: prelude, prop, value: value.trim(), why: 'dynamic' });
            return;
        }
        const lead = value.match(/^\s*/)[0];
        const trail = value.match(/\s*$/)[0];
        const v = value.trim();
        if (!v) return;
        const res = decide(rule, prop, v, prelude);
        if (!res) return;
        if (res.review && !res.value) {
            reviews.push({ ...ctx, line: lineOf(ctx.text, baseOffset + start), selector: prelude, prop, value: v, why: rule });
            return;
        }
        if (res.value && res.value !== v) {
            edits.push({ start: baseOffset + valueStart, end: baseOffset + end, text: lead + res.value + trail, rule, prop, from: v, to: res.value, selector: prelude });
        }
        if (res.review) reviews.push({ ...ctx, line: lineOf(ctx.text, baseOffset + start), selector: prelude, prop, value: v, why: rule + ' partly' });
    };
    while (i < n) {
        const c = css[i];
        if (c === '/' && css[i + 1] === '*') {
            const j = css.indexOf('*/', i + 2);
            const comment = css.slice(i, j < 0 ? n : j + 2);
            if (/ss-codemod:\s*off/.test(comment)) off = true;
            if (/ss-codemod:\s*on/.test(comment)) off = false;
            i = j < 0 ? n : j + 2;
            if (!inline && css.slice(segStart, i).trim().replace(/\/\*[\s\S]*?\*\//g, '').trim() === '') segStart = i;
            continue;
        }
        if (c === '"' || c === "'") {
            const j = css.indexOf(c, i + 1);
            i = j < 0 ? n : j + 1;
            continue;
        }
        if (!inline && c === '{') {
            const prelude = css.slice(segStart, i).replace(/\/\*[\s\S]*?\*\//g, '').trim();
            stack.push(prelude);
            i++; segStart = i;
            continue;
        }
        if (!inline && c === '}') {
            if (stack.length && !stack[stack.length - 1].startsWith('@')) pushDecl(segStart, i);
            stack.pop();
            i++; segStart = i;
            continue;
        }
        if (c === ';') {
            if (inline || (stack.length && !stack[stack.length - 1].startsWith('@'))) pushDecl(segStart, i);
            i++; segStart = i;
            continue;
        }
        i++;
    }
    if (inline && segStart < n) pushDecl(segStart, n);
    return { edits, reviews };
}

function lineOf(text, offset) {
    let line = 1;
    for (let k = 0; k < offset && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
    return line;
}

function processFile(file, opts) {
    const text = fs.readFileSync(file, 'utf8');
    const masked = file.endsWith('.ejs') ? maskEjs(text) : text;
    const ctx = { file: path.relative(ROOT, file), text };
    let edits = [];
    let reviews = [];
    if (file.endsWith('.css')) {
        const r = scanCss(text, masked, 0, opts, ctx);
        edits = r.edits; reviews = r.reviews;
    } else {
        // <style> blocks
        const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
        let m;
        const styleRanges = [];
        while ((m = styleRe.exec(masked))) {
            const innerStart = m.index + m[0].indexOf('>') + 1;
            const innerEnd = innerStart + m[1].length;
            styleRanges.push([innerStart, innerEnd]);
            const r = scanCss(text.slice(innerStart, innerEnd), masked.slice(innerStart, innerEnd), innerStart, opts, ctx);
            edits.push(...r.edits); reviews.push(...r.reviews);
        }
        // style="…" attributes (also inside script strings), outside <style> blocks
        const attrRe = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/g;
        while ((m = attrRe.exec(masked))) {
            const valStart = m.index + m[0].indexOf(m[1]) + 1;
            const valEnd = valStart + m[2].length;
            if (styleRanges.some(([a, b]) => valStart >= a && valStart < b)) continue;
            if (m[2].length > 600 || /[<>]/.test(m[2])) continue;
            // pseudo-selector from the surrounding tag: tag name + classes
            const tagStart = masked.lastIndexOf('<', m.index);
            const tagText = masked.slice(tagStart, valEnd + 1);
            const tag = (tagText.match(/^<([a-zA-Z0-9-]+)/) || [])[1] || '';
            const cls = (tagText.match(/\sclass\s*=\s*["']([^"']*)["']/) || [])[1] || '';
            const sel = `${tag}${cls ? '.' + cls.trim().split(/\s+/).join('.') : ''} [inline]`;
            const r = scanCss(text.slice(valStart, valEnd), masked.slice(valStart, valEnd), valStart, opts, ctx, sel);
            edits.push(...r.edits); reviews.push(...r.reviews);
        }
    }
    return { file, text, edits, reviews };
}

function main() {
    const args = process.argv.slice(2);
    const opts = {
        write: args.includes('--write'),
        check: args.includes('--check'),
        review: args.includes('--review'),
        verbose: args.includes('--verbose'),
        rules: ALL_RULES,
    };
    const r = args.find((a) => a.startsWith('--rules='));
    if (r) opts.rules = r.slice(8).split(',');
    const named = args.filter((a) => !a.startsWith('--'));
    const files = named.length ? named.map((f) => path.resolve(f)) : liveFiles();
    const totals = {};
    let editCount = 0;
    const allReviews = [];
    for (const f of files) {
        const res = processFile(f, opts);
        for (const e of res.edits) totals[e.rule] = (totals[e.rule] || 0) + 1;
        editCount += res.edits.length;
        allReviews.push(...res.reviews);
        if (opts.verbose) for (const e of res.edits) console.log(`${path.relative(ROOT, f)}:${lineOf(res.text, e.start)}  ${e.selector.slice(0, 50)}  ${e.prop}: ${e.from} → ${e.to}`);
        if (opts.write && res.edits.length) {
            let out = res.text;
            const sorted = res.edits.sort((a, b) => b.start - a.start);
            for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
            fs.writeFileSync(f, out);
        }
    }
    if (opts.review) for (const rv of allReviews) console.log(`REVIEW ${rv.file}:${rv.line}  [${rv.why}] ${String(rv.selector).slice(0, 60)}  ${rv.prop}: ${rv.value.slice(0, 90)}`);
    console.log(`${opts.write ? 'applied' : 'would apply'} ${editCount} edits across ${files.length} files`, totals, `review: ${allReviews.length}`);
    if (opts.check && editCount > 0) process.exit(1);
}

if (require.main === module) main();
module.exports = { processFile, scanCss, liveFiles, maskEjs, ruleFor };
