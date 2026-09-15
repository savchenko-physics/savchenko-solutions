/* «Последняя задача», the mini app (views/apps/last_problem.ejs, lastProblem.js).
 *
 * Draws everything below the bar from the state the page inlines, then keeps it fresh: after
 * every action it refetches /api/last-problem/state, and every 30 seconds while visible, so
 * other people's trades and newly solved problems show up without a reload. Inside the chat it
 * lives in an iframe (js/apps/launcher.js) and talks to the chat with postMessage: close, state
 * changed (the card refreshes), reaction unlocked (the pickers unlock it at once).
 *
 * Prices come from the server. The only market maths here is the preview of a buy, which for
 * LMSR depends on nothing but the problem's price and b (js/lmsr.js).
 */
(() => {
    'use strict';

    const boot = JSON.parse(document.getElementById('lpBoot').textContent);
    const C = boot.copy;
    const RU = boot.lang === 'ru';
    const LOCALE = RU ? 'ru-RU' : 'en-GB';
    const SERIES = (window.SSPalettes && window.SSPalettes.SERIES) || ['#2a78d6', '#eb6834', '#1baf7a', '#7d3c98'];
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const main = document.getElementById('lpMain');
    const barEnd = document.getElementById('lpBarEnd');
    const layer = document.getElementById('lpLayer');
    const toastEl = document.getElementById('lpToast');

    let state = boot.state;
    let tab = boot.tab || 'market';
    let openRow = null;
    let busy = false;
    let chartIndex = null;

    if (boot.rx) tab = 'shop';

    // ── Formatting ────────────────────────────────────────────────────────────────────

    const nf0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
    const nf1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const timeFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const hourFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });

    const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function pct(p) {
        const v = Math.max(0, p) * 100;
        return `${v < 20 ? nf1.format(v) : nf0.format(v)}%`;
    }

    function mult(p) {
        if (!(p > 0)) return '';
        const m = 1 / p;
        return `×${m < 100 ? nf1.format(m) : nf0.format(m)}`;
    }

    function plural(n, forms) {
        const k = Math.abs(Math.floor(n));
        if (!RU) return k === 1 ? forms[0] : forms[1];
        const m100 = k % 100;
        const m10 = k % 10;
        if (m100 >= 11 && m100 <= 14) return forms[2];
        if (m10 === 1) return forms[0];
        if (m10 >= 2 && m10 <= 4) return forms[1];
        return forms[2];
    }

    const coin = (extra) => `<img class="lp-coin${extra ? ` ${extra}` : ''}" src="${esc(boot.art.coin)}" alt="ħ" width="16" height="16">`;
    const quanta = (x, extra) => `<span class="lp-q">${nf0.format(Math.floor(x + 1e-9))}${coin(extra)}</span>`;
    const signed = (x) => `${x > 0.005 ? '+' : (x < -0.005 ? '−' : '')}${nf0.format(Math.abs(Math.round(x)))}`;

    function balance() {
        return state.me && state.me.balance != null ? state.me.balance : null;
    }

    // ── Talking to the server and to the chat ─────────────────────────────────────────

    async function post(path, body) {
        const res = await fetch(`${boot.api}/${path}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body || {}),
        });
        let data = {};
        try {
            data = await res.json();
        } catch (_err) { /* an empty or HTML error page */ }
        if (!res.ok) {
            const err = new Error(data.error || 'server');
            err.code = res.status === 401 ? 'auth' : (data.error || 'server');
            throw err;
        }
        return data;
    }

    function tellChat(message) {
        if (window.parent && window.parent !== window) window.parent.postMessage(message, window.location.origin);
    }

    async function refresh() {
        try {
            const res = await fetch(`${boot.api}/state?lang=${boot.lang}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
            if (!res.ok) return;
            state = await res.json();
            render(true);
            tellChat({ type: 'ss-app-state', app: 'last-problem' });
        } catch (_err) { /* keep what is on screen */ }
    }

    let toastTimer = null;
    function toast(text) {
        toastEl.textContent = text;
        toastEl.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3600);
    }

    const errorText = (err) => (C.errors[err && err.code] || C.errors.server);

    async function act(fn) {
        if (busy) return;
        busy = true;
        document.body.classList.add('is-busy');
        try {
            await fn();
        } catch (err) {
            toast(errorText(err));
        } finally {
            busy = false;
            document.body.classList.remove('is-busy');
        }
    }

    // ── The bar ───────────────────────────────────────────────────────────────────────

    function renderBar() {
        const bal = balance();
        if (!boot.signedIn) {
            barEnd.innerHTML = `<a class="lp-signin" href="${esc(boot.loginUrl)}" target="_top">${esc(C.signInButton)}</a>`;
        } else if (bal == null) {
            barEnd.innerHTML = '';
        } else {
            const label = bal < 1 ? `<span class="lp-balance-ground">${esc(C.groundState)}</span>` : `<span>${nf0.format(Math.floor(bal + 1e-9))}</span>`;
            barEnd.innerHTML = `<button type="button" class="lp-balance" data-lp-coin aria-label="${esc(C.balance)}">
                <img class="lp-coin lp-coin--bar" data-lp-coin-face src="${esc(boot.art.coin)}" alt="ħ" width="20" height="20">${label}</button>`;
        }
        document.querySelectorAll('[data-lp-tab]').forEach((btn) => {
            const on = btn.dataset.lpTab === tab;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
    }

    // ── Market ────────────────────────────────────────────────────────────────────────

    function birthdayHtml() {
        const now = new Date();
        if (now.getUTCMonth() !== 9 || now.getUTCDate() !== 10) return '';
        const stars = reducedMotion ? '' : Array.from({ length: 14 }, (_, i) => `<span data-i="${i}">∗</span>`).join('');
        return `<div class="lp-birthday"><span class="lp-burst" aria-hidden="true">${stars}</span>${esc(C.birthday)}</div>`;
    }

    // Colour follows the problem, not its rank: a problem keeps its line colour while it stays
    // on the chart, and a newcomer takes the colour the one it replaced gave up.
    const colourOf = new Map();
    function assignColours(keys) {
        for (const k of [...colourOf.keys()]) if (!keys.includes(k)) colourOf.delete(k);
        const used = new Set(colourOf.values());
        for (const k of keys) {
            if (colourOf.has(k)) continue;
            const free = SERIES.find((c) => !used.has(c)) || SERIES[0];
            colourOf.set(k, free);
            used.add(free);
        }
    }

    function chartHtml() {
        const chart = state.chart;
        if (!chart || !chart.t || !chart.t.length || !chart.series.length) return '';
        const keys = chart.series.map((s) => s.key);
        assignColours(keys);
        const priceNow = new Map(state.outcomes.map((o) => [o.id, o.price]));
        const legend = keys.map((k) => `<li class="lp-legend-item">
            <svg class="lp-legend-key" viewBox="0 0 16 8" width="16" height="8" aria-hidden="true"><line x1="1" y1="4" x2="15" y2="4" stroke="${colourOf.get(k)}" stroke-width="2" stroke-linecap="round"/></svg>
            <span class="lp-legend-name">${esc(k)}</span><span class="lp-legend-value">${pct(priceNow.get(k) || 0)}</span></li>`).join('');
        return `<figure class="lp-chart">
            <ul class="lp-legend">${legend}</ul>
            <div class="lp-plot" data-lp-chart tabindex="0" role="img" aria-label="${esc(C.question)}"></div>
        </figure>`;
    }

    function niceMax(p) {
        const steps = [0.05, 0.1, 0.2, 0.25, 0.4, 0.5, 0.6, 0.8, 1];
        return steps.find((s) => s >= p * 1.08) || 1;
    }

    function drawChart() {
        const box = main.querySelector('[data-lp-chart]');
        const chart = state.chart;
        if (!box || !chart || !chart.t.length) return;
        const W = Math.max(260, Math.round(box.clientWidth));
        const H = 184;
        const pad = { l: 4, r: 40, t: 10, b: 24 };
        const t = chart.t;
        const t0 = t[0];
        const t1 = t[t.length - 1] > t0 ? t[t.length - 1] : t0 + 1;
        const maxP = niceMax(Math.max(0.01, ...chart.series.flatMap((s) => s.p)));
        const x = (v) => pad.l + ((v - t0) / (t1 - t0)) * (W - pad.l - pad.r);
        const y = (p) => pad.t + (1 - p / maxP) * (H - pad.t - pad.b);
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('width', String(W));
        svg.setAttribute('height', String(H));
        svg.setAttribute('class', 'lp-svg');
        const el = (name, attrs, parent) => {
            const node = document.createElementNS(ns, name);
            for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
            (parent || svg).appendChild(node);
            return node;
        };
        for (const g of [0, maxP / 2, maxP]) {
            el('line', { x1: pad.l, x2: W - pad.r, y1: y(g), y2: y(g), class: 'lp-grid' });
            const label = el('text', { x: W - pad.r + 6, y: y(g) + 4, class: 'lp-axis' });
            label.textContent = `${Number.isInteger(Math.round(g * 1000) / 10) ? nf0.format(g * 100) : nf1.format(g * 100)}%`;
        }
        // One day on the chart reads as two times, several days as two dates.
        const sameDay = dayFmt.format(new Date(t0)) === dayFmt.format(new Date(t1));
        const axisFmt = sameDay ? hourFmt : dayFmt;
        const first = el('text', { x: pad.l, y: H - 6, class: 'lp-axis' });
        first.textContent = axisFmt.format(new Date(t0));
        const last = el('text', { x: W - pad.r, y: H - 6, class: 'lp-axis lp-axis--end' });
        last.textContent = axisFmt.format(new Date(t1));

        for (const s of chart.series) {
            let d = `M${x(t[0]).toFixed(1)} ${y(s.p[0]).toFixed(1)}`;
            for (let i = 1; i < t.length; i++) d += ` H${x(t[i]).toFixed(1)} V${y(s.p[i]).toFixed(1)}`;
            el('path', { d, class: 'lp-line', stroke: colourOf.get(s.key) });
        }
        for (const s of chart.series) {
            el('circle', { cx: x(t[t.length - 1]), cy: y(s.p[s.p.length - 1]), r: 4, class: 'lp-dot', fill: colourOf.get(s.key) });
        }
        const cross = el('line', { x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, class: 'lp-cross', visibility: 'hidden' });
        const hit = el('rect', { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, class: 'lp-hit' });

        const tip = document.createElement('div');
        tip.className = 'lp-tip';
        tip.hidden = true;
        box.replaceChildren(svg, tip);

        function show(i) {
            chartIndex = Math.max(0, Math.min(t.length - 1, i));
            const cx = x(t[chartIndex]);
            cross.setAttribute('x1', cx);
            cross.setAttribute('x2', cx);
            cross.setAttribute('visibility', 'visible');
            tip.replaceChildren();
            const when = document.createElement('div');
            when.className = 'lp-tip-when';
            when.textContent = chartIndex === t.length - 1 ? (RU ? 'сейчас' : 'now') : timeFmt.format(new Date(t[chartIndex]));
            tip.appendChild(when);
            const rows = chart.series.map((s) => ({ key: s.key, p: s.p[chartIndex] })).sort((a, b) => b.p - a.p);
            for (const r of rows) {
                const row = document.createElement('div');
                row.className = 'lp-tip-row';
                const key = document.createElementNS(ns, 'svg');
                key.setAttribute('viewBox', '0 0 12 8');
                key.setAttribute('width', '12');
                key.setAttribute('height', '8');
                const line = document.createElementNS(ns, 'line');
                for (const [k, v] of Object.entries({ x1: 1, y1: 4, x2: 11, y2: 4, stroke: colourOf.get(r.key), 'stroke-width': 2, 'stroke-linecap': 'round' })) line.setAttribute(k, String(v));
                key.appendChild(line);
                const value = document.createElement('strong');
                value.textContent = pct(r.p);
                const name = document.createElement('span');
                name.textContent = r.key;
                row.append(key, value, name);
                tip.appendChild(row);
            }
            tip.hidden = false;
            const tipW = tip.offsetWidth;
            let left = cx + 12;
            if (left + tipW > W) left = cx - tipW - 12;
            tip.style.setProperty('--tip-x', `${Math.max(0, left)}px`);
        }
        function hide() {
            cross.setAttribute('visibility', 'hidden');
            tip.hidden = true;
        }
        const nearest = (clientX) => {
            const rect = svg.getBoundingClientRect();
            const px = ((clientX - rect.left) / rect.width) * W;
            let best = 0;
            let bestD = Infinity;
            for (let i = 0; i < t.length; i++) {
                const dist = Math.abs(x(t[i]) - px);
                if (dist < bestD) { bestD = dist; best = i; }
            }
            return best;
        };
        hit.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
        hit.addEventListener('pointerdown', (e) => show(nearest(e.clientX)));
        hit.addEventListener('pointerleave', hide);
        box.onfocus = () => show(t.length - 1);
        box.onblur = hide;
        box.onkeydown = (e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                show((chartIndex == null ? t.length - 1 : chartIndex) + (e.key === 'ArrowLeft' ? -1 : 1));
            }
        };
    }

    function positionsHtml() {
        const me = state.me;
        if (!me || !me.positions.length) return '';
        const status = new Map(state.outcomes.map((o) => [o.id, o.status]));
        const chatBet = new Map(me.chatBets.map((b) => [b.problem, b]));
        const items = me.positions.map((p) => {
            const open = status.get(p.problem) === 'open';
            const bet = chatBet.get(p.problem);
            const shares = `${nf0.format(p.shares)} ${esc(plural(p.shares, C.shares))}`;
            const buttons = open && !state.decidedAt ? `<div class="lp-pos-actions">
                    <button type="button" class="ss-btn ss-btn--secondary ss-btn--sm" data-lp-sell="${esc(p.problem)}" data-shares="half">${esc(C.sellHalf)}</button>
                    <button type="button" class="ss-btn ss-btn--secondary ss-btn--sm" data-lp-sell="${esc(p.problem)}" data-shares="all">${esc(C.sellAll)} ${quanta(p.value)}</button>
                    ${bet ? `<button type="button" class="ss-btn ss-btn--ghost ss-btn--sm" data-lp-cancel="${bet.id}">${esc(C.cancelChatBet)} ${quanta(bet.amount)}</button>` : ''}
                </div>` : '';
            const won = status.get(p.problem) === 'won';
            const outcome = open ? `${esc(C.worthNow)} ${quanta(p.value)}` : (won ? `${esc(C.payout)} ${quanta(p.received)}` : esc(C.feedSolved));
            return `<li class="lp-pos${open || won ? '' : ' is-out'}">
                <div class="lp-pos-head"><span class="lp-pos-id">${esc(p.problem)}</span>${bet ? `<span class="ss-badge">${esc(C.fromChat)}</span>` : ''}
                    <span class="lp-pos-shares">${shares}</span></div>
                <div class="lp-pos-money">${esc(C.spent)} ${quanta(p.spent)} · ${outcome}</div>
                ${buttons}
            </li>`;
        }).join('');
        return `<section class="lp-block"><h2 class="lp-h2">${esc(C.yourPositions)}</h2><ul class="lp-positions">${items}</ul></section>`;
    }

    function heat(difficulty) {
        if (difficulty == null) return '';
        const bucket = Math.min(9, Math.max(1, Math.ceil((difficulty / 100) * 9) || 1));
        return `<span class="lp-heat lp-heat-${bucket}">${nf0.format(difficulty)}</span>`;
    }

    function rowHtml(o) {
        const isOpen = openRow === o.id;
        return `<li class="lp-row${isOpen ? ' is-open' : ''}">
            <button type="button" class="lp-row-main" data-lp-row="${esc(o.id)}" aria-expanded="${isOpen ? 'true' : 'false'}">
                <span class="lp-row-name"><span class="lp-row-id">${esc(o.id)}${o.starred ? '<sup class="ss-star">∗</sup>' : ''}</span>
                    ${o.demon ? `<img class="lp-row-demon" src="${esc(boot.art.demon)}" alt="${esc(C.demonName)}" title="${esc(C.demonName)}" width="16" height="16">` : ''}
                    <span class="lp-row-title">${esc(o.title)}</span></span>
                ${heat(o.difficulty)}
                <span class="lp-row-price">${pct(o.price)}</span>
                <span class="lp-row-mult">${mult(o.price)}</span>
            </button>
            ${isOpen ? tradeHtml(o) : ''}
        </li>`;
    }

    function tradeHtml(o) {
        const statement = `<button type="button" class="ss-btn ss-btn--ghost ss-btn--sm" data-lp-statement="${esc(o.id)}">${esc(C.statement)}</button>`;
        const statementBody = '<div class="lp-statement ss-prose ss-prose--compact" data-lp-statement-body hidden></div>';
        if (!boot.signedIn) {
            return `<div class="lp-trade"><p class="lp-note">${esc(C.signIn)}</p>
                <div class="lp-trade-actions"><a class="ss-btn ss-btn--primary ss-btn--sm" href="${esc(boot.loginUrl)}" target="_top">${esc(C.signInButton)}</a>${statement}</div>${statementBody}</div>`;
        }
        if (state.decidedAt) return `<div class="lp-trade"><div class="lp-trade-actions">${statement}</div>${statementBody}</div>`;
        const bal = balance() == null ? 1000 : balance();
        const start = Math.max(1, Math.min(100, Math.floor(bal + 1e-9)));
        return `<div class="lp-trade" data-lp-trade="${esc(o.id)}" data-price="${o.price}">
            <div class="lp-trade-row">
                <label class="lp-amount"><span class="visually-hidden">${esc(C.amount)}</span>
                    <input class="lp-amount-input" type="text" inputmode="numeric" autocomplete="off" maxlength="9" value="${start}" data-lp-amount>${coin()}</label>
                <div class="lp-quick">
                    ${[50, 100, 250].map((v) => `<button type="button" class="lp-chip" data-lp-add="${v}">+${v}</button>`).join('')}
                    <button type="button" class="lp-chip" data-lp-max>${esc(C.max)}</button>
                </div>
            </div>
            <p class="lp-preview" data-lp-preview></p>
            ${C.problemEggs && C.problemEggs[o.id] ? `<p class="lp-egg">${esc(C.problemEggs[o.id])}</p>` : ''}
            <p class="lp-egg" data-lp-egg hidden></p>
            <div class="lp-trade-actions">
                <button type="button" class="ss-btn ss-btn--primary ss-btn--sm" data-lp-buy="${esc(o.id)}"></button>
                ${statement}
            </div>
            ${statementBody}
        </div>`;
    }

    function solvedHtml() {
        const solved = state.outcomes.filter((o) => o.status === 'solved')
            .sort((a, b) => new Date(b.solvedAt) - new Date(a.solvedAt));
        if (!solved.length) return '';
        const items = solved.map((o) => `<li><span class="lp-solved-id">${esc(o.id)}</span>
            <span class="lp-solved-who">${o.solvedBy ? `${esc(C.solvedBy)} ${esc(o.solvedBy)}` : ''}</span>
            <span class="lp-solved-when">${esc(dayFmt.format(new Date(o.solvedAt)))}</span></li>`).join('');
        return `<details class="lp-block lp-solved"><summary class="lp-h2">${esc(C.solvedList)} <span class="ss-badge">${solved.length}</span></summary><ul>${items}</ul></details>`;
    }

    function feedHtml() {
        if (!boot.signedIn || !state.feed || !state.feed.length) return '';
        const items = state.feed.map((f) => {
            const who = f.actor === 'demon' ? C.demonName : (f.username || '');
            const what = f.kind === 'solved'
                ? `<b>${esc(f.problem)}</b> ${esc(C.feedSolved)}${f.username ? ` · ${esc(C.solvedBy)} ${esc(f.username)}` : ''}`
                : `${esc(who)} ${esc(f.side === 'sell' ? C.feedSell : C.feedBuy)} <b>${esc(f.problem)}</b> ${quanta(f.amount || 0)}${f.actor === 'chat' ? ` <span class="ss-badge">${esc(C.fromChat)}</span>` : ''}`;
            return `<li class="${f.cancelled ? 'is-cancelled' : ''}"><span class="lp-feed-what">${what}</span><span class="lp-feed-when">${esc(timeFmt.format(new Date(f.at)))}</span></li>`;
        }).join('');
        return `<section class="lp-block"><h2 class="lp-h2">${esc(C.recent)}</h2><ul class="lp-feed">${items}</ul></section>`;
    }

    function marketHtml() {
        const open = state.outcomes.filter((o) => o.status === 'open' || o.status === 'won').sort((a, b) => b.price - a.price);
        const meta = state.resolvedAt
            ? esc(state.tradersLabel)
            : `${esc(state.tradersLabel)} · ${state.openCount} ${esc(plural(state.openCount, C.problemsLeft))}`;
        const last = open[0] ? open[0].id : '';
        const banner = state.resolvedAt
            ? `<p class="lp-banner">${esc(C.resolvedBanner.replace('{problem}', state.winner || last))}</p>`
            : (state.decidedAt ? `<p class="lp-banner">${esc(C.decidedBanner.replace('{problem}', last))}</p>` : '');
        return `${birthdayHtml()}${banner}
            <h1 class="lp-question">${esc(C.question)}</h1>
            <p class="lp-meta">${meta}</p>
            ${chartHtml()}
            ${positionsHtml()}
            <ol class="lp-outcomes">${open.map(rowHtml).join('')}</ol>
            ${solvedHtml()}
            ${feedHtml()}
            <details class="lp-block lp-rules"><summary class="lp-h2">${esc(C.rulesTitle)}</summary>
                <ol>${C.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ol></details>`;
    }

    // ── Leaders ───────────────────────────────────────────────────────────────────────

    function avatar(entry, size) {
        if (entry.demon) return `<img class="lp-avatar" src="${esc(boot.art.demon)}" alt="" width="${size}" height="${size}">`;
        return `<img class="lp-avatar" src="${esc(entry.picture || '/img/profile_images/Default_placeholder.svg')}" alt="" width="${size}" height="${size}" loading="lazy">`;
    }

    function leaderName(entry) {
        const name = entry.demon ? C.demonName : entry.username;
        const tags = `${entry.demon ? ` <span class="ss-badge">${esc(C.benchmark)}</span>` : ''}${entry.you ? ` <span class="ss-badge ss-badge--accent">${esc(C.you)}</span>` : ''}`;
        return entry.demon ? `<span>${esc(name)}</span>${tags}` : `<a href="/user/${encodeURIComponent(name)}" target="_top">${esc(name)}</a>${tags}`;
    }

    function topHtml() {
        if (!boot.signedIn || !state.leaderboard) {
            return `<p class="lp-note">${esc(C.signIn)}</p><a class="ss-btn ss-btn--primary" href="${esc(boot.loginUrl)}" target="_top">${esc(C.signInButton)}</a>`;
        }
        const board = state.leaderboard;
        if (board.length <= 1 && board[0] && board[0].demon && state.traders === 0) {
            return `<h1 class="lp-question">${esc(C.topTitle)}</h1><p class="lp-note">${esc(C.topEmpty)}</p>`;
        }
        const podium = board.slice(0, 3).map((e, i) => `<li class="lp-podium-step lp-podium-${i + 1}">
            ${avatar(e, 48)}<div class="lp-podium-name">${leaderName(e)}</div>
            <div class="lp-podium-profit">${signed(e.profit)}${coin()}</div><div class="lp-podium-place">${i + 1}</div></li>`).join('');
        const rest = board.slice(3).map((e, i) => `<li class="lp-leader${e.you ? ' is-you' : ''}">
            <span class="lp-leader-rank">${e.you && i + 3 >= 20 ? (state.me && state.me.rank) || '' : i + 4}</span>${avatar(e, 28)}
            <span class="lp-leader-name">${leaderName(e)}</span><span class="lp-leader-profit">${signed(e.profit)}${coin()}</span></li>`).join('');
        return `<h1 class="lp-question">${esc(C.topTitle)}</h1>
            <p class="lp-meta">${esc(C.profit)} · ${esc(state.tradersLabel)}</p>
            <ol class="lp-podium">${podium}</ol>
            ${rest ? `<ol class="lp-leaders">${rest}</ol>` : ''}`;
    }

    // ── Shop ──────────────────────────────────────────────────────────────────────────

    let confirming = null;

    function shopHtml() {
        const owned = new Set(state.me ? state.me.owned : []);
        const bal = balance();
        const cards = boot.shop.map((item) => {
            let action;
            if (owned.has(item.id)) {
                action = `<span class="lp-rx-owned">${esc(C.owned)}</span>`;
            } else if (item.trophy) {
                action = `<span class="lp-rx-note">${esc(C.trophyHow[item.id] || C.trophy)}</span>`;
            } else if (item.never) {
                action = `<button type="button" class="ss-btn ss-btn--secondary ss-btn--sm" data-lp-perpetuum>∞${coin()}</button>`;
            } else if (!item.inSeason) {
                action = `<span class="lp-rx-note">${esc(C.offSeason)}</span>`;
            } else if (!boot.signedIn) {
                action = `<a class="ss-btn ss-btn--secondary ss-btn--sm" href="${esc(boot.loginUrl)}" target="_top">${nf0.format(item.price)}${coin()}</a>`;
            } else {
                const short = bal == null || bal + 1e-9 < item.price;
                const label = confirming === item.id ? `${esc(C.confirm)} ${nf0.format(item.price)}${coin()}` : `${esc(C.buyFor)} ${nf0.format(item.price)}${coin()}`;
                action = `<button type="button" class="ss-btn ${confirming === item.id ? 'ss-btn--primary' : 'ss-btn--secondary'} ss-btn--sm" data-lp-unlock="${esc(item.id)}"${short ? ' disabled' : ''}>${label}</button>`;
            }
            return `<li class="lp-rx${boot.rx === item.id ? ' is-target' : ''}${owned.has(item.id) ? ' is-owned' : ''}" data-rx="${esc(item.id)}">
                <img class="lp-rx-art" src="${esc(item.url)}" alt="" width="56" height="56">
                <div class="lp-rx-name">${esc(item.name)}</div>${action}</li>`;
        }).join('');
        return `<h1 class="lp-question">${esc(C.shopTitle)}</h1>
            <p class="lp-meta">${esc(C.shopNote)}</p>
            <ul class="lp-shop">${cards}</ul>`;
    }

    // ── Render ────────────────────────────────────────────────────────────────────────

    function render(keepInput) {
        const input = main.querySelector('[data-lp-amount]');
        const saved = keepInput && input ? { value: input.value, focused: document.activeElement === input } : null;
        renderBar();
        main.innerHTML = `<section class="lp-view" data-view="${tab}">${tab === 'top' ? topHtml() : (tab === 'shop' ? shopHtml() : marketHtml())}</section>`;
        if (tab === 'market') {
            drawChart();
            const again = main.querySelector('[data-lp-amount]');
            if (again) {
                if (saved) again.value = saved.value;
                if (!saved || saved.focused) again.focus({ preventScroll: true });
                updatePreview();
            }
        }
        if (tab === 'shop' && boot.rx) {
            const target = main.querySelector('.lp-rx.is-target');
            if (target) target.scrollIntoView({ block: 'center' });
        }
        maybeWelcome();
    }

    function amountValue() {
        const input = main.querySelector('[data-lp-amount]');
        if (!input) return NaN;
        const clean = input.value.replace(/\D+/g, '');
        if (clean !== input.value) input.value = clean;
        return clean ? Number(clean) : NaN;
    }

    function updatePreview() {
        const box = main.querySelector('[data-lp-trade]');
        if (!box) return;
        const id = box.dataset.lpTrade;
        const p = Number(box.dataset.price);
        const amount = amountValue();
        const bal = balance() == null ? 1000 : balance();
        const preview = box.querySelector('[data-lp-preview]');
        const buy = box.querySelector('[data-lp-buy]');
        const egg = box.querySelector('[data-lp-egg]');
        const valid = Number.isSafeInteger(amount) && amount >= 1 && amount <= Math.floor(bal + 1e-9);
        if (Number.isSafeInteger(amount) && amount >= 1 && p > 0) {
            const shares = state.b * Math.log((Math.expm1(amount / state.b) + p) / p);
            preview.innerHTML = `${esc(C.youGet)} ${nf0.format(shares)} ${esc(plural(shares, C.shares))} · ${esc(C.payout)} ${quanta(shares)} (×${nf1.format(shares / amount)}), ${esc(C.ifLast)}`;
        } else {
            preview.textContent = '';
        }
        if (amount > Math.floor(bal + 1e-9)) preview.textContent = C.errors.insufficient;
        buy.disabled = !valid;
        buy.innerHTML = `${esc(C.confirmBuy)} ${Number.isSafeInteger(amount) ? nf0.format(amount) : 0}${coin('lp-coin--on-dark')} · ${esc(id)}`;
        const line = C.amountEggs[String(amount)];
        egg.hidden = !line;
        egg.textContent = line || '';
    }

    function maybeWelcome() {
        if (!boot.signedIn || !state.me || state.me.balance != null || layer.dataset.kind === 'welcome') return;
        layer.dataset.kind = 'welcome';
        layer.innerHTML = `<div class="lp-dialog lp-welcome" role="dialog" aria-modal="true" aria-labelledby="lpWelcomeTitle">
            <button type="button" class="lp-welcome-coin" data-lp-flip aria-label="ħ">
                <img data-lp-coin-face src="${esc(boot.art.coin)}" alt="" width="120" height="120"></button>
            <h2 class="lp-welcome-title" id="lpWelcomeTitle">${esc(C.welcomeTitle)}</h2>
            <p class="lp-welcome-amount">${quanta(1000, 'lp-coin--xl')}</p>
            <p class="lp-note">${esc(C.welcomeNote)}</p>
            <button type="button" class="ss-btn ss-btn--primary ss-btn--block" data-lp-claim>${esc(C.welcomeClaim)}</button>
        </div>`;
        layer.hidden = false;
        const claim = layer.querySelector('[data-lp-claim]');
        if (claim) claim.focus({ preventScroll: true });
    }

    function closeLayer() {
        layer.hidden = true;
        layer.innerHTML = '';
        delete layer.dataset.kind;
    }

    function openNotes() {
        layer.dataset.kind = 'notes';
        layer.innerHTML = `<div class="lp-dialog lp-notes" role="dialog" aria-modal="true" aria-labelledby="lpNotesTitle">
            <div class="lp-notes-head"><img src="${esc(boot.art.demon)}" alt="" width="48" height="48">
                <h2 class="lp-welcome-title" id="lpNotesTitle">${esc(C.notesTitle)}</h2></div>
            <ol class="lp-notes-list">${C.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>
            <button type="button" class="ss-btn ss-btn--secondary ss-btn--block" data-lp-layer-close>${esc(C.close)}</button>
        </div>`;
        layer.hidden = false;
    }

    // ── Easter eggs ───────────────────────────────────────────────────────────────────

    function spinCoin() {
        if (reducedMotion) return;
        document.querySelectorAll('[data-lp-coin-face]').forEach((img) => {
            img.classList.remove('is-flipping');
            void img.offsetWidth;
            img.classList.add('is-flipping');
        });
    }

    let flips = 0;
    let flipTimer = null;
    function flipCoin() {
        const faces = document.querySelectorAll('[data-lp-coin-face]');
        faces.forEach((img) => {
            const back = img.dataset.side !== 'back';
            img.dataset.side = back ? 'back' : 'front';
            img.src = back ? boot.art.coinBack : boot.art.coin;
            if (!reducedMotion) {
                img.classList.remove('is-flipping');
                void img.offsetWidth;
                img.classList.add('is-flipping');
            }
        });
        flips += 1;
        clearTimeout(flipTimer);
        flipTimer = setTimeout(() => { flips = 0; }, 2500);
        if (flips === 7) {
            flips = 0;
            toast(`${C.collapse}: ${Math.random() < 0.5 ? 'ħ' : '∗'}`);
        }
    }

    let demonTaps = 0;
    let demonTimer = null;
    function tapDemon() {
        demonTaps += 1;
        clearTimeout(demonTimer);
        demonTimer = setTimeout(() => { demonTaps = 0; }, 1200);
        if (demonTaps >= 3) {
            demonTaps = 0;
            openNotes();
        }
    }

    // ── Events ────────────────────────────────────────────────────────────────────────

    document.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        const hit = (sel) => target.closest(sel);

        if (hit('[data-lp-close]')) {
            tellChat({ type: 'ss-app-close', app: 'last-problem' });
            return;
        }
        const tabBtn = hit('[data-lp-tab]');
        if (tabBtn) {
            tab = tabBtn.dataset.lpTab;
            confirming = null;
            if (!boot.embed && window.history && window.history.replaceState) {
                const url = new URL(window.location.href);
                url.searchParams.set('tab', tab);
                window.history.replaceState(null, '', url);
            }
            render();
            return;
        }
        if (hit('[data-lp-demon]')) { tapDemon(); return; }
        if (hit('[data-lp-coin]') || hit('[data-lp-flip]')) { flipCoin(); return; }
        if (hit('[data-lp-layer-close]') || target === layer) {
            if (layer.dataset.kind !== 'welcome') closeLayer();
            return;
        }
        if (hit('[data-lp-claim]')) {
            act(async () => {
                await post('claim');
                closeLayer();
                await refresh();
                spinCoin();
            });
            return;
        }
        const row = hit('[data-lp-row]');
        if (row) {
            openRow = openRow === row.dataset.lpRow ? null : row.dataset.lpRow;
            render();
            return;
        }
        const add = hit('[data-lp-add]');
        if (add) {
            const input = main.querySelector('[data-lp-amount]');
            const current = amountValue();
            input.value = String((Number.isSafeInteger(current) ? current : 0) + Number(add.dataset.lpAdd));
            updatePreview();
            return;
        }
        if (hit('[data-lp-max]')) {
            const input = main.querySelector('[data-lp-amount]');
            input.value = String(Math.max(0, Math.floor((balance() == null ? 1000 : balance()) + 1e-9)));
            updatePreview();
            return;
        }
        const buy = hit('[data-lp-buy]');
        if (buy && !buy.disabled) {
            const amount = amountValue();
            act(async () => {
                const r = await post('trade', { problem: buy.dataset.lpBuy, side: 'buy', amount });
                toast(`${C.bought}: ${nf0.format(r.shares)} ${plural(r.shares, C.shares)} ${r.problem}`);
                openRow = null;
                await refresh();
            });
            return;
        }
        const sell = hit('[data-lp-sell]');
        if (sell) {
            const problem = sell.dataset.lpSell;
            const pos = state.me && state.me.positions.find((p) => p.problem === problem);
            const shares = sell.dataset.shares === 'all' || !pos ? 'all' : pos.shares / 2;
            act(async () => {
                const r = await post('trade', { problem, side: 'sell', shares });
                toast(`${C.sold}: ${problem} · +${nf0.format(r.amount)} ħ`);
                await refresh();
            });
            return;
        }
        const cancel = hit('[data-lp-cancel]');
        if (cancel) {
            act(async () => {
                const r = await post('cancel-chat-bet', { id: Number(cancel.dataset.lpCancel) });
                toast(`${r.problem} · +${nf0.format(r.amount)} ħ`);
                await refresh();
            });
            return;
        }
        const statement = hit('[data-lp-statement]');
        if (statement) {
            const trade = statement.closest('.lp-trade');
            const body = trade && trade.querySelector('[data-lp-statement-body]');
            if (!body) return;
            if (!body.hidden) { body.hidden = true; return; }
            body.hidden = false;
            if (!body.dataset.loaded) {
                fetch(`/api/problem/${encodeURIComponent(statement.dataset.lpStatement)}/statement?lang=${boot.lang}`, { credentials: 'same-origin' })
                    .then((r) => (r.ok ? r.json() : null))
                    .then((data) => {
                        body.dataset.loaded = '1';
                        body.innerHTML = data && data.html ? data.html : '';
                    })
                    .catch(() => {});
            }
            return;
        }
        if (hit('[data-lp-perpetuum]')) { toast(C.perpetuumRefusal); return; }
        const unlock = hit('[data-lp-unlock]');
        if (unlock && !unlock.disabled) {
            const emoji = unlock.dataset.lpUnlock;
            if (confirming !== emoji) {
                confirming = emoji;
                render();
                return;
            }
            confirming = null;
            act(async () => {
                await post('unlock', { emoji });
                toast(C.unlocked);
                tellChat({ type: 'ss-rx-unlocked', emoji });
                await refresh();
            });
        }
    });

    document.addEventListener('input', (e) => {
        if (e.target instanceof Element && e.target.matches('[data-lp-amount]')) updatePreview();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!layer.hidden && layer.dataset.kind !== 'welcome') closeLayer();
            else if (boot.embed) tellChat({ type: 'ss-app-close', app: 'last-problem' });
        } else if (e.key === 'Enter' && e.target instanceof Element && e.target.matches('[data-lp-amount]')) {
            const buy = main.querySelector('[data-lp-buy]');
            if (buy && !buy.disabled) buy.click();
        }
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (tab === 'market') drawChart(); }, 120);
    });

    setInterval(() => {
        if (document.visibilityState === 'visible' && !busy && layer.hidden) refresh();
    }, 30 * 1000);

    render();
})();
