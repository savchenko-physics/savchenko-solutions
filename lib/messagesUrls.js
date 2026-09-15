// Where the messenger's pages live: /ru/messages, /ru/messages/5, /en/messages/saved, with the
// language in the path like every other page on the site. Until 2026-09-15 it was the other way
// round (/en/messages/5 only set the language and redirected to a bare /messages/5), so the
// address never said which language the page was in.
//
// The bare /messages/... page addresses still work and redirect here, which keeps every link
// already stored in a notification or an email alive. The JSON and live-update endpoints
// (/messages/stream, /messages/5/send, /messages/pulse, ...) stay where they are: they have no
// language, and moving them would break an open tab mid-conversation.
'use strict';

const LANGS = ['en', 'ru'];

/* The language in a messenger page's own path, or null for a bare /messages/... address. */
function langFromMessagesPath(originalUrl) {
    const m = String(originalUrl || '').match(/^\/(en|ru)\/messages(?=[/?#]|$)/);
    return m ? m[1] : null;
}

/* The language to send a bare address to: what the session remembers, else what the browser
 * asks for first between the two, else English. */
function preferredLang({ sessionLang, acceptLanguage }) {
    if (LANGS.includes(sessionLang)) return sessionLang;
    const header = String(acceptLanguage || '').toLowerCase();
    let best = null;
    let bestQ = -1;
    for (const part of header.split(',')) {
        const [tag, ...params] = part.trim().split(';');
        const base = tag.split('-')[0];
        if (!LANGS.includes(base)) continue;
        const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        const q = qParam ? Number(qParam.slice(2)) : 1;
        if (Number.isFinite(q) && q > bestQ) {
            best = base;
            bestQ = q;
        }
    }
    return best || 'en';
}

/* The same page with the language in its path, keeping the query (?app=last-problem, ...). */
function langMessagesUrl(originalUrl, lang) {
    const url = String(originalUrl || '/messages');
    const q = url.indexOf('?');
    const pathPart = q >= 0 ? url.slice(0, q) : url;
    const query = q >= 0 ? url.slice(q) : '';
    const rest = pathPart.replace(/^\/(?:(?:en|ru)\/)?messages/, '').replace(/\/+$/, '');
    return `/${LANGS.includes(lang) ? lang : 'en'}/messages${rest}${query}`;
}

/* A messenger page address for a language: messagesPath('ru', 5) is /ru/messages/5. */
function messagesPath(lang, rest) {
    const tail = rest === undefined || rest === null || rest === '' ? '' : `/${rest}`;
    return `/${LANGS.includes(lang) ? lang : 'en'}/messages${tail}`;
}

module.exports = { langFromMessagesPath, preferredLang, langMessagesUrl, messagesPath };
