// Page titles never contain an em dash, en dash, colon or semicolon.
//
// The owner's rule since 2026-09-12. Before it, every solution page was titled
// "Problem 1.1.1 Solution — Kinematics | Savchenko Solutions", 36 templates hand-wrote
// " — Savchenko Solutions", a semicolon in sections.csv reached every 14.2 title, and
// forum topics arrived as "Discussion: Problem 1.2.3". A title is what a search result and
// a link preview show, so it is the first thing anyone reads of a page.
//
// Titles are built with docTitle(...parts), which joins with " | ", and any single piece
// of text, whatever a database row or a person typed, goes through titleText()
// (lib/pageTitle.js, both exposed to templates as app.locals). This file checks:
//   1. the helpers, on the real offenders;
//   2. every solution-page title the site can produce, from both section CSVs;
//   3. the template SOURCE of every <title>, og:title and twitter:title under views/,
//      sandbox/views/ and public/: literal text must be clean, and every computed value
//      must be exactly one docTitle(...) or titleText(...) call. Source, not rendered
//      HTML, because EJS's own escaping writes semicolons (&#39;). Dead templates are
//      checked too: it is cheaper than keeping a skip list honest;
//   4. the locale strings that end up in titles.
//
// Not covered: titles set from JavaScript at runtime (nothing sets document.title today).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { titleText, docTitle, solutionTitle } = require('../lib/pageTitle');

const ROOT = path.join(__dirname, '..');
const BANNED = /[—–:;]/;

function walk(dir, exts, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, exts, out);
        else if (exts.includes(path.extname(e.name))) out.push(full);
    }
    return out;
}

// ── 1. The helpers ──────────────────────────────────────────────────────────────────────

test('titleText rewrites the punctuation the owner banned, on real titles', () => {
    const cases = [
        ['IPhO Preparation: Thermodynamics', 'IPhO Preparation, Thermodynamics'],                // study_paths seed
        ['Добавить сборник Овчинкина–Прута', 'Добавить сборник Овчинкина-Прута'],                // feedback board
        ['Исправленное издание задачника: список опечаток и ошибок', 'Исправленное издание задачника, список опечаток и ошибок'],
        ['The slowing down of time and the reduction in the size of bodies in motion; the Lorentz Transformations',
            'The slowing down of time and the reduction in the size of bodies in motion, the Lorentz Transformations'], // sections.csv:74
        ['Physics Tools — Free Utilities for Students', 'Physics Tools, Free Utilities for Students'],
        ['Discussion: Problem 1.2.3', 'Discussion, Problem 1.2.3'],
        ['Contest July 27–30', 'Contest July 27-30'],
        ['Registration closes 09:00 UTC', 'Registration closes 09.00 UTC'],
        ['Study strategies for Savchenko: where to start?', 'Study strategies for Savchenko, where to start?'],
        ['Edit: ', 'Edit'],
        ['  spaced   out  ', 'spaced out'],
    ];
    for (const [input, expected] of cases) {
        assert.equal(titleText(input), expected, input);
        assert.doesNotMatch(titleText(input), BANNED, input);
    }
});

test('titleText is idempotent and total', () => {
    const inputs = ['a — b: c; d – e', '12:30 — 13:45', ':;—–', '', null, undefined, 42, 'Уже чистый заголовок'];
    for (const input of inputs) {
        const once = titleText(input);
        assert.equal(typeof once, 'string');
        assert.equal(titleText(once), once, String(input));
        assert.doesNotMatch(once, BANNED, String(input));
    }
});

test('docTitle joins cleaned parts with " | " and drops empty ones', () => {
    assert.equal(docTitle('Messages', 'Savchenko Solutions'), 'Messages | Savchenko Solutions');
    assert.equal(docTitle('Blog', '', null, 'Savchenko Solutions'), 'Blog | Savchenko Solutions');
    assert.equal(docTitle(['Topic: X', 'Discussion'], 'Savchenko Solutions'), 'Topic, X | Discussion | Savchenko Solutions');
});

// ── 2. Solution pages ───────────────────────────────────────────────────────────────────

test('every solution-page title is clean, for every section in both languages', () => {
    const { getProblemBreadcrumbParts } = require('../parents');
    for (const lang of ['en', 'ru']) {
        const csv = path.join(ROOT, lang === 'ru' ? 'src/ru/database/sections.csv' : 'src/database/sections.csv');
        const sections = fs.readFileSync(csv, 'utf8').replace(/^﻿/, '').trim().split('\n').map((l) => l.split(',')[0].trim());
        assert.ok(sections.length > 70, `${lang}: expected the 77 sections, found ${sections.length}`);
        for (const section of sections) {
            const name = `${section}.1`;
            const crumbs = getProblemBreadcrumbParts(name, lang);
            const title = solutionTitle(name, crumbs && crumbs.sectionTitle, lang);
            assert.doesNotMatch(title, BANNED, `${lang} ${name}: ${title}`);
        }
    }
    assert.equal(
        solutionTitle('14.2.1', 'The slowing down of time and the reduction in the size of bodies in motion; the Lorentz Transformations', 'en'),
        'Problem 14.2.1 Solution | The slowing down of time and the reduction in the size of bodies in motion, the Lorentz Transformations | Savchenko Solutions'
    );
    assert.equal(solutionTitle('1.1.1', 'Движение с постоянной скоростью', 'ru'), 'Задача 1.1.1 Решение | Движение с постоянной скоростью | Решения Савченко');
});

