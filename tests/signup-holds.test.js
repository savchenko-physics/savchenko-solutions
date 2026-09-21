// Registrations from listed networks wait for a person (lib/signupHolds.js, migration 062,
// /admin/signups). Written 2026-09-21 for one troublemaker on a mobile carrier's pool: his
// address changed three times in a day, so a plain blocklist would miss him, and a block on the
// whole pool would turn away real students. A hold only delays. The addresses below are the
// documentation ranges of RFC 5737, never anyone's.
// The registration route and the admin page are not integration-tested (no test database).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { holdFor, isValidCidr, holdNotice } = require('../lib/signupHolds');

const POOL = ['203.0.113.0/24'];

test('three addresses in the held pool all match it', () => {
    for (const ip of ['203.0.113.11', '203.0.113.196', '203.0.113.204']) {
        assert.equal(holdFor(ip, POOL), '203.0.113.0/24', ip);
    }
});

test('an IPv4-mapped address (dual-stack socket) is read as its IPv4', () => {
    assert.equal(holdFor('::ffff:203.0.113.196', POOL), '203.0.113.0/24');
});

test('a bare address in the list is that one address', () => {
    assert.equal(holdFor('1.2.3.4', ['1.2.3.4']), '1.2.3.4');
    assert.equal(holdFor('1.2.3.5', ['1.2.3.4']), null);
});

test('outside the pool, IPv6, garbage and an empty list never match', () => {
    assert.equal(holdFor('203.0.112.1', POOL), null);
    assert.equal(holdFor('203.0.114.1', POOL), null);
    assert.equal(holdFor('2a00:1450::1', ['0.0.0.0/0']), null);
    assert.equal(holdFor('', POOL), null);
    assert.equal(holdFor(undefined, POOL), null);
    assert.equal(holdFor('203.0.113.196', []), null);
    assert.equal(holdFor('203.0.113.196', undefined), null);
});

test('a malformed list entry is skipped, not matched against everything', () => {
    assert.equal(holdFor('203.0.113.196', ['garbage', '203.0.113.0/40', '300.1.1.1/8']), null);
    assert.equal(holdFor('203.0.113.196', ['garbage', '203.0.113.0/24']), '203.0.113.0/24');
});

test('isValidCidr accepts what the admin form should and rejects the rest', () => {
    for (const ok of ['203.0.113.0/24', '1.2.3.4', '10.0.0.0/8', '0.0.0.0/0', '1.2.3.4/32']) assert.equal(isValidCidr(ok), true, ok);
    for (const bad of ['', 'x', '1.2.3', '1.2.3.4/33', '1.2.3.4/-1', '::1', '1.2.3.4/a', '256.1.1.1']) assert.equal(isValidCidr(bad), false, bad);
});

test('the notice tells them it is a check, not a refusal, and follows the punctuation rule', () => {
    for (const lang of ['ru', 'en']) {
        const t = holdNotice(lang);
        assert.match(t, lang === 'ru' ? /вручную/ : /by hand/);
        assert.doesNotMatch(t, /[—:;]/);
    }
});

// Must never hold a real person from elsewhere: addresses outside the pool, from the other
// documentation ranges.
test('addresses from other networks are never held', () => {
    for (const ip of ['192.0.2.171', '192.0.2.172', '198.51.100.15', '198.51.100.103', '198.51.100.115']) {
        assert.equal(holdFor(ip, POOL), null, ip);
    }
});
