// The maths renderer must not grow the heap with what it has rendered.
//
// From 2026-09-03 to 2026-09-19 the app died of "Ineffective mark-compacts near heap limit"
// every 10–20 hours (V8's heap on the box is 470 MB), 596 restarts in all, and each death left a
// 1.3 GB core dump on a 16 GB disk. A sampling heap profile of the live process showed the growth
// coming from mathRender.js, and it reproduced offline: mathjax-full's textmacros package never
// releases the parser it creates for each \text{…}, each cache key was a slice pinning the whole
// page it was cut from, and 20,000 two-byte SVG strings were ~370 MB by themselves. These tests
// hold the three fixes in mathRender.js in place. The heap test renders a thousand distinct
// formulas with \text{} three times over in a child process with the garbage collector exposed:
// pass three must cost nothing more than pass two.
//
// Not covered: the size of the live process, which pm2 recycles at 420 MB RSS before V8 can
// abort (deployment notes), and the rendering itself (tests/math-fallback.test.js).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.MATH_CACHE_MB = '0.05';   // 52,429 bytes: a handful of formulas, so eviction is exercised
const { renderMathInHtml, memoryStats, flatString } = require('../mathRender');

function formula(i) {
    return `$v_{${i}} = ${i}\\,\\text{м/с}, \\quad R_{${i}} = ${i * 3}\\,\\text{кОм}$`;
}

test('no text parser is held after a conversion, however many \\text{} it had', () => {
    for (let i = 0; i < 40; i++) {
        renderMathInHtml(`<p>Дано: ${formula(i)} и $$\\text{при } t = ${i}\\,\\text{с}$$</p>`);
        assert.strictEqual(memoryStats().textParsersHeld, 0, `after formula ${i}`);
    }
});

test('the cache stays within its byte budget and evicts the least recently used entry', () => {
    const { budget } = memoryStats();
    assert.strictEqual(budget, Math.round(0.05 * 1024 * 1024));
    for (let i = 100; i < 160; i++) renderMathInHtml(`<p>${formula(i)}</p>`);
    const stats = memoryStats();
    assert.ok(stats.bytes <= budget, `${stats.bytes} bytes in a ${budget} byte cache`);
    assert.ok(stats.entries >= 3 && stats.entries < 20, `${stats.entries} entries`);
    // Least recently used out first: the survivors are the newest few. Using one of the older
    // survivors makes it the newest, so the next new formula evicts its neighbour instead.
    const oldestSurvivor = 160 - stats.entries;
    const hitsBefore = memoryStats().hits;
    renderMathInHtml(`<p>${formula(oldestSurvivor)}</p>`);
    assert.strictEqual(memoryStats().hits, hitsBefore + 1, 'a survivor is a hit');
    renderMathInHtml(`<p>${formula(160)}</p>`);                       // evicts oldestSurvivor + 1
    renderMathInHtml(`<p>${formula(oldestSurvivor)}</p>`);
    assert.strictEqual(memoryStats().hits, hitsBefore + 2, 'the used entry survived');
    const missesBefore = memoryStats().misses;
    renderMathInHtml(`<p>${formula(oldestSurvivor + 1)}</p>`);
    assert.strictEqual(memoryStats().misses, missesBefore + 1, 'its unused neighbour was evicted');
    assert.ok(memoryStats().bytes <= budget);
});

test('a failed formula is remembered as a failure without being re-parsed', () => {
    const html = '<p>$\\frac{$</p>';
    assert.strictEqual(renderMathInHtml(html), html);
    const before = memoryStats().entries;
    renderMathInHtml(html);
    assert.strictEqual(memoryStats().entries, before);
});

test('flatString keeps every code unit, surrogate pairs and lone surrogates included', () => {
    for (const s of ['', 'v_{ср}', 'a\u{1F600}b', '\ud800', 'x\udc00y', 'I|\\text{кОм}']) {
        const copy = flatString(s);
        assert.strictEqual(copy, s);
        assert.strictEqual(copy.length, s.length);
    }
});

test('rendering the same thousand \\text{} formulas again costs no heap', () => {
    const script = `
        const { renderMathInHtml } = require(${JSON.stringify(path.join(__dirname, '..', 'mathRender.js'))});
        const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
        const pages = [];
        for (let i = 0; i < 1000; i++) pages.push('<p>$u_{' + i + '} = ' + i + '\\\\,\\\\text{м/с}$</p>');
        const after = [];
        for (let pass = 0; pass < 3; pass++) {
            for (const p of pages) renderMathInHtml(p);
            after.push(heap());
        }
        console.log(JSON.stringify(after));
    `;
    const run = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
        env: { ...process.env, MATH_CACHE_MB: '0.001' },   // 1 KB: every pass renders again
        encoding: 'utf8',
        timeout: 120000,
    });
    assert.strictEqual(run.status, 0, run.stderr);
    const [, second, third] = JSON.parse(run.stdout.trim().split('\n').pop());
    const grew = (third - second) / 1048576;
    assert.ok(grew < 1, `pass three added ${grew.toFixed(2)} MB of heap (the leak added ~3 MB)`);
});
