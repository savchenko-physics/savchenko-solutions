// The two community chats: which language a message is in, who starts muted where, and the
// language plumbing around them.
//
// Until 2026-09 there was one site-wide chat. 215 of its 253 messages were Russian and 12
// English; English speakers had nowhere to talk and Russian speakers posted English copies
// of their own messages. It is now an English and a Russian chat
// (conversations.community_lang, migration 051, scripts/split-community-chat.js). Everyone
// is in both, the chat in a person's other language starts muted, and the composer gives a
// quiet hint, with a link, when a draft is in the other chat's language.
//
// Covered here: the decision logic (js/chat-language.js, lib/communityChats.js,
// normalizeLang, localizeNotification), the split script's text surgery, and a few source
// checks for the wiring. Not covered, because there is no test database: the SQL in
// messages.js and the split script. The script was rehearsed end to end (apply, top-up,
// undo, byte-identical state after undo) against a copy of the production chat before it
// ran.
//
// The closing block holds the "never block a real person" invariants: a hint is advice,
// and nothing about a message's language may stop it from being sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { textLanguage, languageHint } = require('../js/chat-language');
const {
    COMMUNITY_TITLES,
    otherLang,
    classifyUserLanguage,
    writesLanguage,
    mutedByDefault,
    communityAvatarSVG,
} = require('../lib/communityChats');
const { normalizeLang } = require('../utils');
const { localizeNotification } = require('../notifications');
const { splitOnce, splitPracticum, MOVE, SPLIT } = require('../scripts/split-community-chat');

// Real lines from the common chat, as they were posted.
const ENGLISH_LINES = [
    'Hi people',
    'can I just start trying to solve problems',
    'Yes, you can post your solutions.',
    'Hi, an interesting discussion',
    'nice website revamp',
    "Good morning. I’ve been meaning to address the platform's new users for a while.",
];
const RUSSIAN_LINES = [
    'Спасибо за чат, этого не хватало!',
    'Здравствуйте',
    'Sergey_Kuleshov, на какую тему планируете переключится?',
    'Добавил как расширенный поиск задач: https://savchenkosolutions.com/problems',
    'Это были не ляпы... (maybe)',
    'Поддерживаю @Valter, посчитал что между мешком и телом прослойка атмосферного воздуха',
    'Вообще решая задачу $X$ савченко ожидает хоть и мысленно ссылаться на задачу $X-n$, где $n<X$.',
];
// Posted in the chat too, and in no particular language.
const NEUTRAL_LINES = ['+0.5', 'https://savchenkosolutions.com/ru/2.4.31', 'OK', '', '   ', '$$a(t) = bt$$', '@emixter', 'С 2.1.4', '14.5.17'];

test('textLanguage reads the real chat lines the way a person would', () => {
    for (const line of ENGLISH_LINES) assert.equal(textLanguage(line), 'en', line);
    for (const line of RUSSIAN_LINES) assert.equal(textLanguage(line), 'ru', line);
    for (const line of NEUTRAL_LINES) assert.equal(textLanguage(line), null, JSON.stringify(line));
    assert.equal(textLanguage(null), null);
    assert.equal(textLanguage(undefined), null);
});

test('languageHint points only at the other chat, and only for clear text', () => {
    assert.equal(languageHint('Hi people', 'ru'), 'en');
    assert.equal(languageHint('Hi people', 'en'), null);
    assert.equal(languageHint('Спасибо за чат, этого не хватало!', 'en'), 'ru');
    assert.equal(languageHint('Спасибо за чат, этого не хватало!', 'ru'), null);
    assert.equal(languageHint('Это были не ляпы... (maybe)', 'ru'), null);
    for (const line of NEUTRAL_LINES) {
        assert.equal(languageHint(line, 'en'), null, JSON.stringify(line));
        assert.equal(languageHint(line, 'ru'), null, JSON.stringify(line));
    }
    assert.equal(languageHint('Hi people', undefined), null, 'no hint outside a community chat');
    assert.equal(languageHint('Hi people', 'de'), null);
});

test('classifyUserLanguage prefers what a person wrote over what is guessed about them', () => {
    assert.equal(classifyUserLanguage({ groupChatEn: 3, name: 'Иван Петров' }), 'en', 'writing beats a name');
    assert.equal(classifyUserLanguage({ groupChatRu: 2, groupChatEn: 2 }), 'ru', 'a tie goes to the chat they were already in');
    assert.equal(classifyUserLanguage({ name: 'Евгений Дубровин', contribEn: 40 }), 'ru', 'a Cyrillic name beats contribution language');
    assert.equal(classifyUserLanguage({ contribRu: 5, contribEn: 9 }), 'en');
    assert.equal(classifyUserLanguage({ country: 'Kazakhstan', sessionLang: 'en' }), 'ru');
    assert.equal(classifyUserLanguage({ email: 'someone@yandex.ru', sessionLang: 'en' }), 'ru');
    assert.equal(classifyUserLanguage({ email: 'student@mail.kz' }), 'ru');
    assert.equal(classifyUserLanguage({ country: 'Peru', sessionLang: 'ru' }), 'en');
    assert.equal(classifyUserLanguage({ sessionLang: 'en' }), 'en');
    assert.equal(classifyUserLanguage({ sessionLang: "en'||DBMS_PIPE.RECEIVE_MESSAGE(CHR(98),15)||'" }), null, 'probe strings are not a language');
    assert.equal(classifyUserLanguage({}), null);
    assert.equal(classifyUserLanguage(undefined), null);
});

