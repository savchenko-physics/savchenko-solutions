// The username rule (lib/usernames.js).
//
// Registration used to accept any string. By 2026-09-14, 718 of 1,014 usernames had capitals,
// 73 were Cyrillic or another script, 64 had spaces (some only a trailing one, "Eldor "), and three
// pairs differed only by case ("Mark"/"mark"). From then on a new username is 2–32 characters of
// a-z, 0-9 and "_", and may not equal an existing one ignoring case. Clause 4.5 of the community
// guidelines says the same in both languages.
//
// The settings form had its own rule, [a-zA-Z0-9._-]{2,32} in both the pattern attribute and the
// route, which quietly stopped every one of those 137 older accounts from saving their profile at
// all, because the form sends the unchanged username with each save.
//
// Covered here: the rule, the settings decision, and source checks that the routes and forms use
// it. Not covered, because there is no test database: the case-insensitive clash queries.
//
// The closing block holds the "never block a real person" invariants: an existing account keeps
// its username and can still save its profile.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
    USERNAME_RE,
    USERNAME_PATTERN,
    isValidNewUsername,
    resolveUsernameChange,
} = require('../lib/usernames');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('a new username is lowercase English letters, digits and underscore, 2 to 32 long', () => {
    for (const ok of ['ab', 'vladimerch', 'albaert_davronov', 'pavel2008', '__', 'a'.repeat(32)]) {
        assert.equal(isValidNewUsername(ok), true, ok);
    }
    for (const bad of [
        '', 'a', 'a'.repeat(33),
        'Daniyar', 'DIS', 'NOT_CHESNOCK',       // capitals
        'андрей', 'Нігерла', 'ölçü', 'ｌａｔｉｎ',  // other alphabets, full-width Latin
        'аlex',                                  // Cyrillic "а" posing as Latin
        'newton fanboy', 'eldor ', ' eldor',     // spaces
        'oyuun-erdene', 'a.b', 'vannguyen@3k53', 'kayirbek’', 'x\n',
        null, undefined, 42,
    ]) {
        assert.equal(isValidNewUsername(bad), false, JSON.stringify(bad));
    }
});

test('the HTML pattern and the server rule are the same rule', () => {
    assert.equal(USERNAME_RE.source, `^${USERNAME_PATTERN}$`);
});

test('settings: a changed username must follow the rule', () => {
    assert.deepEqual(resolveUsernameChange('Mark', 'mark'), { ok: true, username: 'mark', changed: true });
    assert.deepEqual(resolveUsernameChange('Алина', 'alina'), { ok: true, username: 'alina', changed: true });
    assert.deepEqual(resolveUsernameChange('alina', 'Alina'), { ok: false });
    assert.deepEqual(resolveUsernameChange('alina', 'Алина'), { ok: false });
    assert.deepEqual(resolveUsernameChange('alina', ''), { ok: false });
});

test('registration and settings use the rule, and the forms carry it', () => {
    const index = read('index.js');
    const register = index.slice(index.indexOf('app.post("/register"'), index.indexOf('// Login Route'));
    assert.match(register, /isValidNewUsername\(username\)/);
    assert.match(register, /LOWER\(username\) = \$1/);
    assert.ok(register.indexOf('isValidNewUsername') < register.indexOf('INSERT INTO users'));
    assert.match(index, /resolveUsernameChange\(currentUsername, newUsername\)/);
    assert.doesNotMatch(index, /a-zA-Z0-9\._-/);

    assert.match(read('views/register.ejs'), /pattern="<%= usernamePattern %>"/);
    const settings = read('views/user_settings.ejs');
    // A pattern attribute would stop older accounts from submitting their unchanged username.
    assert.doesNotMatch(settings, /id="username"[^>]*pattern=/);
    assert.match(settings, /data-original="<%= username %>"/);

    for (const lang of ['en', 'ru']) {
        const locale = JSON.parse(read(`locales/${lang}.json`));
        assert.ok(locale.auth.register.usernameRules, lang);
        assert.ok(locale.auth.register.usernameTaken, lang);
        assert.match(read(`views/community_guidelines_${lang}.ejs`), /<strong>4\.5\.<\/strong>/);
    }
});

// Never block a real person: every account from before the rule keeps its name and can save.
test('an unchanged username is always kept, whatever it is', () => {
    for (const existing of ['Бека', 'Newton fanboy frfr', 'KayirbekIsmailZver’', 'vannguyen@3k53', 'NOT_CHESNOCK', 'x']) {
        assert.deepEqual(resolveUsernameChange(existing, existing), { ok: true, username: existing, changed: false }, existing);
    }
});

test('a stored trailing space survives the form trimming it', () => {
    assert.deepEqual(resolveUsernameChange('Eldor ', 'Eldor'), { ok: true, username: 'Eldor ', changed: false });
    assert.deepEqual(resolveUsernameChange('Alisher ', ' Alisher  '), { ok: true, username: 'Alisher ', changed: false });
});
