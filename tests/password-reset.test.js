// Account recovery: "Forgot password?", the reset link and the recovery appeal.
//
// The incident (2026-09-15): the owner asked for a reset, no email came, and the page had said
// one was on its way. Five real people had hit the same wall since May and registered a new
// account instead. The rewrite also closed an open mail relay: /recover-account emailed any
// address typed into it, and neither form had a rate limit. lib/passwordReset.js has the full
// account; this file checks the decisions it makes:
//   1. what counts as input, and which accounts a lookup picks;
//   2. the email limits, including simulated floods: however many requests arrive, the site
//      sends at most emailsPerSitePerHour in any hour and emailsPerAccountPerDay to any account;
//   3. the cross-site check, the token and its cookie, the link origin, the new password;
//   4. the emails and the copy, in both languages;
//   5. a few source-level rules accountRecovery.js must keep: the only sendEmail call is the
//      one after the locked decision, a paused site is decided before any lookup, and the SQL
//      counts exactly the outcomes the migration's indexes cover.
// Not covered, because the project has no test database: the SQL and the advisory lock
// themselves. accountRecovery.js says where they were exercised.
//
// The last block holds the "must never block a real person" invariants, built from the real
// requests of 2026-05-17 to 2026-09-15, as in tests/botgate.test.js and tests/feedback.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('../lib/passwordReset');
const {
    LIMITS, OUTCOMES, OUTCOME_LABELS, EMAIL_OUTCOMES, SITE_ORIGIN, RESET_COOKIE,
    parseIdentifier, pickAccounts, siteLimitReached, decideSend, isCrossSite, isResetToken,
    readResetCookie, linkOrigin, validateNewPassword, buildResetEmail, buildAppealEmail, copyFor,
} = policy;

const ROOT = path.join(__dirname, '..');
const ROUTER = fs.readFileSync(path.join(ROOT, 'accountRecovery.js'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'sql/migrations/053_password_reset_outcome.sql'), 'utf8');

const TOKEN = 'a'.repeat(64);
const quiet = { lastHour: 0, lastDay: 0 };
const fresh = { lastDay: 0, secondsSinceLast: null };

// ── 1. Input and lookup ─────────────────────────────────────────────────────────────────

test('the identifier is trimmed and otherwise left alone for the case-insensitive SQL', () => {
    assert.deepEqual(parseIdentifier('  Ivan.Petrov@Gmail.com \n'), { ok: true, value: 'Ivan.Petrov@Gmail.com' });
    assert.deepEqual(parseIdentifier('андрей'), { ok: true, value: 'андрей' });
});

test('empty, whitespace, missing, array and oversized identifiers are refused', () => {
    assert.equal(parseIdentifier('').error, 'empty');
    assert.equal(parseIdentifier('   ').error, 'empty');
    assert.equal(parseIdentifier(undefined).error, 'empty');
    // body-parser's extended mode turns identifier[]=a&identifier[]=b into an array, which pg
    // would otherwise send as a PostgreSQL array literal.
    assert.equal(parseIdentifier(['a@b.c', 'd@e.f']).error, 'empty');
    assert.equal(parseIdentifier({ $ne: '' }).error, 'empty');
    assert.equal(parseIdentifier('x'.repeat(LIMITS.identifierMaxLength + 1)).error, 'too_long');
    assert.equal(parseIdentifier('x'.repeat(LIMITS.identifierMaxLength)).ok, true);
});

const row = (id, flags) => ({ id, username: `u${id}`, email: `u${id}@example.org`,
    email_match: false, email_exact: false, username_match: false, username_exact: false, ...flags });

test('an address that differs from the stored one only in case finds the account', () => {
    const picked = pickAccounts([row(1, { email_match: true })]);
    assert.deepEqual(picked.map((r) => r.id), [1]);
});

test('an exact username wins over one that differs only in case ("mark" and "Mark" are two accounts)', () => {
    const rows = [row(1, { username_match: true, username_exact: true }), row(2, { username_match: true })];
    assert.deepEqual(pickAccounts(rows).map((r) => r.id), [1]);
});

test('case-only variants with no exact match are all mailed, each at its own address, up to the cap', () => {
    const rows = [1, 2, 3, 4, 5].map((id) => row(id, { username_match: true }));
    assert.deepEqual(pickAccounts(rows).map((r) => r.id), [1, 2, 3].slice(0, LIMITS.accountsPerRequest));
});

