/* Brainstorm Room — full per-problem conversation.
 *
 * Embedded inline on the problem page (and reused on the standalone /brainstorm
 * page). Reuses the platform's existing real-time approach (AJAX polling, like the
 * messages chat) — no sockets. The conversation is LAZY-LOADED on first visibility
 * so the hot problem page costs nothing unless the reader actually opens it.
 *
 * Renders messages, posts new ones, toggles emoji reactions, pins (curators),
 * edits/deletes own messages, loads older pages, and supports wiki-style problem
 * links (descriptive `[text](#x.y.z)` and bare `#x.y.z`). Vanilla JS.
 */
(function () {
    'use strict';

    var BSR = window.BSR;
    if (!BSR) return;

    var POLL_MS = 5000;
    var PROBLEM_ID = '\\d{1,2}\\.\\d{1,2}\\.\\d{1,2}';
    var isAdmin = BSR.currentUser === 'astrosander';

    var listEl = document.getElementById('bsrMessages');
    var inputEl = document.getElementById('bsrInput');
    var sendEl = document.getElementById('bsrSend');
    var olderBtn = document.getElementById('bsrLoadOlder');
    if (!listEl) return;
    var roomEl = listEl.closest('.bsr-room') || listEl;

    var newestId = null;
    var oldestId = null;
    var hasMore = false;
    var sinceTs = '1970-01-01T00:00:00.000Z';
    var pollTimer = null;
    var loaded = false;
    var visible = false;

    // Quiet-mode state (rail live chat): 'rotate' = live, 'static' = paused,
    // 'hidden' = collapsed. Persisted in user_preferences (logged in) or
    // localStorage (guest) — the same mechanism the rotating block used.
    var sectionEl = listEl.closest('[data-bsr-room]') || roomEl;
    var QUIET = ['rotate', 'static', 'hidden'];
    var STORAGE_KEY = 'bsDisplayMode';
    var mode = sectionEl.getAttribute('data-mode') || 'rotate';
    if (QUIET.indexOf(mode) === -1) mode = 'rotate';
    if (!BSR.loggedIn) {
        try {
            var stored = window.localStorage.getItem(STORAGE_KEY);
            if (stored && QUIET.indexOf(stored) !== -1) mode = stored;
        } catch (e) { /* storage blocked */ }
    }
    var lastVisibleMode = mode === 'static' ? 'static' : 'rotate';

    // ── helpers ──────────────────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function bumpSince(ts) { if (ts && ts > sinceTs) sinceTs = ts; }

    function relTime(iso) {
        var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
        var ru = BSR.lang === 'ru';
        if (s < 60) return ru ? 'только что' : 'just now';
        var m = Math.floor(s / 60);
        if (m < 60) return ru ? (m + ' мин. назад') : (m + 'm ago');
        var h = Math.floor(m / 60);
        if (h < 24) return ru ? (h + ' ч. назад') : (h + 'h ago');
        var d = Math.floor(h / 24);
        if (d < 30) return ru ? (d + ' дн. назад') : (d + 'd ago');
        return new Date(iso).toLocaleDateString(ru ? 'ru-RU' : 'en-US');
    }

    // Mirror of the server's formatBrainstormHtml (multiline): escape → protect
    // math → wiki/@ links → <br>. Keeps client and server output consistent.
    function format(content) {
        var text = esc(content);
        var math = [];
        text = text.replace(/\$\$([\s\S]*?)\$\$/g, function (mm) { return '\x00M' + (math.push(mm) - 1) + '\x00'; });
        text = text.replace(/\$([^\$\n]+?)\$/g, function (mm) { return '\x00M' + (math.push(mm) - 1) + '\x00'; });
        var reLink = new RegExp('\\[([^\\]]+?)\\]\\(#(' + PROBLEM_ID + ')\\)|(?<![\\w#/.])#(' + PROBLEM_ID + ')\\b', 'g');
        text = text.replace(reLink, function (full, dtext, dtarget, btarget) {
            var target = dtarget || btarget;
            var label = dtarget != null ? dtext : '#' + btarget;
            return '<a href="/' + BSR.lang + '/' + target + '" class="bs-link">' + label + '</a>';
        });
        text = text.replace(/@(\w+)/g, '<a href="/user/$1" class="bs-link">@$1</a>');
        text = text.replace(/\n/g, '<br>');
        text = text.replace(/\x00M(\d+)\x00/g, function (_, i) { return math[parseInt(i, 10)]; });
        return text;
    }

    function typeset(nodes) {
        if (!window.MathJax) return;
        var run = function () { if (window.MathJax.typesetPromise) window.MathJax.typesetPromise(nodes).catch(function () {}); };
        if (window.MathJax.startup && window.MathJax.startup.promise) window.MathJax.startup.promise.then(run);
        else run();
    }

    function reactionsHtml(msg) {
        var chips = (msg.reactions || []).filter(function (r) { return r.count > 0; }).map(function (r) {
            return '<button type="button" class="bsr-chip' + (r.me ? ' is-mine' : '') +
                '" data-react="' + esc(r.emoji) + '">' + esc(r.emoji) + ' <span>' + r.count + '</span></button>';
        }).join('');
        var picker = BSR.reactions.map(function (e) {
            return '<button type="button" class="bsr-pick" data-react="' + esc(e) + '">' + esc(e) + '</button>';
        }).join('');
        var addBtn = BSR.loggedIn
            ? '<button type="button" class="bsr-react-add" title="' + esc(BSR.t.react) + '"><i class="far fa-face-smile"></i>+</button>' +
              '<span class="bsr-picker" hidden>' + picker + '</span>'
            : '';
        return chips + addBtn;
    }

    function toolsHtml(msg) {
        var out = '';
        if (BSR.loggedIn) out += '<button type="button" class="bsr-mtool" data-act="react-open" title="' + esc(BSR.t.react) + '"><i class="far fa-face-smile"></i></button>';
        if (BSR.isCurator) out += '<button type="button" class="bsr-mtool" data-act="pin" title="' + esc(msg.isPinned ? BSR.t.unpin : BSR.t.pin) + '"><i class="fas fa-thumbtack"></i></button>';
        if (msg.isEditable) out += '<button type="button" class="bsr-mtool" data-act="edit" title="' + esc(BSR.t.edit) + '"><i class="fas fa-pen"></i></button>';
        if (msg.isEditable || isAdmin) out += '<button type="button" class="bsr-mtool" data-act="delete" title="' + esc(BSR.t.del) + '"><i class="fas fa-trash"></i></button>';
        return out;
    }

    function messageHtml(msg) {
        var a = msg.author || {};
        var langChip = msg.language ? '<span class="bsr-lang">' + esc(msg.language.toUpperCase()) + '</span>' : '';
        var country = a.country ? '<span class="bsr-country">' + esc(a.country) + '</span>' : '';
        var pin = msg.isPinned ? '<span class="bsr-pinned" title="' + esc(BSR.t.pinned) + '"><i class="fas fa-thumbtack"></i> ' + esc(BSR.t.pinned) + '</span>' : '';
        var edited = msg.edited ? '<span class="bsr-edited">' + esc(BSR.t.edited) + '</span>' : '';
        return '' +
            '<div class="bsr-msg' + (msg.isPinned ? ' is-pinned' : '') + '" data-id="' + msg.id + '">' +
                '<img class="bsr-msg-avatar" src="' + esc(a.profilePicture || BSR.defaultAvatar) + '" alt="" width="36" height="36" loading="lazy">' +
                '<div class="bsr-msg-col">' +
                    '<div class="bsr-msg-top">' +
                        '<a class="bsr-msg-author" href="/user/' + esc(a.username) + '">' + esc(a.fullName || a.username) + '</a>' +
                        country + langChip +
                        '<span class="bsr-msg-time" title="' + esc(msg.createdAt) + '">' + relTime(msg.createdAt) + '</span>' +
                        edited + pin +
                        '<span class="bsr-msg-tools">' + toolsHtml(msg) + '</span>' +
                    '</div>' +
                    '<div class="bsr-msg-body">' + format(msg.content) + '</div>' +
                    '<div class="bsr-msg-reactions">' + reactionsHtml(msg) + '</div>' +
                '</div>' +
            '</div>';
    }

    // The messages list is itself the scroll container (an inline chat box).
    function scrollToBottom() { listEl.scrollTop = listEl.scrollHeight; }
    function nearBottom() { return (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight) < 120; }

    function appendMessage(msg, scroll) {
        if (listEl.querySelector('[data-id="' + msg.id + '"]')) return; // dedupe
        var wrap = document.createElement('div');
        wrap.innerHTML = messageHtml(msg);
        var node = wrap.firstChild;
        listEl.appendChild(node);
        bumpSince(msg.updatedAt || msg.createdAt);
        typeset([node]);
        if (scroll) scrollToBottom();
    }

    function prependMessage(msg) {
        if (listEl.querySelector('[data-id="' + msg.id + '"]')) return;
        var wrap = document.createElement('div');
        wrap.innerHTML = messageHtml(msg);
        var node = wrap.firstChild;
        listEl.insertBefore(node, listEl.firstChild);
        bumpSince(msg.updatedAt || msg.createdAt);
        typeset([node]);
    }

    function renderList(msgs) {
        listEl.innerHTML = '';
        if (!msgs.length) {
            listEl.innerHTML = '<div class="bsr-empty">' + esc(BSR.t.empty) + '</div>';
            return;
        }
        msgs.forEach(function (m) { appendMessage(m, false); });
        scrollToBottom();
    }

    // ── reactions / updates applied to an existing node ──────────────────────
    function applyReactions(id, reactions) {
        var node = listEl.querySelector('[data-id="' + id + '"]');
        if (!node) return;
        node.querySelector('.bsr-msg-reactions').innerHTML = reactionsHtml({ id: id, reactions: reactions });
    }

    function applyUpdate(u) {
        var node = listEl.querySelector('[data-id="' + u.id + '"]');
        if (!node) return;
        if (u.isDeleted) { node.remove(); return; }
        var body = node.querySelector('.bsr-msg-body');
        body.innerHTML = format(u.content);
        typeset([body]);
        node.classList.toggle('is-pinned', !!u.isPinned);
        bumpSince(u.updatedAt);
    }

    // ── network actions ──────────────────────────────────────────────────────
    function postMessage() {
        var content = (inputEl.value || '').trim();
        if (!content) return;
        sendEl.disabled = true;
        fetch('/api/brainstorm/' + encodeURIComponent(BSR.problem) + '/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content, lang: BSR.lang })
        }).then(function (r) { return r.json(); }).then(function (data) {
            sendEl.disabled = false;
            if (data && data.message) {
                var empty = listEl.querySelector('.bsr-empty');
                if (empty) empty.remove();
                appendMessage(data.message, true);
                if (data.message.id > (newestId || 0)) newestId = data.message.id;
                inputEl.value = '';
                inputEl.focus();
            }
        }).catch(function () { sendEl.disabled = false; });
    }

    function toggleReaction(id, emoji) {
        fetch('/api/brainstorm/messages/' + id + '/react', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emoji: emoji })
        }).then(function (r) { return r.json(); }).then(function (data) {
            if (data && data.reactions) applyReactions(id, data.reactions);
        }).catch(function () {});
    }

    function togglePin(id, node) {
        fetch('/api/brainstorm/messages/' + id + '/pin', { method: 'POST' })
            .then(function (r) { return r.json(); }).then(function (data) {
                if (data && typeof data.isPinned === 'boolean') {
                    node.classList.toggle('is-pinned', data.isPinned);
                    var btn = node.querySelector('[data-act="pin"]');
                    if (btn) btn.title = data.isPinned ? BSR.t.unpin : BSR.t.pin;
                }
            }).catch(function () {});
    }

    function deleteMessage(id, node) {
        if (!window.confirm(BSR.t.confirmDelete)) return;
        fetch('/api/brainstorm/messages/' + id, { method: 'DELETE' })
            .then(function (r) { return r.json(); }).then(function (data) {
                if (data && data.ok) node.remove();
            }).catch(function () {});
    }

    function startEdit(id, node) {
        var body = node.querySelector('.bsr-msg-body');
        if (node.querySelector('.bsr-edit')) return;
        var current = body.getAttribute('data-raw') || body.textContent;
        var box = document.createElement('div');
        box.className = 'bsr-edit';
        box.innerHTML = '<textarea class="bsr-edit-input" rows="3"></textarea>' +
            '<div class="bsr-edit-actions">' +
            '<button type="button" class="bsr-edit-cancel">' + esc(BSR.t.cancel) + '</button>' +
            '<button type="button" class="bsr-edit-save">' + esc(BSR.t.save) + '</button></div>';
        body.style.display = 'none';
        node.querySelector('.bsr-msg-col').insertBefore(box, body.nextSibling);
        var ta = box.querySelector('.bsr-edit-input');
        ta.value = current;
        ta.focus();
        box.querySelector('.bsr-edit-cancel').addEventListener('click', function () { box.remove(); body.style.display = ''; });
        box.querySelector('.bsr-edit-save').addEventListener('click', function () {
            var val = (ta.value || '').trim();
            if (!val) return;
            fetch('/api/brainstorm/messages/' + id, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: val })
            }).then(function (r) { return r.json(); }).then(function (data) {
                if (data && data.ok) {
                    body.innerHTML = format(val);
                    body.setAttribute('data-raw', val);
                    typeset([body]);
                    if (!node.querySelector('.bsr-edited')) {
                        var t = node.querySelector('.bsr-msg-time');
                        if (t) t.insertAdjacentHTML('afterend', '<span class="bsr-edited">' + esc(BSR.t.edited) + '</span>');
                    }
                }
                box.remove(); body.style.display = '';
            }).catch(function () { box.remove(); body.style.display = ''; });
        });
    }

    function loadOlder() {
        if (!hasMore || oldestId == null) return;
        olderBtn.disabled = true;
        fetch('/api/brainstorm/' + encodeURIComponent(BSR.problem) + '/messages?before=' + oldestId + '&limit=40')
            .then(function (r) { return r.json(); }).then(function (data) {
                olderBtn.disabled = false;
                if (!data || !data.messages) return;
                var prevHeight = listEl.scrollHeight;
                data.messages.forEach(function (m) { prependMessage(m); }); // server is newest-first
                listEl.scrollTop += (listEl.scrollHeight - prevHeight); // keep viewport stable
                oldestId = data.oldestId;
                hasMore = data.hasMore;
                if (!hasMore) olderBtn.style.display = 'none';
            }).catch(function () { olderBtn.disabled = false; });
    }

    // ── polling ──────────────────────────────────────────────────────────────
    function poll() {
        if (!loaded) return;
        var url = '/api/brainstorm/' + encodeURIComponent(BSR.problem) + '/poll?after=' +
            (newestId || 0) + '&since=' + encodeURIComponent(sinceTs);
        fetch(url).then(function (r) { return r.json(); }).then(function (data) {
            if (!data) return;
            var stick = nearBottom();
            (data.messages || []).forEach(function (m) {
                appendMessage(m, false);
                if (m.id > (newestId || 0)) newestId = m.id;
            });
            (data.updates || []).forEach(applyUpdate);
            (data.reactionUpdates || []).forEach(function (u) { applyReactions(u.messageId, u.reactions); });
            if (stick && (data.messages || []).length) scrollToBottom();
        }).catch(function () {});
    }

    function startPolling() { stopPolling(); pollTimer = setInterval(poll, POLL_MS); }
    function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    // Poll only while the chat is live (not paused/collapsed), visible, loaded.
    function maybeStartPolling() {
        if (loaded && mode === 'rotate' && visible && !document.hidden) startPolling();
        else stopPolling();
    }

    // ── lazy first load ───────────────────────────────────────────────────────
    function fetchFirstPage() {
        fetch('/api/brainstorm/' + encodeURIComponent(BSR.problem) + '/messages?limit=40')
            .then(function (r) { return r.json(); }).then(function (data) {
                var msgs = ((data && data.messages) || []).slice().reverse(); // newest-first → chronological
                oldestId = data ? data.oldestId : null;
                newestId = data ? data.newestId : null;
                hasMore = data ? data.hasMore : false;
                msgs.forEach(function (m) { bumpSince(m.updatedAt || m.createdAt); });
                renderList(msgs);
                if (hasMore && olderBtn) olderBtn.style.display = '';
                maybeStartPolling();
            }).catch(function () {
                listEl.innerHTML = '<div class="bsr-empty">' + esc(BSR.t.failed) + '</div>';
            });
    }

    function ensureLoaded() {
        if (loaded || mode === 'hidden') return;
        loaded = true;
        fetchFirstPage();
    }

    // ── quiet mode (pause / collapse) ─────────────────────────────────────────
    function applyMode(next) {
        mode = next;
        if (next !== 'hidden') lastVisibleMode = next;
        QUIET.forEach(function (m) { sectionEl.classList.remove('bsr-room--' + m); });
        sectionEl.classList.add('bsr-room--' + next);
        sectionEl.setAttribute('data-mode', next);
        var pauseBtn = sectionEl.querySelector('[data-bsr-room-act="pause"]');
        if (pauseBtn) pauseBtn.setAttribute('aria-pressed', next === 'static' ? 'true' : 'false');
        if (next === 'hidden') { stopPolling(); return; }
        if (visible) { ensureLoaded(); maybeStartPolling(); }
    }

    function persistMode(next) {
        if (BSR.loggedIn) {
            fetch('/api/brainstorm/quiet-mode', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: next })
            }).catch(function () {});
        } else {
            try { window.localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
        }
    }

    function setMode(next) {
        if (QUIET.indexOf(next) === -1) return;
        applyMode(next);
        persistMode(next);
    }

    if (sectionEl) {
        sectionEl.addEventListener('click', function (ev) {
            var b = ev.target.closest('[data-bsr-room-act]');
            if (!b || !sectionEl.contains(b)) return;
            var act = b.getAttribute('data-bsr-room-act');
            if (act === 'pause') setMode(mode === 'rotate' ? 'static' : 'rotate');
            else if (act === 'collapse') setMode('hidden');
            else if (act === 'expand') setMode(lastVisibleMode || 'rotate');
        });
    }

    // ── wiring ───────────────────────────────────────────────────────────────
    listEl.addEventListener('click', function (ev) {
        var t = ev.target;
        var reactBtn = t.closest('[data-react]');
        if (reactBtn) {
            var msgNode = reactBtn.closest('.bsr-msg');
            if (msgNode && BSR.loggedIn) toggleReaction(parseInt(msgNode.getAttribute('data-id'), 10), reactBtn.getAttribute('data-react'));
            return;
        }
        var addBtn = t.closest('.bsr-react-add');
        if (addBtn) {
            var picker = addBtn.parentNode.querySelector('.bsr-picker');
            if (picker) picker.hidden = !picker.hidden;
            return;
        }
        var tool = t.closest('[data-act]');
        if (tool) {
            var node = tool.closest('.bsr-msg');
            var id = parseInt(node.getAttribute('data-id'), 10);
            var act = tool.getAttribute('data-act');
            if (act === 'pin') togglePin(id, node);
            else if (act === 'edit') startEdit(id, node);
            else if (act === 'delete') deleteMessage(id, node);
            else if (act === 'react-open') {
                var pk = node.querySelector('.bsr-picker');
                if (pk) pk.hidden = !pk.hidden;
            }
        }
    });

    if (sendEl) sendEl.addEventListener('click', postMessage);
    if (inputEl) {
        inputEl.addEventListener('focus', function () { visible = true; ensureLoaded(); });
        inputEl.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); postMessage(); }
        });
    }
    if (olderBtn) olderBtn.addEventListener('click', loadOlder);

    var toolbar = document.querySelector('.bsr-composer-toolbar');
    if (toolbar && inputEl) {
        toolbar.addEventListener('click', function (ev) {
            var b = ev.target.closest('[data-bsr-tool]');
            if (!b) return;
            var kind = b.getAttribute('data-bsr-tool');
            var insert = '';
            if (kind === 'problem') {
                var num = window.prompt(BSR.t.problemPromptNum);
                if (!num) return;
                num = num.trim().replace(/^#/, '');
                if (!new RegExp('^' + PROBLEM_ID + '$').test(num)) return;
                var label = (window.prompt(BSR.t.problemPromptText) || '').trim();
                insert = label ? ('[' + label + '](#' + num + ')') : ('#' + num);
            } else if (kind === 'mention') { insert = '@'; }
            else if (kind === 'math') { insert = '$$'; }
            var start = inputEl.selectionStart || inputEl.value.length;
            inputEl.value = inputEl.value.slice(0, start) + insert + inputEl.value.slice(inputEl.selectionEnd || start);
            inputEl.focus();
            inputEl.selectionStart = inputEl.selectionEnd = start + insert.length;
        });
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopPolling();
        else if (loaded && mode === 'rotate' && visible) { poll(); startPolling(); }
    });

    // ── boot: reflect the saved quiet mode, then load the conversation when it
    // scrolls into view (lazy). Collapsed stays collapsed until the reader
    // expands it; paused loads once but does not stream. ─────────────────────
    function activate() {
        visible = true;
        if (mode !== 'hidden') { ensureLoaded(); maybeStartPolling(); }
    }
    applyMode(mode);
    if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) { if (e.isIntersecting) { activate(); io.disconnect(); } });
        }, { rootMargin: '250px' });
        io.observe(roomEl);
    } else {
        activate();
    }
})();
