#!/usr/bin/env node
// check-solution-structure.js — run js/solution-structure.js over every post and prove it is harmless.
//
// The structure transform wraps sections of a rendered solution in <section> blocks before the
// maths pass. A mistake there would not show up as an error: an unbalanced tag could swallow an
// answer, or a moved heading could split a $$…$$ span so a formula silently stops rendering. So
// for every post this renders the page body twice — plain and structured — through the same
// markdown and maths pipeline as post.js, and asserts:
//   * <section> and <div class="ss-answer"> tags balance;
//   * the number of rendered formulas (<mjx-container>) and images is identical;
//   * the visible text is identical apart from the documented edits (labels, the book number).
//
//   node scripts/check-solution-structure.js [postsDir=posts] [--verbose]
//
// Run it against a copy of the server's posts/ before deploying — that copy is the authoritative
// one, and the repo's lags behind (CLAUDE.md, Content Structure).

'use strict';

const fs = require('fs');
const path = require('path');
const { parseMarkdown, transformImageMarkdown } = require('../utils');
const { renderMathInHtml } = require('../mathRender');
const { structureSolution } = require('../js/solution-structure');

function pipeline(md) {
    let c = md.replace(/\*/g, '\\*').replace(/~/g, '\\~');
    c = transformImageMarkdown(c);
    let html = parseMarkdown(c);
    html = html.replace(/<em>/g, '_').replace(/<\/em>/g, '_');
    return html.replace(/\\\*/g, '*');
}

function count(re, s) { return (s.match(re) || []).length; }

function visibleText(html) {
    return html
        // the book number was a one-formula span ($2.1.32.$) and is now text: count it as that formula
        .replace(/<span class="ss-num">[\s\S]*?<\/span>/g, ' F ')
        .replace(/<mjx-container[\s\S]*?<\/mjx-container>/g, ' F ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        // section labels, in every spelling the posts use; the structured page normalises them
        .replace(/(у?сл?л?овие|условия|решение\s+и\s+ответ|решение|доказательство|(?:альтерна\S*|аналогичное|другое|второе|иное)\s+решение|ответы|ответ|литература|источники|problem\s+statement|statement|problem|condition|solution\s+and\s+answer|solution|proof|alternative\s+solution|another\s+solution|answers|answer|references|literature)\s*:?/gi, ' ')
        .replace(/[∗*:.,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function main() {
    const args = process.argv.slice(2);
    const verbose = args.includes('--verbose');
    const root = args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'posts');
    let files = 0; let failures = 0; let structured = 0; let answers = 0; let numbers = 0;
    for (const lang of ['ru', 'en']) {
        const dir = path.join(root, lang);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
            const name = f.replace(/\.md$/, '');
            const md = fs.readFileSync(path.join(dir, f), 'utf8');
            files++;
            const plainHtml = pipeline(md);
            const structHtml = structureSolution(plainHtml, { lang, name });
            const a = renderMathInHtml(plainHtml);
            const b = renderMathInHtml(structHtml);
            const problems = [];
            if (count(/<section\b/g, structHtml) !== count(/<\/section>/g, structHtml)) problems.push('unbalanced <section>');
            if (count(/class="ss-answer"/g, structHtml) > count(/<\/div>/g, structHtml) - count(/<\/div>/g, plainHtml)) problems.push('unbalanced answer box');
            const fa = count(/<mjx-container/g, a);
            const fb = count(/<mjx-container/g, b) + count(/class="ss-num"/g, b);
            if (fa !== fb) problems.push(`formulas ${fa} → ${fb}`);
            const ia = count(/<img\b/g, a); const ib = count(/<img\b/g, b);
            if (ia !== ib) problems.push(`images ${ia} → ${ib}`);
            const ta = visibleText(a); const tb = visibleText(b);
            if (ta !== tb) {
                const la = ta.split(' '); const lb = tb.split(' ');
                let k = 0; while (k < la.length && la[k] === lb[k]) k++;
                problems.push(`text differs near "${la.slice(Math.max(0, k - 4), k + 6).join(' ')}" / "${lb.slice(Math.max(0, k - 4), k + 6).join(' ')}"`);
            }
            if (structHtml !== plainHtml) structured++;
            answers += count(/class="ss-answer"/g, structHtml);
            numbers += count(/class="ss-num"/g, structHtml);
            if (structureSolution(structHtml, { lang, name }) !== structHtml) problems.push('not idempotent');
            if (problems.length) {
                failures++;
                console.log(`FAIL ${lang}/${name}: ${problems.join('; ')}`);
            } else if (verbose) {
                console.log(`ok   ${lang}/${name}`);
            }
        }
    }
    console.log(`${files} posts, ${structured} structured, ${answers} answer boxes, ${numbers} book numbers, ${failures} failures`);
    process.exit(failures ? 1 : 0);
}

main();
