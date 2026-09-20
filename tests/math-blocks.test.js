/**
 * math-blocks.test.js — a formula in a solution can never reach past the block it starts in.
 *
 * The incident: /ru/1.4.18's answer line was `$\alpha = 60^{\circ}$$l = 200 \sqrt{3} \approx
 * 345$ м` (two formulas with nothing between them, 2026-09-20). The display pass ran over the
 * whole rendered page with `[\s\S]+?`, so the `$$` in the middle paired with the next `$$`
 * anywhere below, the answer box's closing tag, the footer's prev/next nav and the comment
 * form's opening tag were dropped as if they were a <br> inside a formula, and MathJax drew
 * the swallowed page text as a red-on-yellow error inside the answer box. Ten other posts
 * had the same shape (ru/1.3.14, ru/11.1.11, ru/2.3.28, ru/2.3.47, en/11.1.28, en/11.4.21,
 * en/2.1.23, en/6.2.10 with a `$$` never closed, en/14.3.13 and 14 with `\\[4pt]` in an
 * align read as `\[`). Comments and template text render on the same page, so any `$$`
 * typed later would have closed any of them.
 *
 * Now every pass stops at a block-level tag (a distinct placeholder, `B` in mathRender.js):
 * a formula ends in the block it began in, or the delimiters stay as text. Nothing that a
 * post file holds can drop a tag outside its own paragraph.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderMathInHtml } = require('../mathRender');

const TAIL = '<div class="tail"><nav><a href="/ru/1.4.17">1.4.17</a></nav><p>Автор</p><p>$$x$$</p><p>\\[y\\]</p><textarea>$$</textarea></div>';
const formulas = (html) => (html.match(/<mjx-container/g) || []).length;

test('1.4.18: `$a$$b$` is two inline formulas and the page after the answer box is intact', () => {
    const body = '<div class="answer"><p>$\\alpha = 60^{\\circ}$$l = 200 \\sqrt{3} \\approx 345$ м</p></div>';
    const out = renderMathInHtml(body + TAIL);
    assert.ok(out.includes('<nav><a href="/ru/1.4.17">1.4.17</a></nav><p>Автор</p>'), 'the nav and the author line survive');
    assert.ok(out.includes('</div><div class="tail">'), 'the answer box closes before the tail');
    assert.equal(formulas(out), 4, 'α, l, x and y are each a formula');
    assert.ok(!/merror/.test(out));
});

test('a `$$` never closed in the body stays text and cannot pair with a `$$` further down the page', () => {
    const body = '<p>So, as</p><p>$$E = \\sqrt{a^2 + b^2},</p><p>it is obtained</p>';
    const out = renderMathInHtml(body + TAIL);
    assert.ok(out.includes('<p>$$E = \\sqrt{a^2 + b^2},</p><p>it is obtained</p><div class="tail">'), 'the body is untouched');
    assert.equal(formulas(out), 2, 'the tail\'s own x and y still render');
});

test('`\\[` and `\\begin{align}` left open are contained the same way', () => {
    const out1 = renderMathInHtml('<p>\\[a = b</p><p>text</p>' + TAIL);
    assert.ok(out1.includes('<p>\\[a = b</p><p>text</p><div class="tail">'));
    assert.equal(formulas(out1), 2);
    const out2 = renderMathInHtml('<p>\\begin{align}a &= b</p><p>text \\end{align}</p>' + TAIL);
    assert.ok(out2.includes('<p>\\begin{align}a &= b</p><p>text \\end{align}</p><div class="tail">'));
});

test('a display formula spanning a <br> inside one paragraph still renders', () => {
    const out = renderMathInHtml('<p>$$<br>\\frac{a}{b}<br>$$</p>');
    assert.equal(formulas(out), 1);
    assert.ok(!out.includes('<br>'), 'the breaks inside the formula are dropped as before');
});

test('inline `$…$` stops at a block boundary as it stops at a newline', () => {
    const out = renderMathInHtml('<p>Цена $5</p><p>и ещё $7</p>');
    assert.equal(formulas(out), 0);
    assert.ok(out.includes('<p>Цена $5</p><p>и ещё $7</p>'));
});
