/* Live alerts on every page for a signed-in member (views/default/main_site_header.ejs loads this).
 *
 * Every half minute while the tab is visible, and at once when it becomes visible again, it asks
 * GET /messages/pulse for the unread counts and for new messages worth an alert (lib/pulse.js
 * decides: a DM, a small group, a reply to you, an @mention of you). The header's message badge
 * and bell update in place, and each alert shows as a small card in the corner that opens the
 * message. Not on the messenger's own pages, which update themselves live.
 *
 * Polling rather than a live stream: a stream per open tab on every page is a connection held per
 * reader on a small server, and thirty seconds is soon enough to answer a message.
 * An alert seen in one tab is not shown again in another (localStorage, best effort).
 */
(() => {
    'use strict';

    const script = document.currentScript;
    const RU = ((script && script.dataset.lang) || document.documentElement.lang || '').startsWith('ru');
    const POLL_MS = 30 * 1000;
    const SHOW_MS = 10 * 1000;
    const onMessenger = /^\/(?:(?:en|ru)\/)?messages(?:\/|$)/.test(window.location.pathname);
    const T = RU
        ? { reply: 'ответил(а) на ваше сообщение', mention: 'упомянул(а) вас', dm: 'новое сообщение', group: 'в группе', close: 'Закрыть', region: 'Новые сообщения' }
        : { reply: 'replied to your message', mention: 'mentioned you', dm: 'new message', group: 'in', close: 'Close', region: 'New messages' };

    let cursor = null;
    let busy = false;
    let timer = null;

    function setCount(el, n) {
        if (!el) return;
        el.textContent = n > 99 ? '99+' : String(n);
        if ('hidden' in el) el.hidden = !(n > 0);
        if (el.id === 'notif-badge') el.style.display = n > 0 ? '' : 'none';
    }

    function lastShown() {
        try {
            return Number(window.localStorage.getItem('ss-pulse-shown')) || 0;
        } catch (_err) {
            return 0;
        }
    }

    function markShown(id) {
        try {
            if (id > lastShown()) window.localStorage.setItem('ss-pulse-shown', String(id));
        } catch (_err) { /* private mode */ }
    }

    let region = null;
    function toastRegion() {
        if (region) return region;
        region = document.createElement('div');
        region.className = 'ss-toasts';
        region.setAttribute('role', 'region');
        region.setAttribute('aria-live', 'polite');
        region.setAttribute('aria-label', T.region);
        document.body.appendChild(region);
        return region;
    }

    function showAlert(item) {
        const card = document.createElement('div');
        card.className = 'ss-toast';

        const link = document.createElement('a');
        link.className = 'ss-toast-link';
        link.href = item.url;

        const avatar = document.createElement('img');
        avatar.className = 'ss-toast-avatar';
        avatar.src = item.picture;
        avatar.alt = '';
        avatar.width = 36;
        avatar.height = 36;

        const body = document.createElement('span');
        body.className = 'ss-toast-body';
        const head = document.createElement('span');
        head.className = 'ss-toast-head';
        const name = document.createElement('strong');
        name.textContent = item.sender;
        const what = document.createElement('span');
        what.className = 'ss-toast-what';
        what.textContent = item.kind === 'group' ? `${T.group} ${item.chat}` : T[item.kind];
        head.append(name, what);
        const text = document.createElement('span');
        text.className = 'ss-toast-text';
        text.textContent = item.preview;
        body.append(head, text);
        link.append(avatar, body);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'ss-toast-close';
        close.setAttribute('aria-label', T.close);
        close.textContent = '×';

        card.append(link, close);
        const box = toastRegion();
        box.appendChild(card);
        while (box.childElementCount > 3) box.firstElementChild.remove();

        let hideTimer = setTimeout(() => card.remove(), SHOW_MS);
        card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
        card.addEventListener('mouseleave', () => { hideTimer = setTimeout(() => card.remove(), SHOW_MS / 2); });
        close.addEventListener('click', () => card.remove());
    }

    async function poll() {
        if (busy) return;
        busy = true;
        try {
            const res = await fetch(`/messages/pulse${cursor != null ? `?since=${cursor}` : ''}`, {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            });
            const type = res.headers.get('content-type') || '';
            if (!res.ok || !type.includes('application/json')) return;
            const data = await res.json();
            setCount(document.getElementById('nav-msg-badge'), data.unreadMessages);
            setCount(document.getElementById('nav-msg-badge-m'), data.unreadMessages);
            setCount(document.getElementById('notif-badge'), data.unreadNotifications);
            if (cursor != null && !onMessenger && Array.isArray(data.items)) {
                const seen = lastShown();
                const fresh = data.items.filter((item) => item.id > seen).reverse();
                for (const item of fresh) showAlert(item);
                if (fresh.length) markShown(fresh[fresh.length - 1].id);
            }
            if (Number.isSafeInteger(data.cursor)) cursor = data.cursor;
        } catch (_err) {
            /* offline, or signed out in another tab: try again on the next beat */
        } finally {
            busy = false;
        }
    }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            if (document.visibilityState === 'visible') await poll();
            schedule();
        }, POLL_MS);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') poll();
    });

    poll().then(schedule);
})();
