// lib/postStatement.js: the statement section of a solution post, which lib/statementRender.js
// shows in place of a statement still flattened from the scan (needs_review). /ru/3.5.27's
// preview read "ω = √g/l" while its post carried $\omega_{0} = \sqrt{g/l}$ (2026-09-20).
// Not covered: the renderer's choice itself (needs Postgres); the rule is three lines there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { postStatement } = require('../lib/postStatement');

function withPost(lang, name, md, fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-statement-'));
    fs.mkdirSync(path.join(root, 'posts', lang), { recursive: true });
    fs.writeFileSync(path.join(root, 'posts', lang, `${name}.md`), md);
    try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('the statement section, without the book number, up to the next heading', () => {
    const md = '### Условие \n\n$3.5.27.$ Если отклонить грузики, частота $\\omega_0 = \\sqrt{g/l}$.\n\n$$x_1 = B\\cos\\omega t$$\n\n### Решение\n\nНе условие.\n';
    withPost('ru', '3.5.27', md, (root) => {
        assert.equal(postStatement('3.5.27', 'ru', root), 'Если отклонить грузики, частота $\\omega_0 = \\sqrt{g/l}$.\n\n$$x_1 = B\\cos\\omega t$$');
    });
});

test('every spelling of the heading the posts use; the number in its other forms', () => {
    for (const [heading, lang] of [['### Statement', 'en'], ['## Условие:', 'ru'], ['#### Problem statement', 'en'], ['### Условия', 'ru']]) {
        withPost(lang, '1.2.3', `${heading}\n**1.2.3.** Text $x$.\n### Solution\n`, (root) => {
            assert.equal(postStatement('1.2.3', lang, root), 'Text $x$.', heading);
        });
    }
});

test('no post, no statement heading, or an empty section: null, never a throw', () => {
    assert.equal(postStatement('99.9.9', 'ru', os.tmpdir()), null);
    assert.equal(postStatement('../etc/passwd', 'ru'), null, 'only a problem number is a file name');
    withPost('ru', '1.1.1', '### Решение\n\nТолько решение.\n', (root) => assert.equal(postStatement('1.1.1', 'ru', root), null));
    withPost('ru', '1.1.1', '### Условие\n\n$1.1.1.$\n\n### Решение\n', (root) => assert.equal(postStatement('1.1.1', 'ru', root), null));
});

// lib/statementRender.js's two text repairs, pure and exported.
const { repairStrayDollar, breakSubItems } = require('../lib/statementRender');

test('a stray opening dollar left by the builder goes; balanced dollars are never touched', () => {
    assert.equal(repairStrayDollar('а.$ Из вещества $l$.'), 'а. Из вещества $l$.');
    assert.equal(repairStrayDollar('*.$  Какую $x$'), 'Какую $x$');
    assert.equal(repairStrayDollar('^*$ В вакууме $y$'), 'В вакууме $y$');
    assert.equal(repairStrayDollar('а. $x$ и $y$'), 'а. $x$ и $y$', 'even count: as it is');
    assert.equal(repairStrayDollar('$x$ и $'), '$x$ и $', 'odd but not at the start: left for a person');
});

test('a sub-item after a sentence end opens a paragraph; an abbreviation does not', () => {
    assert.equal(breakSubItems('…со скоростью $\\beta c$? б. Решите задачу.'), '…со скоростью $\\beta c$?\n\nб. Решите задачу.');
    assert.equal(breakSubItems('Find the force. b. The velocity of the body.'), 'Find the force.\n\nb. The velocity of the body.');
    assert.equal(breakSubItems('увеличивается и т. д. Чем объясняется'), 'увеличивается и т. д. Чем объясняется');
    assert.equal(breakSubItems('а. Первый.\n\nб. Второй.'), 'а. Первый.\n\nб. Второй.', 'already separate');
    assert.equal(breakSubItems('при $t = 0$. в. Найдите $v$.'), 'при $t = 0$.\n\nв. Найдите $v$.');
});
