// Whether a member may write in a conversation, and what they are told when they may not.
//
// conversation_members.posting_blocked_until (migration 061) holds the moment the block ends.
// Reading is never restricted. The notice names the end of the block in the reader's zone and
// says whom to ask (the site's owner), because a person kept out of the chat has nowhere else
// to argue. Set with scripts/chat-restrict.js. No em dash, colon or semicolon in the copy.
'use strict';

const { format } = require('../js/local-time');

const CONTACT = 'astrosander';

function isPostingBlocked(until, now = new Date()) {
    if (!until) return false;
    const t = until instanceof Date ? until : new Date(until);
    return !Number.isNaN(t.getTime()) && t.getTime() > now.getTime();
}

function blockedNotice(until, lang, timeZone) {
    const when = format(until, 'datetime', { lang: lang === 'ru' ? 'ru' : 'en', timeZone: timeZone || 'UTC' });
    return lang === 'ru'
        ? `Вы не можете писать в этот чат до ${when}. Читать его можно. С вопросами напишите @${CONTACT}.`
        : `You cannot write in this chat until ${when}. You can still read it. Questions go to @${CONTACT}.`;
}

// The bell notification a blocked member gets, in the chat's language.
function blockNotification(until, lang, chatTitle) {
    const when = format(until, 'datetime', { lang: lang === 'ru' ? 'ru' : 'en', timeZone: 'UTC' }) + ' UTC';
    return lang === 'ru'
        ? { title: `Отправка сообщений в «${chatTitle}» приостановлена`, message: `До ${when}. С вопросами напишите @${CONTACT}.` }
        : { title: `Posting in "${chatTitle}" is paused`, message: `Until ${when}. Questions go to @${CONTACT}.` };
}

module.exports = { CONTACT, isPostingBlocked, blockedNotice, blockNotification };
