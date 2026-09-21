// A member kept from writing in one chat for a while (lib/chatRestrictions.js, migration 061).
// On 2026-09-21 the owner asked that Бека be unable to post in the Russian community chat for
// 24 hours after two messages there, and that the notice point them at @astrosander. Routes are
// not integration-tested (no test database); what is checked here is the decision and the copy.
// The same evening he moved to the English chat and a DM, so the block became account-wide and
// permanent (migration 062): pg hands 'infinity' back as the number Infinity, and the message
// projection clamps it to the year 9999 so it survives JSON.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isPostingBlocked, isPermanent, effectiveBlock, blockedNotice, blockNotification, CONTACT } = require('../lib/chatRestrictions');

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
