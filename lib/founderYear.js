// 2,007 solved is the year the founder was born, and until he posts the next solution nobody else
// publishes (2026-09-18).
//
// On 2026-09-08 emixter started a game in the community chats (#1835 ru, #1836 en), «Обозначь свой
// год рождения решением задачи»: when the number of solved problems equals your birth year, the next
// solution is yours, and he draws you into it. He took 1978 himself (13.4.9); Igor's 3.6.20 turned
// out to be 1994's. The founder, astrosander, was born in 2007 and asked that at 2,007 the site wait
// for him: publishing (the editor's Publish, Publish on the drafts page, /upload, /create-problem)
// answers 423 to everyone else, drafts keep saving, and each of those pages says why.
//
// It switches itself on at exactly 2,007 and off at 2,008, the moment his solution moves the count.
// Only a new problem moves it; an edit or a translation of a solved one does not, which is why his
// own notice sends him to the unsolved list.
//
// The count is the homepage's (unsolved.js getSolutionProgressStats: a book problem with a post in
// either language), so the notice never names a number the homepage does not show. If counting
// fails the gate stays open: a joke is not worth locking anyone out by accident.
//
// Covered by tests/founder-year.test.js: the decision and both languages' copy. Not covered: the
// routes that call it (there is no test database).
'use strict';

const FOUNDER = Object.freeze({ userId: 28, username: 'astrosander', year: 2007 });

// The challenge itself, in each community chat (lib/messagesUrls.js, #msg- anchors of messages.ejs).
const CHALLENGE = Object.freeze({
    author: 'emixter',
    href: { ru: '/ru/messages/5#msg-1835', en: '/en/messages/80#msg-1836' },
});

function founderYearGate(solved, userId) {
    const active = Number.isInteger(solved) && solved === FOUNDER.year;
    const founder = userId !== null && userId !== undefined && Number(userId) === FOUNDER.userId;
    return { active, founder, blocked: active && !founder };
}

/* The notice as parts: a string, or { text, href } for a link. The pages render the links, the
   refusal message is the same parts as plain text, so the two cannot drift apart. */
function founderYearCopy(lang, founder) {
    const ru = lang === 'ru';
    const l = ru ? 'ru' : 'en';
    const count = FOUNDER.year.toLocaleString(ru ? 'ru-RU' : 'en-US');
    const year = String(FOUNDER.year);
    const person = (name) => ({ text: `@${name}`, href: `/${l}/user/${name}` });
    const author = person(CHALLENGE.author);
    const challenge = (text) => ({ text, href: CHALLENGE.href[l] });

    if (founder) {
        return ru ? {
            heading: `Решено ${count} задач, это год вашего рождения`,
            body: [
                'По ', challenge('челленджу'), ' ', author,
                ' следующее решение за вами, и пока его нет, остальные публиковать не могут. ',
                'Загрузите решение одной из ', { text: 'нерешённых задач', href: `/${l}/unsolved` },
                '. Правка или перевод число решённых не меняют. ',
                'Как только оно будет опубликовано, публикация откроется для всех.',
            ],
        } : {
            heading: `${count} problems solved, the year you were born`,
            body: [
                'By ', author, '’s ', challenge('birth-year challenge'),
                ' the next solution is yours, and until it is up nobody else can publish. ',
                'Upload a solution to one of the ', { text: 'unsolved problems', href: `/${l}/unsolved` },
                ', since an edit or a translation does not change the count. ',
                'The moment it is published, publishing reopens for everyone.',
            ],
        };
    }

    return ru ? {
        heading: `Решено ${count} задач, это год рождения основателя`,
        body: [
            'По ', challenge('челленджу'), ' ', author,
            ', когда число решённых задач совпадает с вашим годом рождения, следующую задачу решаете вы. ',
            person(FOUNDER.username), ` родился в ${year} году, поэтому сайт ждёт его решение. `,
            'Пока он его не опубликует, публикация для остальных на паузе. ',
            'Продолжайте писать, черновики сохраняются как обычно. ',
            'Как только его решение появится, челлендж будет выполнен и публикация сразу откроется для всех.',
        ],
    } : {
        heading: `${count} problems solved, the year the founder was born`,
        body: [
            'By ', author, '’s ', challenge('birth-year challenge'),
            ', when the number of solved problems equals your birth year, you solve the next one. ',
            `${year} is the year `, person(FOUNDER.username), ' was born, so the site is waiting for his solution. ',
            'Until he publishes it, publishing is paused for everyone else. ',
            'Keep writing, your drafts are saved as usual. ',
            'The moment his solution is up, the challenge is met and publishing reopens for everyone.',
        ],
    };
}

function founderYearMessage(lang, founder) {
    const { heading, body } = founderYearCopy(lang, founder);
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
    return { ...gate, copy: founderYearCopy(lang, gate.founder), message: founderYearMessage(lang, gate.founder) };
}

module.exports = { FOUNDER, CHALLENGE, founderYearGate, founderYearCopy, founderYearMessage, founderYearFor };
