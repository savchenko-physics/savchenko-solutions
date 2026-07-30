// Regression tests for the two places where statement handling can silently corrupt the
// book. Both of these encode a mistake that actually happened while building the table,
// not a hypothetical one.
//
// The rule they exist to protect: a statement that quietly stops matching the book is worse
// than one that visibly still has flattened maths. Anything ambiguous must be left alone.

const test = require('node:test');
const assert = require('node:assert');

const { repairMath, applyOneOffs, markdownStatement } = require('../scripts/build-statements');
const { acceptable, HAS_MATHS } = require('../scripts/repair-ru-latex');

// ── the OCR repairs applied to the English translation ──────────────────────────────
test('trig functions inside math get their backslash', () => {
    assert.strictEqual(repairMath('$E = E_0 sin \\omega t$'), '$E = E_0 \\sin \\omega t$');
    assert.strictEqual(repairMath('$A = N k T ln 2$'), '$A = N k T \\ln 2$');
});

test('tg and ctg become \\operatorname, never \\tg', () => {
    // MathJax defines neither \tg nor \ctg and the site sets up no macros, so emitting
    // them would render as a red error where the formula should be.
    const out = repairMath('$\\mu < ctg \\alpha$ and $tg \\alpha > \\mu$');
    assert.match(out, /\\operatorname\{ctg\}/);
    assert.match(out, /\\operatorname\{tg\}/);
    assert.doesNotMatch(out, /\\tg\b/);
    assert.doesNotMatch(out, /\\ctg\b/);
});

test('Greek names inside math get their backslash', () => {
    assert.strictEqual(repairMath('$mu$'), '$\\mu$');
    assert.strictEqual(repairMath('$\\frac{\\omega}{2 pi}$'), '$\\frac{\\omega}{2 \\pi}$');
    assert.strictEqual(repairMath('$rho_1$'), '$\\rho_1$');
});

test('prose outside math is never touched', () => {
    // "sin" and "Omega" can legitimately appear as English words, and the axes named in a
    // sentence must not sprout backslashes.
    const prose = 'The sine of the angle, cos of the other, and Omega Industries.';
    assert.strictEqual(repairMath(prose), prose);
    assert.strictEqual(repairMath('a body sinks in water'), 'a body sinks in water');
});

test('flattened exponents after \\cdot are restored', () => {
    assert.strictEqual(repairMath('$3 \\cdot 108$'), '$3 \\cdot 10^{8}$');
    assert.strictEqual(repairMath('$1.3 \\cdot 1012$'), '$1.3 \\cdot 10^{12}$');
});

test('bare numbers that merely look like exponents are left alone', () => {
    // This is the one that matters. An earlier version treated any bare "10NN" in an item
    // that showed the \cdot defect as flattened, and turned 5.2.1's "$1001$ m/s" — one
    // thousand and one, sitting next to $999$ — into "$10^{01}$". Of the 84 bare 10NN in
    // the book all but four are honest hundreds and thousands.
    for (const untouched of ['$1001$', '$100$', '$1000$', '$1013$', '$101.3$', '$100,000$']) {
        assert.strictEqual(repairMath(untouched), untouched, `${untouched} must survive`);
    }
    assert.strictEqual(
        repairMath('from $999$ to $1001$ m/s is $1.3 \\cdot 1012$'),
        'from $999$ to $1001$ m/s is $1.3 \\cdot 10^{12}$'
    );
});

test('a one-off correction that stops matching is a hard error', () => {
    // The named corrections describe defects in a specific file. If main.tex is ever
    // re-exported and a defect is fixed upstream, the correction must fail loudly rather
    // than silently doing nothing — otherwise nobody learns the list is stale.
    assert.throws(() => applyOneOffs('13.4.2', 'text with no such defect'), /re-verify/);
    assert.strictEqual(
        applyOneOffs('13.4.2', 'the normal is $30^\\circ$, $456\\circ$, $60^\\circ$'),
        'the normal is $30^\\circ$, $45^\\circ$, $60^\\circ$'
    );
});

test('problems with no correction on file pass through untouched', () => {
    assert.strictEqual(applyOneOffs('1.1.1', 'unchanged'), 'unchanged');
});

// ── splitting the site's markdown ───────────────────────────────────────────────────
test('the statement is taken from between the two headers', () => {
    const md = '### Условие\n$1.1.1.$ Тело падает.\n\n### Решение\nОно падает быстро.';
    assert.deepStrictEqual(markdownStatement(md), { text: 'Тело падает.', mdStarred: false });
});

test('the number prefix is stripped along with its star', () => {
    // "$2.2.24^*.$" carries Savchenko's marker. Consuming the number but not the star left
    // the statement beginning with the debris "^*.$".
    const md = '###  Условие:\n$2.2.24^*.$ Два тела массы $m_1$.\n\n### Решение\nx';
    const out = markdownStatement(md);
    assert.strictEqual(out.text, 'Два тела массы $m_1$.');
    assert.strictEqual(out.mdStarred, true);
});

test('all three number-prefix spellings are handled', () => {
    for (const prefix of ['$1.1.1.$', '$ 1.1.1.$', '$1.1.1$']) {
        const out = markdownStatement(`### Условие\n${prefix} Тело падает.\n### Решение\nx`);
        assert.strictEqual(out.text, 'Тело падает.', `prefix ${prefix}`);
    }
});

// ── the guard on LLM re-typesetting ─────────────────────────────────────────────────
test('a repair that drops a Russian word is rejected', () => {
    // The real case: "происходят по закону x1 = ..." came back as "происходят по $x_1$",
    // one word lighter. An earlier 15% word-count tolerance waved it through.
    const before = 'Малые колебания происходят по закону x1 = B cos ωt.';
    const after = 'Малые колебания происходят по $x_1 = B \\cos \\omega t$.';
    assert.match(acceptable(before, after), /prose changed/);
});

test('a repair that only changes notation is accepted', () => {
    const before = 'Угловая скорость катушки равна ω, радиус r.';
    const after = 'Угловая скорость катушки равна $\\omega$, радиус $r$.';
    assert.strictEqual(acceptable(before, after), null);
});

test('added words are rejected too', () => {
    const before = 'Тело падает с высоты h.';
    const after = 'Тело свободно падает с высоты $h$ над землёй.';
    assert.notStrictEqual(acceptable(before, after), null);
});

test('output with no maths markup or unbalanced dollars is rejected', () => {
    // Long enough to clear the truncation check, so each assertion tests what it names.
    const before = 'Скорость тела в этот момент равна v, а ускорение равно a.';
    assert.match(acceptable(before, before), /no maths markup/);
    assert.match(acceptable(before, before.replace('v', '$v')), /unbalanced/);
    assert.match(acceptable(before, ''), /empty or truncated/);
});

test('only statements that actually contain maths are sent for repair', () => {
    assert.ok(HAS_MATHS.test('угол 2α и скорость v'));
    assert.ok(HAS_MATHS.test('τy = τx /3'));
    assert.ok(HAS_MATHS.test('размеры меньше 10−18 м'));
    assert.ok(HAS_MATHS.test('отношение sin углов'));
    // Prose with no notation must not be put at risk by a rewrite it does not need.
    assert.ok(!HAS_MATHS.test('В каком случае заряженная частица движется вдоль силовых линий?'));
    assert.ok(!HAS_MATHS.test('Почему небо голубое, а закат красный?'));
});
