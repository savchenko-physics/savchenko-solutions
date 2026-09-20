/**
 * svg-statement-figures.test.js — the rule that gave every post the book's vector statement
 * figure (scripts/svg-statement-figures.js), pinned to what astrosander did by hand for section
 * 1.1 on 2026-09-20. The script rewrote 848 posts on the server in one go and records nothing in
 * `contributions`, so the decisions it makes are the only review those edits get: it must never
 * touch a contributor's own drawing, a statement section with several images, or one of the
 * twenty problems whose book bitmap still holds a neighbour's figure.
 *
 * Not covered: the files themselves (the server's posts/ is the authoritative copy and there is
 * no copy of it here), and how the rewritten markdown renders (tests/solution-structure.test.js
 * covers transformImageMarkdown).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { plan, scalePercent, statementEnd, SHARED_BITMAP } = require('../scripts/svg-statement-figures');

/** viewBox of each 1.1 figure and the share the owner chose (contributions 20837–20856). */
const OWNER = [
    ['1.1.1', 436, 371, 26], ['1.1.4', 724, 405, 40], ['1.1.5', 479, 178, 40], ['1.1.8', 818, 274, 50],
    ['1.1.9', 720, 447, 40], ['1.1.10', 622, 421, 40], ['1.1.13', 898, 328, 65], ['1.1.15', 904, 898, 60],
    ['1.1.16', 847, 365, 50], ['1.1.17', 943, 591, 60], ['1.1.18', 412, 484, 30], ['1.1.19', 660, 513, 40],
    ['1.1.20', 729, 436, 40], ['1.1.21', 434, 483, 30], ['1.1.22', 542, 616, 30], ['1.1.23', 837, 394, 45],
];

test('the scale rule lands within one 5 % step of the owner\'s section 1.1 choices', () => {
    let exact = 0;
    for (const [name, w, h, owner] of OWNER) {
        const pct = scalePercent({ w, h });
        const slack = name === '1.1.13' ? 10 : 5; // the one graph they pushed two steps up
        assert.ok(Math.abs(pct - owner) <= slack, `${name}: rule ${pct}, owner ${owner}`);
        if (pct === owner) exact += 1;
    }
    assert.ok(exact >= 7, `only ${exact} exact`);
});

test('a flat figure is lifted to 120 px tall, a small one a little, and nothing goes under 25 %', () => {
    assert.equal(scalePercent({ w: 479, h: 178 }), 40);   // 1.1.5: 30 % would be 89 px tall
    assert.equal(scalePercent({ w: 412, h: 484 }), 30);   // 1.1.18: half is 206, shown at 240
    assert.equal(scalePercent({ w: 253, h: 300 }), 25);   // the book's smallest drawing
    assert.equal(scalePercent({ w: 1499, h: 400 }), 95);  // 3.4.8, the widest
    assert.equal(scalePercent({ w: 4000, h: 400 }), 100);
});

test('the statement section ends at the first heading after the first line of content', () => {
    const text = '###  Условие:\n\n$1.1.13.$ По графику.\n\n![ Для 1.1.13 |971x284, 80%](../../img/1.1.13/statement.png)\n\n###  Решение:\n\nтекст ![|1x1, 50%](../../img/1.1.13/sol.png)\n';
    assert.equal(text.slice(statementEnd(text)).split('\n')[0], '###  Решение:');
    const noHeading = '\n\n$1.1.1.$ text\n\n![|1x1](../../img/1.1.1/a.png)\n';
    assert.equal(statementEnd(noHeading), noHeading.length);
});

/** A scratch img/ tree with one SVG so plan() can read a viewBox. */
function withSvg(name, w, h, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-figures-'));
    const svg = path.join(dir, 'statement.svg');
    fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${Math.round(w * 0.42)}" height="${Math.round(h * 0.42)}"></svg>`);
    try { return fn(svg); } finally { fs.rmSync(dir, { recursive: true }); }
}

const post = (image, name = '1.1.13') => `###  Условие:\n\n$${name}.$ По графику.\n\n${image}\n\n###  Решение:\n\nтекст\n`;

test('statement.png becomes statement.svg with the viewBox and the rule\'s share; a book caption stays', () => {
    withSvg('1.1.1', 436, 371, (svg) => {
        const p = plan(post('![ К задаче 1.1.1 |507x327, 26%](../../img/1.1.1/statement.png)', '1.1.1'), '1.1.1', svg);
        assert.equal(p.action, 'rewrite');
        assert.equal(p.to, '![ К задаче 1.1.1 |436x371, 30%](../../img/1.1.1/statement.svg)');
        assert.ok(p.text.includes(p.to) && !p.text.includes('statement.png'));
        assert.ok(p.text.endsWith('###  Решение:\n\nтекст\n'));
    });
});

test('an alt that only names the figure is blanked, as the owner blanked "Для 1.1.13"', () => {
    withSvg('1.1.13', 898, 328, (svg) => {
        for (const alt of [' Для 1.1.13 ', 'Для задачи $1.1.13$', 'Figure for 1.1.13', '1.1.13.png', ' For problem $1.1.13^*$ ', 'К задаче 1.1.12', '']) {
            const p = plan(post(`![${alt}|971x284, 80%](../../img/1.1.13/kin.png)`), '1.1.13', svg);
            assert.equal(p.action, 'rewrite', alt);
            const kept = /^\s*(к задаче|for problem)\s+\$?1\.1\.13/i.test(alt);
            assert.equal(p.to, `![${kept ? alt : ''}|898x328, 55%](../../img/1.1.13/statement.svg)`, alt);
        }
    });
});

test('a contributor\'s own captioned drawing, several images, another folder and a shared bitmap are left alone', () => {
    withSvg('5.2.3', 800, 400, (svg) => {
        const own = plan(post('![Функция распределения скоростей|808x422, 65%](../../img/5.2.3/5.2.3.png)', '5.2.3'), '5.2.3', svg);
        assert.equal(own.action, 'own-caption');
        const two = plan(post('![|1x1, 50%](../../img/5.2.3/a.png)\n![|1x1, 50%](../../img/5.2.3/b.png)', '5.2.3'), '5.2.3', svg);
        assert.equal(two.action, 'several-images');
        const other = plan(post('![|1x1, 50%](../../img/5.2.4/a.png)', '5.2.3'), '5.2.3', svg);
        assert.equal(other.action, 'other-folder');
        const done = plan(post('![|800x400, 50%](../../img/5.2.3/statement.svg)', '5.2.3'), '5.2.3', svg);
        assert.equal(done.action, 'already-svg');
        const none = plan(post('', '5.2.3'), '5.2.3', svg);
        assert.equal(none.action, 'no-image');
        // An image after the solution heading is not a statement figure.
        const later = plan(`###  Условие:\n\n$5.2.3.$ x\n\n###  Решение:\n\n![|1x1, 50%](../../img/5.2.3/statement.png)\n`, '5.2.3', svg);
        assert.equal(later.action, 'no-image');
    });
    withSvg('5.4.6', 600, 800, (svg) => {
        assert.ok(SHARED_BITMAP.has('5.4.6'));
        const p = plan(post('![К задаче $5.4.6$|300x200, 50%](../../img/5.4.6/5.4.6.png)', '5.4.6'), '5.4.6', svg);
        assert.equal(p.action, 'shared-bitmap');
    });
    assert.equal(plan(post('![|1x1, 50%](../../img/9.9.9/statement.png)', '9.9.9'), '9.9.9', '/nonexistent/statement.svg').action, 'no-svg');
});
