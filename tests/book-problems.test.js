// The address of a problem nobody has solved yet (lib/bookProblems.js, post.js renderPost).
//
// Reported 2026-09-15: /ru/8.2.27 answered with the 404 page, although 8.2.27 is a real problem of
// the book that simply has no solution yet, and the mini app in the chat links problem numbers to
// the site. Such an address now goes to the solution in the other language when there is one, and
// otherwise to the unsolved list; only an address that is not a problem of the book stays a 404.
//
// Not covered, because there is no test server here: the redirect itself, which was checked
// against the running app before release.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isBookProblem, sectionCounts } = require('../lib/bookProblems');

const ROOT = path.join(__dirname, '..');

test('the book has 2,023 problems in 77 sections, as sections.csv says', () => {
    const counts = sectionCounts();
    assert.equal(counts.size, 77);
    assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 2023);
});

test('a problem of the book is a known section and a number within it, written the site\'s way', () => {
    for (const id of ['1.1.1', '8.2.27', '5.8.9', '14.4.31', '1.1.23']) assert.equal(isBookProblem(id), true, id);
    for (const id of ['1.1.24', '1.1.0', '08.2.27', '8.02.27', '8.2.027', '15.1.1', '8.2', '8.2.27.1', ' 8.2.27', '8,2,27', '', null, 8.227, '__proto__']) {
        assert.equal(isBookProblem(id), false, String(id));
    }
});

test('the solution page sends a real problem with no page to its other language or the unsolved list, before any 404', () => {
    const post = fs.readFileSync(path.join(ROOT, 'post.js'), 'utf8');
    const start = post.indexOf('async function renderPost(');
    const body = post.slice(start, post.indexOf('\nasync function ', start + 10));
    const redirect = body.indexOf('isBookProblem(name)');
    assert.ok(redirect > 0, 'renderPost checks the problem number');
    const other = body.indexOf('return res.redirect(302, `/${alternateLang}/${name}`)', redirect);
    const unsolved = body.indexOf('return res.redirect(302, `/${lang}/unsolved`)', redirect);
    const notFound = body.indexOf('res.status(404)', redirect);
    assert.ok(other > redirect && unsolved > other && notFound > unsolved, 'other language, then the unsolved list, then 404');
    assert.match(body.slice(redirect - 80, redirect), /lang === 'en' \|\| lang === 'ru'/, 'only for the two languages the site has');
});

// ── Must never block a real person ───────────────────────────────────────────────────────

test('every problem the book has is recognised, so none of them can end on a 404', () => {
    let n = 0;
    for (const [section, count] of sectionCounts()) {
        for (let i = 1; i <= count; i++) {
            assert.equal(isBookProblem(`${section}.${i}`), true, `${section}.${i}`);
            n += 1;
        }
    }
    assert.equal(n, 2023);
});
