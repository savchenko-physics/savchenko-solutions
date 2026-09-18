// A solved count that is someone's birth year is that person's turn: until they post the next
// solution nobody else publishes (2026-09-18). 2,007 is the founder's, 2,008 Valter's.
//
// On 2026-09-08 emixter started a game in the community chats (#1835 ru, #1836 en), «Обозначь свой
// год рождения решением задачи»: when the number of solved problems equals your birth year, the next
// solution is yours, and he draws you into it. He took 1978 himself (13.4.9); Igor's 3.6.20 turned
// out to be 1994's. The founder, astrosander, was born in 2007 and asked that at 2,007 the site wait
// for his solution, and then that 2,008 wait for Valter's (Valter gave the year in the chat, #2220).
// On a turn, publishing (the editor's Publish, Publish on the drafts page, /upload, /create-problem)
// answers 423 to everyone but that person, drafts keep saving, and each of those pages says why.
//
// A turn starts at exactly its year and ends the moment the person's solution moves the count, so
// 2,007 hands over to 2,008 and 2,009 is open to everyone. Only a new problem moves the count; an
// edit or a translation of a solved one does not, which is why their own notice sends them to the
// unsolved list. The copy names people by their @handle and never says he or she.
//
// The count is the homepage's (unsolved.js getSolutionProgressStats: a book problem with a post in
// either language), so the notice never names a number the homepage does not show. If counting
// fails the gate stays open: a joke is not worth locking anyone out by accident.
//
// Covered by tests/founder-year.test.js: the decision and both languages' copy. Not covered: the
// routes that call it (there is no test database).
'use strict';

const TURNS = Object.freeze([
    Object.freeze({ year: 2007, userId: 28, username: 'astrosander', founder: true }),
    Object.freeze({ year: 2008, userId: 2543, username: 'Valter' }),
]);

// The challenge itself, in each community chat (lib/messagesUrls.js, #msg- anchors of messages.ejs).
const CHALLENGE = Object.freeze({
    author: 'emixter',
    href: { ru: '/ru/messages/5#msg-1835', en: '/en/messages/80#msg-1836' },
});

function turnAt(solved) {
    return TURNS.find((turn) => turn.year === solved) || null;
}

function founderYearGate(solved, userId) {
    const turn = Number.isInteger(solved) ? turnAt(solved) : null;
    const own = !!turn && userId !== null && userId !== undefined && Number(userId) === turn.userId;
    return { active: !!turn, own, blocked: !!turn && !own, turn };
}

/* The notice as parts: a string, or { text, href } for a link. The pages render the links, the
   refusal message is the same parts as plain text, so the two cannot drift apart. `own` is the
   notice for the person whose turn it is. */
function founderYearCopy(lang, turn, own) {
    const ru = lang === 'ru';
    const l = ru ? 'ru' : 'en';
    const count = turn.year.toLocaleString(ru ? 'ru-RU' : 'en-US');
    const person = (name) => ({ text: `@${name}`, href: `/${l}/user/${name}` });
    const author = person(CHALLENGE.author);
    const challenge = (text) => ({ text, href: CHALLENGE.href[l] });
    const unsolved = (text) => ({ text, href: `/${l}/unsolved` });
    const next = turnAt(turn.year + 1);

    if (own) {
        return ru ? {
            heading: `Решено ${count} задач, это год вашего рождения`,
            body: [
                'По ', challenge('челленджу'), ' ', author,
                ' следующее решение за вами, и пока его нет, остальные публиковать не могут. ',
                'Загрузите решение одной из ', unsolved('нерешённых задач'),
                '. Правка или перевод число решённых не меняют. ',
                ...(next
                    ? ['После вашего решения очередь ', person(next.username), `, ${next.year} года рождения.`]
                    : ['Как только оно будет опубликовано, публикация откроется для всех.']),
            ],
        } : {
            heading: `${count} problems solved, the year you were born`,
            body: [
                'By ', author, '’s ', challenge('birth-year challenge'),
                ' the next solution is yours, and until it is up nobody else can publish. ',
                'Upload a solution to one of the ', unsolved('unsolved problems'),
                ', since an edit or a translation does not change the count. ',
                ...(next
                    ? ['After yours the turn passes to ', person(next.username), `, born in ${next.year}.`]
                    : ['The moment it is published, publishing reopens for everyone.']),
            ],
        };
    }

    return ru ? {
        heading: `Решено ${count} задач, это год рождения ${turn.founder ? 'основателя' : turn.username}`,
        body: [
            'По ', challenge('челленджу'), ' ', author,
            ', когда число решённых задач совпадает с вашим годом рождения, следующую задачу решаете вы. ',
            'Сайт ждёт решения от ', person(turn.username), `, ${turn.year} года рождения. `,
            'Пока его нет, публикация для остальных на паузе. ',
            'Продолжайте писать, черновики сохраняются как обычно. ',
            ...(next
                ? ['После него очередь ', person(next.username), `, ${next.year} года рождения, и только потом публикация откроется для всех.`]
                : ['Как только решение появится, челлендж будет выполнен и публикация сразу откроется для всех.']),
        ],
    } : {
        heading: `${count} problems solved, the year ${turn.founder ? 'the founder' : turn.username} was born`,
        body: [
            'By ', author, '’s ', challenge('birth-year challenge'),
            ', when the number of solved problems equals your birth year, you solve the next one. ',
            'The site is waiting for a solution from ', person(turn.username), `, born in ${turn.year}. `,
            'Until it is up, publishing is paused for everyone else. ',
            'Keep writing, your drafts are saved as usual. ',
            ...(next
                ? ['After it the turn passes to ', person(next.username), `, born in ${next.year}, and only then does publishing reopen for everyone.`]
                : ['The moment it is published, the challenge is met and publishing reopens for everyone.']),
        ],
    };
}

function founderYearMessage(lang, turn, own) {
    const { heading, body } = founderYearCopy(lang, turn, own);
    return `${heading}. ${body.map((part) => (typeof part === 'string' ? part : part.text)).join('')}`;
}

/* Counting reads the CSVs and both posts/ folders synchronously, about 45 ms on the server
   (measured 2026-09-18). A page that only shows the notice reuses a count up to 10 s old; the
   decision to refuse a publish always counts afresh. */
const PAGE_COUNT_TTL_MS = 10 * 1000;
let lastCount = { at: 0, solved: null };

async function currentSolvedCount(fresh) {
    if (!fresh && lastCount.solved !== null && Date.now() - lastCount.at < PAGE_COUNT_TTL_MS) return lastCount.solved;
    // Required here, not at the top: the tests load this file without the site's posts.
    const stats = await require('../unsolved').getSolutionProgressStats('en');
    lastCount = { at: Date.now(), solved: stats.solvedProblems };
    return lastCount.solved;
}

/* The gate for one person, with the notice to show, or null when there is nothing to say.
   `fresh` for the decision to refuse a publish; pages that only explain may use a recent count. */
async function founderYearFor(userId, lang, { fresh = false } = {}) {
    let solved;
    try {
        solved = await currentSolvedCount(fresh);
    } catch (err) {
        console.error('founderYear: could not count solved problems', err);
        return null;
    }
    const gate = founderYearGate(solved, userId);
    if (!gate.active) return null;
    return {
        ...gate,
        copy: founderYearCopy(lang, gate.turn, gate.own),
        message: founderYearMessage(lang, gate.turn, gate.own),
    };
}

module.exports = { TURNS, CHALLENGE, founderYearGate, founderYearCopy, founderYearMessage, founderYearFor };
