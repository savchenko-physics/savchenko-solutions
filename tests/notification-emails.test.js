// How much mail one address can receive, and what stops a loop from filling an inbox.
//
// The incident (2026-09-16, 04:20 local): ten identical "Albaert_Davronov started following
// you" emails arrived in 27 seconds. Following is a toggle, so twenty clicks made ten follows,
// each with a notification and an email; nothing counted mail per person, so nothing stopped
// it. lib/mailGuard.js has the full account. This file checks:
//   1. the ceiling and which kinds are exempt from it;
//   2. the source rules the three senders must keep — email.js counts before it sends and
//      logs every outcome, notifications.js debounces per thread (and only the *email*, never
//      the bell), index.js announces a follower once a month and rate-limits the toggle;
//   3. that every caller tells email.js what kind of mail it is, because an unlabelled send
//      is an uncountable one.
// Not covered, because the project has no test database: the SQL. The rig run is recorded in
// the deploy notes; the queries are exercised end to end there.
//
// The closing block is the "must never block a real person" set, built from every email the
// site actually sent between 2026-07-18 and 2026-09-16.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guard = require('../lib/mailGuard');
const { LIMITS, UNCAPPED_KINDS, KINDS, normalizeAddress, normalizeKind, isCapped, overRecipientCap, maskAddress } = guard;

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const EMAIL = read('email.js');
const NOTIFY = read('notifications.js');
const INDEX = read('index.js');
const MIGRATION = read('sql/migrations/056_email_sends.sql');

// The real traffic these limits must never get in the way of (measured 2026-09-16 over every
// email since SES went live): the busiest hour one person had, and the busiest day.
const BUSIEST_REAL_HOUR = 10;
const BUSIEST_REAL_DAY = 26;

// ── 1. The ceiling ──────────────────────────────────────────────────────────────────────

test('an address is normalised the same way for counting and for logging', () => {
    assert.equal(normalizeAddress('  Alex@Example.COM '), 'alex@example.com');
    assert.equal(normalizeAddress(undefined), '');
    assert.equal(normalizeAddress(['a@b.c']), '');
});

test('a kind is a short slug, and anything unrecognisable is logged as other', () => {
    assert.equal(normalizeKind('new_follower'), 'new_follower');
    assert.equal(normalizeKind('Reply_To_Comment'), 'reply_to_comment');
    assert.equal(normalizeKind('kind; DROP TABLE'), 'other');
    assert.equal(normalizeKind(undefined), 'other');
    assert.equal(normalizeKind('x'.repeat(41)), 'other');
    for (const kind of KINDS) assert.equal(normalizeKind(kind), kind, kind);
});

test('only the kinds that get a person back into an account are exempt from the ceiling', () => {
    assert.deepEqual([...UNCAPPED_KINDS].sort(), ['appeal_ack', 'email_verify', 'password_reset']);
    for (const kind of UNCAPPED_KINDS) assert.equal(isCapped(kind), false, kind);
    for (const kind of ['new_follower', 'comment_on_solution', 'reply_to_comment', 'email_change', 'other']) {
        assert.equal(isCapped(kind), true, kind);
    }
    // An unknown kind is capped, not exempt: a new sender cannot opt itself out by accident.
    assert.equal(isCapped('some_new_feature'), true);
});

test('the ceiling is per address, hourly and daily, and never applies to recovery mail', () => {
    const at = (lastHour, lastDay, kind = 'new_follower') => overRecipientCap({ kind, lastHour, lastDay });
    assert.equal(at(LIMITS.perAddressPerHour - 1, 0), false);
    assert.equal(at(LIMITS.perAddressPerHour, 0), true);
    assert.equal(at(0, LIMITS.perAddressPerDay), true);
    assert.equal(at(0, LIMITS.perAddressPerDay - 1), false);
    // pg returns count(*)::int as a number; a string must not slip past the comparison.
    assert.equal(at(String(LIMITS.perAddressPerHour), '0'), true);
    assert.equal(at(999, 999, 'password_reset'), false);
    assert.equal(at(999, 999, 'email_verify'), false);
});

test('an address in a log line can be recognised but not harvested', () => {
    assert.equal(maskAddress('alex@savchenkosolutions.com'), 'ale***@savchenkosolutions.com');
    assert.equal(maskAddress('ab@x.io'), 'ab***@x.io');
    assert.equal(maskAddress('not-an-address'), '(no address)');
});

// ── 2. What the senders must keep doing ─────────────────────────────────────────────────

test('email.js counts before it sends, and records every outcome', () => {
    assert.match(EMAIL, /if \(isCapped\(sendKind\)\) \{\s*\n\s*const counts = await recipientCounts\(address\);/);
    for (const status of ['sent', 'failed', 'suppressed']) {
        assert.ok(EMAIL.includes(`status: "${status}"`), status);
    }
    // The count runs before the SendEmailCommand is even loaded.
    assert.ok(EMAIL.indexOf('recipientCounts(address)') < EMAIL.indexOf('SendEmailCommand'));
    assert.ok(EMAIL.indexOf('status: "suppressed"') < EMAIL.indexOf('SendEmailCommand'));
});

test('the bookkeeping fails open: an unreadable log costs the limits, never the mail', () => {
    // recipientCounts returns null on error and the caller only enforces `counts &&`.
    assert.match(EMAIL, /catch \(err\) \{[^}]*recipient counts unavailable[^}]*return null;/s);
    assert.match(EMAIL, /if \(counts && overRecipientCap/);
    assert.match(NOTIFY, /catch \(err\) \{[^}]*debounce unavailable[^}]*return false;/s);
});

