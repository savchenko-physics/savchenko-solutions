/* Dates and times in the reader's own time zone, on every page.
 *
 * The server runs in UTC and used to write dates into its pages itself: "Last edited 15 Sep",
 * "3 hours ago", a forum reply's time, the chat's day separators. A reader in Vladivostok or New
 * York saw them shifted, and late in the evening "today" was already tomorrow (the owner,
 * 2026-09-15: all times on the site in the reader's time zone, not just the chat's). So the server
 * now writes <time datetime="ISO" data-local="kind">UTC text</time> (lib/localTime.js, the
 * `localTime` template helper), and this script rewrites the text in the browser's own zone, in
 * the page's language, for those elements and for any added to the page later.
 *
 *   date       15 сент. 2026 г.             Sep 15, 2026
 *   longdate   15 сентября 2026 г.          September 15, 2026
 *   day        15 сентября (2025 if not now)  15 Sep
 *   daytime    15 сент., 13:40               Sep 15, 1:40 PM
 *   datetime   15 сент. 2026 г., 13:40       Sep 15, 2026, 1:40 PM
 *   time       13:40                         1:40 PM
 *   month      сентябрь 2026 г.              Sep 2026
 *   relative   только что, 5 мин назад, 3 ч назад, вчера, then as day
 *   recent     только что for the first hour, then as day (the feedback board writes dates)
 *
 * The language comes from data-lang on the element (the server always writes it), else <html lang>.
 * The full date and time go in the title for a hover. UMD like js/reactions.js: the server
 * require()s format() for the fallback text, which it writes in UTC.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SSTime = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Hours as 13:40 in Russian and 1:40 PM in English.
    const OPTIONS = {
        ru: {
            date: { year: 'numeric', month: 'short', day: 'numeric' },
            longdate: { year: 'numeric', month: 'long', day: 'numeric' },
            daytime: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
            datetime: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
            time: { hour: '2-digit', minute: '2-digit' },
            month: { year: 'numeric', month: 'long' },
        },
        en: {
            date: { year: 'numeric', month: 'short', day: 'numeric' },
            longdate: { year: 'numeric', month: 'long', day: 'numeric' },
            daytime: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
            datetime: { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
            time: { hour: 'numeric', minute: '2-digit' },
            month: { year: 'numeric', month: 'short' },
        },
    };
    const KINDS = ['date', 'longdate', 'day', 'daytime', 'datetime', 'time', 'month', 'relative', 'recent'];

    const cache = new Map();
    function formatter(locale, options, timeZone) {
        const key = `${locale}|${timeZone || ''}|${JSON.stringify(options)}`;
        let f = cache.get(key);
        if (!f) {
            f = new Intl.DateTimeFormat(locale, timeZone ? Object.assign({ timeZone }, options) : options);
            cache.set(key, f);
        }
        return f;
    }

    const localeOf = (lang) => (lang === 'ru' ? 'ru-RU' : 'en-US');

    function toDate(value) {
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
        if (value == null || value === '') return null;
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    // The calendar day of a moment in a zone, as a number that compares and subtracts by days.
    function dayNumber(date, timeZone) {
        const parts = formatter('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' }, timeZone).formatToParts(date);
        const get = (type) => Number((parts.find((p) => p.type === type) || {}).value);
        return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / 86400000);
    }

    function yearOf(date, timeZone) {
        return formatter('en-US', { year: 'numeric' }, timeZone).format(date);
    }

    /* "15 сентября" and "15 Sep", day first in both, as the drafts and the feedback board always
     * wrote it (en-GB's own short month is "Sept" in current browsers, so English is put together
     * from en-US parts); the year only when it is not this one. */
    function formatDay(date, lang, timeZone, now) {
        const withYear = yearOf(date, timeZone) !== yearOf(now, timeZone);
        if (lang === 'ru') {
            const options = withYear ? { day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long' };
            return formatter('ru-RU', options, timeZone).format(date);
        }
        const parts = formatter('en-US', { day: 'numeric', month: 'short', year: 'numeric' }, timeZone).formatToParts(date);
        const get = (type) => (parts.find((p) => p.type === type) || {}).value;
        return `${get('day')} ${get('month')}${withYear ? ` ${get('year')}` : ''}`;
    }

    function formatRelative(date, lang, timeZone, now) {
        const ru = lang === 'ru';
        const seconds = (now.getTime() - date.getTime()) / 1000;
        if (seconds < 60) return ru ? 'только что' : 'just now';
        if (seconds < 3600) {
            const m = Math.floor(seconds / 60);
            return ru ? `${m} мин назад` : `${m} min ago`;
        }
        const days = dayNumber(now, timeZone) - dayNumber(date, timeZone);
        // Hours while it is today, or a few hours ago just past midnight.
        if (seconds < 86400 && (days <= 0 || seconds < 6 * 3600)) {
            const h = Math.floor(seconds / 3600);
            return ru ? `${h} ч назад` : `${h} h ago`;
        }
        if (days === 1) return ru ? 'вчера' : 'yesterday';
        return formatDay(date, lang, timeZone, now);
    }

    /* The text for a moment. opts: { lang: 'ru' | 'en', timeZone (default the browser's), now }. */
    function format(value, kind, opts) {
        const date = toDate(value);
        if (!date) return '';
        const o = opts || {};
        const lang = o.lang === 'ru' ? 'ru' : 'en';
        const timeZone = o.timeZone || undefined;
        const now = toDate(o.now) || new Date();
        if (kind === 'relative') return formatRelative(date, lang, timeZone, now);
        if (kind === 'recent') {
            return now.getTime() - date.getTime() < 3600 * 1000 ? (lang === 'ru' ? 'только что' : 'just now') : formatDay(date, lang, timeZone, now);
        }
        if (kind === 'day') return formatDay(date, lang, timeZone, now);
        const options = OPTIONS[lang][kind] || OPTIONS[lang].date;
        return formatter(localeOf(lang), options, timeZone).format(date);
    }

    /* The full date and time, for a title. */
    function full(value, opts) {
        return format(value, 'datetime', opts);
    }

    function langFor(el) {
        const own = el.getAttribute('data-lang');
        if (own) return own;
        const doc = el.ownerDocument && el.ownerDocument.documentElement;
        return doc && String(doc.getAttribute('lang') || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
    }

    function localizeElement(el) {
        const kind = el.getAttribute('data-local');
        const iso = el.getAttribute('datetime');
        if (!kind || !iso) return;
        const lang = langFor(el);
        const text = format(iso, KINDS.includes(kind) ? kind : 'date', { lang });
        if (!text) return;
        if (el.textContent !== text) el.textContent = text;
        if (kind !== 'datetime' && !el.hasAttribute('data-local-notitle')) {
            const title = full(iso, { lang });
            if (el.getAttribute('title') !== title) el.setAttribute('title', title);
        }
    }

    function localize(rootNode) {
        const scope = rootNode || (typeof document !== 'undefined' ? document : null);
        if (!scope || !scope.querySelectorAll) return;
        if (scope.matches && scope.matches('time[data-local]')) localizeElement(scope);
        scope.querySelectorAll('time[data-local]').forEach(localizeElement);
    }

    function start() {
        localize(document);
        if (typeof MutationObserver === 'function') {
            new MutationObserver((records) => {
                for (const r of records) {
                    for (const node of r.addedNodes) {
                        if (node.nodeType === 1) localize(node);
                    }
                }
            }).observe(document.documentElement, { childList: true, subtree: true });
        }
        // "5 min ago" becomes "6 min ago" while the page stays open.
        setInterval(() => {
            if (document.visibilityState === 'visible') document.querySelectorAll('time[data-local="relative"], time[data-local="recent"]').forEach(localizeElement);
        }, 60 * 1000);
    }

    if (typeof document !== 'undefined' && typeof window !== 'undefined' && !window.__ssTimeStarted) {
        window.__ssTimeStarted = true;
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
        else start();
    }

    return { format, full, localize, dayNumber, KINDS };
});
