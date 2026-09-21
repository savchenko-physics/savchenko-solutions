// Whether a member may write in the messenger, and what they are told when they may not.
//
// Two levels, the later end wins (`effectiveBlock`):
//   conversation_members.posting_blocked_until (migration 061)  one chat, for a while
//   users.posting_blocked_until (migration 062)                  every chat, every DM, and solution
//                                                               comments; 'infinity' is for good
// pg hands 'infinity' back as the number Infinity; the message projection clamps it to
// 9999-12-31 so it survives JSON, and `isPermanent` reads both. Reading is never restricted.
// The notice names the end of the block in the reader's zone and says whom to ask (the site's
// owner), because a person kept out of the chat has nowhere else to argue. Set with
// scripts/chat-restrict.js. No em dash, colon or semicolon in the copy.
'use strict';

const { format } = require('../js/local-time');

const CONTACT = 'astrosander';
const PERMANENT_YEAR = 9999;

function toTime(until) {
    if (until === Infinity) return Infinity;
    if (until == null || until === '') return null;
    const t = until instanceof Date ? until.getTime() : new Date(until).getTime();
    return Number.isNaN(t) ? null : t;
}

function isPostingBlocked(until, now = new Date()) {
    const t = toTime(until);
    return t !== null && t > now.getTime();
}

function isPermanent(until) {
    const t = toTime(until);
    return t === Infinity || (t !== null && new Date(t).getUTCFullYear() >= PERMANENT_YEAR);
}

// The later of a member's chat block and their account block (either may be missing).
function effectiveBlock(a, b) {
    const ta = toTime(a), tb = toTime(b);
    if (ta === null) return tb === null ? null : b;
    if (tb === null) return a;
    return ta >= tb ? a : b;
}

function when(until, lang, timeZone) {
    return format(new Date(toTime(until)), 'datetime', { lang: lang === 'ru' ? 'ru' : 'en', timeZone: timeZone || 'UTC' });
}

function blockedNotice(until, lang, timeZone) {
    if (isPermanent(until)) {
        return lang === 'ru'
            ? `Вы не можете писать сообщения на сайте. Читать их можно. С вопросами напишите @${CONTACT}.`
            : `You cannot write messages on this site. You can still read them. Questions go to @${CONTACT}.`;
    }
    const w = when(until, lang, timeZone);
    return lang === 'ru'
        ? `Вы не можете писать в этот чат до ${w}. Читать его можно. С вопросами напишите @${CONTACT}.`
        : `You cannot write in this chat until ${w}. You can still read it. Questions go to @${CONTACT}.`;
}

// The bell notification a blocked member gets, in the chat's language. `chatTitle` is null for
// an account-wide block.
function blockNotification(until, lang, chatTitle) {
    const ru = lang === 'ru';
    const where = chatTitle ? (ru ? `в «${chatTitle}»` : `in "${chatTitle}"`) : (ru ? 'на сайте' : 'on this site');
    const title = ru ? `Отправка сообщений ${where} приостановлена` : `Posting ${where} is paused`;
    const ask = ru ? `С вопросами напишите @${CONTACT}.` : `Questions go to @${CONTACT}.`;
    if (isPermanent(until)) return { title: ru ? `Отправка сообщений ${where} закрыта` : `Posting ${where} is closed`, message: ask };
    const w = when(until, lang, 'UTC') + ' UTC';
    return { title, message: ru ? `До ${w}. ${ask}` : `Until ${w}. ${ask}` };
}

module.exports = { CONTACT, PERMANENT_YEAR, isPostingBlocked, isPermanent, effectiveBlock, blockedNotice, blockNotification };
