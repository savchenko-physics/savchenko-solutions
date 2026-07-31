// Difficulty mode for the problem grids — one implementation for every grid on the site.
//
// The homepage chapter grid and the section grid in each solution page's sidebar show the
// same problems and must never disagree about how they are coloured. They previously had a
// copy of this logic each, which meant two places to keep in step and two ways to drift.
//
// The choice is stored under one key and reapplied on every page, so it follows the reader
// around; the `storage` event carries it to other open tabs, which is the case a page-load
// read cannot cover. Without that, toggling on the homepage left a solution page already
// open in the next tab showing the old colours indefinitely.
//
// Markup contract:
//   <input type="checkbox" role="switch" data-grid-mode-toggle>   the switch (any number)
//   <element data-grid-mode-when="difficulty">                    shown only in heat mode
//   <element data-grid-mode-when="progress">                      hidden in heat mode
// and `body.grid-heat` is what the CSS actually keys off.
(function gridMode() {
    const KEY = 'ss-grid-mode';
    const ON = 'difficulty';

    const read = () => {
        try { return localStorage.getItem(KEY); } catch (_) { return null; }   // private mode
    };
    const write = (value) => {
        try { localStorage.setItem(KEY, value); } catch (_) { /* nothing to do */ }
    };

    function apply(on, persist) {
        document.body.classList.toggle('grid-heat', on);
        // Every switch on the page follows, not just the one that was clicked.
        document.querySelectorAll('[data-grid-mode-toggle]').forEach((el) => { el.checked = on; });
        document.querySelectorAll('[data-grid-mode-when="difficulty"]').forEach((el) => { el.hidden = !on; });
        document.querySelectorAll('[data-grid-mode-when="progress"]').forEach((el) => { el.hidden = on; });
        if (persist) write(on ? ON : 'progress');
    }

    function init() {
        apply(read() === ON, false);
        document.querySelectorAll('[data-grid-mode-toggle]').forEach((el) => {
            el.addEventListener('change', () => apply(el.checked, true));
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // Fires in every OTHER tab of this origin when one of them writes the key.
    window.addEventListener('storage', (e) => {
        if (e.key === KEY) apply(e.newValue === ON, false);
    });
})();
