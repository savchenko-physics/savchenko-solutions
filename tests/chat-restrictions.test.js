// A member kept from writing in one chat for a while (lib/chatRestrictions.js, migration 061).
// On 2026-09-21 the owner asked that Бека be unable to post in the Russian community chat for
// 24 hours after two messages there, and that the notice point them at @astrosander. Routes are
// not integration-tested (no test database); what is checked here is the decision and the copy.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isPostingBlocked, blockedNotice, blockNotification, CONTACT } = require('../lib/chatRestrictions');

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
