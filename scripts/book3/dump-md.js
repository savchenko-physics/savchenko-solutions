#!/usr/bin/env node
// Dump the statement section of every posts/<lang>/*.md through the same splitter
// scripts/build-statements.js uses, so the book comparison sees exactly what the site
// would store. Output: src/database/book3/md_<lang>.json  { name: { text, mdStarred, figures } }
const fs = require('fs');
const path = require('path');
const { markdownStatement } = require('../build-statements');
const ROOT = path.join(__dirname, '..', '..');
for (const lang of ['ru', 'en']) {
    const dir = path.join(ROOT, 'posts', lang);
    const out = {};
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md')) continue;
        const name = file.slice(0, -3);
        if (!/^\d{1,2}\.\d{1,2}\.\d{1,3}$/.test(name)) continue;
        const parsed = markdownStatement(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (!parsed || !parsed.text) continue;
        const figures = [...parsed.text.matchAll(/!\[[^\]]*\]\(\.\.\/\.\.\/img\/([^)/]+)\/([^)]+)\)/g)].map((f) => `/img/${f[1]}/${f[2]}`);
        out[name] = { ...parsed, figures };
    }
    fs.writeFileSync(path.join(ROOT, 'src/database/book3', `md_${lang}.json`), JSON.stringify(out, null, 1));
    console.log(`${lang}: ${Object.keys(out).length} statements`);
}
