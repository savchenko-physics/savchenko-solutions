// At 2,007 solved, the founder's birth year, publishing waits for his solution (lib/founderYear.js).
//
// Asked for on 2026-09-18 with the counter at 2,006. emixter's birth-year challenge (#1835 in the
// Russian chat, #1836 in the English one) says that whoever was born in the year the count reaches
// solves the next problem, and astrosander was born in 2007. The gate may only close at exactly
// 2,007, never for the founder, and the notice and the refusal must say the same thing in both
// languages.
//
// Not covered, because there is no test database: the routes that ask (save, /api/upload,
// /create-problem answer 423; the editor, /upload and /drafts show the notice) and the count
// itself, which is the homepage's (unsolved.js getSolutionProgressStats). Drafts never ask: the
// autosave endpoint is untouched, which is what "keep writing" in the notice promises.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FOUNDER, CHALLENGE, founderYearGate, founderYearCopy, founderYearMessage } = require('../lib/founderYear');

const EMIXTER = 232;
const SOMEONE = 1017;

test('the founder is astrosander, born in 2007', () => {
    assert.equal(FOUNDER.username, 'astrosander');
    assert.equal(FOUNDER.year, 2007);
    assert.equal(FOUNDER.userId, 28);
});

test('dormant at 2,006, closed at 2,007, gone at 2,008', () => {
    assert.deepEqual(founderYearGate(2006, EMIXTER), { active: false, founder: false, blocked: false });
    assert.deepEqual(founderYearGate(2007, EMIXTER), { active: true, founder: false, blocked: true });
    assert.deepEqual(founderYearGate(2008, EMIXTER), { active: false, founder: false, blocked: false });
});

test('a session id that arrives as a string is still the founder', () => {
    assert.equal(founderYearGate(2007, '28').founder, true);
    assert.equal(founderYearGate(2007, '28').blocked, false);
});

test('a count that could not be read keeps the gate open', () => {
    for (const solved of [undefined, null, NaN, '2007', 2007.5]) {
        assert.equal(founderYearGate(solved, SOMEONE).blocked, false, String(solved));
    }
});

for (const lang of ['ru', 'en']) {
    for (const founder of [false, true]) {
        const who = founder ? 'the founder' : 'everyone else';

        test(`${lang}, ${who}: names the count, the challenge and its author, and links only inside the site`, () => {
            const { heading, body } = founderYearCopy(lang, founder);
            assert.ok(heading.includes(FOUNDER.year.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US')), heading);
            const links = body.filter((part) => typeof part !== 'string');
            const hrefs = links.map((link) => link.href);
            assert.ok(hrefs.includes(`/${lang}/user/emixter`), hrefs.join(' '));
            assert.ok(hrefs.includes(CHALLENGE.href[lang]), hrefs.join(' '));
            if (founder) assert.ok(hrefs.includes(`/${lang}/unsolved`), 'the founder is sent to a problem that moves the count');
            else assert.ok(hrefs.includes(`/${lang}/user/astrosander`), 'everyone else is told whom they are waiting for');
            for (const href of hrefs) assert.ok(href.startsWith(`/${lang}/`), href);
            for (const link of links) assert.ok(link.text.trim(), 'no empty link');
        });

        test(`${lang}, ${who}: written in its own language, without emoji`, () => {
            const text = founderYearMessage(lang, founder);
            if (lang === 'ru') assert.match(text, /[а-яё]/i);
            else assert.doesNotMatch(text, /[а-яё]/i);
            assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
        });

        test(`${lang}, ${who}: the refusal says what the notice says`, () => {
            const { heading, body } = founderYearCopy(lang, founder);
            const plain = body.map((part) => (typeof part === 'string' ? part : part.text)).join('');
            assert.equal(founderYearMessage(lang, founder), `${heading}. ${plain}`);
            assert.doesNotMatch(plain, / {2}/, 'parts join without doubled spaces');
        });
    }
}

test('everyone else is told their drafts are safe, the founder that an edit does not count', () => {
    assert.match(founderYearMessage('en', false), /drafts are saved/);
    assert.match(founderYearMessage('ru', false), /черновики сохраняются/);
    assert.match(founderYearMessage('en', true), /an edit or a translation does not change the count/);
    assert.match(founderYearMessage('ru', true), /Правка или перевод число решённых не меняют/);
});

// Must never block a real person beyond the one thing asked for.
test('the founder can publish at every count from 0 to 2,023', () => {
    for (let solved = 0; solved <= 2023; solved += 1) {
        assert.equal(founderYearGate(solved, FOUNDER.userId).blocked, false, String(solved));
    }
});

test('nobody is held at any count other than 2,007', () => {
    for (let solved = 0; solved <= 2023; solved += 1) {
        if (solved === FOUNDER.year) continue;
        for (const userId of [EMIXTER, SOMEONE, null]) {
            assert.equal(founderYearGate(solved, userId).blocked, false, `${solved} ${userId}`);
        }
    }
});
