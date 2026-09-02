#!/usr/bin/env node
/**
 * Render every candidate statement exactly as the site does and report the ones MathJax
 * rejects.
 *
 *   node scripts/book3/render-check.js            # RU from statements_ru.json + EN from main.tex
 *
 * A formula MathJax cannot parse is left as raw "$...$" text by mathRender.js (tex2svg
 * returns null), and a formula it can parse but not typeset comes back as an SVG carrying
 * data-mjx-error. Both are reported, with the offending TeX. Output:
 * src/database/book3/render_errors.json — the RU problem names that fail, which
 * scripts/book3/assemble.py then keeps away from the 'md' shortcut.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { parseMarkdown, transformImageMarkdown } = require(path.join(ROOT, 'utils'));
const { renderMathInHtml } = require(path.join(ROOT, 'mathRender'));
const { englishStatements } = require(path.join(ROOT, 'scripts', 'build-statements'));

const W = path.join(ROOT, 'src/database/book3');
const ru = JSON.parse(fs.readFileSync(path.join(W, 'statements_ru.json'), 'utf8'));
const en = englishStatements();

function check(text) {
    const html = renderMathInHtml(parseMarkdown(transformImageMarkdown(text)));
    const problems = [];
    for (const m of html.matchAll(/data-mjx-error="([^"]*)"/g)) problems.push(`mjx: ${m[1]}`);
    // AllPackages includes noundefined: an unknown macro (\tg, \ctg) is not an error but
    // red literal text, marked in the SVG by fill="red".
    if (/fill="red"/.test(html)) {
        const macros = [...text.matchAll(/\\([A-Za-z]+)/g)].map((m) => m[1]);
        problems.push(`undefined macro among: ${[...new Set(macros)].join(' ')}`);
    }
    // Leftover delimiters in text nodes = a formula tex2svg refused.
    const textOnly = html.replace(/<[^>]+>/g, ' ');
    const left = textOnly.match(/\$[^$]{1,120}\$/g);
    if (left) problems.push(...left.map((f) => `unrendered: ${f}`));
    return problems;
}

const failures = { ru: {}, en: {} };
for (const [name, s] of Object.entries(ru)) {
    const p = check(s.text);
    if (p.length) failures.ru[name] = { source: s.source, problems: p };
}
for (const [name, e] of en) {
    const p = check(e.text);
    if (p.length) failures.en[name] = { problems: p };
}
for (const lang of ['ru', 'en']) {
    const names = Object.keys(failures[lang]);
    console.log(`\n  ${lang}: ${names.length} statements with render problems`);
    for (const n of names.slice(0, 40)) {
        const f = failures[lang][n];
        console.log(`    ${n}${f.source ? ` [${f.source}]` : ''}: ${f.problems.slice(0, 2).join(' | ').slice(0, 160)}`);
    }
}
fs.writeFileSync(path.join(W, 'render_errors.json'), JSON.stringify(Object.keys(failures.ru), null, 1));
fs.writeFileSync(path.join(W, 'render_errors_detail.json'), JSON.stringify(failures, null, 1));