test('an address match wins over a username that happens to be the same address', () => {
    const rows = [row(1, { username_match: true, username_exact: true }), row(2, { email_match: true })];
    assert.deepEqual(pickAccounts(rows).map((r) => r.id), [2]);
});

test('no rows, or no usable rows, pick nothing', () => {
    assert.deepEqual(pickAccounts([]), []);
    assert.deepEqual(pickAccounts(undefined), []);
    assert.deepEqual(pickAccounts([row(1, {})]), []);
});

// ── 2. The limits ───────────────────────────────────────────────────────────────────────

test('a first request on a quiet site sends', () => {
    assert.equal(decideSend({ site: quiet, account: fresh }), 'send');
});

test('the account limit: per day, and a minimum gap', () => {
    assert.equal(decideSend({ site: quiet, account: { lastDay: LIMITS.emailsPerAccountPerDay - 1, secondsSinceLast: 3600 } }), 'send');
    assert.equal(decideSend({ site: quiet, account: { lastDay: LIMITS.emailsPerAccountPerDay, secondsSinceLast: 3600 } }), 'account_limit');
    const gap = LIMITS.secondsBetweenAccountEmails;
    assert.equal(decideSend({ site: quiet, account: { lastDay: 1, secondsSinceLast: gap - 1 } }), 'account_limit');
    assert.equal(decideSend({ site: quiet, account: { lastDay: 1, secondsSinceLast: gap } }), 'send');
});

test('the site ceiling, hourly and daily, comes before anything about the account', () => {
    assert.equal(siteLimitReached({ lastHour: LIMITS.emailsPerSitePerHour - 1, lastDay: 0 }), false);
    assert.equal(siteLimitReached({ lastHour: LIMITS.emailsPerSitePerHour, lastDay: 0 }), true);
    assert.equal(siteLimitReached({ lastHour: 0, lastDay: LIMITS.emailsPerSitePerDay }), true);
    // pg returns count(*)::int as a number, but a string must not slip through either.
    assert.equal(siteLimitReached({ lastHour: String(LIMITS.emailsPerSitePerHour), lastDay: '0' }), true);
    assert.equal(decideSend({ site: { lastHour: LIMITS.emailsPerSitePerHour, lastDay: 0 }, account: fresh }), 'site_limit');
});

// Replays requests through the same decisions accountRecovery.js makes under its lock, with
// the database's counts computed from the emails "sent" so far.
function replay(requests) {
    const sent = [];
    for (const { t, account } of requests) {
        const inWindow = (e, seconds) => e.t > t - seconds;
        const site = {
            lastHour: sent.filter((e) => inWindow(e, 3600)).length,
            lastDay: sent.filter((e) => inWindow(e, 86400)).length,
        };
        if (siteLimitReached(site)) continue;
        const mine = sent.filter((e) => e.account === account && inWindow(e, 86400));
        const last = mine.length ? mine[mine.length - 1].t : null;
        const decision = decideSend({ site, account: { lastDay: mine.length, secondsSinceLast: last === null ? null : t - last } });
        if (decision === 'send') sent.push({ t, account });
    }
    return sent;
}

function maxInAnyWindow(times, seconds) {
    let best = 0;
    for (let i = 0, j = 0; i < times.length; i += 1) {
        while (times[i] - times[j] >= seconds) j += 1;
        best = Math.max(best, i - j + 1);
    }
    return best;
}

test('a flood of 3,000 requests an hour for two days, over 1,000 accounts, stays inside the ceilings', () => {
    const requests = [];
    for (let i = 0; i < 3000 * 48; i += 1) requests.push({ t: i * 1.2, account: i % 1000 });
    const sent = replay(requests);
    const times = sent.map((e) => e.t);
    assert.ok(maxInAnyWindow(times, 3600) <= LIMITS.emailsPerSitePerHour, `hour: ${maxInAnyWindow(times, 3600)}`);
    assert.ok(maxInAnyWindow(times, 86400) <= LIMITS.emailsPerSitePerDay, `day: ${maxInAnyWindow(times, 86400)}`);
    assert.ok(sent.length <= 2 * LIMITS.emailsPerSitePerDay, `total: ${sent.length}`);
});

test('one address hammered once a second for a day receives at most the account limit', () => {
    const requests = Array.from({ length: 86400 }, (_, t) => ({ t, account: 'victim' }));
    const sent = replay(requests);
    assert.equal(sent.length, LIMITS.emailsPerAccountPerDay);
    for (let i = 1; i < sent.length; i += 1) {
        assert.ok(sent[i].t - sent[i - 1].t >= LIMITS.secondsBetweenAccountEmails);
    }
});

