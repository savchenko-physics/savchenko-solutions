// Unit tests for avatar cache busting — avatar.js.
//
// Guards the bug reported on 2026-08-28: two contributors changed their profile picture,
// saw the old one for days, and could only tell it had worked by opening the site signed
// out. The cause was not the upload. An avatar's URL is built from the user id
// (/img/profile_images/232.webp), so it does not change when the picture does, and /img
// was served with `Cache-Control: public, max-age=2592000` — thirty days in which the
// browser answered from its own disk and never asked. A browser with an empty cache, i.e.
// everyone else, saw the new face immediately, which is exactly why it looked like the
// upload had failed only for the person who made it.
//
// The fix has two halves and both are tested here: processAvatar returns a URL carrying a
// hash of the image's own bytes (so a new picture is a new URL that no cache can hold),
// and avatarCacheControl refuses to hand out a long cache for any URL that does not name
// its bytes. No database and no HTTP: the routes are not integration-testable in this
// project (no test database), so what is covered is the decision logic underneath them.
//
// The closing block is the "must never" invariant list this project keeps for anything
// that can fail silently — here, any combination that would let a stale face survive.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    versionedAvatarUrl, avatarCacheControl, thumbUrl, AVATAR_DIR,
} = require('../avatar');

const VERSIONED = /^\/img\/profile_images\/[^?]+\?v=[0-9a-f]{8}$/;

// ── The version token ─────────────────────────────────────────────────────────

test('a URL built from bytes carries an 8-hex token', () => {
    const url = versionedAvatarUrl('232.webp', Buffer.from('a picture'));
    assert.match(url, VERSIONED);
    assert.equal(url.split('?')[0], '/img/profile_images/232.webp');
});

test('the same picture yields the same URL, so an unchanged avatar stays cached', () => {
    const bytes = Buffer.from('the same photo, uploaded twice');
    assert.equal(versionedAvatarUrl('9.webp', bytes), versionedAvatarUrl('9.webp', bytes));
});

test('a different picture yields a different URL — the whole point', () => {
    const before = versionedAvatarUrl('9.webp', Buffer.from('old face'));
    const after = versionedAvatarUrl('9.webp', Buffer.from('new face'));
    assert.notEqual(before, after);
});

test('one byte of difference is enough', () => {
    // Two crops of the same photo differ in very little; the token must still change.
    const a = versionedAvatarUrl('9.webp', Buffer.alloc(4096, 7));
    const b = Buffer.alloc(4096, 7); b[4095] = 8;
    assert.notEqual(a, versionedAvatarUrl('9.webp', b));
});

test('with no bytes passed, the token is read from the file on disk', () => {
    const url = versionedAvatarUrl('Default_placeholder.svg');
    assert.match(url, VERSIONED);
    assert.equal(url, versionedAvatarUrl('Default_placeholder.svg')); // and it is stable
});

test('two different files on disk get different tokens', () => {
    // Both are committed to img/profile_images/, so this holds on a fresh clone too.
    assert.notEqual(
        versionedAvatarUrl('Default_placeholder.svg').split('?')[1],
        versionedAvatarUrl('232.jpg').split('?')[1]
    );
});

test('a file that is not there yields the bare URL instead of throwing', () => {
    // A missing ?v= costs one revalidation; a thrown error costs the settings save.
    assert.equal(versionedAvatarUrl('no-such-user.webp'), '/img/profile_images/no-such-user.webp');
});

test('AVATAR_DIR is where the app actually serves avatars from', () => {
    assert.equal(path.basename(AVATAR_DIR), 'profile_images');
});

// ── The cache policy ──────────────────────────────────────────────────────────

test('a versioned request is cached for a year and never revalidated', () => {
    const cc = avatarCacheControl('232.webp', true);
    assert.match(cc, /immutable/);
    assert.match(cc, /max-age=31536000/);
});

test('a bare per-user avatar must be revalidated, not trusted', () => {
    // <id>.webp is a name, not a picture: tomorrow it holds a different face.
    for (const f of ['232.webp', '232_thumb.webp', '2444.png', '34.jpeg', '68.jpg']) {
        assert.equal(avatarCacheControl(f, false), 'no-cache', f);
    }
});

test('the shared placeholder is a constant and keeps the long cache', () => {
    // 969 of 1007 accounts render it, on every page: revalidating it would be pure cost.
    assert.equal(avatarCacheControl('Default_placeholder.svg', false), 'public, max-age=2592000');
});

test('a versioned placeholder is still fine to pin', () => {
    assert.match(avatarCacheControl('Default_placeholder.svg', true), /immutable/);
});

// ── Thumbnails ────────────────────────────────────────────────────────────────

test('the thumbnail inherits the main image version', () => {
    // Both files are written by the same processAvatar call from the same upload, so one
    // token describes both. Dropping it here would leave every 96px avatar uncacheable.
    assert.equal(
        thumbUrl('/img/profile_images/232.webp?v=deadbeef'),
        '/img/profile_images/232_thumb.webp?v=deadbeef'
    );
});

test('an unversioned main avatar still maps to its thumbnail', () => {
    assert.equal(thumbUrl('/img/profile_images/232.webp'), '/img/profile_images/232_thumb.webp');
});

test('anything that is not an optimized main avatar is passed through untouched', () => {
    for (const u of [
        '/img/profile_images/Default_placeholder.svg',
        '/img/profile_images/2444.png',                 // a raw upload, never optimized
        '/img/profile_images/232_thumb.webp?v=deadbeef', // already a thumbnail
        'https://example.com/avatar.webp',
        null, undefined, 42,
    ]) {
        assert.equal(thumbUrl(u), u);
    }
});

// ── Must never happen ─────────────────────────────────────────────────────────
// Every URL shape that exists in production today, checked against the one rule that
// matters: a picture someone just changed must not be able to stay hidden. A policy is
// safe only if it either names the bytes (versioned, so a new picture is a new URL) or
// forces the browser to ask. A long cache on a URL that can be reused is the bug.

test('no URL in production can serve a stale face', () => {
    const inTheWild = [
        // What the users table holds: 38 optimized avatars, and the raw uploads that
        // predate the WebP conversion and that the upload route still falls back to.
        { file: '232.webp', versioned: true }, { file: '232.webp', versioned: false },
        { file: '2612_thumb.webp', versioned: true }, { file: '2612_thumb.webp', versioned: false },
        { file: '2444.png', versioned: false }, { file: '34.jpeg', versioned: false },
        { file: '1265.jpg', versioned: false },
    ];
    for (const { file, versioned } of inTheWild) {
        const cc = avatarCacheControl(file, versioned);
        const pinned = /max-age=(\d+)/.exec(cc);
        const seconds = pinned ? Number(pinned[1]) : 0;
        assert.ok(
            versioned || seconds === 0,
            `${file} (versioned=${versioned}) may be held for ${seconds}s under an unversioned URL: ${cc}`
        );
    }
});

test('a new upload can never reuse the URL the old picture was cached under', () => {
    // The end-to-end property, at the level this can be tested without a database:
    // the URL the settings route stores is a function of the image, so replacing the
    // image replaces the URL, and the browser has no entry for it.
    const stored = (bytes) => versionedAvatarUrl('232.webp', bytes);
    const oldUrl = stored(Buffer.from('photo taken in 2024'));
    const newUrl = stored(Buffer.from('photo taken in 2026'));
    assert.notEqual(oldUrl, newUrl);
    assert.notEqual(thumbUrl(oldUrl), thumbUrl(newUrl)); // and the small sizes move too
});
