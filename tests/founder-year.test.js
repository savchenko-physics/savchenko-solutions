// A solved count that is someone's birth year waits for that person's solution (lib/founderYear.js):
// 2,007 for the founder, 2,008 for Valter.
//
// Asked for on 2026-09-18 with the counter at 2,006. emixter's birth-year challenge (#1835 in the
// Russian chat, #1836 in the English one) says that whoever was born in the year the count reaches
// solves the next problem; astrosander was born in 2007, and Valter, who gave the year in the chat,
// in 2008. A turn may only hold at exactly its year, never for its own person, 2,007 must hand over
// to 2,008 and 2,009 be open, and the notice and the refusal must say the same thing in both
// languages.
//
// Only a first post of a problem is held, because only that moves the count. On the first day the
// editor's Publish was held too, and Daniyar could not correct a wrong solution (2026-09-19); the
// count had reached 2,007 that morning. So: an edit is never a first post, a translation is never a
// first post, and the notice says both work as usual.
//
// Not covered, because there is no test database: the routes that ask (/api/upload and
// /create-problem answer 423; /upload shows the notice) and the count itself, which is the
// homepage's (unsolved.js getSolutionProgressStats). The save route and the drafts endpoints do
// not ask at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TURNS, CHALLENGE, founderYearGate, isFirstPost, founderYearCopy, founderYearMessage } = require('../lib/founderYear');

const FOUNDER = 28;
const VALTER = 2543;
const EMIXTER = 232;
const SOMEONE = 1017;
const turnOf = (year) => TURNS.find((turn) => turn.year === year);

test('2,007 is the founder astrosander, 2,008 is Valter', () => {
    assert.deepEqual(TURNS.map((t) => [t.year, t.userId, t.username]), [[2007, FOUNDER, 'astrosander'], [2008, VALTER, 'Valter']]);
    assert.equal(turnOf(2007).founder, true);
    assert.ok(!turnOf(2008).founder);
});

test('open at 2,006, the founder alone at 2,007, Valter alone at 2,008, open again at 2,009', () => {
    const blocked = (solved, userId) => founderYearGate(solved, userId).blocked;
    for (const userId of [FOUNDER, VALTER, EMIXTER, null]) assert.equal(blocked(2006, userId), false);
    assert.deepEqual([FOUNDER, VALTER, EMIXTER, null].map((id) => blocked(2007, id)), [false, true, true, true]);
    assert.deepEqual([FOUNDER, VALTER, EMIXTER, null].map((id) => blocked(2008, id)), [true, false, true, true]);
    for (const userId of [FOUNDER, VALTER, EMIXTER, null]) assert.equal(blocked(2009, userId), false);
});

test('a session id that arrives as a string is still its owner', () => {
    assert.equal(founderYearGate(2007, '28').own, true);
    assert.equal(founderYearGate(2008, '2543').blocked, false);
});

test('a count that could not be read keeps the gate open', () => {
    for (const solved of [undefined, null, NaN, '2007', 2007.5, '2008']) {
        assert.equal(founderYearGate(solved, SOMEONE).blocked, false, String(solved));
    }
});