test('the ceilings are far below "thousands an hour" and a token outlives its reuse window', () => {
    assert.ok(LIMITS.emailsPerSitePerHour <= 100);
    assert.ok(LIMITS.emailsPerSitePerDay >= LIMITS.emailsPerSitePerHour);
    assert.ok(LIMITS.emailsPerAccountPerDay <= LIMITS.emailsPerSitePerHour);
    assert.ok(LIMITS.tokenReuseMinutes * 60 > LIMITS.secondsBetweenAccountEmails);
    assert.ok(LIMITS.tokenHours * 60 > LIMITS.tokenReuseMinutes);
});

// ── 3. Cross-site check, token, cookie, origin, password ────────────────────────────────

test('only a submission from this site\'s own page counts as same-site', () => {
    const host = 'savchenkosolutions.com';
    assert.equal(isCrossSite({ fetchSite: 'same-origin', origin: `https://${host}`, host }), false);
    assert.equal(isCrossSite({ fetchSite: 'cross-site', origin: 'https://evil.example', host }), true);
    // A sibling subdomain (the sandbox runs other people's code) is not this page either.
    assert.equal(isCrossSite({ fetchSite: 'same-site', origin: `https://sandbox.${host}`, host }), true);
    assert.equal(isCrossSite({ fetchSite: 'none', host }), false);
});

test('without Sec-Fetch-Site the Origin decides, and a browser sending neither is let through', () => {
    const host = 'savchenkosolutions.com';
    assert.equal(isCrossSite({ origin: `https://${host}`, host }), false);
    assert.equal(isCrossSite({ origin: 'https://evil.example', host }), true);
    assert.equal(isCrossSite({ origin: 'not a url', host }), true);
    assert.equal(isCrossSite({ origin: 'null', host }), false);
    assert.equal(isCrossSite({ host }), false);
    assert.equal(isCrossSite({ origin: 'http://localhost:3300', host: 'localhost:3300' }), false);
});

test('a reset token is exactly 64 lowercase hex characters', () => {
    assert.equal(isResetToken(TOKEN), true);
    assert.equal(isResetToken('A'.repeat(64)), false);
    assert.equal(isResetToken('a'.repeat(63)), false);
    assert.equal(isResetToken(`${TOKEN}'--`), false);
    assert.equal(isResetToken([TOKEN]), false);
    assert.equal(isResetToken(undefined), false);
});

test('the reset cookie is read by its exact name and only when well formed', () => {
    assert.equal(readResetCookie(`connect.sid=s%3Aabc; ${RESET_COOKIE}=${TOKEN}; lang=ru`), TOKEN);
    assert.equal(readResetCookie(`${RESET_COOKIE}=${TOKEN}`), TOKEN);
    assert.equal(readResetCookie(`x${RESET_COOKIE}=${TOKEN}`), null);
    assert.equal(readResetCookie(`${RESET_COOKIE}=nothex`), null);
    assert.equal(readResetCookie(''), null);
    assert.equal(readResetCookie(undefined), null);
});

