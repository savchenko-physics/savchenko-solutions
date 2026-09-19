// The RU / EN link in the site header keeps the reader on the page they are reading
// (lib/langSwitch.js): the same address with the language prefix swapped or added, query
// and all.
//
// Asked for on 2026-09-19, passed on from a reader: "when you look at a problem in Russian
// and press the language button, it takes you to the very beginning of the site instead of
// staying on that problem". The header fell back to /en or /ru unless a template handed it
// an address, and nine did; the solution page, the messenger's reply pages, the finder, the
// forum, the profile did not. Now index.js computes the address for every request and no
// template has to know its own. The only pages that may say otherwise are the ones whose
// address breaks the rule: the 404 page and the Russian-only summit page (homepage), and
// the recovery pages, which say their language in ?lang= (accountRecovery.js).
//
// Not covered, because there is no test database: that /ru/discuss, /ru/paths, /ru/compete,
// /ru/bank and /ru/notifications render, in Russian (the mounts and the reads are checked
// in the source below; a scratch cluster and curl confirmed all of them on 2026-09-19), and
// that the header's link is what these locals say (it is a one-line lookup).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LANGS, langSwitchUrl, langSwitchUrls } = require('../lib/langSwitch');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('a prefixed page keeps its path and query, only the language changes', () => {
    assert.equal(langSwitchUrl('/ru/5.3.12', 'en'), '/en/5.3.12');
    assert.equal(langSwitchUrl('/en/5.3.12', 'ru'), '/ru/5.3.12');
    assert.equal(langSwitchUrl('/ru/problems?q=%D0%BC%D0%B0%D1%8F%D1%82%D0%BD%D0%B8%D0%BA&sort=hard', 'en'),
        '/en/problems?q=%D0%BC%D0%B0%D1%8F%D1%82%D0%BD%D0%B8%D0%BA&sort=hard');
    assert.equal(langSwitchUrl('/en/messages/5', 'ru'), '/ru/messages/5');
    assert.equal(langSwitchUrl('/ru/messages/saved', 'en'), '/en/messages/saved');
    assert.equal(langSwitchUrl('/ru/settings?tab=privacy', 'en'), '/en/settings?tab=privacy');
    assert.equal(langSwitchUrl('/en/user/astrosander', 'ru'), '/ru/user/astrosander');
    assert.equal(langSwitchUrl('/ru/contributions/5.3.12', 'en'), '/en/contributions/5.3.12');
    assert.equal(langSwitchUrl('/en/5.3.12/brainstorm', 'ru'), '/ru/5.3.12/brainstorm');
    assert.equal(langSwitchUrl('/ru/apps/last-problem?embed=1', 'en'), '/en/apps/last-problem?embed=1');
    assert.equal(langSwitchUrl('/en/feedback/AbCdEfGhIj', 'ru'), '/ru/feedback/AbCdEfGhIj');
});

test('the homepage and the two language homepages switch between each other', () => {
    assert.deepEqual(langSwitchUrls('/'), { en: '/en', ru: '/ru' });
    assert.deepEqual(langSwitchUrls('/ru'), { en: '/en', ru: '/ru' });
    assert.deepEqual(langSwitchUrls('/en/'), { en: '/en/', ru: '/ru/' });
    assert.deepEqual(langSwitchUrls(''), { en: '/en', ru: '/ru' });
    assert.deepEqual(langSwitchUrls(undefined), { en: '/en', ru: '/ru' });
});

test('a bare address gets the prefix, and the page under it speaks that language', () => {
    assert.equal(langSwitchUrl('/discuss', 'ru'), '/ru/discuss');
    assert.equal(langSwitchUrl('/discuss/help/12-how-to-start', 'ru'), '/ru/discuss/help/12-how-to-start');
    assert.equal(langSwitchUrl('/paths/mechanics-in-30-days', 'ru'), '/ru/paths/mechanics-in-30-days');
    assert.equal(langSwitchUrl('/compete', 'ru'), '/ru/compete');
    assert.equal(langSwitchUrl('/bank/problem/7', 'ru'), '/ru/bank/problem/7');
    assert.equal(langSwitchUrl('/notifications?page=2', 'ru'), '/ru/notifications?page=2');
    assert.equal(langSwitchUrl('/user/astrosander', 'ru'), '/ru/user/astrosander');
    assert.equal(langSwitchUrl('/blog/why-savchenko', 'en'), '/en/blog/why-savchenko');
    assert.equal(langSwitchUrl('/tools/latex', 'ru'), '/ru/tools/latex');
    assert.equal(langSwitchUrl('/unsolved', 'ru'), '/ru/unsolved');
    assert.equal(langSwitchUrl('/upload', 'ru'), '/ru/upload');
});

