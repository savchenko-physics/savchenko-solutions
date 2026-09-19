// Which new chat messages deserve a live alert on whatever page someone is reading
// (js/pulse.js asks GET /messages/pulse in messages.js every half minute).
//
// Until 2026-09-15 a message only reached someone who had /messages open: the header's badge and
// bell were drawn once per page load, so a DM could sit unseen for as long as a person read
// solutions. Now a new DM, a message in a small group, a reply to your message or an @mention of
// you shows a small card in the corner of any page, and the badges update in place.
//
// What alerts, in order:
//   reply    someone replied to a message of yours, in any chat, muted or not
//   mention  someone wrote @you, in any chat, muted or not
//   dm       a message in a one-to-one chat you have not muted
//   group    a message in a group of at most 25 members you have not muted
// Everything else is silent, above all the community chats with a thousand members each (the
// same cut-off notifications.js uses for the bell).
'use strict';

const { kindOf } = require('./messageAttachments');

const LARGE_CONVERSATION_MEMBERS = 25;

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Does the text mention @username as a whole word? Case does not matter; an email address or a
 * longer name that merely starts with it does not count. */
function mentionsUser(content, username) {
    if (typeof content !== 'string' || !content || typeof username !== 'string' || !username) return false;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_@.])@${escapeRegExp(username)}(?![\\p{L}\\p{N}_])`, 'iu');
    return re.test(content);
}

/* The kind of alert a message is for the viewer, or null for none.
 *   row:    { senderId, isGroup, memberCount, muted, replyToSenderId, content, isSaved }
 *   viewer: { userId, username } */
function alertKind(row, viewer) {
    if (!row || !viewer || row.senderId === viewer.userId || row.isSaved) return null;
    if (row.replyToSenderId != null && row.replyToSenderId === viewer.userId) return 'reply';
    if (mentionsUser(row.content, viewer.username)) return 'mention';
    if (row.muted) return null;
    if (!row.isGroup) return 'dm';
    if (Number(row.memberCount) <= LARGE_CONVERSATION_MEMBERS) return 'group';
    return null;
}

/* One line of the message for the card: text squeezed to `max` characters, else what was sent. */
function previewText(content, { imageUrl, fileName, lang, max = 100 } = {}) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (text) return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
    if (fileName) return kindOf(fileName) === 'video' ? (lang === 'ru' ? 'Видео' : 'Video') : String(fileName);
    if (imageUrl) return lang === 'ru' ? 'Фото' : 'Photo';
    return '';
}

module.exports = { LARGE_CONVERSATION_MEMBERS, mentionsUser, alertKind, previewText };
