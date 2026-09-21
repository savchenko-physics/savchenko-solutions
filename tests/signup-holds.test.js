// Registrations from listed networks wait for a person (lib/signupHolds.js, migration 062,
// /admin/signups). Written 2026-09-21 for one troublemaker on Tele2 Kazakhstan's mobile pool
// (188.124.224.0/19): his address changed three times in a day, so a plain blocklist would miss
// him, and a block on the whole pool would turn away real students. A hold only delays.
// The registration route and the admin page are not integration-tested (no test database).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { holdFor, isValidCidr, holdNotice } = require('../lib/signupHolds');

const POOL = ['188.124.224.0/19'];

test('the three addresses he used all fall in the held pool', () => {
    for (const ip of ['188.124.234.11', '188.124.246.196', '188.124.236.204']) {
        assert.equal(holdFor(ip, POOL), '188.124.224.0/19', ip);
    }
});

test('an IPv4-mapped address (dual-stack socket) is read as its IPv4', () => {
    assert.equal(holdFor('::ffff:188.124.246.196', POOL), '188.124.224.0/19');
});

test('a bare address in the list is that one address', () => {
    assert.equal(holdFor('1.2.3.4', ['1.2.3.4']), '1.2.3.4');
    assert.equal(holdFor('1.2.3.5', ['1.2.3.4']), null);
});

test('outside the pool, IPv6, garbage and an empty list never match', () => {
    assert.equal(holdFor('188.124.100.1', POOL), null);
    assert.equal(holdFor('188.125.224.1', POOL), null);
    assert.equal(holdFor('2a00:1450::1', ['0.0.0.0/0']), null);
    assert.equal(holdFor('', POOL), null);
    assert.equal(holdFor(undefined, POOL), null);
    assert.equal(holdFor('188.124.246.196', []), null);
    assert.equal(holdFor('188.124.246.196', undefined), null);
});

test('a malformed list entry is skipped, not matched against everything', () => {
    assert.equal(holdFor('188.124.246.196', ['garbage', '188.124.224.0/40', '300.1.1.1/8']), null);
    assert.equal(holdFor('188.124.246.196', ['garbage', '188.124.224.0/19']), '188.124.224.0/19');
});

test('isValidCidr accepts what the admin form should and rejects the rest', () => {
    for (const ok of ['188.124.224.0/19', '1.2.3.4', '10.0.0.0/8', '0.0.0.0/0', '1.2.3.4/32']) assert.equal(isValidCidr(ok), true, ok);
    for (const bad of ['', 'x', '1.2.3', '1.2.3.4/33', '1.2.3.4/-1', '::1', '1.2.3.4/a', '256.1.1.1']) assert.equal(isValidCidr(bad), false, bad);
});

test('the notice tells them it is a check, not a refusal, and follows the punctuation rule', () => {
    for (const lang of ['ru', 'en']) {
        const t = holdNotice(lang);
        assert.match(t, lang === 'ru' ? /вручную/ : /by hand/);
        assert.doesNotMatch(t, /[—:;]/);
    }
});

// Must never hold a real person from elsewhere: the addresses of the site's own contributors
// seen in request_log on the day the list was made.
test('contributors from other networks are never held', () => {
    for (const ip of ['192.68.112.171', '87.241.157.172', '46.216.114.15', '89.111.31.103', '88.154.84.115']) {
        assert.equal(holdFor(ip, POOL), null, ip);
    }
});
