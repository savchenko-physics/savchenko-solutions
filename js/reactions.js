/* The reaction vocabulary: the six Unicode emoji the site has always offered, and the
 * community's own set, drawn from its in-jokes (img/emoji/*.svg).
 *
 * Until 2026-09 the six lived in four hand-kept copies (messages.js, brainstorm.js and twice
 * in views/messages.ejs), and every reaction column was VARCHAR(8). The community set came out
 * of reading the two community chats and the solution comments: "юный джедай", "Печеньки!!!",
 * "подгон под ответ", the errors in the book, the AI-written solutions, and so on. A custom
 * reaction is stored as its :shortcode: in the same `emoji` column (VARCHAR(32) since
 * migration 052), so every existing query, broadcast and poll carries it unchanged.
 *
 * Lives in js/ because the browser runs it (views/messages.ejs, views/solution_post.ejs) and
 * the server and tests/reactions.test.js require() it.
 *
 * NEVER DELETE A CUSTOM ENTRY. People's reactions keep its id forever. To take one out of the
 * picker set `retired: true`: it still renders, and whoever left it can still take it back.
 *
 * No DOM, no fetch, no storage access.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Reactions = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // The Unicode reactions, most used first: 👍 ❤️ 🙏 🔥 😂 🤔. Escapes, not pasted emoji: an
    // editor can silently drop the U+FE0F after the heart.
    //
    // 🙏 and 🔥 replaced 👎 and 😢 on 2026-09-13. In four months 👎 was never used and 😢 three
    // times, while people typed their thanks in 125 posts (25 people, more than anything else)
    // and "круто / класс / огонь" in 52. 🤔 stayed: eleven uses, most of them doubting a claim
    // under a solution. Order, as of that day: 👍 256 and ❤️ 178 reactions; the two new ones by
    // how often that feeling is typed, which puts them ahead of 😂 (33 reactions, typed 44
    // times) and 🤔 (11, typed 35).
    const STANDARD = Object.freeze(['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F64F}', '\u{1F525}', '\u{1F602}', '\u{1F914}']);

    // No longer offered, still known: the pills already left keep rendering, and whoever left
    // one can still take it back.
    const RETIRED_STANDARD = Object.freeze(['\u{1F44E}', '\u{1F622}']);

    // Most talked-about first: how many posts in the two community chats and the solution
    // comments raise each in-joke (2026-09-13; ties by the number of people). Reorder by real
    // reaction counts once there are some.
    const CUSTOM = Object.freeze([
        { id: ':ai:', ru: 'Свидетели ИИ', en: 'AI wrote this' },              // 20 posts
        { id: ':etalon:', ru: 'Эталонное решение', en: 'Gold standard' },     // 18
        { id: ':match:', ru: 'Сошлось!', en: 'Answer matches' },               // 16
        { id: ':trap:', ru: 'Капкан Савченко', en: "Savchenko's trap" },       // 15
        { id: ':podgon:', ru: 'Подгон под ответ', en: 'Fudged to fit' },       // 6, five people
        { id: ':cookies:', ru: 'Печеньки!!!', en: 'Cookies!!!' },              // 6, four people
        { id: ':zachetka:', ru: 'Давай зачётку!', en: 'Pass!' },               // 5
        { id: ':grob:', ru: 'Гроб', en: 'Killer problem' },                    // 4, three people
        { id: ':jedi:', ru: 'Юный джедай', en: 'Young Jedi' },                 // 4, one person
        { id: ':horse:', ru: 'Сферический конь', en: 'Spherical horse' },      // 3
        { id: ':precious:', ru: 'Моя прелесть', en: 'My precious' },           // 2
        { id: ':cat:', ru: 'Кот Шрёдингера', en: "Schrödinger's cat" },        // 1
    ].map(Object.freeze));

    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
    }

    function create(options) {
        const standard = Object.freeze([...options.standard]);
        const retiredStandard = Object.freeze([...(options.retiredStandard || [])]);
        const custom = Object.freeze([...options.custom]);
        // Sets and Maps, never obj[value]: '__proto__' and 'constructor' must not pass.
        const known = new Set([...standard, ...retiredStandard]);
        const retired = new Set(retiredStandard);
        const customById = new Map();
        for (const entry of custom) {
            known.add(entry.id);
            customById.set(entry.id, entry);
            if (entry.retired) retired.add(entry.id);
        }

        function isKnownReaction(value) {
            return typeof value === 'string' && known.has(value);
        }

        function isCustomReaction(value) {
            return typeof value === 'string' && customById.has(value);
        }

        /* What pressing `value` does for someone who already has it (alreadyHas) or not.
         * Taking a reaction back is always allowed for anything the site ever offered, so
         * retiring an emoji can never strand one. */
        function reactionAction(value, alreadyHas) {
            if (!isKnownReaction(value)) return 'reject';
            if (alreadyHas) return 'remove';
            return retired.has(value) ? 'reject' : 'add';
        }

        /* The picker: the six, then the custom emoji that are not retired. */
        function pickerIds() {
            return [...standard, ...custom.filter((entry) => !entry.retired).map((entry) => entry.id)];
        }

        /* img/emoji/<name>.svg for a custom id, null for anything else. */
        function emojiFile(value) {
            return isCustomReaction(value) ? `${value.slice(1, -1)}.svg` : null;
        }

        /* Versioned URLs for every custom emoji, retired ones included, keyed by id.
         * `asset` is the server's asset() helper; without one the URLs are unversioned. */
        function emojiUrls(asset) {
            const urls = {};
            for (const entry of custom) {
                const file = `/img/emoji/${emojiFile(entry.id)}`;
                urls[entry.id] = typeof asset === 'function' ? asset(file) : file;
            }
            return urls;
        }

        function reactionTitle(value, lang) {
            const entry = isCustomReaction(value) ? customById.get(value) : null;
            if (!entry) return '';
            return lang === 'ru' ? entry.ru : entry.en;
        }

        /* Markup for one reaction glyph. A custom id with a URL becomes an <img>; anything
         * else, including an id whose URL is missing, becomes escaped text. Never throws. */
        function glyphHTML(value, urls, lang) {
            const text = value == null ? '' : String(value);
            const url = isCustomReaction(text) && urls && Object.prototype.hasOwnProperty.call(urls, text)
                ? urls[text] : null;
            if (typeof url !== 'string' || !url) return escapeHtml(text);
            const title = escapeHtml(reactionTitle(text, lang));
            return `<img class="rx-img" src="${escapeHtml(url)}" alt="${title}" title="${title}" draggable="false">`;
        }

        return {
            STANDARD: standard,
            RETIRED_STANDARD: retiredStandard,
            CUSTOM: custom,
            isKnownReaction,
            isCustomReaction,
            reactionAction,
            pickerIds,
            emojiFile,
            emojiUrls,
            reactionTitle,
            glyphHTML,
            escapeHtml,
        };
    }

    const api = create({ standard: STANDARD, retiredStandard: RETIRED_STANDARD, custom: CUSTOM });
    api.create = create;
    return api;
});
