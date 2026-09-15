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

        // Premium, since 2026-09-15: bought with quanta (ħ) in the «Последняя задача» mini app
        // (lastProblem.js), from the in-jokes of that week's chat. Every price is above the 1000 ħ
        // everyone starts with, so only someone who has won quanta can buy one. `price` in ħ; Infinity is
        // never for sale; `trophy` cannot be bought, the app awards it; `sale` limits when it
        // can be bought (UTC dates, inclusive). Owning one is a row in reaction_unlocks. Anyone
        // can see a premium reaction left by its owner, and taking one back always works.
        { id: ':kvant:', ru: 'Квант', en: 'Quantum', price: 1200 },
        { id: ':errata:', ru: 'Закон сохранения ошибок', en: 'Conservation of errata', price: 1300 },
        { id: ':ammeter:', ru: 'Сломанный амперметр', en: 'Broken ammeter', price: 1300 },
        { id: ':dino:', ru: 'Динозавр из 80-х', en: '80s dinosaur', price: 1400 },
        { id: ':cyborgs:', ru: 'Отряд вальтерят', en: 'Cyborg squad', price: 1400 },
        // The site is a Libra (first solution 10 Oct 2023), so it is sold in Libra season only.
        { id: ':libra:', ru: 'Весы', en: 'Libra', price: 1500, sale: { from: '2026-09-23', to: '2026-10-23' } },
        { id: ':laplace:', ru: 'Демон Лапласа', en: "Laplace's demon", price: 2000 },
        // "Всё возможно, кроме вечного двигателя" (emixter). The shop shows it; nobody gets it.
        { id: ':perpetuum:', ru: 'Вечный двигатель', en: 'Perpetual motion', price: Infinity },
        { id: ':n2000:', ru: 'Задача № 2000', en: 'Problem 2000', trophy: true },
        { id: ':last:', ru: 'Последняя задача', en: 'The last problem', trophy: true },
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

        function premiumEntry(value) {
            const entry = isCustomReaction(value) ? customById.get(value) : null;
            return entry && (entry.trophy || entry.price !== undefined) ? entry : null;
        }

        function isPremium(value) {
            return premiumEntry(value) !== null;
        }

        /* `owned` as the callers have it: a Set or array of ids, or true/false for this one id. */
        function owns(owned, value) {
            if (owned === true) return true;
            if (owned instanceof Set) return owned.has(value);
            if (Array.isArray(owned)) return owned.indexOf(value) !== -1;
            return false;
        }

        /* A sale window in UTC days, both ends included. No window: always. */
        function inSeason(entry, now) {
            if (!entry.sale) return true;
            const t = (now instanceof Date ? now : new Date()).getTime();
            const from = Date.parse(`${entry.sale.from}T00:00:00Z`);
            const to = Date.parse(`${entry.sale.to}T00:00:00Z`) + 24 * 60 * 60 * 1000;
            return t >= from && t < to;
        }

        /* Can this premium reaction be bought right now? Answers { ok, price } or { ok: false, error }. */
        function purchaseCheck(value, options) {
            const o = options || {};
            if (!isKnownReaction(value)) return { ok: false, error: 'unknown' };
            const entry = premiumEntry(value);
            if (!entry) return { ok: false, error: 'not_premium' };
            if (owns(o.owned, value)) return { ok: false, error: 'owned' };
            if (entry.trophy) return { ok: false, error: 'trophy' };
            if (entry.retired) return { ok: false, error: 'retired' };
            if (!Number.isFinite(entry.price)) return { ok: false, error: 'never' };
            if (!inSeason(entry, o.now)) return { ok: false, error: 'off_season' };
            if (o.balance !== undefined && !(Number(o.balance) >= entry.price)) {
                return { ok: false, error: 'insufficient', price: entry.price };
            }
            return { ok: true, price: entry.price };
        }

        /* What pressing `value` does for someone who already has it (alreadyHas) or not.
         * Taking a reaction back is always allowed for anything the site ever offered, so
         * retiring an emoji can never strand one. A premium reaction is 'locked' for anyone
         * who does not own it (`owned`: a Set or array of ids, or true for this one). */
        function reactionAction(value, alreadyHas, owned) {
            if (!isKnownReaction(value)) return 'reject';
            if (alreadyHas) return 'remove';
            if (retired.has(value)) return 'reject';
            if (isPremium(value) && !owns(owned, value)) return 'locked';
            return 'add';
        }

        /* The picker: the six, then the free custom emoji that are not retired, then the premium
         * ones this viewer owns or could buy today. A trophy nobody gave you and an emoji out
         * of season stay out of it; the shop in the app lists everything. */
        function pickerIds(options) {
            const o = options || {};
            const free = [];
            const premium = [];
            for (const entry of custom) {
                if (entry.retired) continue;
                if (!premiumEntry(entry.id)) {
                    free.push(entry.id);
                } else if (owns(o.owned, entry.id)
                    || (!entry.trophy && Number.isFinite(entry.price) && inSeason(entry, o.now))) {
                    premium.push(entry.id);
                }
            }
            return [...standard, ...free, ...premium];
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
            isPremium,
            premiumEntry,
            purchaseCheck,
            inSeason,
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
