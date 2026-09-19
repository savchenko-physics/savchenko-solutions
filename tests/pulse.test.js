// Live alerts on every page (js/pulse.js, GET /messages/pulse, lib/pulse.js), and the language in
// the messenger's addresses (lib/messagesUrls.js).
//
// Reported 2026-09-15: a message only reached someone who had /messages open, because the header's
// badge and bell were drawn once per page load; and the messenger was the one part of the site
// whose address did not say which language it was in (/messages/5, where every other page is
// /ru/... or /en/...). What this file guards: who gets an alert (never the whole thousand-member
// community chat for every message; always a reply or a mention), that a mention is a whole word,
// that a bare /messages address still reaches the same page with its query intact (links stored in
// notifications and emails), and that the header and chat link to the language addresses.
//
// Not covered, because there is no browser or test database here: the polling itself, the cards'
// layout, and the SQL of the pulse route. Those were checked on a scratch copy of the schema in
// Firefox before release.
//
// The closing block holds the "must never block a real person" invariants.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const { mentionsUser, alertKind, previewText, LARGE_CONVERSATION_MEMBERS } = require('../lib/pulse');
const { langFromMessagesPath, preferredLang, langMessagesUrl, messagesPath } = require('../lib/messagesUrls');

const me = { userId: 28, username: 'astrosander' };
const msg = (over) => Object.assign({ senderId: 232, isGroup: false, memberCount: 2, muted: false, replyToSenderId: null, content: 'привет', isSaved: false }, over);

// ── Who gets an alert ────────────────────────────────────────────────────────────────────

test('a DM or a small group alerts, the community chats do not', () => {
    assert.equal(alertKind(msg(), me), 'dm');
    assert.equal(alertKind(msg({ isGroup: true, memberCount: 5 }), me), 'group');
    assert.equal(alertKind(msg({ isGroup: true, memberCount: LARGE_CONVERSATION_MEMBERS }), me), 'group');
    assert.equal(alertKind(msg({ isGroup: true, memberCount: 1014 }), me), null, 'every message of the community chat would bury the rest');
    assert.equal(alertKind(msg({ muted: true }), me), null, 'a muted DM stays quiet');
    assert.equal(alertKind(msg({ senderId: 28 }), me), null, 'never about your own message');
    assert.equal(alertKind(msg({ isSaved: true, senderId: 5 }), me), null, 'saved messages are not news');
});

test('a reply or a mention alerts anywhere, even in a muted thousand-member chat', () => {
    const big = { isGroup: true, memberCount: 1014, muted: true };
    assert.equal(alertKind(msg(Object.assign({ replyToSenderId: 28 }, big)), me), 'reply');
    assert.equal(alertKind(msg(Object.assign({ content: 'смотри, @astrosander, тут ошибка' }, big)), me), 'mention');
    assert.equal(alertKind(msg(Object.assign({ replyToSenderId: 999 }, big)), me), null, 'a reply to someone else');
});

test('a mention is the whole name, in any case, and an email address is not one', () => {
    assert.equal(mentionsUser('@astrosander посмотри', 'astrosander'), true);
    assert.equal(mentionsUser('Спасибо, @AstroSander!', 'astrosander'), true);
    assert.equal(mentionsUser('(@astrosander)', 'astrosander'), true);
    assert.equal(mentionsUser('@astrosander_2 это не он', 'astrosander'), false);
    assert.equal(mentionsUser('@astrosanderx', 'astrosander'), false);
    assert.equal(mentionsUser('mail astro@astrosander.com', 'astrosander'), false);
    assert.equal(mentionsUser('astrosander без собаки', 'astrosander'), false);
    assert.equal(mentionsUser('@Picksell Prod', 'Picksell Prod'), true, 'old names with spaces');
    assert.equal(mentionsUser('@a.b+c', 'a.b+c'), true, 'regex characters in a name are literal');
    assert.equal(mentionsUser('@aXb+c', 'a.b+c'), false);
    for (const odd of [null, undefined, 42, {}]) {
        assert.equal(mentionsUser(odd, 'x'), false);
        assert.equal(mentionsUser('@x', odd), false);
    }
});

test('the card shows one line of the message, or what was sent', () => {
    assert.equal(previewText('  много\n\nпробелов  '), 'много пробелов');
    assert.equal(previewText('x'.repeat(300), { max: 100 }).length, 100);
    assert.ok(previewText('x'.repeat(300)).endsWith('…'));
    assert.equal(previewText('', { imageUrl: '/img/messages/a.png', lang: 'ru' }), 'Фото');
    assert.equal(previewText('', { imageUrl: '/img/messages/a.png', lang: 'en' }), 'Photo');
    assert.equal(previewText('', { fileName: 'lecture.pdf', lang: 'ru' }), 'lecture.pdf');
    assert.equal(previewText('', { fileName: 'IMG_0042.MOV', lang: 'ru' }), 'Видео');
    assert.equal(previewText('', { fileName: 'clip.webm', lang: 'en' }), 'Video');
    assert.equal(previewText('', { fileName: 'Berea College 58.m4a', lang: 'ru' }), 'Аудио');
    assert.equal(previewText('', { fileName: 'solution.pdf' }), 'solution.pdf');
    assert.equal(previewText(null), '');
});

