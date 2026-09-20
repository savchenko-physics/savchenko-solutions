// A problem's statement above the cursor while it rests on a link to that problem, as a PDF
// reader previews the target of a reference (the owner, 2026-09-19). Any link whose address
// is a problem qualifies: a number in a text (a.problem-ref), a dot of the homepage grid, a
// dot of a solution page's section grid, a chip of /unsolved. The statement comes from
// GET /<lang>/problems/statements?names=<n> (the problem database's own batch endpoint,
// rendered and cached on the server) and is kept for the page's life, so the second hover
// on the same problem is instant. Only where a cursor exists: a touch screen has no hover.
(function () {
    'use strict';
    if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;
    if (!window.fetch || !document.querySelector) return;

    var LANG = document.documentElement.lang === 'ru' ? 'ru' : 'en';
    var LINKS = 'a.problem-ref, a.problem-dot, a.problem-grid-item, a.problem-chip';
    var SHOW_DELAY = 220;   // a cursor passing over a link is not a request
    var HIDE_DELAY = 140;   // long enough to move from the link into the card
    var WIDTH = 640;
    var MARGIN = 12;

    var cache = Object.create(null);   // problem -> HTML (null: none on record)
    var card = null, body = null, head = null, open = null;
    var showTimer = 0, hideTimer = 0, current = null, seq = 0;

    // The problem a link leads to: /ru/5.8.5, /en/5.8.5#x, /ru/problems?q=5.8.5.
    function problemOf(link) {
        var href = link.getAttribute('href') || '';
        var m = /^\/(?:en|ru)\/(\d{1,2}\.\d{1,2}\.\d{1,3})(?:[?#]|$)/.exec(href)
            || /[?&]q=(\d{1,2}\.\d{1,2}\.\d{1,3})(?:[&#]|$)/.exec(href);
        return m ? m[1] : null;
    }

    function ensureCard() {
        if (card) return;
        card = document.createElement('div');
        card.className = 'ss-peek';
        card.setAttribute('role', 'tooltip');
        card.hidden = true;
        head = document.createElement('div');
        head.className = 'ss-peek-head';
        var num = document.createElement('span');
        num.className = 'ss-peek-num';
        open = document.createElement('a');
        open.className = 'ss-peek-open';
        head.appendChild(num);
        head.appendChild(open);
        body = document.createElement('div');
        body.className = 'ss-peek-body ss-prose ss-prose--compact';
        card.appendChild(head);
        card.appendChild(body);
        card.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
        card.addEventListener('mouseleave', scheduleHide);
        document.body.appendChild(card);
    }

    function load(problem) {
        if (problem in cache) return Promise.resolve(cache[problem]);
        return fetch('/' + LANG + '/problems/statements?names=' + encodeURIComponent(problem), { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .then(function (map) { cache[problem] = map && map[problem] ? map[problem] : null; return cache[problem]; })
            .catch(function () { return null; });
    }

    // Above the link, centred on it and kept inside the viewport; below it when the space
    // above is not enough.
    function place(link) {
        var r = link.getBoundingClientRect();
        var vw = document.documentElement.clientWidth;
        var vh = document.documentElement.clientHeight;
        var w = Math.min(WIDTH, vw - 2 * MARGIN);
        card.style.width = w + 'px';
        card.style.left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, vw - w - MARGIN)) + 'px';
        card.style.top = '0px';
        card.hidden = false;
        var h = card.offsetHeight;
        var above = r.top - h - 8;
        var top = above >= MARGIN ? above : (r.bottom + 8 + h <= vh - MARGIN ? r.bottom + 8 : Math.max(MARGIN, above));
        card.style.top = top + 'px';
    }

    function show(link, problem) {
        var my = ++seq;
        load(problem).then(function (html) {
            if (my !== seq || !html) return;
            ensureCard();
            head.firstChild.textContent = (LANG === 'ru' ? 'Задача ' : 'Problem ') + problem;
            open.href = link.getAttribute('href');
            open.textContent = LANG === 'ru' ? 'Открыть →' : 'Open →';
            body.innerHTML = html;
            body.scrollTop = 0;
            place(link);
        });
    }

    function hide() {
        seq++;
        current = null;
        if (card) card.hidden = true;
    }
    function scheduleHide() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, HIDE_DELAY);
    }

    document.addEventListener('mouseover', function (e) {
        var link = e.target.closest && e.target.closest(LINKS);
        if (!link) return;
        var problem = problemOf(link);
        if (!problem) return;
        clearTimeout(hideTimer);
        if (link === current) return;
        clearTimeout(showTimer);
        current = link;
        showTimer = setTimeout(function () { if (current === link) show(link, problem); }, SHOW_DELAY);
    });
    document.addEventListener('mouseout', function (e) {
        var link = e.target.closest && e.target.closest(LINKS);
        if (!link || link !== current) return;
        var to = e.relatedTarget;
        if (to && (link.contains(to) || (card && card.contains(to)))) return;
        clearTimeout(showTimer);
        scheduleHide();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', function () { if (card && !card.hidden) hide(); }, { passive: true });
})();
