// Every username in its rank's colour, on every page, as on Codeforces (the owner, 2026-09-21).
//
// The header inlines window.__USER_RANKS__ = { username: tierKey } for every contributor
// (lib/userRank.js, five-minute cache); a name not in it is a newbie. This paints every link
// to a profile (/user/<name>) and every element that names a user in data-username, on load
// and whenever a page adds such links (chat, comments, search results). It only adds classes:
// .ss-rank-c-<key> carries the colour (css/design-system.css, with link states so a page's own
// a:hover cannot take it back) and .ss-rank-<key> the legendary tier's black first letter,
// which needs an inline-block box. A container with data-no-rank keeps its own colours.
(function () {
    'use strict';
    const ranks = window.__USER_RANKS__ || {};
    const KEYS = ['legendaryGrandmaster', 'internationalGrandmaster', 'grandmaster', 'internationalMaster', 'master',
        'candidateMaster', 'expert', 'specialist', 'pupil', 'newbie', 'headquarters'];

    function nameOf(el) {
        if (el.dataset && el.dataset.username) return el.dataset.username;
        const href = el.getAttribute && el.getAttribute('href');
        if (!href) return null;
        const m = /^\/user\/([^/?#]+)/.exec(href);
        if (!m) return null;
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }

    function paint(el) {
        if (el.__ranked || el.closest('[data-no-rank]')) return;
        const name = nameOf(el);
        if (!name) return;
        // Only an element whose text is the name (or the name with a flag or an @): an avatar
        // link, a card or a row that happens to point at a profile keeps its own look.
        const text = (el.textContent || '').trim().replace(/^@/, '');
        if (!text || text.length > name.length + 4 || text.indexOf(name) === -1) return;
        const key = ranks[name] || 'newbie';
        if (KEYS.indexOf(key) === -1) return;
        el.classList.add('ss-rank-c-' + key, 'ss-rank-' + key);
        // ::first-letter needs a block box; an inline link gets one, a block (a sidebar row's
        // name with its ellipsis) already has one and keeps its layout.
        if (getComputedStyle(el).display === 'inline') el.classList.add('ss-ranked');
        el.__ranked = true;
    }

    function paintAll(root) {
        const scope = root && root.querySelectorAll ? root : document;
        if (scope !== document && scope.matches && scope.matches('a[href^="/user/"], [data-username]')) paint(scope);
        scope.querySelectorAll('a[href^="/user/"], [data-username]').forEach(paint);
    }

    // Started at once, while the page is still being parsed: the observer paints every link
    // the parser adds, so a name has its colour before the first paint (the owner, 2026-09-21).
    // getComputedStyle on a node still being parsed is fine; a node painted before its own
    // text arrived is painted again by the name check on DOMContentLoaded.
    paintAll(document);
    if (typeof MutationObserver === 'function') {
        new MutationObserver(function (records) {
            for (const r of records) for (const node of r.addedNodes) if (node.nodeType === 1) paintAll(node);
        }).observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener('DOMContentLoaded', function () {
        document.querySelectorAll('a[href^="/user/"], [data-username]').forEach(function (el) { el.__ranked = false; paint(el); });
    });
})();