for (const year of [2007, 2008]) {
    for (const lang of ['ru', 'en']) {
        for (const own of [false, true]) {
            const turn = turnOf(year);
            const who = own ? turn.username : 'everyone else';

            test(`${year} ${lang}, ${who}: names the count, the challenge and its author, and links only inside the site`, () => {
                const { heading, body } = founderYearCopy(lang, turn, own);
                assert.ok(heading.includes(year.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US')), heading);
                const links = body.filter((part) => typeof part !== 'string');
                const hrefs = links.map((link) => link.href);
                assert.ok(hrefs.includes(`/${lang}/user/emixter`), hrefs.join(' '));
                assert.ok(hrefs.includes(CHALLENGE.href[lang]), hrefs.join(' '));
                if (own) assert.ok(hrefs.includes(`/${lang}/unsolved`), 'sent to a problem that moves the count');
                else assert.ok(hrefs.includes(`/${lang}/user/${turn.username}`), 'told whom they are waiting for');
                for (const href of hrefs) assert.ok(href.startsWith(`/${lang}/`), href);
                for (const link of links) assert.ok(link.text.trim(), 'no empty link');
            });

            test(`${year} ${lang}, ${who}: says what comes after the turn`, () => {
                const { body } = founderYearCopy(lang, turn, own);
                const hrefs = body.filter((part) => typeof part !== 'string').map((link) => link.href);
                const text = founderYearMessage(lang, turn, own);
                if (year === 2007) {
                    assert.ok(hrefs.includes(`/${lang}/user/Valter`), 'the founder hands over to Valter');
                    assert.match(text, /2008/);
                } else {
                    assert.ok(!hrefs.includes(`/${lang}/user/astrosander`), 'no turn after Valter');
                    assert.match(text, lang === 'ru' ? /снова смогут добавлять все\.$/ : /can add new solutions again\.$/);
                }
            });

            test(`${year} ${lang}, ${who}: written in its own language, without emoji or a guessed gender`, () => {
                const text = founderYearMessage(lang, turn, own);
                if (lang === 'ru') assert.match(text, /[а-яё]/i);
                else assert.doesNotMatch(text, /[а-яё]/i);
                assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
                // \b does not see Cyrillic letters, so word edges are spelled out
                const word = (list) => new RegExp(`(?<!\\p{L})(${list})(?!\\p{L})`, 'iu');
                if (lang === 'en') assert.doesNotMatch(text, word('he|she|his|her|him'));
                else assert.doesNotMatch(text, word('родился|родилась|он|она|его решение'));
            });

            test(`${year} ${lang}, ${who}: the refusal says what the notice says`, () => {
                const { heading, body } = founderYearCopy(lang, turn, own);
                const plain = body.map((part) => (typeof part === 'string' ? part : part.text)).join('');
                assert.equal(founderYearMessage(lang, turn, own), `${heading}. ${plain}`);
                assert.doesNotMatch(plain, / {2}/, 'parts join without doubled spaces');
            });
        }
    }
}

test('everyone else is told that edits, translations and drafts work, the person whose turn it is that an edit does not count', () => {
    for (const turn of TURNS) {
        assert.match(founderYearMessage('en', turn, false), /Editing published solutions, translations and drafts work as usual/);
        assert.match(founderYearMessage('ru', turn, false), /Правки опубликованных решений, переводы и черновики работают как обычно/);
        assert.match(founderYearMessage('en', turn, true), /an edit or a translation does not change the count/);
        assert.match(founderYearMessage('ru', turn, true), /Правка или перевод число решённых не меняют/);
    }
});

// What is held: only a post that would be the problem's first in either language.
test('a first post is one with no file in either language; a translation or an edit is not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-year-'));
    try {
        for (const lang of ['en', 'ru']) fs.mkdirSync(path.join(dir, lang));
        fs.writeFileSync(path.join(dir, 'ru', '5.8.9.md'), '# solved in Russian');
        fs.writeFileSync(path.join(dir, 'en', '1.1.1.md'), '# solved in English');
        fs.writeFileSync(path.join(dir, 'ru', '1.1.1.md'), '# and in Russian');
        assert.equal(isFirstPost('14.3.6', dir), true, 'nothing in either language');
        assert.equal(isFirstPost('5.8.9', dir), false, 'an English translation of a Russian solution');
        assert.equal(isFirstPost('1.1.1', dir), false, 'an edit of a solution in both languages');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a name that is not a problem number is never a first post, so it is never held', () => {
    for (const name of ['', '../x', '5.8', 'abc', null, undefined, '1.1.1.md']) {
        assert.equal(isFirstPost(name, os.tmpdir()), false, String(name));
    }
});

// Must never block a real person beyond the one thing asked for.
test('whoever holds a turn can publish at every count from 0 to 2,023, except the other turn', () => {
    for (let solved = 0; solved <= 2023; solved += 1) {
        assert.equal(founderYearGate(solved, FOUNDER).blocked, solved === 2008, `founder at ${solved}`);
        assert.equal(founderYearGate(solved, VALTER).blocked, solved === 2007, `Valter at ${solved}`);
    }
});

test('nobody is held at any count other than 2,007 and 2,008', () => {
    for (let solved = 0; solved <= 2023; solved += 1) {
        if (solved === 2007 || solved === 2008) continue;
        for (const userId of [FOUNDER, VALTER, EMIXTER, SOMEONE, null]) {
            assert.equal(founderYearGate(solved, userId).blocked, false, `${solved} ${userId}`);
        }
    }
});
