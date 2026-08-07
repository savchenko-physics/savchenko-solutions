// feedback.js: the suggestion box, the contextual prompts and the one-question poll.
//
// Vanilla, no dependencies, no third-party origin (tests/external-assets.test.js enforces
// the last one). Loaded on every page from the site-wide header partial.
//
// Markup contract. The templates stay almost empty and everything else is built here, so
// there is one copy of this UI rather than one per page:
//
//   <script type="application/json" id="fb-config">{...}</script>   copy + categories, from feedbackQuestions.js
//   <button class="fb-tab" data-fb-tab>                             the floating tab
//   <element data-fb-open [data-fb-category="broken"]>              any contextual prompt
//   <element data-fb-poll>                                          where the poll may appear
//
// Three behaviours are deliberate and easy to undo by accident:
//
//   The contact field is not rendered until something has been typed. Progressive
//   disclosure is why this form can ask for a contact at all without paying for it in
//   completions.
//
//   The receipt link is shown, not just implied. A signed-out submitter has no account to
//   check; without a link they assume the message vanished and re-post it somewhere else,
//   which is exactly what has been happening.
//
//   The poll shows one question and then never appears again for that browser. If you find
//   yourself adding a second question to the same view, the design has been lost.
(function feedbackWidget() {
    'use strict';

    const cfgEl = document.getElementById('fb-config');
    if (!cfgEl) return;

    let CFG;
    try {
        CFG = JSON.parse(cfgEl.textContent);
    } catch (_) {
        return; // never let a copy error take a solution page down with it
    }
    const T = CFG.copy || {};
    const CATS = CFG.categories || [];
    if (!CATS.length) return;

    const POLL_KEY = 'ss-fb-poll';

    const read = (k) => {
        try { return localStorage.getItem(k); } catch (_) { return null; }   // private mode
    };
    const write = (k, v) => {
        try { localStorage.setItem(k, v); } catch (_) { /* nothing to do */ }
    };
    const answeredPolls = () => {
        try { return JSON.parse(read(POLL_KEY) || '[]') || []; } catch (_) { return []; }
    };
    const markPollAnswered = (id) => {
        const a = answeredPolls();
        if (!a.includes(id)) a.push(id);
        write(POLL_KEY, JSON.stringify(a));
    };

    const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;      // textContent, never innerHTML
        return n;
    };

    // The problem this reader is looking at, so a bare "it's wrong" still lands attached to
    // something. The template may say; otherwise the URL does, and /ru/8.3.36 is the shape
    // 54% of all landings take.
    function problemContext() {
        const d = document.body.dataset || {};
        if (d.fbProblem) return { name: d.fbProblem, lang: d.fbProblemLang || CFG.lang };
        const m = location.pathname.match(/^\/(ru|en)\/(\d{1,2}\.\d{1,2}\.\d{1,3})(?:\/|$)/);
        return m ? { name: m[2], lang: m[1] } : { name: null, lang: null };
    }

    // ── Panel ───────────────────────────────────────────────────────────────────────

    let panel = null;
    let state = null;

    function buildPanel() {
        const root = el('div', 'fb-panel');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'false');
        root.setAttribute('aria-label', T.title || 'Feedback');
        root.hidden = true;

        const head = el('div', 'fb-head');
        const heads = el('div');
        heads.appendChild(el('p', 'fb-title', T.title));
        heads.appendChild(el('p', 'fb-sub', T.subtitle));
        const close = el('button', 'fb-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', T.close || 'Close');
        head.append(heads, close);

        const body = el('div', 'fb-body');

        body.appendChild(el('span', 'fb-legend', T.categoryLegend));
        const cats = el('div', 'fb-cats');
        CATS.forEach((c) => {
            const b = el('button', 'fb-cat', c.label);
            b.type = 'button';
            b.dataset.cat = c.id;
            b.setAttribute('aria-pressed', 'false');
            cats.appendChild(b);
        });
        body.appendChild(cats);

        const prompt = el('p', 'fb-prompt', '');
        const input = el('textarea', 'fb-input');
        input.rows = 4;

        // Off-screen and unlabelled. A person never sees it; a form-filling bot fills it.
        const hp = el('input', 'fb-hp');
        hp.type = 'text';
        hp.name = 'website';
        hp.tabIndex = -1;
        hp.setAttribute('autocomplete', 'off');
        hp.setAttribute('aria-hidden', 'true');

        body.append(prompt, input, hp);

        // Everything below appears only after the reader has typed something.
        const more = el('div', 'fb-more');
        more.hidden = true;
        more.appendChild(el('span', 'fb-legend', T.contactLegend));
        const row = el('div', 'fb-contact-row');
        (T.contactKinds || []).forEach((k, i) => {
            const b = el('button', 'fb-kind', k.label);
            b.type = 'button';
            b.dataset.kind = k.id;
            b.setAttribute('aria-pressed', String(i === 0));
            row.appendChild(b);
        });
        const contact = el('input', 'fb-contact');
        contact.type = 'text';
        contact.setAttribute('autocomplete', 'off');
        row.appendChild(contact);
        more.appendChild(row);

        const check = el('label', 'fb-check');
        const cb = el('input');
        cb.type = 'checkbox';
        check.append(cb, document.createTextNode(' ' + (T.notifyLabel || '')));
        more.appendChild(check);
        body.appendChild(more);

        const err = el('p', 'fb-error', '');
        err.hidden = true;
        err.setAttribute('role', 'alert');
        body.appendChild(err);

        const foot = el('div', 'fb-foot');
        const hint = el('span', 'fb-hint');
        const boardA = el('a', null, T.boardLink);
        boardA.href = boardHref();
        hint.appendChild(boardA);
        const send = el('button', 'fb-send', T.send);
        send.type = 'button';
        send.disabled = true;
        foot.append(hint, send);

        root.append(head, body, foot);
        document.body.appendChild(root);

        state = {
            root, body, foot, cats, prompt, input, hp, more, contact, cb, err, send,
            category: null,
            contactKind: (T.contactKinds && T.contactKinds[0] && T.contactKinds[0].id) || 'telegram',
            openedAt: 0,
        };

        close.addEventListener('click', hide);
        cats.addEventListener('click', (e) => {
            const b = e.target.closest('.fb-cat');
            if (b) selectCategory(b.dataset.cat);
        });
        row.addEventListener('click', (e) => {
            const b = e.target.closest('.fb-kind');
            if (!b) return;
            state.contactKind = b.dataset.kind;
            row.querySelectorAll('.fb-kind').forEach((k) => k.setAttribute('aria-pressed', String(k === b)));
            const kind = (T.contactKinds || []).find((k) => k.id === state.contactKind);
            state.contact.placeholder = (kind && kind.placeholder) || '';
            state.contact.focus();
        });
        input.addEventListener('input', () => {
            const typed = input.value.trim().length > 0;
            state.more.hidden = !typed;
            state.send.disabled = !typed || !state.category;
            state.err.hidden = true;
        });
        send.addEventListener('click', submit);
        // Escape closes, which is what a dialog is expected to do even when it is modeless.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !root.hidden) hide();
        });

        return root;
    }

    function boardHref() {
        return CFG.lang === 'ru' ? '/ru/feedback' : '/en/feedback';
    }

    function selectCategory(id) {
        const cat = CATS.find((c) => c.id === id);
        if (!cat) return;
        state.category = id;
        state.cats.querySelectorAll('.fb-cat').forEach((b) => {
            b.setAttribute('aria-pressed', String(b.dataset.cat === id));
        });
        // The prompt and the placeholder are the entire specificity mechanism: the same box
        // asks a different question depending on what the reader picked.
        state.prompt.textContent = cat.prompt;
        state.input.placeholder = cat.placeholder;
        state.send.disabled = state.input.value.trim().length === 0;
        state.input.focus();
    }

    // What an opener with no explicit category falls back to. NOT CATS[0], which is
    // "error in a solution": the floating tab is labelled Suggest, so opening it used to
    // greet the reader with "what exactly is wrong?" and a box asking which formula broke.
    // Every contextual prompt passes its own category, so this only covers the generic tab.
    const DEFAULT_CATEGORY = CATS.some((c) => c.id === 'idea') ? 'idea' : CATS[0].id;

    function show(category) {
        if (!panel) panel = buildPanel();
        panel.hidden = false;
        const tab = document.querySelector('[data-fb-tab]');
        if (tab) tab.hidden = true;
        state.openedAt = Date.now();
        selectCategory(category && CATS.some((c) => c.id === category) ? category : DEFAULT_CATEGORY);
    }

    function hide() {
        if (panel) panel.hidden = true;
        const tab = document.querySelector('[data-fb-tab]');
        if (tab) tab.hidden = false;
    }

    function showError(key) {
        const map = {
            too_short: T.errorTooShort,
            too_long: T.errorTooLong,
            too_fast: T.errorTooFast,
            rate_limited: T.errorRateLimited,
            contact_email: T.errorGeneric,
            contact_telegram: T.errorGeneric,
        };
        state.err.textContent = map[key] || T.errorGeneric;
        state.err.hidden = false;
        state.send.disabled = false;
        state.send.textContent = T.send;
    }

    async function submit() {
        const ctx = problemContext();
        state.send.disabled = true;
        state.send.textContent = T.sending;
        state.err.hidden = true;
        try {
            const res = await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    category: state.category,
                    body: state.input.value,
                    lang: CFG.lang,
                    hp: state.hp.value,
                    // A delta on one clock, so a wrong system time cannot reject anyone.
                    elapsedMs: state.openedAt ? Date.now() - state.openedAt : null,
                    contactKind: state.contactKind,
                    contactValue: state.contact.value,
                    notifyOnShip: state.cb.checked,
                    pageUrl: location.href,
                    problemName: ctx.name,
                    problemLang: ctx.lang,
                    viewportW: window.innerWidth,
                    referrer: document.referrer || null,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) return showError(data.error);
            renderDone(data.publicId);
        } catch (_) {
            showError('server');
        }
    }

    function renderDone(publicId) {
        const url = `${location.origin}/feedback/${publicId}`;
        state.body.remove();
        state.foot.remove();
        const done = el('div', 'fb-done');
        done.appendChild(el('h3', null, T.thanksTitle));
        done.appendChild(el('p', null, T.thanksBody));
        done.appendChild(el('span', 'fb-legend', T.receiptLabel));
        const a = el('a', 'fb-receipt', url);
        a.href = url;
        done.appendChild(a);
        const actions = el('div', 'fb-done-actions');
        const again = el('button', 'fb-linkbtn', T.again);
        again.type = 'button';
        // Sending a second, separate message is the intended pattern: two short ones beat
        // one long one nobody finishes.
        again.addEventListener('click', () => {
            state.root.remove();
            panel = null;
            state = null;
            show(null);
        });
        const board = el('a', 'fb-linkbtn', T.boardLink);
        board.href = boardHref();
        actions.append(again, board);
        done.appendChild(actions);
        state.root.appendChild(done);
    }

    // ── Poll ────────────────────────────────────────────────────────────────────────

    async function initPoll() {
        const slot = document.querySelector('[data-fb-poll]');
        if (!slot) return;
        const answered = answeredPolls();
        let q;
        try {
            const res = await fetch(`/api/feedback/poll?lang=${encodeURIComponent(CFG.lang)}&answered=${encodeURIComponent(answered.join(','))}`);
            if (!res.ok) return;
            q = (await res.json()).question;
        } catch (_) {
            return;
        }
        if (!q) return;   // this browser has seen them all; it is now done, permanently

        const box = el('div', 'fb-poll');
        const heading = el('p', 'fb-poll-q', q.question);
        box.appendChild(heading);

        const finish = (payload) => {
            markPollAnswered(q.id);
            fetch('/api/feedback/poll', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    questionId: q.id,
                    lang: CFG.lang,
                    viewportW: window.innerWidth,
                    pageUrl: location.href,
                    ...payload,
                }),
            }).catch(() => {});
            box.textContent = '';
            box.appendChild(el('p', 'fb-poll-thanks', T.pollThanks));
        };

        // A second line, only for teachers, only after they have said they are one. They are
        // the group best placed to answer and rare enough that the extra ask costs nothing
        // in aggregate.
        const askFollowUp = (choice) => {
            box.textContent = '';
            box.appendChild(el('p', 'fb-poll-q', q.followUp.prompt));
            const wrap = el('div', 'fb-poll-free');
            const inp = el('input');
            inp.type = 'text';
            const go = el('button', 'fb-poll-send', T.pollSubmit);
            go.type = 'button';
            wrap.append(inp, go);
            box.appendChild(wrap);
            const skip = el('button', 'fb-poll-skip', T.pollSkip);
            skip.type = 'button';
            box.appendChild(skip);
            go.addEventListener('click', () => finish({ choice, freeText: inp.value }));
            inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
            skip.addEventListener('click', () => finish({ choice }));
        };

        const answer = (choice, freeText) => {
            if (q.followUp && choice && q.followUp.when.indexOf(choice) !== -1) return askFollowUp(choice);
            finish({ choice, freeText });
        };

        if (q.options) {
            const opts = el('div', 'fb-poll-opts');
            q.options.forEach((o) => {
                const b = el('button', 'fb-poll-opt', o);
                b.type = 'button';
                b.addEventListener('click', () => answer(o, null));
                opts.appendChild(b);
            });
            if (q.allowOther) {
                const b = el('button', 'fb-poll-opt', T.pollOther);
                b.type = 'button';
                // The old survey's "Other" was a checkbox with nowhere to write, so the one
                // person who picked it told us nothing. This one has a box.
                b.addEventListener('click', () => {
                    opts.remove();
                    const wrap = el('div', 'fb-poll-free');
                    const inp = el('input');
                    inp.type = 'text';
                    const go = el('button', 'fb-poll-send', T.pollSubmit);
                    go.type = 'button';
                    wrap.append(inp, go);
                    box.insertBefore(wrap, box.querySelector('.fb-poll-skip'));
                    inp.focus();
                    go.addEventListener('click', () => finish({ choice: 'Other', freeText: inp.value }));
                    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
                });
                opts.appendChild(b);
            }
            box.appendChild(opts);
        } else {
            const wrap = el('div', 'fb-poll-free');
            const inp = el('input');
            inp.type = 'text';
            inp.placeholder = q.placeholder || '';
            const go = el('button', 'fb-poll-send', T.pollSubmit);
            go.type = 'button';
            wrap.append(inp, go);
            box.appendChild(wrap);
            go.addEventListener('click', () => { if (inp.value.trim()) finish({ freeText: inp.value }); });
            inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
        }

        const skip = el('button', 'fb-poll-skip', T.pollSkip);
        skip.type = 'button';
        // Skipping retires the question too. Re-asking someone who declined is how a poll
        // stops being a question and starts being nagging.
        skip.addEventListener('click', () => { markPollAnswered(q.id); box.remove(); });
        box.appendChild(skip);

        slot.appendChild(box);
    }

    // ── Wiring ──────────────────────────────────────────────────────────────────────

    function init() {
        document.addEventListener('click', (e) => {
            const opener = e.target.closest('[data-fb-open], [data-fb-tab]');
            if (!opener) return;
            e.preventDefault();
            show(opener.dataset.fbCategory || null);
        });
        initPoll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
