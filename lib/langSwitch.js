// The address of the page being read, in the other language: what the RU / EN link in the
// site header points at.
//
// Until 2026-09-19 that link took almost every page to the homepage. The header fell back
// to /en or /ru unless the template handed it an address of its own, and nine templates
// did; the solution page, the one nearly everyone is on, was not among them. So a reader
// half-way through 5.3.12 in Russian who pressed EN landed on the front page and had to
// find the problem again ("чтобы тебя не отправляло в самое начало сайта, а остался на
// этой задаче").
//
// Every page that speaks a language lives at /en/… or /ru/…, or at a bare address that
// answers under either prefix as well (/blog, /tools, /problems, /discuss, /paths, …; the
// bare address speaks the session's language). So one rule serves the whole site: swap
// the prefix, or add one, and keep the rest of the address and its query, so the finder's
// search, the chat that is open and the settings tab all survive the switch. index.js
// computes it for every request and the header reads it. A page whose address does not
// follow the rule passes its own to the header (langSwitchEnUrl / langSwitchRuUrl): the
// 404 page and the summit page, which exist in one language only, and the recovery pages,
// which say their language in ?lang= and have no prefixed twin.
'use strict';

const LANGS = ['en', 'ru'];
const PREFIX = /^\/(en|ru)(?=\/|$)/;
// The one-shot messages the site passes in the query after a form post. Carried over, they
// would be shown a second time, in the wrong language, on the page in the other language.
const FLASH = /(^|&)(error|success)=[^&]*/g;
const LANG_PARAM = /(^|&)lang=[^&]*/g;

/* The same page in `target`, from the address the browser asked for (req.originalUrl,
 * path and query, as sent). Always a same-origin path starting with /en or /ru. */
function langSwitchUrl(originalUrl, target) {
    if (!LANGS.includes(target)) throw new TypeError(`unknown language: ${target}`);
    let url = typeof originalUrl === 'string' ? originalUrl : '/';
    const hash = url.indexOf('#');
    if (hash >= 0) url = url.slice(0, hash);
    const q = url.indexOf('?');
    let path = q >= 0 ? url.slice(0, q) : url;
    let query = q >= 0 ? url.slice(q + 1) : '';
    // "//host/x" would be a protocol-relative link to another site; single slashes keep
    // every result on this one.
    path = `/${path.replace(/\/{2,}/g, '/').replace(/^\//, '')}`;
    query = query
        .replace(FLASH, '')
        .replace(LANG_PARAM, `$1lang=${target}`)
        .replace(/^&+/, '');
    const m = PREFIX.exec(path);
    const rest = m ? path.slice(m[0].length) : (path === '/' ? '' : path);
    return `/${target}${rest}${query ? `?${query}` : ''}`;
}

/* Both languages' addresses for the page, for the header's locals. */
function langSwitchUrls(originalUrl) {
    return { en: langSwitchUrl(originalUrl, 'en'), ru: langSwitchUrl(originalUrl, 'ru') };
}

module.exports = { LANGS, langSwitchUrl, langSwitchUrls };
