// A backslash in front of ASCII punctuation is a CommonMark escape, so marked eats it and
// the TeX macro spelled that way arrives at MathJax as bare punctuation: `\,` renders as a
// comma sitting inside the formula, `\!` as a factorial. parseMarkdown therefore hands
// marked a doubled backslash, which marked halves back to one.
//
// This used to be done in post.js per `$…$` span, which missed every other way a solution
// writes maths — hence the cases below. The delimiter cases are the older half of the same
// protection and are here so a future edit cannot drop them.

const test = require('node:test');
const assert = require('node:assert');

const { parseMarkdown } = require('../utils');

test('thin space survives in single-line inline math', () => {
    assert.match(parseMarkdown('$v \\, dt$'), /\\, dt/);
});

test('thin space survives in inline math broken over a line', () => {
    // The old per-span regex refused to cross a newline, so every `\,` in a formula
    // written across two lines lost its backslash.
    const html = parseMarkdown('$\\mathbf{E} = E_0 \\cos(\\omega t)\\,\\hat{\\mathbf{y}},\n\\mathbf{B} = \\frac{E_0}{c}\\,\\hat{\\mathbf{z}}$');
    assert.strictEqual((html.match(/\\,/g) || []).length, 2);
});

test('thin space survives in display math', () => {
    assert.match(parseMarkdown('$$\nx = \\int v \\, dt\n$$'), /\\, dt/);
});

test('thin space survives in a bare equation environment', () => {
    // 63 solutions write display maths as \begin{equation} with no $ delimiters at all.
    const html = parseMarkdown('\\begin{equation}\nr_1 \\approx 1 \\, \\mu\\text{m}\n\\end{equation}');
    assert.match(html, /1 \\, \\mu/);
});

test('the other spacing macros survive too', () => {
    assert.match(parseMarkdown('$a \\; b$'), /\\; b/);
    assert.match(parseMarkdown('$\\cos\\!\\left(x\\right)$'), /\\cos\\!\\left/);
});

test('the older doubled-backslash convention still renders as one macro', () => {
    // Sources exist in both conventions; the substitution has to converge, not stack.
    assert.match(parseMarkdown('$v \\\\, dt$'), /\\, dt/);
    assert.doesNotMatch(parseMarkdown('$v \\\\, dt$'), /\\\\, dt/);
});

test('math delimiters still reach MathJax', () => {
    assert.match(parseMarkdown('\\[ E = mc^2 \\]'), /\\\[ E = mc\^2 \\\]/);
    assert.match(parseMarkdown('\\( E = mc^2 \\)'), /\\\( E = mc\^2 \\\)/);
});
