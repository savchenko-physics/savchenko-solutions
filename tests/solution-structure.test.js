// Tests for js/solution-structure.js, the display-time shape of a solution page.
//
// The transform wraps a rendered solution's sections in labelled <section> blocks (statement
// card, answer box, the book's problem number with Savchenko's ∗). It runs on every solution a
// reader opens and in the editor preview, on HTML produced from contributors' markdown in nine
// heading spellings, and nothing about a mistake would announce itself: an unbalanced tag could
// swallow an answer, a moved heading could split a $$…$$ span so a formula silently stops
// rendering, a misread number could label 2.1.33 as 2.1.32. So this file pins:
//   1. every heading spelling the posts actually use, including their typos;
//   2. the documented edits (labels, the answer moved out of its heading, the number and ∗);
//   3. what it must leave alone (headings in blockquotes, numbers of other problems, unknown
//      headings, non-string input) and that running it twice changes nothing;
//   4. the seam the 6.6.15 figure is rendered into still lands under the solution heading;
//   5. isBookCaption, which drops the "К задаче N" caption the book already draws in the figure.
//
// The closing block runs the transform over every post in the repo's posts/ and asserts that no
// reader loses a word: sections balance, the text is unchanged apart from the labels and the
// number, and a second pass is a no-op. Formulas are counted as raw $…$ spans here; the full
// MathJax comparison (slower, and meant for the server's authoritative copy of posts/) is
// scripts/check-solution-structure.js. Not covered: the route wiring in post.js and the editor
// preview beyond "they call it", since there is no render harness in this project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { structureSolution, isBookCaption, classify } = require('../js/solution-structure');
const { splitAtSolutionHeading } = require('../lib/solutionFigures');
const { parseMarkdown, transformImageMarkdown } = require('../utils');

const ROOT = path.join(__dirname, '..');

// The same steps post.js runs before the transform (maths still raw at this point).
function render(md) {
    let c = md.replace(/\*/g, '\\*').replace(/~/g, '\\~');
    c = transformImageMarkdown(c);
    let html = parseMarkdown(c);
    html = html.replace(/<em>/g, '_').replace(/<\/em>/g, '_');
    return html.replace(/\\\*/g, '*');
}

const count = (re, s) => (s.match(re) || []).length;

