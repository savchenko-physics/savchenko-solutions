// Dates and times in the reader's own time zone (js/local-time.js, lib/localTime.js).
//
// Asked for on 2026-09-15: the chat already showed message times in the browser's zone, but
// everything else on the site was written by the server in UTC, so "Last edited", forum replies,
// notifications, drafts, blog comments and the chat's own day separators were hours off for most
// readers, and "today" could be yesterday. What this file guards: the formats in both languages,
// that a template writes a <time> the browser can rewrite (valid ISO, the language, escaped), that
// a calendar date stored as UTC midnight is not shifted into the day before, and that no template
// goes back to formatting an event's time on the server.
//
// Not covered, because there is no browser here: the rewriting itself and the chat's regrouping
// of its day separators, both checked in Firefox with the system time zone set to
// America/Los_Angeles and Asia/Vladivostok before release.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const T = require('../js/local-time');
const { localTime, isUtcMidnight } = require('../lib/localTime');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const AT = new Date('2026-09-15T13:40:38.655Z');
const NOW = new Date('2026-09-15T17:00:00Z');

test('each kind in both languages, in the zone asked for', () => {
    const f = (kind, lang, timeZone) => T.format(AT, kind, { lang, timeZone, now: NOW });
    assert.equal(f('date', 'ru', 'UTC'), '15 сент. 2026 г.');
    assert.equal(f('date', 'en', 'UTC'), 'Sep 15, 2026');
    assert.equal(f('longdate', 'en', 'UTC'), 'September 15, 2026');
    assert.equal(f('day', 'ru', 'UTC'), '15 сентября');
    assert.equal(f('day', 'en', 'UTC'), '15 Sep');
    assert.equal(f('time', 'ru', 'UTC'), '13:40');
    assert.equal(f('time', 'ru', 'Asia/Vladivostok'), '23:40');
    assert.equal(f('time', 'en', 'America/Los_Angeles'), '6:40 AM');
    assert.equal(f('month', 'en', 'UTC'), 'Sep 2026');
    // The same moment is a different day in a zone far enough east.
    assert.equal(T.format(new Date('2026-09-15T20:30:00Z'), 'day', { lang: 'ru', timeZone: 'Asia/Vladivostok', now: NOW }), '16 сентября');
    assert.equal(T.format(new Date('2025-02-01T12:00:00Z'), 'day', { lang: 'en', timeZone: 'UTC', now: NOW }), '1 Feb 2025', 'the year when it is not this one');
});

test('relative time: minutes, hours, yesterday, then the day, by the reader\'s calendar', () => {
    const rel = (iso, lang, timeZone) => T.format(new Date(iso), 'relative', { lang, timeZone, now: NOW });
    assert.equal(rel('2026-09-15T16:59:30Z', 'ru', 'UTC'), 'только что');
    assert.equal(rel('2026-09-15T16:55:00Z', 'en', 'UTC'), '5 min ago');
    assert.equal(rel('2026-09-15T13:40:00Z', 'ru', 'UTC'), '3 ч назад');
    assert.equal(rel('2026-09-14T20:00:00Z', 'ru', 'UTC'), 'вчера');
    // 18.00 and 02.00 UTC are different days in London and the same evening in Los Angeles.
    const lateNow = new Date('2026-09-15T02:00:00Z');
    assert.equal(T.format(new Date('2026-09-14T18:00:00Z'), 'relative', { lang: 'en', timeZone: 'UTC', now: lateNow }), 'yesterday');
    assert.equal(T.format(new Date('2026-09-14T18:00:00Z'), 'relative', { lang: 'en', timeZone: 'America/Los_Angeles', now: lateNow }), '8 h ago');
    assert.equal(rel('2026-09-10T10:00:00Z', 'ru', 'UTC'), '10 сентября');
    assert.equal(T.format(new Date('2026-09-15T16:30:00Z'), 'recent', { lang: 'ru', now: NOW }), 'только что');
    assert.equal(T.format(new Date('2026-09-15T10:30:00Z'), 'recent', { lang: 'en', timeZone: 'UTC', now: NOW }), '15 Sep');
});