test('notifications.js debounces the email per thread, and the bell keeps everything', () => {
    assert.match(NOTIFY, /if \(await emailedAboutRecently\(email, type, link\)\) return;/);
    assert.match(NOTIFY, /make_interval\(mins => \$4\)/);
    assert.match(NOTIFY, /MAIL_LIMITS\.threadDebounceMinutes/);
    // The debounce belongs to the email path only: createNotification still inserts every row,
    // because three replies in a live thread are three things to read.
    const create = NOTIFY.slice(NOTIFY.indexOf('async function createNotification('), NOTIFY.indexOf('async function createMessageNotifications('));
    assert.ok(create.includes('INSERT INTO notifications'));
    assert.doesNotMatch(create, /emailedAboutRecently|threadDebounceMinutes/);
});

test('the follow route announces a follower once a month and limits the toggle', () => {
    const route = INDEX.slice(INDEX.indexOf('app.post("/api/follow/:userId"'), INDEX.indexOf('// Like/Unlike solution'));
    assert.match(route, /app\.post\("\/api\/follow\/:userId", checkAuthenticated, followLimiter,/);
    assert.match(route, /type = 'new_follower' AND link = \$2/);
    assert.match(route, /make_interval\(days => \$3\)/);
    assert.match(route, /MAIL_LIMITS\.followRepeatDays/);
    // The check comes first, and the notification only happens when nothing was found.
    assert.ok(route.indexOf('alreadyTold') < route.indexOf('notifications.createNotification'));
    assert.match(route, /if \(alreadyTold\.rows\.length === 0\) \{/);
    assert.match(INDEX, /max: MAIL_LIMITS\.followTogglesPerHour/);
    assert.match(INDEX, /max: MAIL_LIMITS\.emailChangesPerHour/);
    assert.match(INDEX, /app\.post\("\/:lang\/settings\/account\/email", checkAuthenticated, emailChangeLimiter,/);
});

test('every sender tells email.js what kind of mail it is', () => {
    const senders = ['index.js', 'notifications.js', 'feedback.js', 'accountRecovery.js'];
    for (const file of senders) {
        const src = read(file);
        for (const m of src.matchAll(/sendEmail\(\{/g)) {
            const call = src.slice(m.index, m.index + 400);
            // `kind:` or the shorthand `kind,` (accountRecovery.js passes the dispatch's own).
            assert.match(call, /\bkind[:,]/, `${file} at ${m.index} sends without a kind`);
        }
    }
});

test('the log the limits read is the table the migration creates', () => {
    assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS email_sends/);
    for (const column of ['to_address', 'kind', 'thread', 'status', 'user_id', 'created_at']) {
        assert.ok(MIGRATION.includes(column), column);
    }
    assert.match(MIGRATION, /idx_email_sends_address_time/);
    assert.ok(EMAIL.includes('FROM email_sends'));
    assert.ok(NOTIFY.includes('FROM email_sends'));
});

// ── Must never block a real person ──────────────────────────────────────────────────────

test('the busiest hour and day anyone really had stay under the ceiling', () => {
    assert.ok(LIMITS.perAddressPerHour > BUSIEST_REAL_HOUR, `${LIMITS.perAddressPerHour} <= ${BUSIEST_REAL_HOUR}`);
    assert.ok(LIMITS.perAddressPerDay > BUSIEST_REAL_DAY, `${LIMITS.perAddressPerDay} <= ${BUSIEST_REAL_DAY}`);
    assert.equal(overRecipientCap({ kind: 'comment_on_solution', lastHour: BUSIEST_REAL_HOUR, lastDay: BUSIEST_REAL_DAY }), false);
});

test('a discussion that runs all afternoon still reaches the inbox', () => {
    // One email per thread per window, so an afternoon of replies is a handful of emails,
    // not one per reply, and never silence.
    assert.ok(LIMITS.threadDebounceMinutes <= 120, 'a thread must not go quiet for hours');
    assert.ok(LIMITS.threadDebounceMinutes >= 15, 'a shorter window would not have stopped the flood');
    const perAfternoon = Math.floor((5 * 60) / LIMITS.threadDebounceMinutes);
    assert.ok(perAfternoon >= 4 && perAfternoon < LIMITS.perAddressPerDay);
});

test('a follower who comes back later is announced again', () => {
    assert.ok(LIMITS.followRepeatDays >= 7 && LIMITS.followRepeatDays <= 90);
});

test('the toggle limit is far above anyone browsing the contributor list', () => {
    assert.ok(LIMITS.followTogglesPerHour >= 30);
    // The flood was 20 toggles in 40 seconds; the limit stops the loop, not the reader.
    assert.ok(LIMITS.followTogglesPerHour < 20 * 60);
});
