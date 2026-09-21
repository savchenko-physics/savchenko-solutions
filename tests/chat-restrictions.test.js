// A member kept from writing in one chat for a while (lib/chatRestrictions.js, migration 061).
// On 2026-09-21 the owner asked that one member be unable to post in the Russian community chat for
// 24 hours after two messages there, and that the notice point them at @astrosander. Routes are
// not integration-tested (no test database); what is checked here is the decision and the copy.
// The same evening he moved to the English chat and a DM, so the block became account-wide and
// permanent (migration 062): pg hands 'infinity' back as the number Infinity, and the message
// projection clamps it to the year 9999 so it survives JSON.
'use strict';

const test = require('node:test');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const { isPostingBlocked, isPermanent, effectiveBlock, blockedNotice, blockNotification, writeGuard, CONTACT } = require('../lib/chatRestrictions');

const NOW = new Date('2026-09-21T13:00:00Z');

test('no value, a past value or garbage never blocks', () => {
    assert.equal(isPostingBlocked(null, NOW), false);
    assert.equal(isPostingBlocked(undefined, NOW), false);
    assert.equal(isPostingBlocked(new Date('2026-09-21T12:59:59Z'), NOW), false);
    assert.equal(isPostingBlocked('not a date', NOW), false);
});

test('a future value blocks, as a Date or as the string pg may hand over', () => {
    assert.equal(isPostingBlocked(new Date('2026-09-22T13:00:00Z'), NOW), true);
    assert.equal(isPostingBlocked('2026-09-22T13:00:00Z', NOW), true);
});

test('the notice names the end in the reader\'s zone and the person to ask, in both languages', () => {
    const until = new Date('2026-09-22T13:00:00Z');
    const ru = blockedNotice(until, 'ru', 'Asia/Almaty');
    assert.match(ru, /22 сент\. 2026 г\., 19:00/);
    assert.match(ru, new RegExp(`@${CONTACT}`));
    const en = blockedNotice(until, 'en', 'UTC');
    assert.match(en, /Sep 22, 2026, 1:00 PM/);
    assert.match(en, new RegExp(`@${CONTACT}`));
});

test('the copy follows the owner\'s punctuation rule (no em dash, colon or semicolon)', () => {
    const until = new Date('2026-09-22T13:00:00Z');
    for (const lang of ['ru', 'en']) {
        const texts = [blockedNotice(until, lang, 'UTC'), ...Object.values(blockNotification(until, lang, 'Savchenko Solutions'))];
        for (const t of texts) {
            // A time such as 13:00 keeps its colon; anything else with one is a violation.
            assert.doesNotMatch(t.replace(/\d{1,2}:\d{2}/g, ''), /[—:;]/, t);
        }
    }
});

test('the bell notification names the chat and the person to ask', () => {
    const n = blockNotification(new Date('2026-09-22T13:00:00Z'), 'ru', 'Savchenko Solutions');
    assert.match(n.title, /Savchenko Solutions/);
    assert.match(n.message, /UTC/);
    assert.match(n.message, new RegExp(`@${CONTACT}`));
});

test('an account block for good: Infinity from pg, or the year 9999 the projection clamps it to', () => {
    assert.equal(isPostingBlocked(Infinity, NOW), true);
    assert.equal(isPermanent(Infinity), true);
    assert.equal(isPermanent('9999-12-31T00:00:00Z'), true);
    assert.equal(isPermanent(new Date('2026-09-22T13:00:00Z')), false);
    assert.equal(isPermanent(null), false);
});

test('the later of a chat block and an account block wins, either may be missing', () => {
    const a = new Date('2026-09-22T13:00:00Z'), b = new Date('2026-09-23T13:00:00Z');
    assert.equal(effectiveBlock(null, null), null);
    assert.equal(effectiveBlock(a, null), a);
    assert.equal(effectiveBlock(null, b), b);
    assert.equal(effectiveBlock(a, b), b);
    assert.equal(effectiveBlock(b, a), b);
    assert.equal(effectiveBlock(a, Infinity), Infinity);
});

test('a permanent block\'s copy names no date, and the bell says the site rather than a chat', () => {
    for (const lang of ['ru', 'en']) {
        const notice = blockedNotice(Infinity, lang, 'Asia/Almaty');
        assert.doesNotMatch(notice, /\d{4}/);
        assert.match(notice, new RegExp(`@${CONTACT}`));
        const n = blockNotification(Infinity, lang, null);
        assert.match(n.title, lang === 'ru' ? /на сайте/ : /on this site/);
        assert.match(n.message, new RegExp(`@${CONTACT}`));
        for (const t of [notice, n.title, n.message]) assert.doesNotMatch(t.replace(/\d{1,2}:\d{2}/g, ''), /[—:;]/, t);
    }
});

