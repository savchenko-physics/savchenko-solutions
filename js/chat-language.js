/* Which language a chat message is written in, for the two community chats.
 *
 * Until 2026-09 the site had one common chat for everyone. 215 of its 253 messages were
 * Russian, English speakers could not follow it, and Russian speakers took to posting
 * English copies of their own messages (1835 and 1836 are the same text twice). It is now
 * two chats, one per language, and the composer shows a quiet hint when someone starts
 * typing in the other chat's language, with a link to the chat that speaks it.
 *
 * Lives in js/ because the browser runs it (views/messages.ejs) and tests/community-chats
 * require()s it. The hint is advice only: nothing here can stop a message from being sent,
 * and the answer is deliberately "don't know" (null) for anything short or mixed, because
 * a wrong hint on "+0.5" or a pasted link is worse than no hint at all.
 *
 * No DOM, no fetch, no storage access.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ChatLanguage = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const CYRILLIC = /[Ѐ-ӿ]/g;
    const LATIN = /[A-Za-z]/g;
    const LATIN_WORD = /[A-Za-z]{2,}/g;

    /* Everything that is written in Latin letters whatever language the sentence around
     * it is in: links, TeX, code, @mentions and e-mail addresses. */
    function stripLanguageNeutral(text) {
        return String(text == null ? '' : text)
            .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
            .replace(/\$\$[\s\S]*?\$\$/g, ' ')
            .replace(/\$[^$\n]*\$/g, ' ')
            .replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, ' ')
            .replace(/`[^`]*`/g, ' ')
            .replace(/\S+@\S+\.\S+/g, ' ')
            .replace(/@[\w.\-]+/g, ' ');
    }

    function count(re, s) {
        const m = s.match(re);
        return m ? m.length : 0;
    }

    /* 'ru' for clearly Cyrillic text, 'en' for clearly English text, null otherwise.
     * Cyrillic wins when it is at least twice the Latin letter count, so a Russian sentence
     * with a name or a unit in it is still Russian. English needs no Cyrillic at all, at
     * least eight letters and two words, so "OK", "+0.5" and "Hi" never count. */
    function textLanguage(text) {
        const s = stripLanguageNeutral(text);
        const cyr = count(CYRILLIC, s);
        const lat = count(LATIN, s);
        if (cyr >= 3 && cyr >= 2 * lat) return 'ru';
        if (cyr === 0 && lat >= 8 && count(LATIN_WORD, s) >= 2) return 'en';
        return null;
    }

    /* The language the draft is in, when that is not the chat's language; otherwise null. */
    function languageHint(text, chatLang) {
        if (chatLang !== 'en' && chatLang !== 'ru') return null;
        const lang = textLanguage(text);
        return lang && lang !== chatLang ? lang : null;
    }

    return { textLanguage, languageHint };
});
