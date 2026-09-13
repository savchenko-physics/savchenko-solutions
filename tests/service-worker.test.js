// The site does not register a service worker, and /sw.js only removes old ones.
//
// Reported 2026-09-12: switching chats on /messages made every avatar blank out and load
// again, even though the images were cached (the access log showed no refetches). The cause
// was the service worker the site had registered on every page since 2026-07-18. Firefox
// bypasses its shared image cache for any document a service worker controls, so each
// navigation reloaded and re-decoded every image. Measured against the real
// views/messages.ejs in Firefox 155 at 60 fps: 33–166 ms of blank avatars on every chat
// switch with a worker (including one with no fetch handler at all, and one using static
// routes), zero blank frames without one. Chrome never showed it, which is how it survived.
//
// The fix is to have no worker: public/sw.js unregisters itself when a browser updates it,
// and pages call unregister() directly. This file keeps both true. Not covered: whether a
// given browser has actually picked the new file up (that needs a browser).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function walk(dir, exts, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, exts, out);
        else if (exts.includes(path.extname(e.name))) out.push(full);
    }
    return out;
}

test('no page registers a service worker', () => {
    const files = [
        ...walk(path.join(ROOT, 'views'), ['.ejs', '.html']),
        ...walk(path.join(ROOT, 'public'), ['.ejs', '.html', '.js']),
        ...walk(path.join(ROOT, 'js'), ['.js']).filter((f) => !f.includes(`${path.sep}vendor${path.sep}`)),
    ];
    assert.ok(files.length > 50, `expected the site's pages and scripts, found ${files.length}`);
    const offenders = files.filter((f) => /serviceWorker\s*\.\s*register\s*\(/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});

test('public/sw.js still exists, handles no fetches and unregisters itself', () => {
    // It must keep existing: browsers that still run the old worker look for updates at this
    // URL, and a 404 would leave that worker installed indefinitely.
    const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
    const code = sw.replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /addEventListener\(\s*['"]fetch['"]/, 'a fetch listener puts every request back behind the worker');
    assert.doesNotMatch(code, /\bonfetch\b/);
    assert.doesNotMatch(code, /clients\.claim\s*\(/, 'claiming clients would take control of open pages again');
    assert.match(code, /registration\.unregister\s*\(\s*\)/);
});

test('the pages that used to register the worker now remove it', () => {
    for (const rel of ['views/default/main_site_header_head.ejs', 'views/eng_page.ejs', 'views/solution_post.ejs', 'views/messages.ejs']) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        assert.match(src, /getRegistrations\(\)[\s\S]{0,120}\.unregister\(\)/, rel);
    }
});