// 2026-09-21, 20:05 in the Russian chat: "у меня у всех такая надпись". Postgres's LEAST
// skips NULLs, so LEAST(GREATEST(NULL, NULL), '9999-12-31') was 9999-12-31 for everyone and
// every member wore the "не может писать" badge for a quarter of an hour.
test('the message projection yields NULL, not the clamp, for a member with no block', () => {
    const messages = fs.readFileSync(path.join(__dirname, '..', 'messages.js'), 'utf8');
    const col = messages.slice(messages.indexOf('AS sender_blocked_until') - 400, messages.indexOf('AS sender_blocked_until'));
    assert.doesNotMatch(col, /LEAST\(GREATEST\(/, 'LEAST over a possibly-NULL GREATEST returns the clamp');
    assert.match(col, /WHERE b IS NOT NULL/);
});

// ── The write guard on the editor, uploads, comments, reactions and reports (2026-09-21) ──
// The owner's condition when the block was widened from the chat to every route that writes
// content: it must never hold anyone else. So every case but a live block calls next().

function fakeRes() {
    const res = { code: 200, body: null, kind: null };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.kind = 'json'; res.body = b; return res; };
    res.type = () => res;
    res.send = (b) => { res.kind = 'text'; res.body = b; return res; };
    return res;
}
const rowsOf = (v) => async () => ({ rows: v === undefined ? [] : [{ posting_blocked_until: v }] });
async function run(query, req) {
    const res = fakeRes();
    let passed = false;
    await writeGuard(query)(req, res, () => { passed = true; });
    return { passed, res };
}
const signedIn = (extra = {}) => ({ session: { userId: 7, lang: 'ru' }, params: {}, body: {}, get: () => '', originalUrl: '/ru/save/1.1.1', ...extra });

test('the write guard passes everyone who is not blocked', async () => {
    for (const [label, query] of [
        ['no row for the user', rowsOf(undefined)],
        ['NULL', rowsOf(null)],
        ['a block that has ended', rowsOf(new Date(Date.now() - 60_000))],
        ['a string that is not a date', rowsOf('garbage')],
        ['a result with no rows array', async () => ({})],
    ]) {
        const { passed, res } = await run(query, signedIn());
        assert.equal(passed, true, label);
        assert.equal(res.kind, null, label);
    }
});

test('the write guard passes a visitor with no session (the auth middleware answers those)', async () => {
    let queried = false;
    const { passed } = await run(async () => { queried = true; return { rows: [] }; }, { session: {}, params: {}, body: {}, get: () => '' });
    assert.equal(passed, true);
    assert.equal(queried, false, 'no lookup without a user');
});

test('the write guard fails open when the database errors', async () => {
    const { passed, res } = await run(async () => { throw new Error('connection reset'); }, signedIn());
    assert.equal(passed, true);
    assert.equal(res.kind, null);
});

test('the write guard refuses a live block, as JSON for the API and the editor, as text otherwise', async () => {
    const blocked = rowsOf(Infinity);
    let r = await run(blocked, signedIn({ originalUrl: '/api/upload' }));
    assert.equal(r.passed, false);
    assert.equal(r.res.code, 403);
    assert.equal(r.res.kind, 'json');
    assert.match(r.res.body.error, new RegExp(`@${CONTACT}`));
    assert.equal(r.res.body.success, false);
    r = await run(blocked, signedIn({ get: (h) => h === 'Accept' ? 'application/json' : '' }));
    assert.equal(r.res.kind, 'json', 'the editor asks for JSON');
    r = await run(blocked, signedIn({ get: () => 'text/html', originalUrl: '/create-problem' }));
    assert.equal(r.res.kind, 'text');
    assert.equal(r.res.code, 403);
    r = await run(rowsOf(new Date(Date.now() + 3600_000)), signedIn({ params: { lang: 'en' } }));
    assert.equal(r.passed, false);
    assert.match(r.res.body, /^You cannot write in this chat until/);
});

test('every content route in index.js and upload.js carries the guard', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    for (const route of ['app.post("/:lang/save/:name"', 'app.post("/create-problem"', 'app.post("/api/drafts", requireAuthJson', "app.post('/upload-image/:name'",
        'app.post("/api/solutions/:problemName/:language/comments"', 'app.put("/api/solutions/:problemName/:language/comments/:commentId"',
        'app.post("/api/solutions/comments/:commentId/reactions"', 'app.post("/api/solutions/:problemName/:language/like"', 'app.post("/api/report-solution"']) {
        const i = index.indexOf(route);
        assert.ok(i > 0, route);
        assert.match(index.slice(i, i + 200), /blockedWriter/, route);
    }
    const upload = fs.readFileSync(path.join(__dirname, '..', 'upload.js'), 'utf8');
    assert.match(upload, /router\.post\("\/api\/upload", checkAuthenticated, blockedWriter,/);
    const messages = fs.readFileSync(path.join(__dirname, '..', 'messages.js'), 'utf8');
    const react = messages.slice(messages.indexOf("router.post('/:msgId(\\\\d+)/react'"));
    assert.match(react.slice(0, 600), /postingBlockFor\(userId, null\)/);
});