// ── Addresses with a language ────────────────────────────────────────────────────────────

test('a messenger address says its language, and a bare one keeps its page and query', () => {
    assert.equal(langFromMessagesPath('/ru/messages'), 'ru');
    assert.equal(langFromMessagesPath('/en/messages/5?app=last-problem'), 'en');
    assert.equal(langFromMessagesPath('/ru/messages/saved'), 'ru');
    assert.equal(langFromMessagesPath('/messages/5'), null);
    assert.equal(langFromMessagesPath('/ru/messagesX'), null);
    assert.equal(langFromMessagesPath('/de/messages'), null);

    assert.equal(langMessagesUrl('/messages', 'ru'), '/ru/messages');
    assert.equal(langMessagesUrl('/messages/', 'en'), '/en/messages');
    assert.equal(langMessagesUrl('/messages/5', 'ru'), '/ru/messages/5');
    assert.equal(langMessagesUrl('/messages/5?app=last-problem', 'ru'), '/ru/messages/5?app=last-problem');
    assert.equal(langMessagesUrl('/messages/saved', 'en'), '/en/messages/saved');
    assert.equal(langMessagesUrl('/messages/5', 'xx'), '/en/messages/5');

    assert.equal(messagesPath('ru'), '/ru/messages');
    assert.equal(messagesPath('en', 80), '/en/messages/80');
});

test('the language for a bare address: the session, else the browser, else English', () => {
    assert.equal(preferredLang({ sessionLang: 'ru', acceptLanguage: 'en-US,en;q=0.9' }), 'ru');
    assert.equal(preferredLang({ acceptLanguage: 'ru-RU,ru;q=0.9,en;q=0.8' }), 'ru');
    assert.equal(preferredLang({ acceptLanguage: 'en-GB,ru;q=0.5' }), 'en');
    assert.equal(preferredLang({ acceptLanguage: 'de-DE,ru;q=0.7,en;q=0.3' }), 'ru', 'the first of the two it asks for');
    assert.equal(preferredLang({ acceptLanguage: 'kk-KZ' }), 'en');
    assert.equal(preferredLang({ sessionLang: 'de' }), 'en');
    assert.equal(preferredLang({}), 'en');
});

// ── Wiring ───────────────────────────────────────────────────────────────────────────────

test('the messenger answers at /:lang/messages before the solution catch-all, and its pages redirect bare addresses', () => {
    const index = read('index.js');
    const mount = index.indexOf("app.use('/:lang(en|ru)/messages', messagesRouter);");
    assert.ok(mount > 0);
    assert.ok(mount < index.indexOf('app.get("/:lang/:name"'));
    const messages = read('messages.js');
    for (const route of ["router.get('/', async", "router.get('/saved', async", "router.get('/:id(\\\\d+)', async"]) {
        const at = messages.indexOf(route);
        assert.ok(at > 0, route);
        assert.match(messages.slice(at, at + 400), /pageLang\(req, res\)/, `${route} takes its language from the address`);
    }
    assert.doesNotMatch(messages, /redirect\(`\/messages|redirect\('\/messages/, 'no redirect to a bare messenger address');
    assert.match(messages, /router\.get\('\/pulse'/);
});

test('the header and the chat link to the language addresses', () => {
    const header = read('views', 'default', 'main_site_header.ejs');
    assert.doesNotMatch(header, /href="\/messages/);
    assert.equal((header.match(/href="\/<%= navLang %>\/messages"/g) || []).length, 2);
    assert.match(header, /id="nav-msg-badge"/);
    assert.match(header, /id="nav-msg-badge-m"/);
    // Only for someone signed in: the pulse script sits inside the navUser block.
    const at = header.indexOf("asset('/js/pulse.js')");
    assert.ok(at > 0);
    assert.ok(header.lastIndexOf('<% if (navUser) { %>', at) > header.lastIndexOf('<% } %>', at));

    const chat = read('views', 'messages.ejs');
    assert.doesNotMatch(chat, /href="\/messages/);
    assert.doesNotMatch(chat, /location\.href = '\/messages/);
});

// ── Must never block a real person ───────────────────────────────────────────────────────

test('a DM from anyone reaches an unmuted recipient, whatever the text', () => {
    for (const content of ['', ')))', '@', 'https://savchenkosolutions.com/ru/2.1.4', '$\\frac{1}{2}$', 'x'.repeat(5000)]) {
        assert.equal(alertKind(msg({ content }), me), 'dm', JSON.stringify(content.slice(0, 20)));
    }
    assert.equal(alertKind(msg({ senderId: null }), me), 'dm', 'a deleted sender still counts as someone else');
});

test('every bare messenger address a notification ever stored still resolves to a page', () => {
    for (const link of ['/messages', '/messages/5', '/messages/80', '/messages/5?app=last-problem', '/messages/123456']) {
        for (const lang of ['ru', 'en']) {
            const to = langMessagesUrl(link, lang);
            assert.equal(langFromMessagesPath(to), lang, `${link} -> ${to}`);
            assert.ok(to.endsWith(link.replace(/^\/messages/, '')), `${link} -> ${to} keeps its page`);
        }
    }
});
