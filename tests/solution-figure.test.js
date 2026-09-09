// Unit tests for the interactive-figure registry and the body split it drives.
//
// Same approach as tests/feedback.test.js: node:test, no framework, no database. What is
// covered is the pure decision logic in lib/solutionFigures.js; the route wiring in
// post.js and views/solution_post.ejs is not, because there is no test database and no
// render harness in this project.
//
// The incident this guards against is structural rather than historical. A figure is
// injected by splitting the rendered solution body in two and rendering a partial into the
// seam, so a split that loses a byte silently truncates somebody's solution — the single
// worst failure this site has, and one that would show up as "the answer section vanished"
// long after the deploy. Hence the invariant at the bottom: before + after must reconstruct
// the input exactly, for every input, registered or not.
//
// The second block is the "must never touch a page that did not ask for one" set. 1,515 of
// the 1,516 solutions have no figure, and none of them may change.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FIGURES, getFigure, splitAtSolutionHeading } = require('../lib/solutionFigures');

// A body shaped like what post.js actually produces: marked runs with headerIds:false,
// so headings arrive as bare <h3>, and the maths is still raw $…$ at this point.
const RU_BODY =
    '<h3>Условие</h3>\n<p>$6.6.15.$ Электрофильтр состоит из длинной металлической трубы…</p>\n' +
    '<h3>Решение</h3>\n<p><b>а)</b> Найдем распределение электрического поля…</p>\n' +
    '<h4>Ответ</h4>\n<p>а. К нити</p>';

const EN_BODY =
    '<h3>Statement</h3>\n<p>An electrostatic precipitator consists of…</p>\n' +
    '<h3>Solution</h3>\n<p><b>a)</b> Let us find the distribution…</p>';

// ── The registry ────────────────────────────────────────────────────────────────────

test('6.6.15 is registered and carries every field the template dereferences', () => {
    const f = getFigure('6.6.15');
    assert.ok(f);
    for (const key of ['id', 'partial', 'script', 'css']) {
        assert.equal(typeof f[key], 'string', `missing ${key}`);
        assert.ok(f[key].length > 0);
    }
    // solution_post.ejs builds the include path as 'partials/figures/' + figure.id, so the
    // two have to agree or the page 500s on a missing partial.
    assert.equal(f.partial, 'partials/figures/' + f.id);
    assert.ok(f.script.startsWith('/js/'));
    assert.ok(f.css.startsWith('/css/'));
});

test('every registered figure points at files that exist on disk', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    for (const [name, f] of Object.entries(FIGURES)) {
        for (const rel of [f.script, f.css, '/views/' + f.partial + '.ejs']) {
            const full = path.join(root, rel);
            assert.ok(fs.existsSync(full), `${name}: missing ${rel}`);
        }
    }
});

test('an unregistered problem gets nothing', () => {
    for (const name of ['6.6.16', '6.6.14', '1.1.1', '14.5.24']) {
        assert.equal(getFigure(name), null);
    }
});

test('odd input never throws and never invents a figure', () => {
    // The problem name comes straight off the URL (index.js:3152 has no validity check).
    for (const bad of [null, undefined, '', 0, {}, [], '__proto__', 'constructor', 'toString']) {
        assert.doesNotThrow(() => getFigure(bad));
        assert.equal(getFigure(bad), null);
    }
});

// ── The split ───────────────────────────────────────────────────────────────────────

test('a Russian body splits right after the Решение heading', () => {
    const { before, after } = splitAtSolutionHeading(RU_BODY);
    assert.ok(before.endsWith('<h3>Решение</h3>'));
    assert.ok(after.startsWith('\n<p><b>а)</b>'));
});

test('an English body splits right after the Solution heading', () => {
    const { before, after } = splitAtSolutionHeading(EN_BODY);
    assert.ok(before.endsWith('<h3>Solution</h3>'));
    assert.ok(after.startsWith('\n<p><b>a)</b>'));
});

test('the heading level and stray attributes do not matter', () => {
    for (const h of ['h2', 'h3', 'h4']) {
        const html = `<p>x</p><${h} id="s">Решение</${h}><p>y</p>`;
        const { before, after } = splitAtSolutionHeading(html);
        assert.equal(after, '<p>y</p>', h);
        assert.ok(before.endsWith(`</${h}>`));
    }
});

test('surrounding whitespace and a trailing colon still match', () => {
    const { after } = splitAtSolutionHeading('<h3> Solution: </h3><p>y</p>');
    assert.equal(after, '<p>y</p>');
});

test('the first Решение heading wins, not a later one', () => {
    const html = '<h3>Решение</h3><p>a</p><h3>Решение</h3><p>b</p>';
    const { before } = splitAtSolutionHeading(html);
    assert.equal(before, '<h3>Решение</h3>');
});

test('a heading-lookalike inside a code block cannot false-positive', () => {
    // marked escapes HTML inside a fence, so what reaches the split is entity-encoded and
    // must not be mistaken for a real heading.
    const html = '<pre><code>&lt;h3&gt;Решение&lt;/h3&gt;</code></pre><p>real body</p>';
    const { before, after } = splitAtSolutionHeading(html);
    assert.equal(before, html);
    assert.equal(after, '');
});

test('a body with no heading at all is returned whole', () => {
    const html = '<p>Просто текст без заголовков.</p>';
    const { before, after } = splitAtSolutionHeading(html);
    assert.equal(before, html);
    assert.equal(after, '');
});

// ── Must never lose a byte of somebody's solution ───────────────────────────────────

test('before + after always reconstructs the input exactly', () => {
    const bodies = [
        RU_BODY,
        EN_BODY,
        '',
        '<p>no heading</p>',
        '<h3>Решение</h3>',
        '<h3>Решение</h3><p>tail</p>',
        '<p>lead</p><h3>Решение</h3>',
        '<h3>Условие</h3><h3>Решение</h3><h4>Ответ</h4>',
        // Real shapes from posts/: a figure right under the heading, and display maths.
        '<h3>Решение</h3>\n<center style="margin-top:5px"><figure><img src="../../img/6.6.16/6.6.16.png" /></figure></center>\n<p>$$F=\\frac{Q^2}{R}$$</p>',
        // A solution whose heading is spelled some other way entirely.
        '<h3>Розв\u0027язання</h3><p>тіло</p>',
    ];
    for (const html of bodies) {
        const { before, after } = splitAtSolutionHeading(html);
        assert.equal(before + after, html, JSON.stringify(html.slice(0, 40)));
    }
});

test('non-string input degrades to empty halves rather than throwing', () => {
    for (const bad of [null, undefined, 0, {}, []]) {
        assert.doesNotThrow(() => splitAtSolutionHeading(bad));
        const { before, after } = splitAtSolutionHeading(bad);
        assert.equal(before, '');
        assert.equal(after, '');
    }
});

test('the split is stateless — the same input gives the same answer every time', () => {
    // The heading pattern is a module-level RegExp; a /g flag on it would make lastIndex
    // carry between calls and every second call would miss.
    for (let i = 0; i < 3; i++) {
        assert.equal(splitAtSolutionHeading(RU_BODY).before.endsWith('<h3>Решение</h3>'), true);
    }
});
