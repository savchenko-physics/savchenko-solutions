// The weekly digest: one email a week instead of one per notification.
//
// Why it exists (2026-09-16): every notification worth an email sent one immediately, so three
// replies in a discussion were three emails nine minutes apart and a follow/unfollow toggle was
// ten in twenty-seven seconds. digest.js has the full account. This file checks:
//   1. the email itself — both languages, escaping, no images, every link back to the site,
//      the unsubscribe, the sections that disappear when there is nothing to put in them;
//   2. the excerpt cleaner, which is what stands between a reader and a wall of raw LaTeX;
//   3. who gets one and how often;
//   4. the source rules: notifications send no mail of their own any more, the digest goes
//      out through email.js (so it is logged and counted), and index.js starts the clock.
// Not covered, because the project has no test database: the week's queries. A dry run against
// the real database is one command (scripts/send-digest.js) and is part of the deploy notes.
//
// The closing block is the "must never spam a real person" set: the things that would have to
// be true for this to become the thing it replaced.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderDigest, excerpt, initial, periodLabel, copyFor, COPY } = require('../lib/digestRender');
const { shouldSend, SCHEDULE, SEND_TO_DORMANT, DORMANT_DAYS } = require('../digest');
const { KINDS, isCapped } = require('../lib/mailGuard');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DIGEST = read('digest.js');
const NOTIFY = read('notifications.js');
const INDEX = read('index.js');

const ORIGIN = 'https://savchenkosolutions.com';
const week = {
    fromISO: '2026-09-09T06:00:00.000Z',
    toISO: '2026-09-16T06:00:00.000Z',
};
const base = (over = {}) => ({
    lang: 'ru',
    origin: ORIGIN,
    siteUrl: `${ORIGIN}/ru`,
    settingsUrl: `${ORIGIN}/ru/settings`,
    unsubscribeUrl: `${ORIGIN}/unsubscribe?u=28&t=deadbeef`,
    username: 'astrosander',
    period: week,
    counters: { solutions: 56, comments: 16, members: 9 },
    discussions: [{ problem: '7.2.9', language: 'ru', comments: 4, lastAuthor: 'igor', excerpt: 'Популяризовал задачу', url: `${ORIGIN}/ru/7.2.9` }],
    updates: [{ problem: '12.1.7', language: 'ru', authors: ['Valter'], url: `${ORIGIN}/ru/12.1.7` }],
    wanted: [{ problem: '1.4.12', views: 1874, url: `${ORIGIN}/ru/1.4.12` }],
    replies: [{ kind: 'reply', author: 'Valter', problem: '7.2.10', language: 'ru', excerpt: 'Посмотри на предельный случай', url: `${ORIGIN}/ru/7.2.10` }],
    onYourSolutions: [],
    followers: [{ username: 'Albaert_Davronov', url: `${ORIGIN}/user/Albaert_Davronov` }],
    likes: 7,
    ...over,
});

// ── 1. The email ────────────────────────────────────────────────────────────────────────

test('both languages render a subject, an HTML body and a plain-text body', () => {
    for (const lang of ['ru', 'en']) {
        const mail = renderDigest(base({ lang }));
        assert.ok(mail.subject.length > 10, lang);
        assert.match(mail.html, /^<!doctype html>/, lang);
        assert.ok(mail.text.includes(ORIGIN), lang);
        assert.ok(mail.html.length < 100 * 1024, `${lang} email is too heavy: ${mail.html.length}`);
    }
    assert.notEqual(renderDigest(base({ lang: 'ru' })).subject, renderDigest(base({ lang: 'en' })).subject);
});

test('everything a person typed is escaped', () => {
    const mail = renderDigest(base({
        username: '<script>alert(1)</script>',
        replies: [{ kind: 'reply', author: 'a"b', problem: '1.1.1', language: 'ru', excerpt: '<img src=x onerror=alert(1)> "кавычки"', url: `${ORIGIN}/ru/1.1.1` }],
    }));
    assert.ok(!mail.html.includes('<script>'), 'script tag survived');
    // The words survive as text, which is fine; what must not survive is the tag around them.
    assert.doesNotMatch(mail.html, /<img[^>]*onerror/i, 'an attribute escaped into a tag');
    assert.ok(mail.html.includes('&lt;img src=x onerror=alert(1)'), 'the words stay, as text');
    assert.ok(mail.html.includes('&lt;script&gt;'));
    assert.ok(mail.html.includes('a&quot;b'));
});

