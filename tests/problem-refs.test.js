// Problem numbers inside a statement link to those problems (lib/problemRefs.js). Savchenko's
// statements lean on each other — "решите задачи 14.3.1–14.3.3, 14.3.5", "14.3.6 а, б и 14.3.7" —
// and on the problem database (2026-09-19) every such number was plain text, so a reader had
// to type it into the search. Only rendered statements go through this; solutions keep their
// explicit #x.y.z references (utils.js autoLinkProblemRefs).
//
// Not covered: the statement renderer itself (needs Postgres); the bare \begin{equation}
// pass in mathRender.js is exercised below through renderMathInHtml.

const test = require('node:test');
const assert = require('node:assert/strict');

const { linkProblemRefs } = require('../lib/problemRefs');
const { renderMathInHtml } = require('../mathRender');

const link = (n, lang = 'ru') => `<a class="problem-ref" href="/${lang}/${n}">${n}</a>`;

test('every number of the book in a statement becomes a link, each end of a range too', () => {
    assert.equal(linkProblemRefs('<p>решите задачи 14.3.1–14.3.3, 14.3.5.</p>', 'ru'),
        `<p>решите задачи ${link('14.3.1')}–${link('14.3.3')}, ${link('14.3.5')}.</p>`);
    assert.equal(linkProblemRefs('<p>see 1.1.1</p>', 'en'), `<p>see ${link('1.1.1', 'en')}</p>`);
});

test('a letter glued to the number stays outside the link, and the statement\'s own number is not linked', () => {
    assert.equal(linkProblemRefs('<p>в задаче 3.4.15а и 14.3.6 а, б и 14.3.7</p>', 'ru', { self: '14.3.6' }),
        `<p>в задаче ${link('3.4.15')}а и 14.3.6 а, б и ${link('14.3.7')}</p>`);
});

test('what is not a problem of the book stays text: versions, decimals, numbers past a section\'s end', () => {
    for (const s of ['1.2.3.4', '0.1.5', '1.1.24', '15.1.1', '3.14', '2.5.3.1']) {
        assert.equal(linkProblemRefs(`<p>${s}</p>`, 'ru'), `<p>${s}</p>`, s);
    }
});

test('tags, attributes, existing links and typeset formulas are never touched', () => {
    const html = '<img alt="1.1.1" src="/img/1.1.1/a.svg"><a href="/x">1.1.1</a><svg viewBox="0 0 1.1.1"><text>1.1.1</text></svg>';
    assert.equal(linkProblemRefs(html, 'ru'), html);
    assert.equal(linkProblemRefs('', 'ru'), '');
    assert.equal(linkProblemRefs(null, 'ru'), null);
});

test('a bare \\begin{equation} … \\end{equation} is typeset as display maths, as the editor preview shows it', () => {
    const html = '<p>\\begin{equation}<br />    \\vec{B} = \\frac{[\\vec{\\beta} \\times \\vec{E}]}{c}<br />\\end{equation}</p><p>\\begin{align*}a&amp;=b\\\\c&amp;=d\\end{align*}</p>';
    const out = renderMathInHtml(html);
    assert.equal((out.match(/display="true"/g) || []).length, 2, out.slice(0, 200));
    // The source stays beside each formula for copying (mathRender.js withSource), but as text of
    // the page nothing is left.
    assert.ok(!out.replace(/<span class="mjx-tex"[^>]*>[\s\S]*?<\/span>/g, '').includes('\\begin{'), 'nothing left as text');
    // An environment inside $$ is still one formula, not two.
    const inside = renderMathInHtml('<p>$$\\begin{equation}x=1\\end{equation}$$</p>');
    assert.equal((inside.match(/<mjx-container/g) || []).length, 1);
    // A non-display environment outside maths is left alone, as MathJax leaves it.
    assert.equal(renderMathInHtml('<p>\\begin{itemize}x\\end{itemize}</p>'), '<p>\\begin{itemize}x\\end{itemize}</p>');
});
