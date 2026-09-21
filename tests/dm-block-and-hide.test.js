// "Block" and "Delete chat" in a one-to-one chat's info panel (2026-09-21, migration 064).
// The owner's condition on delete: nothing leaves the database, the chat is only hidden from
// the member who deleted it. There is no test database, so this reads the source: the route
// must only stamp conversation_members.hidden_at, and every query that shows a member a
// chat's messages must apply the stamp.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'messages.js'), 'utf8');

test('delete-chat deletes nothing: one UPDATE of the member\'s own row', () => {
    const start = src.indexOf("router.post('/:id(\\\\d+)/delete-chat'");
    assert.ok(start > 0, 'route missing');
    const route = src.slice(start, src.indexOf('\nrouter.', start + 1));
    assert.doesNotMatch(route, /DELETE FROM/i);
    assert.doesNotMatch(route, /unlink|rm\(/);
    assert.match(route, /UPDATE conversation_members SET hidden_at = NOW\(\)[^;]*WHERE conversation_id = \$1 AND user_id = \$2/);
    assert.match(route, /is_group \|\| c\.rows\[0\]\.saved_for_user_id/, 'groups and Saved Messages are refused');
});

test('every query that shows a member a chat keeps only what came after their hidden_at', () => {
    const uses = (src.match(/afterHidden\('\$\d'\)/g) || []).length;
    assert.ok(uses >= 6, `afterHidden() used ${uses} times, expected the page, history, poll, search, info counts and media`);
    const list = src.slice(src.indexOf('async function buildConversationList'), src.indexOf('async function buildConversationList') + 3000);
    assert.equal((list.match(/cm\.hidden_at IS NULL OR/g) || []).length, 3, 'the sidebar: unread count, last message, and whether the chat is listed at all');
    const total = src.slice(src.indexOf('async function getUnreadMessageCount'), src.indexOf('async function getUnreadMessageCount') + 900);
    assert.match(total, /cm\.hidden_at IS NULL OR mx\.created_at > cm\.hidden_at/);
});

test('a blocked person is refused on send, forward and a new DM, and told why in place of the composer', () => {
    assert.equal((src.match(/dmBlockNotice\(userId, \{ convId \}/g) || []).length, 2, 'page render and send');
    assert.match(src, /dmBlockNotice\(userId, \{ convId: targetId \}/, 'forward');
    assert.match(src, /dmBlockNotice\(userId, \{ otherId: parseInt\(recipientId\) \}/, 'new DM');
    const notice = src.slice(src.indexOf('async function dmBlockNotice'), src.indexOf('async function dmBlockNotice') + 1200);
    assert.match(notice, /c\.is_group = FALSE AND c\.saved_for_user_id IS NULL/, 'a block never touches a group');
});

test('the info panel offers Block and Delete chat only in a one-to-one chat', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'messages.ejs'), 'utf8');
    const i = view.indexOf("actionHTML('block'");
    assert.ok(i > 0);
    const guard = view.slice(view.lastIndexOf('if (', i), i);
    assert.match(guard, /!c\.isGroup && !c\.isSaved && c\.otherId/);
    assert.ok(view.indexOf("actionHTML('delete-chat'") > i);
});