// ── 3. Template source ──────────────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', colon: ':', semi: ';' };
function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return Object.prototype.hasOwnProperty.call(ENTITIES, body.toLowerCase()) ? ENTITIES[body.toLowerCase()] : m;
    });
}

/** True when `expr` is exactly one call to docTitle(...) or titleText(...), nothing around it. */
function isSingleTitleCall(expr) {
    const e = expr.trim().replace(/;$/, '').trim();
    const m = e.match(/^(docTitle|titleText)\s*\(/);
    if (!m) return false;
    let depth = 0;
    let quote = null;
    for (let i = m[0].length - 1; i < e.length; i++) {
        const ch = e[i];
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '(') depth++;
        if (ch === ')') {
            depth--;
            if (depth === 0) return i === e.length - 1;
        }
    }
    return false;
}

/** Every title-bearing region in a template: <title> bodies and og/twitter title contents. */
function titleRegions(source) {
    const tags = [];
    const masked = source.replace(/<%[\s\S]*?%>/g, (tag) => {
        tags.push(tag);
        return `\u0001${tags.length - 1}\u0001`;
    });
    const regions = [];
    for (const m of masked.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)) regions.push({ kind: '<title>', text: m[1] });
    for (const m of masked.matchAll(/<meta\b[^>]*>/gi)) {
        if (!/\b(?:property|name)\s*=\s*["'](?:og:title|twitter:title)["']/i.test(m[0])) continue;
        const content = m[0].match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
        if (content) regions.push({ kind: 'og/twitter title', text: content[2] });
    }
    return regions.map((r) => ({
        kind: r.kind,
        literal: decodeEntities(r.text.replace(/\u0001\d+\u0001/g, ' ')),
        tags: [...r.text.matchAll(/\u0001(\d+)\u0001/g)].map((t) => tags[Number(t[1])]),
    }));
}

test('the region extractor sees what a title check needs to see', () => {
    const [plain] = titleRegions('<title>Blog — Savchenko Solutions</title>');
    assert.match(plain.literal, BANNED);
    const [computed] = titleRegions("<title><%= docTitle(post.title, 'Blog') %></title>");
    assert.equal(computed.tags.length, 1);
    assert.ok(isSingleTitleCall(computed.tags[0].slice(3, -2)));
    assert.equal(isSingleTitleCall("titleText(a) + ' — ' + titleText(b)"), false);
    assert.equal(isSingleTitleCall('title'), false);
    assert.equal(isSingleTitleCall("docTitle(x.replace(')', ''), 'Savchenko Solutions')"), true);
    const [meta] = titleRegions('<meta property="og:title" content="<%= titleText(title) %> &mdash; x" />');
    assert.match(meta.literal, BANNED);
});

test('no template writes a title with an em dash, en dash, colon or semicolon', () => {
    const files = [
        ...walk(path.join(ROOT, 'views'), ['.ejs', '.html']),
        ...walk(path.join(ROOT, 'sandbox', 'views'), ['.ejs', '.html']),
        ...walk(path.join(ROOT, 'public'), ['.ejs', '.html']),
    ];
    assert.ok(files.length > 50, `expected the site's templates, found ${files.length}`);
    const problems = [];
    let regionsSeen = 0;
    for (const file of files) {
        const rel = path.relative(ROOT, file);
        for (const region of titleRegions(fs.readFileSync(file, 'utf8'))) {
            regionsSeen++;
            if (BANNED.test(region.literal)) {
                problems.push(`${rel}: ${region.kind} text "${region.literal.trim()}"`);
            }
            for (const tag of region.tags) {
                if (tag.startsWith('<%#')) continue;
                const output = tag.match(/^<%[=-]([\s\S]*?)-?%>$/);
                if (!output || !isSingleTitleCall(output[1])) {
                    problems.push(`${rel}: ${region.kind} computes ${JSON.stringify(tag)} without docTitle()/titleText()`);
                }
            }
        }
    }
    assert.ok(regionsSeen > 50, `expected the site's titles, found ${regionsSeen}`);
    assert.deepEqual(problems, []);
});

// ── 4. Locale strings used in titles ────────────────────────────────────────────────────

test('locale strings that become titles are clean in both languages', () => {
    const get = (obj, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    for (const lang of ['en', 'ru']) {
        const locale = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf8'));
        // The site name, and the forum prefixes that translateTopicTitle (forum.js) swaps
        // into topic titles and headings.
        for (const key of ['title', 'forumPage.topicPrefix_discussion', 'forumPage.topicPrefix_question', 'forumPage.topicPrefix_error']) {
            const value = get(locale, key);
            assert.equal(typeof value, 'string', `${lang}: ${key} missing`);
            assert.doesNotMatch(value, BANNED, `${lang}: ${key} = ${value}`);
        }
    }
});
