/**
 * The two community chats: one English, one Russian (conversations.community_lang).
 *
 * Until 2026-09 the site had a single common chat that every account joined at
 * registration. 215 of its 253 messages were Russian and 12 English, so the people who
 * write in English had nowhere to talk and everyone else read their messages as noise.
 * It is now two chats. Everyone is a member of both, so nobody loses access and anyone can
 * read either, but the chat in a person's other language starts muted: no bell, and it does
 * not add to the unread count in the site header. The mute is a starting point, not a
 * wall; the bell button in the chat header flips it.
 *
 * This file holds only decisions (no pool, no requires), so the registration route, the
 * one-off split script and tests/community-chats.test.js all share one definition.
 */

const COMMUNITY_LANGS = ['en', 'ru'];

// Stored once in conversations.title; each language names itself, as language pickers do.
const COMMUNITY_TITLES = {
    en: 'Savchenko Solutions · English',
    ru: 'Savchenko Solutions · Русский',
};

// users.country_location holds the English common names from data/countries.json.
const RUSSIAN_READING_COUNTRIES = new Set([
    'Russia', 'Belarus', 'Kazakhstan', 'Ukraine', 'Uzbekistan', 'Kyrgyzstan', 'Tajikistan',
    'Turkmenistan', 'Armenia', 'Azerbaijan', 'Georgia', 'Moldova', 'Latvia', 'Lithuania', 'Estonia',
]);

const RUSSIAN_READING_EMAIL = /(\.(ru|by|kz|ua|uz|kg|am|az|md|tj|tm)$)|(@(yandex|ya|mail|inbox|list|bk|rambler)\.)/i;

const CYRILLIC = /[Ѐ-ӿ]/;

function otherLang(lang) {
    return lang === 'ru' ? 'en' : 'ru';
}

/**
 * Best guess at the language a person reads, from what the site already knows about
 * them. Strongest evidence first:
 *   1. what they wrote in group chats (never DMs: private conversations are not read
 *      for this, even by a script),
 *   2. a Cyrillic name,
 *   3. the language of the solutions they contributed,
 *   4. a country or e-mail domain where Russian is widely read (→ ru), any other
 *      country (→ en),
 *   5. the language of the site they last browsed, from their session.
 * null when there is nothing to go on, which is most dormant accounts.
 *
 * signals: { groupChatRu, groupChatEn, contribRu, contribEn, name, country, email, sessionLang }
 */
function classifyUserLanguage(signals) {
    const s = signals || {};
    const chatRu = Number(s.groupChatRu) || 0;
    const chatEn = Number(s.groupChatEn) || 0;
    if (chatRu || chatEn) return chatRu >= chatEn ? 'ru' : 'en';

    if (CYRILLIC.test(String(s.name || ''))) return 'ru';

    const contribRu = Number(s.contribRu) || 0;
    const contribEn = Number(s.contribEn) || 0;
    if (contribRu || contribEn) return contribRu >= contribEn ? 'ru' : 'en';

    if (RUSSIAN_READING_COUNTRIES.has(s.country) || RUSSIAN_READING_EMAIL.test(String(s.email || ''))) return 'ru';
    if (s.country) return 'en';

    // Exact values only: the session table also holds scanner probes as `lang`.
    if (s.sessionLang === 'en' || s.sessionLang === 'ru') return s.sessionLang;
    return null;
}

/** Has this person written in `lang`, in group chats or in contributed solutions? */
function writesLanguage(signals, lang) {
    const s = signals || {};
    return lang === 'ru'
        ? (Number(s.groupChatRu) || 0) + (Number(s.contribRu) || 0) > 0
        : (Number(s.groupChatEn) || 0) + (Number(s.contribEn) || 0) > 0;
}

/**
 * Whether a membership in the community chat for `chatLang` starts muted. Always a boolean:
 * conversation_members.muted is NOT NULL, and an undefined here would make the insert fail.
 *   - Moderators see both chats: they are the ones who answer newcomers.
 *   - Anyone who already writes in the chat's language keeps it.
 *   - Otherwise the chat in the person's other language is muted.
 *   - Unknown language keeps things as they were before the split: the Russian chat, which
 *     every account was already in, stays as it was, and the new English chat starts quiet.
 */
function mutedByDefault({ chatLang, userLang, isModerator = false, writesChatLang = false } = {}) {
    if (isModerator || writesChatLang) return false;
    if (userLang === 'en' || userLang === 'ru') return userLang !== chatLang;
    return chatLang === 'en';
}

/** Flat navy disc with the language code, instead of the letter-and-gradient group avatar. */
function communityAvatarSVG(lang, size) {
    const s = Number(size) || 44;
    const code = lang === 'ru' ? 'RU' : 'EN';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" role="img" aria-label="${code}">` +
        `<rect width="${s}" height="${s}" fill="#1a1a2e"/>` +
        `<text x="50%" y="52%" text-anchor="middle" dominant-baseline="central" fill="#ffffff" ` +
        `font-family="Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-weight="600" ` +
        `font-size="${Math.round(s * 0.34)}">${code}</text></svg>`;
}

module.exports = {
    COMMUNITY_LANGS,
    COMMUNITY_TITLES,
    otherLang,
    classifyUserLanguage,
    writesLanguage,
    mutedByDefault,
    communityAvatarSVG,
};
