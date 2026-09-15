// The server's half of dates in the reader's time zone (js/local-time.js has the whole story).
//
// A template writes <%- localTime(row.created_at, 'relative', lang) %> and gets
//   <time datetime="2026-09-15T13:40:38.655Z" data-local="relative">3 ч назад</time>
// with the text in UTC, which the browser replaces with its own zone's. Registered as
// app.locals.localTime in index.js and sandbox/sandbox-app.js.
//
// calendar: true is for a value that is a calendar date stored as UTC midnight (the feedback
// board's seeded rows, DATE columns): shifting it into a zone west of UTC would show the day
// before, so such a value is written as plain UTC text with no data-local.
'use strict';

const { format, full, KINDS } = require('../js/local-time');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function isUtcMidnight(date) {
    return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

function localTime(value, kind, lang, opts) {
    const o = opts || {};
    const date = value instanceof Date ? value : (value == null || value === '' ? null : new Date(value));
    if (!date || Number.isNaN(date.getTime())) return '';
    const k = KINDS.includes(kind) ? kind : 'date';
    const l = lang === 'ru' ? 'ru' : 'en';
    const className = o.className ? ` class="${escapeHtml(o.className)}"` : '';
    if (o.calendar && isUtcMidnight(date)) {
        const calendarKind = k === 'relative' || k === 'daytime' || k === 'datetime' || k === 'time' ? 'day' : k;
        return `<span${className}>${escapeHtml(format(date, calendarKind, { lang: l, timeZone: 'UTC', now: o.now }))}</span>`;
    }
    const text = format(date, k, { lang: l, timeZone: 'UTC', now: o.now });
    const title = k === 'datetime' ? '' : ` title="${escapeHtml(`${full(date, { lang: l, timeZone: 'UTC' })} UTC`)}"`;
    // The language the server wrote it in, since not every page's <html lang> follows the address.
    return `<time${className} datetime="${date.toISOString()}" data-local="${k}" data-lang="${l}"${title}>${escapeHtml(text)}</time>`;
}

module.exports = { localTime, isUtcMidnight };