test('only a real prefix counts as one', () => {
    assert.equal(langSwitchUrl('/english-corner', 'ru'), '/ru/english-corner');
    assert.equal(langSwitchUrl('/rules', 'en'), '/en/rules');
    assert.equal(langSwitchUrl('/en2/x', 'ru'), '/ru/en2/x');
});

test('a ?lang= in the query follows the switch, and a flash message does not', () => {
    assert.equal(langSwitchUrl('/profile?lang=ru', 'en'), '/en/profile?lang=en');
    assert.equal(langSwitchUrl('/ru/settings?tab=password&success=%D0%A1%D0%BE%D1%85%D1%80%D0%B0%D0%BD%D0%B5%D0%BD%D0%BE', 'en'),
        '/en/settings?tab=password');
    assert.equal(langSwitchUrl('/ru/login?error=Wrong', 'en'), '/en/login');
    assert.equal(langSwitchUrl('/ru/register?error=x&ref=chat', 'en'), '/en/register?ref=chat');
});

test('the result is always a path on this site, whatever the request line held', () => {
    for (const url of ['//evil.example/x', '///evil.example', '/ru//evil.example', 'http:/x', '/en/x#frag', '/#frag']) {
        for (const lang of LANGS) {
            const out = langSwitchUrl(url, lang);
            assert.match(out, /^\/(en|ru)(\/[^/]|$)/, `${url} -> ${out}`);
            assert.ok(!out.includes('#'), out);
        }
    }
    assert.throws(() => langSwitchUrl('/ru/1.1.1', 'de'), TypeError);
});

// ── Wiring: the source has to hold up what the function promises ──────────────────────

test('index.js computes both addresses for every request and the header reads them', () => {
    const index = read('index.js');
    assert.match(index, /const langSwitch = langSwitchUrls\(req\.originalUrl\);/);
    assert.match(index, /res\.locals\.langSwitchEnUrl = langSwitch\.en;/);
    assert.match(index, /res\.locals\.langSwitchRuUrl = langSwitch\.ru;/);
    // Before the first router mount, so every page gets them.
    assert.ok(index.indexOf('res.locals.langSwitchEnUrl') < index.indexOf("app.use('/admin', adminRouter)"));
    const header = read('views/default/main_site_header.ejs');
    assert.match(header, /langSwitchEnUrl/);
    assert.match(header, /langSwitchRuUrl/);
    assert.match(header, /href="<%= langHrefRu %>"[^>]*>RU</);
    assert.match(header, /href="<%= langHrefEn %>"[^>]*>EN</);
});

