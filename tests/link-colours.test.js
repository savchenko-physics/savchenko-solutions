// Links never keep a colour that vanishes on the surface they sit on.
//
// 2026-09-13: links in your own chat messages were invisible. The sent bubble is navy
// (#1a1a2e) and every URL, @mention and #ref in a message carried an inline
// color:#1a5276, 2.0:1 on it, which no stylesheet can override. A crawl of the site in real
// Chrome then found the same site link blue on other dark surfaces, and a second route to it:
// a bare `a:visited` in css/main_page.css (0,1,1) outranked Bootstrap's `.btn` (0,1,0), so
// the mobile menu's "Log in" (.btn-dark) turned #1a5276 on #212529 once the login page had
// been visited.
//
// This file checks:
//   1. the server auto-links (utils.js) take their colour from --auto-link-color, the site
//      link blue being only the fallback, so a dark container can repaint them;
//   2. the chat's client linkify() does the same, and the sent bubble sets a colour that
//      actually reads on it;
//   3. no stylesheet a page loads, and no template <style>, colours a bare `a:link` or
//      `a:visited` — that would outrank .btn. Use `:not(.btn)`, or `:where(:not(.btn))` to
//      keep the old specificity.
//
// Since the September 2026 type unification the site link rule itself is `a { color }` at
// (0,0,1), so a container rule like `.dark a { color: #fff }` wins as it should; the (0,2,1)
// a:link:not(.btn) rule it replaced is what used to leave such links #1a5276.
// Not covered: contrast in general — that takes a real browser (scripts/qa/type_audit.py).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { linkifyMessageContent, linkifyBlogHtml } = require('../utils');

const ROOT = path.join(__dirname, '..');
const LINK_STYLE = /^style="color:var\(--auto-link-color,#1a5276\);/;

function walk(dir, exts, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, exts, out);
        else if (exts.includes(path.extname(e.name))) out.push(full);
    }
    return out;
}