test('mutedByDefault: the other language starts muted, moderators and bilingual writers see both', () => {
    for (const chatLang of ['en', 'ru']) {
        assert.equal(mutedByDefault({ chatLang, userLang: otherLang(chatLang), isModerator: true }), false, 'moderators answer newcomers in both');
        assert.equal(mutedByDefault({ chatLang, userLang: otherLang(chatLang), writesChatLang: true }), false, 'people who write in it keep it');
        assert.equal(mutedByDefault({ chatLang, userLang: chatLang }), false);
        assert.equal(mutedByDefault({ chatLang, userLang: otherLang(chatLang) }), true);
    }
    // Unknown language keeps the state from before the split: the Russian chat as it was,
    // the new English chat quiet.
    assert.equal(mutedByDefault({ chatLang: 'ru', userLang: null }), false);
    assert.equal(mutedByDefault({ chatLang: 'en', userLang: null }), true);
    // conversation_members.muted is NOT NULL: never anything but a boolean.
    for (const args of [undefined, {}, { chatLang: 'en' }, { chatLang: 'xx', userLang: 'yy' }]) {
        assert.equal(typeof mutedByDefault(args), 'boolean', JSON.stringify(args));
    }
});

test('writesLanguage counts group-chat messages and contributed solutions', () => {
    assert.equal(writesLanguage({ groupChatEn: 1 }, 'en'), true);
    assert.equal(writesLanguage({ contribRu: 2 }, 'ru'), true);
    assert.equal(writesLanguage({ contribRu: 2 }, 'en'), false);
    assert.equal(writesLanguage({}, 'ru'), false);
});

test('community chat titles and avatars follow the design rules', () => {
    assert.equal(COMMUNITY_TITLES.en, 'Savchenko Solutions English');
    assert.equal(COMMUNITY_TITLES.ru, 'Savchenko Solutions Русский');
    for (const lang of ['en', 'ru']) {
        const svg = communityAvatarSVG(lang, 44);
        assert.match(svg, lang === 'en' ? />EN</ : />RU</);
        assert.doesNotMatch(svg, /gradient/i, 'no gradients anywhere');
        assert.match(svg, /#1a1a2e/);
    }
});

test('normalizeLang turns every stored session probe into the site default', () => {
    const probes = [
        "en'\"", "en0'XOR(if(now()=sysdate(),sleep(15),0))XOR'Z", "en-1 waitfor delay '0:0:15' -- ",
        "if(now()=sysdate(),sleep(15),0)", '-1 OR 2+777-777-1=0+0+0+1', '/evil.example', '//evil.example',
        'RU', 'ru ', undefined, null, 1, {}, 'en',
    ];
    for (const p of probes) assert.equal(normalizeLang(p), 'en', JSON.stringify(p));
    assert.equal(normalizeLang('ru'), 'ru');
});

test('chat notifications read in the reader language, and nothing else changes', () => {
    const chat = { id: 1, type: 'new_message', title: 'New message from emixter', message: '[Image]', link: '/messages/5' };
    assert.deepEqual(localizeNotification(chat, 'ru'), { ...chat, title: 'Новое сообщение от emixter', message: '[Фото]' });
    assert.equal(localizeNotification({ ...chat, message: '[File]' }, 'ru').message, '[Файл]');
    assert.equal(localizeNotification({ ...chat, message: 'Hi people' }, 'ru').message, 'Hi people', 'message text is never translated');
    assert.equal(localizeNotification(chat, 'en'), chat);
    const other = { type: 'new_follower', title: 'New follower', message: 'x' };
    assert.equal(localizeNotification(other, 'ru'), other);
    assert.equal(chat.title, 'New message from emixter', 'the stored row is not mutated');
});

test('the split script cuts bilingual posts only where the author put the separator', () => {
    assert.deepEqual(splitOnce('Привет!\n--\nHello!', '\n--\n'), { ru: 'Привет!', en: 'Hello!' });
    assert.throws(() => splitOnce('no separator here', '\n--\n'));
    assert.throws(() => splitOnce('a\n--\nb\n--\nc', '\n--\n'), 'a second separator means the text is not the reviewed one');

    const links = [
        'https://sites.google.com/view/theorphys-2026/2026-front-page-eng',
        'https://sites.google.com/view/theorphys-2026/2026-front-page-ru',
        'https://sites.google.com/view/theorphys-2026/2026-front-page-ukr',
    ];
    const post = ['**Практикум**\n\nПривет!', '**Practicum**\n\nHi!',
        ['Подробности / Details (ENG · RUS · UKR):', ...links, '', 'Полная информация в баннере на главной. Full info is in the homepage banner.'].join('\n'),
    ].join('\n\n•••\n\n');
    const { ru, en } = splitPracticum(post);
    assert.equal(ru, ['**Практикум**\n\nПривет!', '', 'Подробности (ENG · RUS · UKR):', ...links, '', 'Полная информация в баннере на главной.'].join('\n'));
    assert.equal(en, ['**Practicum**\n\nHi!', '', 'Details (ENG · RUS · UKR):', ...links, '', 'Full info is in the homepage banner.'].join('\n'));
    assert.equal(textLanguage(en.replace(/\*\*/g, '')), 'en');
    assert.throws(() => splitPracticum(post.replace('Full info', 'All info')));

    const ids = [...MOVE, ...SPLIT].map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'a message is either moved or split, once');
    assert.ok(!ids.includes(836), '836 is a bare link inside a Russian thread and stays');
    for (const m of [...MOVE, ...SPLIT]) assert.match(m.md5, /^[0-9a-f]{32}$/, `#${m.id}`);
});

