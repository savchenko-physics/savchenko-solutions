// What a username may be.
//
// Until 2026-09-14 registration accepted anything: of the 1,014 accounts then, 718 had capitals,
// 73 were in Cyrillic or another script and 64 had spaces ("Newton fanboy frfr", "Eldor "), and
// "Mark"/"mark", "Temirlan"/"temirlan", "Андрей"/"андрей" were different people. A username is a
// URL (/user/<name>) and an @mention, so from then on a new one is lowercase English letters,
// digits and underscore, and may not differ from an existing one only by case.
//
// Existing usernames are kept as they are. Settings sends the username with every profile save,
// so an unchanged one is always accepted there; only a changed one must follow the rule.

const USERNAME_MIN = 2;
const USERNAME_MAX = 32;
const USERNAME_RE = /^[a-z0-9_]{2,32}$/;
// The same rule for the HTML pattern attribute (anchored implicitly, `v` flag in modern browsers).
const USERNAME_PATTERN = "[a-z0-9_]{2,32}";

function isValidNewUsername(value) {
    return typeof value === "string" && USERNAME_RE.test(value);
}

/**
 * A profile save: `current` is the stored username, `submitted` what the form sent.
 * Returns { ok: true, username } with the value to store, or { ok: false }.
 * An unchanged username (surrounding whitespace aside, which the form's trim adds or drops)
 * keeps its stored spelling even if it predates the rule.
 */
function resolveUsernameChange(current, submitted) {
    const stored = String(current ?? "");
    const wanted = String(submitted ?? "").trim();
    if (wanted === stored || wanted === stored.trim()) return { ok: true, username: stored, changed: false };
    if (!isValidNewUsername(wanted)) return { ok: false };
    return { ok: true, username: wanted, changed: true };
}

module.exports = {
    USERNAME_MIN,
    USERNAME_MAX,
    USERNAME_RE,
    USERNAME_PATTERN,
    isValidNewUsername,
    resolveUsernameChange,
};
