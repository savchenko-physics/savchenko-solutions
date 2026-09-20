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
    // Any link to a problem's page: a number in a text, a grid dot, an unsolved chip, the
    // previous/next problem, the related problems, a line of the recent changes — whatever
    // its class (the owner, 2026-09-20). Not the problem database's own card, whose number
    // and buttons stand beside the statement they would preview.
    var LINKS = 'a[href]';
    var NOT = '.pf-card-name, .pf-card-open, .pf-card-upload, .ss-peek-open';
    var SHOW_DELAY = 220;   // a cursor passing over a link is not a request
    var HIDE_DELAY = 140;   // long enough to move from the link into the card
    var WIDTH = 640;
    var MARGIN = 12;
    var GAP = 8;         // between the link and the card

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

    // Strictly above the link, centred on it and kept inside the viewport, never over the
    // link: the card is anchored by its bottom edge, so a figure that arrives after the
    // card is placed grows it upward, and its height is capped to the room above, the
    // statement scrolling inside. (Measured once from the top and grown downward, a card
    // with a figure covered the link and the cursor with it, 2026-09-20.) Only when there
    // is no room above at all does it go below, anchored by its top edge.
    var MIN_ROOM = 140;
    function place(link) {
        var r = link.getBoundingClientRect();
        var vw = document.documentElement.clientWidth;
        var vh = document.documentElement.clientHeight;
        var w = Math.min(WIDTH, vw - 2 * MARGIN);
        card.style.width = w + 'px';
        card.style.left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, vw - w - MARGIN)) + 'px';
        var roomAbove = r.top - GAP - MARGIN;
        var roomBelow = vh - r.bottom - GAP - MARGIN;
        if (roomAbove >= MIN_ROOM || roomAbove >= roomBelow) {
            card.style.top = 'auto';
            card.style.bottom = (vh - r.top + GAP) + 'px';
            card.style.maxHeight = Math.max(MIN_ROOM, roomAbove) + 'px';
        } else {
            card.style.bottom = 'auto';
            card.style.top = (r.bottom + GAP) + 'px';
            card.style.maxHeight = Math.max(MIN_ROOM, roomBelow) + 'px';
        }
        card.hidden = false;
    }

    // The card appears with its figure already drawn: its <img> carry width and height
    // (lib/statementRender.js), so nothing moves when the file arrives, and the card waits
    // for the files up to a short limit before it shows, so a figure does not pop into an
    // empty box. A cached figure resolves at once.
    var IMAGE_WAIT = 600;
    function imagesReady(root) {
        var imgs = Array.prototype.slice.call(root.querySelectorAll('img'));
        if (!imgs.length) return Promise.resolve();
        var all = Promise.all(imgs.map(function (img) {
            if (img.complete) return Promise.resolve();
            return new Promise(function (resolve) {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
            });
        }));
        return Promise.race([all, new Promise(function (resolve) { setTimeout(resolve, IMAGE_WAIT); })]);
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
            // Lazy images never start loading in a hidden card; they are wanted now.
            Array.prototype.forEach.call(body.querySelectorAll('img[loading]'), function (img) { img.loading = 'eager'; });
            body.scrollTop = 0;
            imagesReady(body).then(function () {
                if (my !== seq) return;
                place(link);
            });
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
        // A problem named inside the card ("см. задачу 12.1.19") is a link too, and it must
        // not open a preview of its own: that replaced the card's content under the cursor,
        // which then counted as leaving the link, and both vanished (2026-09-20). Inside the
        // card the cursor keeps the card; the link there opens the page when clicked.
        if (card && card.contains(e.target)) { clearTimeout(hideTimer); return; }
        var link = e.target.closest && e.target.closest(LINKS);
        if (!link || link.matches(NOT)) return;
        var problem = problemOf(link);
        if (!problem) return;
        clearTimeout(hideTimer);
        if (link === current) return;
        clearTimeout(showTimer);
        current = link;
        showTimer = setTimeout(function () { if (current === link) show(link, problem); }, SHOW_DELAY);
    });
    document.addEventListener('mouseout', function (e) {
        if (card && card.contains(e.target)) return;   // the card's own mouseleave decides
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
