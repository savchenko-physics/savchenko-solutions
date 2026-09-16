// lib/mailGuard.js: how much mail one address may receive, and which kinds are exempt.
// email.js enforces it; this file holds the numbers and the decisions, so
// tests/notification-emails.test.js can check them without a database.
//
// The incident (2026-09-16, 04:20 local): ten identical "Albaert_Davronov started following
// you" emails landed in the owner's inbox in 27 seconds. The follow button is a toggle, so
// twenty clicks in forty seconds made ten follows, each with its own notification and its own
// email. Nothing counted how much mail one person had been sent, so nothing could stop it —
// and afterwards the question "how many did we send, and to whom" could only be answered by
// reconstructing it from five tables.
//
// Three rules, narrowest first:
//   1. A follower is announced at most once every `followRepeatDays` (the follow route in
//      index.js). Being told twice that the same person follows you says nothing new.
//   2. A notification email about the same thread is not repeated within
//      `threadDebounceMinutes` (notifications.js). The bell still gets every notification:
//      three replies in ten minutes are three things to read and one thing to email about.
//      This matters because reply notifications all carry the same text ("On problem 7.2.10"),
//      so they cannot be told apart by content — only by thread and time.
//   3. Whatever the reason, an address gets at most `perAddressPerHour` / `perAddressPerDay`
//      emails (email.js), counted in the `email_sends` log. The exceptions are UNCAPPED_KINDS:
//      getting back into an account must never be blocked by inbox noise, and those kinds
//      already carry their own stricter limits (see lib/passwordReset.js).
//
// Measured over every email the site sent between 2026-07-18 (SES live) and 2026-09-16: the
// busiest hour one person ever had was 10 emails and the busiest day 26; the 99th percentiles
// were 7 and 14. The ceilings sit above the busiest real day and far below a flood.

const LIMITS = Object.freeze({
    perAddressPerHour: 15,
    perAddressPerDay: 40,
    threadDebounceMinutes: 60,
    followRepeatDays: 30,
    // Per account, on the two routes that can ask for mail in a loop.
    followTogglesPerHour: 60,
    emailChangesPerHour: 5,
});

// Mail nobody should ever be cut off from: each is either a reply to something the person
// just did, or the only way back into an account.
const UNCAPPED_KINDS = Object.freeze(['password_reset', 'appeal_ack', 'email_verify']);

// What `kind` a send is logged under. The notification kinds are the notification types, so
// the log breaks down the same way the bell does.
const KINDS = Object.freeze([
    ...UNCAPPED_KINDS,
    'email_change',
    'reply_to_comment', 'comment_on_solution', 'new_follower', 'challenge_result',
    'report_resolved', 'forum_reply', 'forum_solution', 'feedback_update',
    'other',
]);

/** The address as the log and the counts see it: trimmed and lower-cased. */
function normalizeAddress(to) {
    return typeof to === 'string' ? to.trim().toLowerCase() : '';
}

/** A short, storable kind. Anything unknown is logged as 'other' and stays capped. */
function normalizeKind(kind) {
    const k = String(kind == null ? '' : kind).trim().toLowerCase();
    return /^[a-z][a-z0-9_]{0,39}$/.test(k) ? k : 'other';
}

function isCapped(kind) {
    return !UNCAPPED_KINDS.includes(normalizeKind(kind));
}

/** True when this address has had its fill for now. Counts are of sends in the two windows. */
function overRecipientCap({ kind, lastHour, lastDay }) {
    if (!isCapped(kind)) return false;
    return Number(lastHour) >= LIMITS.perAddressPerHour || Number(lastDay) >= LIMITS.perAddressPerDay;
}

/** An address for a log line: enough to recognise, not enough to harvest. */
function maskAddress(to) {
    const address = normalizeAddress(to);
    const at = address.indexOf('@');
    return at <= 0 ? '(no address)' : `${address.slice(0, Math.min(3, at))}***${address.slice(at)}`;
}

module.exports = { LIMITS, UNCAPPED_KINDS, KINDS, normalizeAddress, normalizeKind, isCapped, overRecipientCap, maskAddress };