test('the wiring: registration, the header badge and the history pager', () => {
    // Since 2026-09-21 the account itself is created by lib/accounts.js (the registration route
    // and an admin approving a held signup share it), so the chat wiring lives there.
    const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    const accounts = fs.readFileSync(path.join(ROOT, 'lib', 'accounts.js'), 'utf8');
    assert.match(index, /await createAccount\(\{/, 'registration creates the account through lib/accounts.js');
    assert.doesNotMatch(accounts, /title = 'Savchenko Solutions'/, 'registration must not find the chat by a title moderators can rename');
    assert.match(accounts, /community_lang = ANY\(\$1\)/);
    assert.match(accounts, /!!mutedByDefault\(/);

    const messages = fs.readFileSync(path.join(ROOT, 'messages.js'), 'utf8');
    const badge = messages.slice(messages.indexOf('async function getUnreadMessageCount'));
    assert.match(badge.slice(0, 900), /cm\.muted = FALSE/, 'muted chats do not add to the header badge');
    assert.match(messages, /\(m\.created_at, m\.id\) < \(SELECT cur\.created_at, cur\.id FROM messages cur WHERE cur\.id = \$2\)/,
        'history pages by (created_at, id): the split halves have new ids but old timestamps');
});

// ── Must never block a real person ──────────────────────────────────────────────────────

test('sending a message never depends on its language', () => {
    // The chat's script is js/messages-page.js since 2026-09-21 (it was inlined in the template).
    const view = fs.readFileSync(path.join(ROOT, 'js', 'messages-page.js'), 'utf8');
    const start = view.indexOf('function sendMessage()');
    assert.ok(start > 0, 'sendMessage() not found in js/messages-page.js');
    // The function body, up to the next top-level function of the inline script.
    const body = view.slice(start, view.indexOf('\n  function ', start + 1));
    assert.doesNotMatch(body, /languageHint|textLanguage|ChatLanguage|langHint|COMMUNITY_LANG/);

    const server = fs.readFileSync(path.join(ROOT, 'messages.js'), 'utf8');
    const send = server.slice(server.indexOf("router.post('/:id(\\\\d+)/send'"), server.indexOf("router.put('/:msgId(\\\\d+)/edit'"));
    assert.ok(send.length > 200, 'send route not found in messages.js');
    assert.doesNotMatch(send, /chat-language|textLanguage|languageHint|community_lang/, 'the server never rejects a message for its language');
});

test('the hint has only three possible answers, and never throws on what people type', () => {
    const inputs = [...ENGLISH_LINES, ...RUSSIAN_LINES, ...NEUTRAL_LINES, 'Ё'.repeat(10000), '$'.repeat(501), '```\nconst x = 1;\n```', '😀😀😀', 'ℏω = E'];
    for (const input of inputs) {
        for (const chat of ['en', 'ru']) {
            const hint = languageHint(input, chat);
            assert.ok(hint === null || hint === 'en' || hint === 'ru', `${JSON.stringify(input).slice(0, 40)} → ${hint}`);
        }
    }
});

// 2026-09-21: a moderator deleted a 32-message spree and every member kept 32 bell entries and a
// header count that included the deleted messages.
test('a deleted message leaves no unread count and takes its notifications with it', () => {
    const messages = fs.readFileSync(path.join(ROOT, 'messages.js'), 'utf8');
    const total = messages.slice(messages.indexOf('async function getUnreadMessageCount'));
    assert.match(total.slice(0, 900), /mx\.deleted_at IS NULL/, 'the header total skips deleted messages');
    const del = messages.slice(messages.indexOf("router.delete('/:msgId(\\\\d+)/delete'"));
    assert.match(del.slice(0, 3500), /notifications\.removeForMessage\(msgId\)/);
    const notif = fs.readFileSync(path.join(ROOT, 'notifications.js'), 'utf8');
    assert.match(notif, /INSERT INTO notifications \(user_id, type, title, message, link, message_id\)/);
    for (const call of messages.matchAll(/createMessageNotifications\(([\s\S]*?)\);/g)) {
        assert.match(call[1], /\.rows\[0\]\.id\s*$/, 'every fan-out names its message: ' + call[1].replace(/\s+/g, ' '));
    }
});
