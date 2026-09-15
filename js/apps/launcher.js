/* Opens «Последняя задача» (lastProblem.js) over the page the way a messenger opens a mini app,
 * and wires the two places it lives: the chat (views/messages.ejs) and the reaction pickers under
 * solutions (views/solution_post.ejs).
 *
 *   - A message carrying a link to the app gets a live card: the question, the top three problems,
 *     the best predictors, an Open button. Found by a MutationObserver over the message list,
 *     so bubbles drawn by the server, by the live stream, by history paging and by the catch-up
 *     poll all get one without touching the four places that build a bubble.
 *   - The app itself runs in an iframe in a sheet: full screen on a phone, a 420px panel on a
 *     desktop. It asks to close, reports that its state changed, and reports an unlocked
 *     reaction, all by postMessage from the same origin.
 *   - /messages/<chat>?app=last-problem opens it straight away (the bell notification links there).
 *   - Premium reactions (js/reactions.js) look locked in the pickers until this member owns them;
 *     tapping a locked one opens the app's shop on it. Ownership is fetched once, the first time a
 *     picker is filled.
 *
 * Loaded after js/reactions.js. window.SSApps is the only global.
 */
(() => {
    'use strict';

    const APP = 'last-problem';
    const LANG = (document.documentElement.lang || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
    const RX = window.Reactions || null;
    const HOSTS = new Set([window.location.host, 'savchenkosolutions.com', 'www.savchenkosolutions.com']);

    // ── The sheet ─────────────────────────────────────────────────────────────────────

    let sheet = null;
    let returnFocus = null;

    function open(options) {
        const o = options || {};
        const params = new URLSearchParams({ embed: '1' });
        if (o.tab) params.set('tab', o.tab);
        if (o.rx) params.set('rx', o.rx);
        const src = `/${LANG}/apps/${APP}?${params.toString()}`;
        if (!sheet) {
            sheet = document.createElement('div');
            sheet.className = 'mapp-sheet';
            sheet.hidden = true;
            sheet.innerHTML = '<div class="mapp-scrim" data-mapp-close></div>'
                + '<div class="mapp-panel" role="dialog" aria-modal="true"><iframe class="mapp-frame"></iframe></div>';
            sheet.querySelector('iframe').title = LANG === 'ru' ? 'Последняя задача' : 'The Last Problem';
            sheet.addEventListener('click', (e) => {
                if (e.target instanceof Element && e.target.closest('[data-mapp-close]')) close();
            });
            document.body.appendChild(sheet);
        }
        const frame = sheet.querySelector('iframe');
        if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
        returnFocus = document.activeElement;
        sheet.hidden = false;
        document.documentElement.classList.add('mapp-open');
        frame.focus();
    }

    function close() {
        if (!sheet || sheet.hidden) return;
        sheet.hidden = true;
        document.documentElement.classList.remove('mapp-open');
        if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
        refreshCards();
    }

    window.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin || !e.data || typeof e.data !== 'object') return;
        if (e.data.type === 'ss-app-close') close();
        else if (e.data.type === 'ss-app-state') refreshCards();
        else if (e.data.type === 'ss-rx-unlocked' && typeof e.data.emoji === 'string') {
            owned.add(e.data.emoji);
            applyLocks(true);
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sheet && !sheet.hidden) close();
    });

    // ── Cards under messages that link to the app ─────────────────────────────────────

    function isAppLink(a) {
        try {
            const url = new URL(a.getAttribute('href'), window.location.href);
            return HOSTS.has(url.host) && /^\/(?:(?:en|ru)\/)?apps\/last-problem\/?$/.test(url.pathname);
        } catch (_err) {
            return false;
        }
    }

    let card = null;
    let cardAt = 0;
    let cardPending = null;
    function fetchCard(force) {
        if (!force && card && Date.now() - cardAt < 60 * 1000) return Promise.resolve(card);
        if (cardPending) return cardPending;
        cardPending = fetch(`/api/last-problem/card?lang=${LANG}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                card = data;
                cardAt = Date.now();
                return data;
            })
            .catch(() => null)
            .finally(() => { cardPending = null; });
        return cardPending;
    }

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };

    const pct = (p) => {
        const v = Math.max(0, p) * 100;
        const nf = new Intl.NumberFormat(LANG === 'ru' ? 'ru-RU' : 'en-GB', { minimumFractionDigits: v < 20 ? 1 : 0, maximumFractionDigits: v < 20 ? 1 : 0 });
        return `${nf.format(v)}%`;
    };

    function fillCard(box, d) {
        box.replaceChildren();
        const head = el('div', 'mapp-card-head');
        const avatar = el('img', 'mapp-card-avatar');
        avatar.src = d.demon;
        avatar.alt = '';
        avatar.width = 32;
        avatar.height = 32;
        const titles = el('div', 'mapp-card-titles');
        titles.append(el('div', 'mapp-card-title', d.title), el('div', 'mapp-card-kind', d.kind));
        head.append(avatar, titles);

        const question = el('div', 'mapp-card-question', d.question);

        const top = el('ol', 'mapp-card-top');
        const max = Math.max(0.0001, ...d.top.map((t) => t.price));
        for (const t of d.top) {
            const row = el('li', 'mapp-card-row');
            const bar = el('span', 'mapp-card-bar');
            const fill = el('span', 'mapp-card-fill');
            fill.style.setProperty('--p', String(t.price / max));
            bar.appendChild(fill);
            row.append(el('span', 'mapp-card-id', t.id), bar, el('span', 'mapp-card-pct', pct(t.price)));
            top.appendChild(row);
        }

        box.append(head, question, top);

        if (d.leaders && d.leaders.length) {
            const leaders = el('div', 'mapp-card-leaders');
            leaders.appendChild(el('span', 'mapp-card-leaders-label', `${d.leadersLabel}: `));
            d.leaders.forEach((l, i) => {
                leaders.appendChild(el('span', 'mapp-card-leader', `${i + 1}. ${l.username} +${Math.round(l.profit)} ħ`));
            });
            box.appendChild(leaders);
        }

        const foot = el('div', 'mapp-card-foot');
        const openBtn = el('button', 'ss-btn ss-btn--primary ss-btn--sm mapp-card-open', d.open);
        openBtn.type = 'button';
        openBtn.dataset.mappOpen = '';
        foot.append(el('span', 'mapp-card-traders', d.traders), openBtn);
        box.appendChild(foot);
    }

    function decorate(root) {
        if (!root) return;
        const links = [...root.querySelectorAll('.msg-bubble a[href]')].filter((a) => {
            const bubble = a.closest('.msg-bubble');
            return bubble && !bubble.querySelector('.mapp-card') && isAppLink(a);
        });
        if (!links.length) return;
        fetchCard(false).then((data) => {
            if (!data) return;
            for (const a of links) {
                const bubble = a.closest('.msg-bubble');
                if (!bubble || bubble.querySelector('.mapp-card')) continue;
                a.classList.add('mapp-link');
                const box = el('div', 'mapp-card');
                fillCard(box, data);
                bubble.insertBefore(box, bubble.querySelector('.msg-reaction-add'));
            }
        });
    }

    function refreshCards() {
        if (!document.querySelector('.mapp-card')) return;
        fetchCard(true).then((data) => {
            if (!data) return;
            document.querySelectorAll('.mapp-card').forEach((box) => fillCard(box, data));
        });
    }

    document.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        if (target.closest('[data-mapp-open]')) {
            e.preventDefault();
            open();
            return;
        }
        const link = target.closest('a.mapp-link');
        if (link && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
            e.preventDefault();
            open();
        }
    });

    const list = document.getElementById('chatMessages');
    if (list) {
        decorate(list);
        let queued = false;
        new MutationObserver((mutations) => {
            if (queued || !mutations.some((m) => m.addedNodes.length)) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                decorate(list);
            });
        }).observe(list, { childList: true, subtree: true });
        // Keep the numbers on the cards moving while the chat is open.
        setInterval(() => { if (document.visibilityState === 'visible') refreshCards(); }, 60 * 1000);
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('app') === APP) {
        const tab = params.get('tab');
        params.delete('app');
        params.delete('tab');
        if (window.history && window.history.replaceState) {
            const rest = params.toString();
            window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
        }
        open({ tab: tab || undefined });
    }

    // ── Premium reactions in the pickers ──────────────────────────────────────────────

    const owned = new Set();
    let ownedState = 'idle';

    function isLocked(id) {
        return !!(RX && RX.isPremium && RX.isPremium(id) && !owned.has(id));
    }

    /* After ownership arrives: unlock the tiles, and if someone owns a reaction the pickers do
     * not show to everyone (a trophy, an out-of-season one), empty them so they refill with it. */
    function applyLocks(refill) {
        document.querySelectorAll('.msg-reaction-pick[data-emoji], .comment-react-pick[data-emoji]').forEach((tile) => {
            tile.classList.toggle('is-locked', isLocked(tile.dataset.emoji));
        });
        const hidden = RX && RX.pickerIds ? [...owned].some((id) => !RX.pickerIds({ now: new Date() }).includes(id)) : false;
        if (refill || hidden) {
            document.querySelectorAll('.msg-reaction-picker, .comment-react-picker').forEach((picker) => {
                if (!picker.matches(':hover') && !picker.contains(document.activeElement)) picker.replaceChildren();
            });
        }
    }

    function loadOwned() {
        if (ownedState !== 'idle') return;
        ownedState = 'loading';
        fetch('/api/reactions/owned', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : { owned: [] }))
            .then((data) => {
                for (const id of data.owned || []) owned.add(id);
                ownedState = 'done';
                applyLocks(false);
            })
            .catch(() => { ownedState = 'idle'; });
    }

    function pickerIds() {
        loadOwned();
        return RX ? RX.pickerIds({ owned, now: new Date() }) : [];
    }

    /* The title a locked tile shows: its name and price. */
    function lockedTitle(id, lang) {
        const entry = RX && RX.premiumEntry ? RX.premiumEntry(id) : null;
        if (!entry) return '';
        const name = lang === 'ru' ? entry.ru : entry.en;
        return Number.isFinite(entry.price) ? `${name} · ${entry.price} ħ` : name;
    }

    window.SSApps = { open, close, premium: { pickerIds, isLocked, lockedTitle } };
})();
