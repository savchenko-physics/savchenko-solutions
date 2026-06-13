/* Brainstorm Room — rotating block (problem page).
 *
 * Progressive enhancement over the server-rendered block: all top-N messages are
 * already in the DOM (good first paint, SEO, no flicker). This script only:
 *   - rotates which message is visible (subtle crossfade / vertical ticker),
 *   - pauses on hover and on focus, and honours prefers-reduced-motion,
 *   - lets the reader switch to a quiet (static) mode or hide the block,
 *   - persists that choice (server for logged-in users, localStorage for guests).
 * No framework, no dependencies — matches the rest of the site's vanilla JS.
 */
(function () {
    'use strict';

    var ROTATE_MS = 6000;
    var STORAGE_KEY = 'bsDisplayMode';
    var VALID = ['rotate', 'static', 'hidden'];

    function init(block) {
        var problem = block.getAttribute('data-problem');
        var loggedIn = block.getAttribute('data-logged-in') === '1';
        var count = parseInt(block.getAttribute('data-count'), 10) || 0;
        var reduceMotion = window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        var msgs = Array.prototype.slice.call(block.querySelectorAll('[data-bs-msg]'));
        var dots = Array.prototype.slice.call(block.querySelectorAll('[data-bs-dot]'));
        var ticker = block.querySelector('[data-bs-ticker]');

        var index = 0;
        var timer = null;
        var hoverPaused = false;
        // Mode the reader last had visible, so "show" restores something sensible.
        var lastVisible = block.getAttribute('data-mode') === 'static' ? 'static' : 'rotate';
        var mode = block.getAttribute('data-mode') || 'rotate';

        // For guests, the server can't know their stored preference — reconcile now.
        if (!loggedIn) {
            try {
                var stored = window.localStorage.getItem(STORAGE_KEY);
                if (stored && VALID.indexOf(stored) !== -1) mode = stored;
            } catch (e) { /* storage blocked — fall back to server default */ }
        }

        function show(i) {
            if (!msgs.length) return;
            index = (i + msgs.length) % msgs.length;
            msgs.forEach(function (m, j) {
                var active = j === index;
                m.classList.toggle('is-active', active);
                if (active) { m.removeAttribute('aria-hidden'); }
                else { m.setAttribute('aria-hidden', 'true'); }
                // Keep links in hidden messages out of the tab order / a11y tree.
                // `inert` is ignored by older browsers (graceful degradation).
                m.inert = !active;
            });
            dots.forEach(function (d, j) {
                d.classList.toggle('is-active', j === index);
            });
        }

        function stop() {
            if (timer) { clearInterval(timer); timer = null; }
        }

        function start() {
            stop();
            if (mode !== 'rotate' || reduceMotion || count <= 1 || hoverPaused) return;
            timer = setInterval(function () { show(index + 1); }, ROTATE_MS);
        }

        function applyMode(next) {
            mode = next;
            if (next !== 'hidden') lastVisible = next;
            VALID.forEach(function (m) { block.classList.remove('bs-block--' + m); });
            block.classList.add('bs-block--' + next);
            block.setAttribute('data-mode', next);

            var motionBtn = block.querySelector('[data-bs-action="toggle-motion"]');
            if (motionBtn) motionBtn.setAttribute('aria-pressed', next === 'static' ? 'true' : 'false');

            if (next === 'rotate' && !reduceMotion) { start(); }
            else { stop(); show(0); } // static/hidden: park on the top message
        }

        function persist(next) {
            if (loggedIn) {
                fetch('/api/brainstorm/quiet-mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: next })
                }).catch(function () { /* non-critical; the view already updated */ });
            } else {
                try { window.localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
            }
        }

        function setMode(next) {
            if (VALID.indexOf(next) === -1) return;
            applyMode(next);
            persist(next);
        }

        // Pause on hover / focus so motion never fights the reader.
        if (ticker) {
            ticker.addEventListener('mouseenter', function () { hoverPaused = true; stop(); });
            ticker.addEventListener('mouseleave', function () { hoverPaused = false; start(); });
            ticker.addEventListener('focusin', function () { hoverPaused = true; stop(); });
            ticker.addEventListener('focusout', function () { hoverPaused = false; start(); });
        }

        // Controls (event-delegated so the restore button works too).
        block.addEventListener('click', function (ev) {
            var actionEl = ev.target.closest('[data-bs-action]');
            if (actionEl && block.contains(actionEl)) {
                var action = actionEl.getAttribute('data-bs-action');
                if (action === 'toggle-motion') setMode(mode === 'rotate' ? 'static' : 'rotate');
                else if (action === 'hide') setMode('hidden');
                else if (action === 'show') setMode(lastVisible || 'rotate');
                return;
            }
            var dot = ev.target.closest('[data-bs-dot]');
            if (dot && block.contains(dot)) {
                show(parseInt(dot.getAttribute('data-index'), 10) || 0);
                start(); // reset the timer so it doesn't immediately advance past the pick
            }
        });

        applyMode(VALID.indexOf(mode) !== -1 ? mode : 'rotate');
    }

    function boot() {
        var block = document.querySelector('[data-bs-block]');
        if (block) init(block);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