// WCAG relative luminance contrast of two #rrggbb colours.
function contrast(a, b) {
    const lum = (hex) => {
        const [r, g, bl] = [1, 3, 5].map((i) => {
            const c = parseInt(hex.slice(i, i + 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

// ── 1. Server auto-links ────────────────────────────────────────────────────────────────

test('server auto-links take their colour from --auto-link-color', () => {
    const html = [
        linkifyMessageContent('см. https://www.youtube.com/watch?v=czU5ylX6_AM, @igor и #1.1.1', 'ru'),
        linkifyBlogHtml('<p>#2.1.1, 3.3.3, astrosander, спасибо Игорю</p>', 'ru'),
    ].join('\n');
    // 6 since 2026-09-21: a username link is coloured by its rank class, not an inline style.
    const styles = html.match(/style="[^"]*"/g) || [];
    assert.equal(styles.length, 6, html);
    for (const s of styles) assert.match(s, LINK_STYLE);
});

// ── 2. The chat client ──────────────────────────────────────────────────────────────────

test('the chat client linkify() matches, and the sent bubble repaints its links legibly', () => {
    const src = fs.readFileSync(path.join(ROOT, 'views/messages.ejs'), 'utf8');
    const fn = src.slice(src.indexOf('function linkify('), src.indexOf('function fmtTime('));
    const styles = fn.match(/style="[^"]*"/g) || [];
    assert.equal(styles.length, 3, 'URL, @mention and #ref links');
    for (const s of styles) assert.match(s, LINK_STYLE);

    const sentBg = src.match(/--msg-sent:\s*(#[0-9a-f]{6})/i)[1];
    const sentRule = src.match(/\.msg-bubble\.sent \{[^}]*\}/)[0];
    const linkColour = (sentRule.match(/--auto-link-color:\s*(#[0-9a-f]{6})/i) || [])[1];
    assert.ok(linkColour, '.msg-bubble.sent must set --auto-link-color');
    assert.ok(contrast(linkColour, sentBg) >= 4.5,
        `${linkColour} on ${sentBg} is ${contrast(linkColour, sentBg).toFixed(2)}:1`);
    assert.ok(contrast('#1a5276', sentBg) < 3, 'sanity: the fallback really is unreadable there');
});

// ── 3. Bare a:link / a:visited colour rules ─────────────────────────────────────────────

function bareLinkColourRules(css) {
    const found = [];
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = m[1].split(',').map((s) => s.trim());
        const setsColour = /(^|[;\s])color\s*:/.test(m[2]);
        const bare = selectors.filter((s) => /^a:(link|visited)$/.test(s));
        if (setsColour && bare.length) found.push(bare.join(', '));
    }
    return found;
}

test('the rule check catches the original main_page.css rule and passes the fixed one', () => {
    assert.deepEqual(bareLinkColourRules('a:visited {\n  color: #1a5276;\n}'), ['a:visited']);
    assert.deepEqual(bareLinkColourRules('a,\na:visited { color: var(--link-visited); }'), ['a:visited']);
    assert.deepEqual(bareLinkColourRules('a:visited:where(:not(.btn)) { color: #1a5276; }'), []);
    assert.deepEqual(bareLinkColourRules('a:link:not(.btn), a:visited:not(.btn) { color: red; }'), []);
    assert.deepEqual(bareLinkColourRules('@media print { a, a:visited { text-decoration: underline; } }'), []);
});

test('no stylesheet a page loads colours a bare a:link or a:visited', () => {
    const templates = [
        ...walk(path.join(ROOT, 'views'), ['.ejs']),
        ...walk(path.join(ROOT, 'sandbox', 'views'), ['.ejs']),
    ];
    // Stylesheets linked from templates (absolute, ../../ relative, or through asset()/av()),
    // the files concatenated into bundle.css, and anything they @import.
    const linked = new Set(require('../scripts/build-css').SOURCES.map((f) => path.join(ROOT, 'css', f)));
    const offenders = [];
    for (const file of templates) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/(?:href=["']|\(\s*['"])(?:\.\.\/)*\/?(css\/[^"'?)\s]+\.css)/g)) {
            linked.add(path.join(ROOT, m[1]));
        }
        for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
            for (const rule of bareLinkColourRules(m[1])) offenders.push(`${path.relative(ROOT, file)} <style>: ${rule}`);
        }
    }
    for (const file of [...linked]) {
        if (!fs.existsSync(file)) continue;
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/@import\s+["']([^"']+\.css)["']/g)) {
            linked.add(path.join(path.dirname(file), m[1]));
        }
    }
    assert.ok(linked.size > 5, `found only ${linked.size} linked stylesheets`);
    for (const file of linked) {
        if (!fs.existsSync(file) || file.includes(`${path.sep}vendor${path.sep}`) || file.endsWith('bundle.css')) continue;
        for (const rule of bareLinkColourRules(fs.readFileSync(file, 'utf8'))) {
            offenders.push(`${path.relative(ROOT, file)}: ${rule}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('the site link rule stays at (0,0,1), so containers and buttons can colour their own links', () => {
    const ds = fs.readFileSync(path.join(ROOT, 'css', 'design-system.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(ds, /(^|\n)a \{\s*color: var\(--ss-link\);/);
    assert.doesNotMatch(ds, /a:link:not\(\.btn\)|a:visited:not\(\.btn\)/);
    // Hover and visited are wrapped in :where() so they add nothing to the specificity.
    assert.match(ds, /a:where\(:hover\) \{/);
});

// The blog's linkers touch the text between tags only: the username linker once matched "igor"
// inside a figure's alt text and put an <a> into the <img>, which ended the tag early and spilled
// the caption onto the page (the chain-reaction post, 2026-09-20).
test('blog auto-links never reach into a tag, an existing link or code', () => {
    const html = '<p>igor и emixter решили 14.2.1.</p><img src="/img/a.svg" alt="igor работает утром, 14.2.1." /><p><a href="/x">igor</a> <code>emixter 1.1.1</code></p>';
    const out = linkifyBlogHtml(html, 'ru');
    assert.match(out, /<img src="\/img\/a\.svg" alt="igor работает утром, 14\.2\.1\." \/>/, 'the tag is untouched');
    assert.match(out, /<a href="\/x">igor<\/a> <code>emixter 1\.1\.1<\/code>/, 'a link and code are untouched');
    assert.match(out, /<a href="\/user\/igor"[^>]*>igor<\/a> и <a href="\/user\/emixter"[^>]*>emixter<\/a> решили <a href="\/ru\/14\.2\.1"[^>]*>14\.2\.1<\/a>\./, 'the text is linked, the number at the end of the sentence too');
});