test('every page router answers under /en and /ru as well, or the switch would 404', () => {
    const index = read('index.js');
    // Mounts that are not pages: JSON, tracking pixels, admin, the one-click unsubscribe,
    // and the two routers mounted at the root that carry their own page addresses.
    const notPages = new Set(['/api/', '/api/feedback', '/api/last-problem', '/api/reactions', '/api/brainstorm',
        '/admin', '/unsubscribe', '/e', '/', '/css/vendor/fonts/h']);
    const mounts = [...index.matchAll(/^app\.use\('([^']+)',\s*(\w+)\)/gm)].map((m) => ({ path: m[1], router: m[2] }));
    const bare = mounts.filter((m) => !m.path.startsWith('/:lang') && !notPages.has(m.path));
    assert.ok(bare.length >= 12, `expected the page routers, saw ${bare.map((m) => m.path).join(' ')}`);
    for (const m of bare) {
        const twin = mounts.find((t) => t.router === m.router && /^\/:lang(\(en\|ru\))?\//.test(t.path) && t.path.endsWith(m.path));
        assert.ok(twin, `${m.path} (${m.router}) is mounted only at its bare address`);
        assert.ok(index.indexOf(`'${twin.path}'`) < index.indexOf('app.get("/:lang/:name"'), `${twin.path} must precede the solution route`);
    }
    for (const page of ['notifications', 'settings', 'profile', 'study-guide', 'community-guidelines', 'contributors', 'drafts', 'user/:username']) {
        assert.match(index, new RegExp(`app\\.get\\(\\["/${page}", "/:lang(\\(en\\|ru\\))?/${page}"\\]`), `/${page} has no prefixed twin`);
    }
});

test('a router mounted under /en and /ru reads the language of the address before the session', () => {
    // Otherwise /ru/blog is English for every visitor botgate does not count (a VPN on a
    // datacenter address, a browser without client hints, Tor): the session write that
    // used to be the only way the address reached these routers is skipped for them, and
    // the switch would take them to a /ru/… page that speaks English.
    assert.match(read('index.js'), /req\.urlLang = langMatch \? langMatch\[1\] : null;/);
    for (const f of ['blog.js', 'forum.js', 'bank.js', 'paths.js', 'challenges.js', 'contest.js', 'contestJudge.js', 'tools.js']) {
        const reads = read(f).split('\n').filter((l) => /req\.session\.lang\b/.test(l) && !/req\.session\.lang\s*=[^=]/.test(l));
        assert.ok(reads.length > 0, `${f} reads the session language somewhere`);
        for (const l of reads) assert.match(l, /req\.urlLang \|\|/, `${f}: ${l.trim()}`);
    }
});

test('no template repeats an address the rule already gives; the exceptions say why', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(path.join(dir, d.name)) : (d.name.endsWith('.ejs') ? [path.join(dir, d.name)] : []));
    const overriding = walk(path.join(ROOT, 'views'))
        .filter((f) => /langSwitch(En|Ru)Url:/.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(ROOT, f)).sort();
    // post.ejs is dead (CLAUDE.md), rendered by nothing; it is left as it was.
    assert.deepEqual(overriding, ['views/404.ejs', 'views/post.ejs', 'views/summit.ejs']);
    assert.match(read('views/404.ejs'), /langSwitchEnUrl: '\/en',\s*langSwitchRuUrl: '\/ru'/);
    assert.match(read('views/summit.ejs'), /langSwitchEnUrl: '\/en'/);
    const recovery = read('accountRecovery.js');
    assert.match(recovery, /langSwitchEnUrl: `\$\{page\}\?lang=en`, langSwitchRuUrl: `\$\{page\}\?lang=ru`/);
    for (const page of ["'/forgot-password'", 'COOKIE_PATH', "'/recover-account'"]) {
        assert.ok(recovery.includes(`pageLocals(res, lang, status, ${page},`), `recovery page ${page} names its address`);
    }
});

// ── Must never send a real reader somewhere else ───────────────────────────────────────
// Addresses taken from the access log's most read page shapes; each must stay on its page.

test('the pages people actually read stay put', () => {
    const cases = [
        ['/ru/2.1.32', '/en/2.1.32'],
        ['/en/14.5.24', '/ru/14.5.24'],
        ['/ru/', '/en/'],
        ['/ru/problems?q=2.1&sort=easy', '/en/problems?q=2.1&sort=easy'],
        ['/ru/problems/topic/kinematics', '/en/problems/topic/kinematics'],
        ['/ru/unsolved', '/en/unsolved'],
        ['/ru/contributors', '/en/contributors'],
        ['/ru/messages/5', '/en/messages/5'],
        ['/ru/upload', '/en/upload'],
        ['/ru/drafts', '/en/drafts'],
        ['/ru/user/Valter', '/en/user/Valter'],
        ['/ru/feedback', '/en/feedback'],
        ['/ru/blog', '/en/blog'],
        ['/ru/tools/formulas', '/en/tools/formulas'],
        ['/ru/recommendations/channels', '/en/recommendations/channels'],
        ['/ru/about', '/en/about'],
        ['/ru/login', '/en/login'],
        ['/ru/study-guide', '/en/study-guide'],
    ];
    for (const [from, to] of cases) {
        const target = to.startsWith('/en') ? 'en' : 'ru';
        assert.equal(langSwitchUrl(from, target), to);
    }
});