test('no images at all, and every link goes to the site', () => {
    const mail = renderDigest(base());
    assert.doesNotMatch(mail.html, /<img\b/, 'an image would be blocked or proxied by the mail client');
    const urls = [...mail.html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(urls.length > 0);
    for (const url of urls) assert.ok(url.startsWith(`${ORIGIN}/`), url);
});

test('the unsubscribe and the settings link are in both bodies', () => {
    const mail = renderDigest(base());
    for (const body of [mail.html, mail.text]) {
        assert.ok(body.includes('/unsubscribe?u=28'), 'unsubscribe link missing');
        assert.ok(body.includes('/ru/settings'), 'settings link missing');
    }
});

test('the layout is the one mail clients can render', () => {
    const html = renderDigest(base()).html;
    assert.match(html, /max-width:600px/);
    assert.match(html, /<!--\[if mso\]>/, 'Outlook needs the fixed-width ghost table');
    assert.match(html, /role="presentation"/);
    assert.doesNotMatch(html, /<script|<style|class="/, 'no scripts, no stylesheet, no classes');
    assert.match(html, /display:none;max-height:0/, 'no preheader');
});

test('a section with nothing in it is not printed', () => {
    const quiet = renderDigest(base({ replies: [], onYourSolutions: [], followers: [], likes: 0, discussions: [], updates: [], wanted: [] }));
    for (const title of [COPY.ru.youTitle, COPY.ru.discussionsTitle, COPY.ru.updatesTitle, COPY.ru.wantedTitle]) {
        assert.ok(!quiet.html.includes(`>${title}<`), `${title} printed with nothing under it`);
    }
    // The counters and the footer always stay.
    assert.ok(quiet.html.includes(COPY.ru.footerWhy));
    assert.ok(quiet.text.includes('56'));
});

test('long lists are cut to what an email can carry', () => {
    const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
    const mail = renderDigest(base({
        replies: many(20, (i) => ({ kind: 'reply', author: `a${i}`, problem: `1.1.${i}`, language: 'ru', excerpt: 'x', url: `${ORIGIN}/ru/1.1.${i}` })),
        discussions: many(20, (i) => ({ problem: `2.2.${i}`, language: 'ru', comments: 2, lastAuthor: 'b', excerpt: 'y', url: `${ORIGIN}/ru/2.2.${i}` })),
        updates: many(30, (i) => ({ problem: `3.3.${i}`, language: 'ru', authors: ['c'], url: `${ORIGIN}/ru/3.3.${i}` })),
        wanted: many(10, (i) => ({ problem: `4.4.${i}`, views: 10, url: `${ORIGIN}/ru/4.4.${i}` })),
    }));
    const count = (re) => (mail.html.match(re) || []).length;
    assert.equal(count(/Задача 1\.1\./g), 6);
    assert.equal(count(/Задача 2\.2\.\d+<\/a>/g), 4);
    assert.equal(count(/Задача 3\.3\./g), 8);
    assert.equal(count(/Задача 4\.4\./g), 3);
});

test('the Russian copy counts in Russian', () => {
    const one = renderDigest(base({ counters: { solutions: 1, comments: 21, members: 3 } })).html;
    assert.ok(one.includes('решение обновлено'), 'a single solution');
    assert.ok(one.includes('комментарий'), '21 comments takes the singular form');
    assert.ok(one.includes('новых участника'), '3 members');
});

// ── 2. Excerpts ─────────────────────────────────────────────────────────────────────────

test('an excerpt reads as prose, not as markup', () => {
    assert.equal(excerpt('**жирный** текст со [ссылкой](http://x) и ![картинкой](/img/a.png)'), 'жирный текст со ссылкой и');
    assert.equal(excerpt('если продолжить $\\vec{v}$, получится $E = mc^2$ и $\\frac{1}{2}$ ответа'),
        'если продолжить v, получится E = mc^2 и 1/2 ответа');
    assert.equal(excerpt('$E_0$ и $$\\int_0^1 x\\,dx$$'), 'E0 и 0^1 x dx');
});

test('an excerpt stops at a word and says that it stopped', () => {
    const long = 'слово '.repeat(60).trim();
    const cut = excerpt(long, 50);
    assert.ok(cut.length <= 51, cut.length);
    assert.ok(cut.endsWith('…'));
    assert.ok(!cut.includes('  '));
    assert.equal(excerpt('короткий текст', 50), 'короткий текст');
    assert.equal(excerpt(null), '');
});

test('the letter in the circle is the first letter of the name', () => {
    assert.equal(initial('Valter'), 'V');
    assert.equal(initial('андрей'), 'А');
    assert.equal(initial(''), '?');
    assert.equal(initial(undefined), '?');
});

test('the period reads naturally in both languages, inside a month and across two', () => {
    assert.equal(periodLabel('2026-09-09T06:00:00Z', '2026-09-16T06:00:00Z', 'ru'), '9 – 16 сентября');
    assert.equal(periodLabel('2026-09-09T06:00:00Z', '2026-09-16T06:00:00Z', 'en'), 'September 9 – 16');
    assert.equal(periodLabel('2026-08-30T06:00:00Z', '2026-09-06T06:00:00Z', 'ru'), '30 августа – 6 сентября');
    assert.equal(periodLabel('2026-08-30T06:00:00Z', '2026-09-06T06:00:00Z', 'en'), 'August 30 – September 6');
});

test('the two languages say the same things', () => {
    const keys = (o) => Object.keys(o).sort();
    assert.deepEqual(keys(COPY.ru), keys(COPY.en));
    assert.deepEqual(keys(COPY.ru.counters), keys(COPY.en.counters));
    assert.equal(copyFor('xx'), COPY.en);
    assert.equal(copyFor('ru'), COPY.ru);
});

// ── 3. Who gets one ─────────────────────────────────────────────────────────────────────

test('news about you is the reason to write; an empty week is not', () => {
    assert.equal(shouldSend({ hasPersonalNews: true, siteHasNews: false, daysSinceSeen: 0 }), true);
    assert.equal(shouldSend({ hasPersonalNews: false, siteHasNews: true, daysSinceSeen: 365 }), SEND_TO_DORMANT);
    assert.equal(shouldSend({ hasPersonalNews: false, siteHasNews: false, daysSinceSeen: 365 }), false);
});

test('the site does not mail a thousand dormant accounts by accident', () => {
    // Turning this on is a newsletter to every account that never came back — the owner's
    // decision, not a side effect of replacing per-event mail.
    assert.equal(SEND_TO_DORMANT, false);
    assert.ok(DORMANT_DAYS >= 7);
});

test('once a week, on a fixed hour, and never twice', () => {
    assert.equal(SCHEDULE.windowDays, 7);
    assert.ok(SCHEDULE.minDaysBetween >= 6 && SCHEDULE.minDaysBetween < SCHEDULE.windowDays);
    assert.ok(SCHEDULE.dayUtc >= 0 && SCHEDULE.dayUtc <= 6);
    assert.ok(SCHEDULE.hourUtc >= 0 && SCHEDULE.hourUtc <= 23);
    // The window must cover the gap between runs, or a week of news falls between two digests.
    assert.ok(SCHEDULE.windowDays * 24 >= 7 * 24);
    assert.ok(SCHEDULE.checkEveryMs <= 60 * 60 * 1000, 'the hour would be missed');
});

// ── 4. The rules the code must keep ─────────────────────────────────────────────────────

test('notifications no longer send mail of their own', () => {
    assert.doesNotMatch(NOTIFY, /sendEmail/, 'a notification that mails is the thing this replaced');
    assert.match(NOTIFY, /DIGEST_NOTIFICATION_TYPES/);
    assert.match(NOTIFY, /INSERT INTO notifications/, 'the bell still gets everything');
});

test('the digest goes out through email.js, logged, counted and one-click unsubscribable', () => {
    assert.match(DIGEST, /kind: 'digest'/);
    assert.match(DIGEST, /List-Unsubscribe/);
    assert.match(DIGEST, /List-Unsubscribe-Post/);
    assert.equal([...DIGEST.matchAll(/sendEmail\(/g)].length, 1, 'one place sends, so one place counts');
    assert.ok(KINDS.includes('digest'));
    assert.equal(isCapped('digest'), true, 'the per-address ceiling still applies to it');
});

test('only people who asked for mail are candidates', () => {
    const q = DIGEST.slice(DIGEST.indexOf('async function candidates('), DIGEST.indexOf('function shouldSend('));
    assert.match(q, /u\.email_verified/);
    assert.match(q, /COALESCE\(up\.email_notifications, true\)/);
    assert.match(q, /kind = 'digest'/, 'a second digest in the same week must be impossible');
    assert.match(q, /make_interval\(days => \$1\)/);
});

test('the weekly clock is started by the app', () => {
    assert.match(INDEX, /digest\.startScheduler\(pool\)/);
    assert.match(DIGEST, /process\.env\.DIGEST/, 'there has to be a way to stop it without a deploy');
});

// ── Must never spam a real person ───────────────────────────────────────────────────────

test('a week of a live discussion is one email, not one per message', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
        kind: 'reply', author: 'Valter', problem: '7.2.10', language: 'ru', excerpt: `ответ ${i}`, url: `${ORIGIN}/ru/7.2.10`,
    }));
    const mail = renderDigest(base({ replies: many }));
    assert.equal(typeof mail.subject, 'string');
    assert.ok(mail.html.length < 100 * 1024);
});

test('the follow toggle that started all this is one line, however many times it was clicked', () => {
    // digest.js asks for DISTINCT followers; ten toggles are one person.
    assert.match(DIGEST, /SELECT DISTINCT f\.following_id AS owner/);
    const mail = renderDigest(base({ followers: [{ username: 'Albaert_Davronov', url: `${ORIGIN}/user/Albaert_Davronov` }] }));
    assert.equal((mail.html.match(/Albaert_Davronov/g) || []).length, 2, 'once as the link text, once in the href');
});