function words(html) {
    return html
        .replace(/<span class="ss-num">[\s\S]*?<\/span>/g, ' NUM ')
        .replace(/\$\s*\d{1,2}\.\d{1,2}\.\d{1,3}\s*(?:\^\s*\{?\s*(?:\*|∗|\\ast)\s*\}?)?\s*\.?\s*\$/g, ' NUM ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/(у?сл?л?овие|условия|решение\s+и\s+ответ|решение|доказательство|(?:альтерна\S*|аналогичное|другое|второе|иное)\s+решение|ответы|ответ|литература|источники|problem\s+statement|statement|problem|condition|solution\s+and\s+answer|solution|proof|alternative\s+solution|another\s+solution|answers|answer|references|literature)\s*:?/gi, ' ')
        .replace(/[∗*:.,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

// ── 1. Heading spellings ─────────────────────────────────────────────────────────────────

test('every heading spelling in posts/ is recognised, typos included', () => {
    const cases = [
        ['Условие', 'statement'], ['Условие:', 'statement'], ['Услловие:', 'statement'], ['Условия', 'statement'],
        ['Statement', 'statement'], ['Problem', 'statement'], ['Problem statement', 'statement'],
        ['Решение', 'solution'], ['Решение:', 'solution'], ['Решение и Ответ:', 'solution'], ['Доказательство', 'solution'],
        ['Solution', 'solution'], ['Solution 2', 'solution'], ['Proof', 'solution'],
        ['Альтернативное решение:', 'alternative'], ['Альтернавное решение:', 'alternative'], ['Аналогичное решение', 'alternative'],
        ['Alternative solution', 'alternative'], ['Another solution', 'alternative'],
        ['Ответ', 'answer'], ['Ответ:', 'answer'], ['Ответы', 'answer'], ['Answer 1', 'answer'], ['Answers', 'answer'],
        ['Литература', 'literature'], ['References', 'literature'],
    ];
    for (const [heading, kind] of cases) {
        const c = classify(heading);
        assert.ok(c, heading);
        assert.equal(c.kind, kind, heading);
    }
    for (const heading of ['Замечание', 'Решение задачи в общем виде', 'Ответ на вопрос б)', 'Part (a)', '']) {
        assert.equal(classify(heading), null, heading);
    }
    assert.equal(classify('Answer 2').num, '2');
    assert.equal(classify('Решение и Ответ:').combined, true);
    assert.equal(classify('<strong>Условие</strong>').kind, 'statement', 'inline markup inside the heading');
});

// ── 2. The documented edits ──────────────────────────────────────────────────────────────

test('a typical Russian solution becomes statement card, solution and answer box', () => {
    const html = render('### Условие:\n\n$2.1.32.$ Текст условия.\n\n### Решение\n\nТекст.\n\n$$x=1$$\n\nПосле.\n\n#### Ответ\n\n$v = 2$\n');
    const out = structureSolution(html, { lang: 'ru', name: '2.1.32', starred: false });
    assert.match(out, /^<section class="ss-sec ss-sec--statement ss-problem"><h2 class="ss-label">Условие<\/h2>/);
    assert.match(out, /<p><span class="ss-num">2\.1\.32\.<\/span> Текст условия\.<\/p>/);
    assert.match(out, /<section class="ss-sec ss-sec--solution"><h2 class="ss-label">Решение<\/h2>/);
    assert.match(out, /<p class="ss-eq">\$\$x=1\$\$<\/p>/);
    assert.match(out, /<section class="ss-sec ss-sec--answer"><h2 class="ss-label">Ответ<\/h2><div class="ss-answer">\s*<p>\$v = 2\$<\/p>\s*<\/div><\/section>$/);
    assert.equal(count(/<section\b/g, out), 3);
    assert.equal(count(/<\/section>/g, out), 3);
});

test('an answer written into its heading (397 Russian posts) moves into the answer box', () => {
    const out = structureSolution(render('### Решение\n\nТекст.\n\n#### Ответ: $v = \\sqrt{2gh}$\n'), { lang: 'ru' });
    assert.match(out, /<h2 class="ss-label">Ответ<\/h2><div class="ss-answer"><p>\$v = \\sqrt\{2gh\}\$<\/p>/);
    // "<strong>Ответ:</strong> $x$" — the tags the split leaves dangling are dropped, nothing else.
    const strong = structureSolution('<h4><strong>Ответ:</strong> $x = 1$</h4>', { lang: 'ru' });
    assert.equal(strong, '<section class="ss-sec ss-sec--answer"><h2 class="ss-label">Ответ</h2><div class="ss-answer"><p>$x = 1$</p></div></section>');
});

test('numbered answers keep their numbers (en/12.1.4)', () => {
    const md = fs.readFileSync(path.join(ROOT, 'posts/en/12.1.4.md'), 'utf8');
    const out = structureSolution(render(md), { lang: 'en', name: '12.1.4' });
    assert.match(out, /<h2 class="ss-label">Answer 1<\/h2><div class="ss-answer">/);
    assert.match(out, /<h2 class="ss-label">Answer 2<\/h2><div class="ss-answer">/);
    assert.match(out, /<span class="ss-num">12\.1\.4\.<\/span>/);
    // "Finally, the phase is," sits between the boxes, outside both.
    assert.match(out, /Finally, the phase is,<\/p>\s*<\/div><\/section><section class="ss-sec ss-sec--answer"><h2 class="ss-label">Answer 2/);
});

test('the book number takes Savchenko\'s ∗ from the database, and only for its own problem', () => {
    const body = '<h3>Условие</h3>\n<p>$ 1.1.1.$ На рисунке приведена «смазанная фотография».</p>';
    assert.match(structureSolution(body, { lang: 'ru', name: '1.1.1', starred: true }),
        /<span class="ss-num">1\.1\.1<sup class="ss-star" aria-label="∗">∗<\/sup>\.<\/span> На рисунке/);
    assert.match(structureSolution(body, { lang: 'ru', name: '1.1.1', starred: false }), /<span class="ss-num">1\.1\.1\.<\/span> На/);
    // Without a database answer the post's own ^* decides.
    const marked = '<h3>Условие</h3>\n<p>$2.1.32^*.$ Текст.</p>';
    assert.match(structureSolution(marked, { lang: 'ru', name: '2.1.32' }), /2\.1\.32<sup class="ss-star"/);
    // A number that is not this page's problem is left exactly as written.
    const other = '<h3>Условие</h3>\n<p>$2.1.33.$ Текст.</p>';
    assert.doesNotMatch(structureSolution(other, { lang: 'ru', name: '2.1.32' }), /ss-num/);
    // Only at the start of the statement, never in the solution.
    const inSolution = '<h3>Решение</h3>\n<p>$2.1.32.$ Текст.</p>';
    assert.doesNotMatch(structureSolution(inSolution, { lang: 'ru', name: '2.1.32' }), /ss-num/);
});

test('labels are normalised per language and combined headings keep both words', () => {
    assert.match(structureSolution('<h3>Решение и Ответ:</h3>\n<p>Текст.</p>', { lang: 'ru' }), /<h2 class="ss-label">Решение и ответ<\/h2>/);
    assert.match(structureSolution('<h3>Альтернавное решение:</h3>\n<p>Текст.</p>', { lang: 'ru' }), /ss-sec--alternative"><h2 class="ss-label">Альтернативное решение<\/h2>/);
    assert.match(structureSolution('<h3>Problem</h3>\n<p>Text.</p>', { lang: 'en' }), /<h2 class="ss-label">Statement<\/h2>/);
});

// ── 3. What it leaves alone ──────────────────────────────────────────────────────────────

test('headings inside a blockquote or a list are not sections', () => {
    const html = '<blockquote>\n<h3>Решение</h3>\n<p>Цитата.</p>\n</blockquote>\n<p>Текст.</p>';
    assert.equal(structureSolution(html, { lang: 'ru' }), html);
    const list = '<ul>\n<li><h4>Ответ</h4></li>\n</ul>';
    assert.equal(structureSolution(list, { lang: 'ru' }), list);
});

test('an unknown heading ends the statement card and loses only its trailing colon', () => {
    const out = structureSolution('<h3>Условие</h3>\n<p>Текст.</p>\n<h3>Замечание:</h3>\n<p>Ещё.</p>', { lang: 'ru' });
    assert.equal(out, '<section class="ss-sec ss-sec--statement ss-problem"><h2 class="ss-label">Условие</h2>\n<p>Текст.</p>\n</section><h3>Замечание</h3>\n<p>Ещё.</p>');
});

test('a heading with nothing under it is dropped rather than shown as an empty block', () => {
    const out = structureSolution('<h3>Условие</h3>\n<p>Текст.</p>\n<h3>решение:</h3>\n', { lang: 'ru' });
    assert.equal(count(/<section\b/g, out), 1);
    assert.doesNotMatch(out, /Решение/);
});

test('a second "Условие" is text, not a second card', () => {
    const out = structureSolution('<h3>Условие</h3>\n<p>А.</p>\n<h3>Решение</h3>\n<p>Б.</p>\n<h3>Условие:</h3>\n<p>В.</p>', { lang: 'ru' });
    assert.equal(count(/ss-sec--statement/g, out), 1);
    assert.match(out, /<h3>Условие<\/h3>\n<p>В\.<\/p>/);
});

test('running twice changes nothing, and non-string input passes through', () => {
    const once = structureSolution(render('### Условие\n\n$1.1.1.$ А.\n\n### Решение\n\nБ.\n\n#### Ответ: $x$\n'), { lang: 'ru', name: '1.1.1' });
    assert.equal(structureSolution(once, { lang: 'ru', name: '1.1.1' }), once);
    for (const v of [undefined, null, '', 42]) assert.equal(structureSolution(v), v);
    const plain = '<p>Solution without any headings.</p>';
    assert.equal(structureSolution(plain, { lang: 'en' }), plain);
});

// ── 4. The figure seam ───────────────────────────────────────────────────────────────────

test('the 6.6.15 figure seam still lands right under the solution label, inside its section', () => {
    const body = '<h3>Условие</h3>\n<p>$6.6.15.$ Электрофильтр состоит из длинной металлической трубы…</p>\n' +
        '<h3>Решение</h3>\n<p><b>а)</b> Найдем распределение электрического поля…</p>\n<h4>Ответ</h4>\n<p>а. К нити</p>';
    const out = structureSolution(body, { lang: 'ru', name: '6.6.15', starred: false });
    const { before, after } = splitAtSolutionHeading(out);
    assert.equal(before + after, out);
    assert.match(before, /<section class="ss-sec ss-sec--solution"><h2 class="ss-label">Решение<\/h2>$/);
    assert.equal(count(/<section\b/g, before) - count(/<\/section>/g, before), 1, 'the seam is inside the solution section');
    assert.match(after, /^\n<p><b>а\)<\/b> Найдем/);
});

// ── 5. Book captions ─────────────────────────────────────────────────────────────────────

test('isBookCaption matches only the book\'s own caption on that problem\'s statement figure', () => {
    assert.equal(isBookCaption(' К задаче 1.1.1 ', '1.1.1', 'statement.png'), true);
    assert.equal(isBookCaption('К задаче $2.1.32^*$.', '2.1.32', 'statement.svg'), true);
    assert.equal(isBookCaption('For problem 12.1.4', '12.1.4', 'statement.png'), true);
    assert.equal(isBookCaption('К задаче 1.1.2', '1.1.1', 'statement.png'), false, 'another problem\'s figure');
    assert.equal(isBookCaption('К задаче $11.4.10$', '11.4.10', '11.4.10.png'), false, 'a contributor\'s own image');
    assert.equal(isBookCaption('1.1.1. Движение самолёта', '1.1.1', 'statement.png'), false, 'a real caption');
    assert.equal(isBookCaption(undefined, undefined, undefined), false);
});

test('transformImageMarkdown drops the duplicate book caption and keeps real ones', () => {
    const book = transformImageMarkdown('![ К задаче 1.1.1 |507x327, 26%](../../img/1.1.1/statement.png)');
    assert.match(book, /<figure class="ss-image">/);
    assert.doesNotMatch(book, /figcaption/);
    const real = transformImageMarkdown('![ 1.1.1. Движение самолёта |747x555, 51%](../../img/1.1.1/1.1.1.png)');
    assert.match(real, /<figcaption[^>]*>[^<]*Движение самолёта/);
    assert.doesNotMatch(real, /<center/);
});

test('the route and the editor preview both run the transform, and the route has a kill switch', () => {
    const post = fs.readFileSync(path.join(ROOT, 'post.js'), 'utf8');
    assert.match(post, /process\.env\.SS_STRUCTURE !== 'off'/);
    const structureAt = post.indexOf('structureSolution(html');
    assert.ok(structureAt > 0 && structureAt < post.indexOf('splitAtSolutionHeading(html)'), 'structure first, then the figure split');
    const editor = fs.readFileSync(path.join(ROOT, 'views/edit_post.ejs'), 'utf8');
    assert.match(editor, /\/js\/solution-structure\.js/);
    assert.match(editor, /SolutionStructure\.structureSolution\(/);
});

// ── Must never lose a reader's content ───────────────────────────────────────────────────

test('over every post in posts/: sections balance, no word is lost, a second pass is a no-op', () => {
    let files = 0;
    const failures = [];
    for (const lang of ['ru', 'en']) {
        const dir = path.join(ROOT, 'posts', lang);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
            const name = f.replace(/\.md$/, '');
            const plain = render(fs.readFileSync(path.join(dir, f), 'utf8'));
            const out = structureSolution(plain, { lang, name });
            files++;
            const problems = [];
            if (count(/<section\b/g, out) !== count(/<\/section>/g, out)) problems.push('unbalanced sections');
            if (count(/\$/g, out) !== count(/\$/g, plain) - (count(/class="ss-num"/g, out) * 2)) problems.push('a $ went missing');
            if (count(/<img\b/g, out) !== count(/<img\b/g, plain)) problems.push('images');
            if (words(out) !== words(plain)) problems.push('text');
            if (structureSolution(out, { lang, name }) !== out) problems.push('not idempotent');
            if (problems.length) failures.push(`${lang}/${name}: ${problems.join(', ')}`);
        }
    }
    assert.ok(files > 1000, `only ${files} posts found`);
    assert.deepEqual(failures, []);
});