test('a template gets a <time> the browser can rewrite, and nothing for no date', () => {
    const html = localTime(AT, 'relative', 'ru', { now: NOW, className: 'x" onmouseover="y' });
    assert.match(html, /^<time class="x&quot; onmouseover=&quot;y" datetime="2026-09-15T13:40:38\.655Z" data-local="relative" data-lang="ru" title="15 сент\. 2026 г\., 13:40 UTC">3 ч назад<\/time>$/);
    assert.match(localTime('2026-09-15T13:40:38Z', 'date', 'en'), /data-lang="en"[^>]*>Sep 15, 2026<\/time>$/);
    assert.match(localTime(AT, 'nonsense', 'de'), /data-local="date" data-lang="en"/, 'an unknown kind or language falls back');
    for (const nothing of [null, undefined, '', 'not a date', new Date(NaN)]) assert.equal(localTime(nothing, 'date', 'ru'), '');
});

test('a calendar date stored as UTC midnight stays that day for everyone', () => {
    const seeded = new Date('2024-12-28T00:00:00Z');
    assert.equal(isUtcMidnight(seeded), true);
    const html = localTime(seeded, 'recent', 'ru', { calendar: true, now: NOW });
    assert.equal(html, '<span>28 декабря 2024 г.</span>');
    assert.doesNotMatch(html, /data-local/);
    assert.match(localTime(new Date('2024-12-28T09:15:00Z'), 'recent', 'ru', { calendar: true }), /data-local="recent"/, 'a real moment is still local');
});

test('no template formats an event\'s time on the server any more', () => {
    // Calendar dates, which are right in UTC and wrong shifted: challenge weeks and the months of
    // a contributor's first and last edit (DATE values).
    const allowed = [
        'views/challenges/index.ejs',
        'views/challenges/show.ejs',
        'views/contributor_page.ejs',
    ];
    // Dead templates nothing renders (CLAUDE.md, Known Technical Debt).
    const dead = new Set(['views/solutions_post.ejs', 'views/profile.ejs', 'views/post.ejs', 'views/eng_page_old.ejs']);
    const offenders = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const rel = `${dir}/${e.name}`;
            if (e.isDirectory()) walk(rel);
            else if (e.name.endsWith('.ejs') && !dead.has(rel)) {
                const lines = read(rel).split('\n');
                lines.forEach((line, i) => {
                    if (/<%[=-][^%]*new Date\([^)]*\)\.toLocale(?:Date|Time)?String\(/.test(line) && !allowed.includes(rel)) offenders.push(`${rel}:${i + 1}`);
                    if (/<%=\s*[\w.]*(?:created_at|updated_at|edited_at|submitted_at)\s*%>/.test(line)) offenders.push(`${rel}:${i + 1} (a raw Date)`);
                });
            }
        }
    };
    walk('views');
    walk('sandbox/views');
    assert.deepEqual(offenders, []);
});

test('every page that shows such a time loads the script that makes it local', () => {
    const header = read('views', 'default', 'main_site_header.ejs');
    const at = header.indexOf("asset('/js/local-time.js')");
    assert.ok(at > 0, 'the header, on nearly every page');
    assert.ok(header.lastIndexOf('<% } %>', at) > header.lastIndexOf('<% if (navUser) { %>', at), 'for signed-out readers too');
    for (const page of ['views/admin/dashboard.ejs', 'views/file_list.ejs', 'sandbox/views/partials/footer.ejs']) {
        assert.match(read(page), /\/js\/local-time\.js/, `${page} has no site header, so it loads it itself`);
    }
    const index = read('index.js');
    assert.match(index, /app\.locals\.localTime = localTime;/);
    assert.match(read('sandbox', 'sandbox-app.js'), /app\.locals\.localTime = /);
});

test('the chat puts its day separators on the reader\'s days', () => {
    const chat = read('js', 'messages-page.js');   // the chat's script, since 2026-09-21
    const key = chat.slice(chat.indexOf('function clientDayKey('), chat.indexOf('function clientDaySepText('));
    assert.doesNotMatch(key, /getUTC/);
    const text = chat.slice(chat.indexOf('function clientDaySepText('), chat.indexOf('function regroupDaySeparators('));
    assert.doesNotMatch(text, /timeZone/);
    const start = chat.indexOf("const rowEls = chatEl ? chatEl.querySelectorAll('.msg-bubble-row[data-msg-id]') : [];");
    assert.ok(start > 0 && chat.indexOf('regroupDaySeparators();', start) - start < 200, 'regrouped as soon as the rows are found');
    assert.match(read('views', 'messages.ejs'), /data-created="<%= new Date\(m\.created_at\)\.toISOString\(\) %>"/);
});
