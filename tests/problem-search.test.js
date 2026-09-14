// The site's search, since 2026-09-14 a filter on the problem finder (lib/problemSearch.js).
//
// There used to be two searches with two designs: the header's box and the hero's opened a
// separate /global-search results page, while /problems had its own box that matched only
// problem numbers and topic tags. The owner wanted one place, so /find and the header now hand
// text to /<lang>/problems?q=, which ranks problems by their statements and solutions, and
// /global-search redirects there. Two things were found on the way and are guarded here:
// the query "трение" matched 45 problems while 144 statements contain the word (Russian
// endings defeat prefix matching), and a problem number searched as text hits every formula
// with those digits.
//
// Not covered: the routes themselves (no test database, see CLAUDE.md "Testing"), and the
// finder's client code, which was checked in Firefox against the local rig.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeHits, buildStatementIndex, isProblemNumberQuery, stemWord, queryTerms } = require('../lib/problemSearch');

test('problem numbers, whole or partial, are not searched as text', () => {
    for (const q of ['2.1.32', '2.1', '14', '3,2,6', ' 2.1.3 ']) assert.equal(isProblemNumberQuery(q), true, q);
    for (const q of ['маятник', '2.1.32 маятник', 'F=ma', 'x2']) assert.equal(isProblemNumberQuery(q), false, q);
});

test('Russian words lose their case ending, never below four letters', () => {
    assert.equal(stemWord('трение'), 'трен');
    assert.equal(stemWord('трения'), 'трен');
    assert.equal(stemWord('пружина'), 'пружин');
    assert.equal(stemWord('сохранения'), 'сохранен');
    assert.equal(stemWord('наклонной'), 'наклонн');
    assert.equal(stemWord('маятник'), 'маятник');
    assert.equal(stemWord('поле'), 'поле', 'a four-letter word stays whole');
    assert.equal(stemWord('Энергии'), 'энерг');
    assert.equal(stemWord('oscillations'), 'oscillation');
    assert.equal(stemWord('glass'), 'glass');
    assert.deepEqual(queryTerms('закон сохранения, энергии'), ['закон', 'сохранен', 'энерг']);
});

test('a stem finds every case of the word in the statements, in both languages', () => {
    const { index, names } = buildStatementIndex([
        { problem_name: '1.1.1', statement_tex: 'Коэффициент трения бруска о плоскость $\\mu$.' },
        { problem_name: '1.1.1', statement_tex: 'The coefficient of friction is $\\mu$.' },
        { problem_name: '2.2.2', statement_tex: 'Сила трением не учитывается.' },
        { problem_name: '3.3.3', statement_tex: 'Математический маятник.' },
    ]);
    const hits = (q) => [...new Set(index.search(queryTerms(q).join(' ')).map((id) => names[id]))].sort();
    assert.deepEqual(hits('трение'), ['1.1.1', '2.2.2']);
    assert.deepEqual(hits('frictions'), ['1.1.1']);
    assert.deepEqual(hits('маятника'), ['3.3.3']);
    assert.deepEqual(hits('mu'), [], 'maths is stripped before indexing');
});

test('statement hits lead, solution-only hits follow with their snippets, each problem once', () => {
    const merged = mergeHits(['3.1.1', '2.1.5', '3.1.1'], [
        { problemName: '2.1.5', snippet: 'in the statement already' },
        { problemName: '7.2.2', snippet: '...маятник...' },
        { problemName: '7.2.3', snippet: '' },
    ]);
    assert.deepEqual(merged.names, ['3.1.1', '2.1.5', '7.2.2', '7.2.3']);
    assert.deepEqual(merged.snippets, { '7.2.2': '...маятник...' });
    const capped = mergeHits(['1.1.1'], [{ problemName: '9.9.9', snippet: 'cut' }], 1);
    assert.deepEqual(capped, { names: ['1.1.1'], snippets: {} });
});

test('every old way into the results page now reaches the finder', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
    assert.doesNotMatch(index, /res\.render\(\s*["']search["']/, 'the old results template is not rendered');
    assert.match(index, /app\.get\("\/global-search"[\s\S]{0,400}res\.redirect\(301, query \? `\/\$\{lang\}\/problems\?q=/);
    assert.match(index, /return res\.redirect\(302, `\/\$\{lang\}\/problems\?q=\$\{encodeURIComponent\(raw\)\}`\);/, '/find hands text to the finder');
    assert.equal(fs.existsSync(path.join(root, 'views', 'search.ejs')), false);
    const views = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ejs')) views.push(p);
        }
    };
    walk(path.join(root, 'views'));
    for (const v of views) assert.doesNotMatch(fs.readFileSync(v, 'utf8'), /global-search/, path.relative(root, v));
    // The header's box works on every page that shows it: the script comes with the header.
    const header = fs.readFileSync(path.join(root, 'views', 'default', 'main_site_header.ejs'), 'utf8');
    assert.match(header, /<%- include\('main_site_search_script'\) %>/);
});