test('links in emails point at the site whatever the request said, unless the operator overrides it', () => {
    assert.equal(linkOrigin(undefined), SITE_ORIGIN);
    assert.equal(linkOrigin(''), SITE_ORIGIN);
    assert.equal(linkOrigin('http://localhost:3300'), 'http://localhost:3300');
    assert.equal(linkOrigin('https://evil.example/reset'), SITE_ORIGIN);
    assert.equal(linkOrigin('javascript:alert(1)'), SITE_ORIGIN);
    // The old handler built the link from req.protocol and the Host header.
    assert.match(ROUTER, /const origin = \(\) => policy\.linkOrigin\(process\.env\.SITE_ORIGIN\);/);
    assert.doesNotMatch(ROUTER, /req\.protocol/);
    assert.equal([...ROUTER.matchAll(/`\$\{origin\(\)\}\//g)].length, 2);
});

test('the new password: present twice, long enough, identical', () => {
    assert.equal(validateNewPassword(undefined, undefined), 'missing');
    assert.equal(validateNewPassword('', ''), 'missing');
    assert.equal(validateNewPassword(['a'], ['a']), 'missing');
    assert.equal(validateNewPassword('x'.repeat(LIMITS.passwordMinLength - 1), 'x'.repeat(LIMITS.passwordMinLength - 1)), 'too_short');
    assert.equal(validateNewPassword('correct horse', 'correct horsE'), 'mismatch');
    assert.equal(validateNewPassword('x'.repeat(LIMITS.passwordMinLength), 'x'.repeat(LIMITS.passwordMinLength)), null);
});

// ── 4. Emails and copy ──────────────────────────────────────────────────────────────────

test('the reset email names the username, carries the link, and escapes both in HTML', () => {
    const url = `${SITE_ORIGIN}/reset-password?token=${TOKEN}&lang=en`;
    for (const lang of ['en', 'ru']) {
        const email = buildResetEmail({ lang, username: '<b>Mark</b>', url });
        assert.ok(email.subject.length > 0);
        assert.ok(email.text.includes('<b>Mark</b>'), lang);
        assert.ok(email.text.includes(url), lang);
        assert.ok(email.text.includes(String(LIMITS.tokenHours)), lang);
        assert.ok(!email.html.includes('<b>Mark</b>'), lang);
        assert.ok(email.html.includes('&lt;b&gt;Mark&lt;/b&gt;'), lang);
        assert.ok(email.html.includes(`href="${SITE_ORIGIN}/reset-password?token=${TOKEN}&amp;lang=en"`), lang);
    }
    assert.match(buildResetEmail({ lang: 'ru', username: 'u', url }).text, /24 часа/);
});

test('the appeal acknowledgement names the username and offers the self-service reset', () => {
    const forgotUrl = `${SITE_ORIGIN}/forgot-password?lang=ru`;
    for (const lang of ['en', 'ru']) {
        const email = buildAppealEmail({ lang, username: 'андрей', forgotUrl });
        assert.ok(email.text.includes('андрей'), lang);
        assert.ok(email.text.includes(forgotUrl), lang);
    }
});

test('both languages have the same copy, and every error the router can show exists in both', () => {
    const keys = (o) => Object.keys(o).sort();
    assert.deepEqual(keys(copyFor('ru')), keys(copyFor('en')));
    assert.deepEqual(keys(copyFor('ru').errors), keys(copyFor('en').errors));
    const used = new Set([...ROUTER.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]));
    for (const e of ['empty', 'empty_email', 'too_long', 'missing', 'too_short', 'mismatch']) used.add(e);
    for (const e of used) {
        assert.ok(copyFor('en').errors[e], `en ${e}`);
        assert.ok(copyFor('ru').errors[e], `ru ${e}`);
    }
    assert.equal(copyFor('xx'), copyFor('en'));
});

test('the confirmation never asserts that an account exists', () => {
    for (const lang of ['en', 'ru']) {
        assert.match(copyFor(lang).sentLead, /^(If what you entered matches an account|Если введённые данные совпадают с аккаунтом)/);
    }
});

// ── 5. Rules accountRecovery.js must keep ───────────────────────────────────────────────

test('the only email this module sends is the one dispatched after the locked decision', () => {
    assert.equal([...ROUTER.matchAll(/sendEmail\(/g)].length, 1);
    assert.match(ROUTER, /function dispatch\(pool, emails, build\) \{\n\s+for \(const email of emails\) \{\n\s+sendEmail\(/);
    const dispatched = [...ROUTER.matchAll(/(?<!function )dispatch\(pool, ([\w.]+),/g)].map((m) => m[1]);
    assert.deepEqual(dispatched, ['result.emails', 'result.emails']);
    const locked = [...ROUTER.matchAll(/result = await inRecoveryLock\(pool, \(client\) => (\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(locked.sort(), ['fileAppeal', 'requestReset']);
});

test('a paused site is decided before any account is looked up, and every accepted request gets the same page', () => {
    const body = ROUTER.slice(ROUTER.indexOf('async function requestReset('), ROUTER.indexOf('async function fileAppeal('));
    assert.ok(body.indexOf('siteLimitReached(site)') > 0);
    assert.ok(body.indexOf('siteLimitReached(site)') < body.indexOf('findAccounts(client, identifier)'));
    const sentRenders = [...ROUTER.matchAll(/renderForgot\([^)]*state: 'sent'[^)]*\)/g)].map((m) => m[0]);
    assert.deepEqual(sentRenders, ["renderForgot(res, lang, { state: 'sent' })"]);
});

test('the SQL counts exactly the email outcomes, which are the predicate of both partial indexes', () => {
    const predicate = `outcome IN (${EMAIL_OUTCOMES.map((o) => `'${o}'`).join(', ')})`;
    assert.equal([...MIGRATION.matchAll(new RegExp(`WHERE ${predicate.replace(/[()]/g, '\\$&')}`, 'g'))].length, 2);
    assert.match(ROUTER, /const EMAILED = `outcome IN \(\$\{policy\.EMAIL_OUTCOMES/);
    assert.equal([...ROUTER.matchAll(/\$\{EMAILED\}/g)].length, 2);
    for (const o of EMAIL_OUTCOMES) assert.ok(OUTCOMES.includes(o));
});

test('no page local is called username, which the site header takes for the signed-in person', () => {
    // It did on the first draft: the reset page showed the account's avatar, bell and messages
    // to a visitor who was not signed in.
    const header = fs.readFileSync(path.join(ROOT, 'views/default/main_site_header.ejs'), 'utf8');
    assert.match(header, /typeof username !== 'undefined'/);
    const locals = [...ROUTER.matchAll(/pageLocals\(res, lang, status, \{([^}]*)\}\)/g)].map((m) => m[1]);
    assert.equal(locals.length, 3);
    for (const l of locals) assert.doesNotMatch(l, /\busername\b/);
    for (const view of ['forgot_password', 'reset_password', 'recover_account']) {
        const src = fs.readFileSync(path.join(ROOT, `views/${view}.ejs`), 'utf8');
        assert.doesNotMatch(src, /<%=\s*username\s*%>/, view);
    }
});

test('every outcome the router writes is one the admin queue can label', () => {
    const written = new Set([
        ...[...ROUTER.matchAll(/outcome: '([a-z_]+)'/g)].map((m) => m[1]),
        ...[...ROUTER.matchAll(/SET outcome = '([a-z_]+)'/g)].map((m) => m[1]),
        'sent', 'account_limit', 'site_limit', // decideSend's, mapped in requestReset/fileAppeal
    ]);
    for (const o of written) assert.ok(OUTCOME_LABELS[o], o);
    assert.deepEqual(OUTCOMES, Object.keys(OUTCOME_LABELS));
});

// ── Must never block a real person ──────────────────────────────────────────────────────
//
// Every request from 2026-05-17 to 2026-09-15 that matched an account (the 2026-05-28 test
// burst aside), by UTC time and anonymised account, plus the person who asked three times in
// ten minutes on 2026-06-10 while no email came. Under the new limits every one of them sends.

const REAL = [
    ['2026-05-20T18:44:46Z', 'a5'], ['2026-05-26T14:27:17Z', 'a2'], ['2026-05-30T15:26:52Z', 'a9'],
    ['2026-06-05T17:07:16Z', 'a9'], ['2026-06-10T13:37:46Z', 'retry'], ['2026-06-10T13:45:29Z', 'retry'],
    ['2026-06-10T13:47:28Z', 'retry'], ['2026-07-18T06:44:59Z', 'a1'], ['2026-07-19T12:16:05Z', 'a6'],
    ['2026-07-22T10:28:51Z', 'a10'], ['2026-07-22T14:22:03Z', 'a7'], ['2026-07-25T10:52:14Z', 'a12'],
    ['2026-07-28T19:47:43Z', 'a11'], ['2026-08-07T16:08:02Z', 'a4'], ['2026-08-20T00:12:14Z', 'a13'],
    ['2026-08-23T19:15:57Z', 'a14'], ['2026-09-01T11:13:02Z', 'a8'], ['2026-09-10T03:32:44Z', 'a3'],
];

test('every real request since May would have been emailed', () => {
    const requests = REAL.map(([at, account]) => ({ t: Date.parse(at) / 1000, account }));
    assert.equal(replay(requests).length, REAL.length);
});

test('someone who asks again every minute or so for ten minutes gets emails, all with the one link', () => {
    const requests = [0, 65, 140, 300, 600].map((t) => ({ t, account: 'me' }));
    const sent = replay(requests);
    assert.equal(sent.length, LIMITS.emailsPerAccountPerDay);
    // All within the reuse window, so every email carries the same working token.
    assert.ok(sent[sent.length - 1].t - sent[0].t < LIMITS.tokenReuseMinutes * 60);
});

test('a class of twenty resetting in the same hour from one school is not held back', () => {
    const requests = Array.from({ length: 20 }, (_, i) => ({ t: i * 90, account: `pupil${i}` }));
    assert.equal(replay(requests).length, 20);
    assert.ok(LIMITS.requestsPerIpPerHour >= 20);
});
