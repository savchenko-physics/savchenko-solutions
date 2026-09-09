// Avatar optimization. Profile pictures were stored as raw uploads (up to ~2MB,
// full camera resolution) but displayed at 20–260px. We now generate two WebP
// sizes per user:
//   {id}.webp        320×320  — the profile-page hero (200–260px display)
//   {id}_thumb.webp   96×96   — every small context (chat ≤44px, collaborator
//                               grids 32px, contributions 20px, leaderboard 24px)
// Center-crop (matches the CSS object-fit:cover), EXIF-auto-rotated for phone photos.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const AVATAR_DIR = path.join(__dirname, 'img', 'profile_images');
const MAIN_SIZE = 320;
const THUMB_SIZE = 96;
const RASTER_RE = /\.(jpe?g|png|gif|webp)$/i;

// ── Cache busting ─────────────────────────────────────────────────────────────
// An avatar's URL is derived from the user id, so it does NOT change when the picture
// does, and /img is served with a 30-day max-age. So a user who changed their photo kept
// seeing the old one for weeks: their browser never asked the server again. The giveaway
// in the report (2026-08-28) was that a signed-out browser — nothing cached — showed the
// new picture immediately. Appending a hash of the image's own bytes gives every new
// picture a brand-new URL, which no cache can already hold; it is the same trick
// assetUrl() plays for CSS and JS (index.js). Because the token is the content, not the
// time, re-saving the settings form with the same photo yields the same URL and the
// browser keeps its copy.
const VERSION_LEN = 8;

/**
 * Public URL for a file in the avatar directory, carrying a version token read from its
 * contents. Pass `bytes` when the caller already has them, to skip re-reading the file.
 * A file that cannot be read yields the bare URL: a missing ?v= costs one revalidation
 * (see avatarCacheControl), never a wrong picture.
 */
function versionedAvatarUrl(fileName, bytes) {
    const url = `/img/profile_images/${fileName}`;
    try {
        const buf = bytes || fs.readFileSync(path.join(AVATAR_DIR, fileName));
        return `${url}?v=${crypto.createHash('md5').update(buf).digest('hex').slice(0, VERSION_LEN)}`;
    } catch (_err) {
        return url;
    }
}

// The files named after a user: the optimized pair, and the raw uploads that predate it
// (and that the upload route still falls back to if sharp throws).
const PER_USER_FILE = /^\d+(_thumb)?\.[a-z0-9]+$/i;

/**
 * Cache-Control for a file served from the avatar directory.
 *   versioned — the URL names these exact bytes, so it can never go stale: cache for a year.
 *   per-user, unversioned — `<id>.webp` may hold a different face tomorrow, so the browser
 *       must ask first. `no-cache` still stores the file; it only forbids using it without
 *       revalidating, which costs a 304 with no body. A month-old face costs more.
 *   anything else — Default_placeholder.svg and friends are constants; keep /img's 30 days.
 */
function avatarCacheControl(fileName, versioned) {
    if (versioned) return 'public, max-age=31536000, immutable';
    if (PER_USER_FILE.test(fileName)) return 'no-cache';
    return 'public, max-age=2592000';
}

/**
 * Build optimized main + thumbnail WebP avatars for a user from an input image.
 * Returns the public path of the main avatar, versioned — store it as-is; every read
 * site renders users.profile_picture verbatim, so that one value is what makes a
 * changed picture appear everywhere at once. Does not delete the input.
 */
async function processAvatar(inputPath, userId) {
    const buf = fs.readFileSync(inputPath); // read once; input path may be reused
    const mainOut = path.join(AVATAR_DIR, `${userId}.webp`);
    const thumbOut = path.join(AVATAR_DIR, `${userId}_thumb.webp`);
    // failOn:'none' tolerates slightly-broken/truncated uploads rather than rejecting.
    const mainBuf = await sharp(buf, { failOn: 'none' }).rotate()
        .resize(MAIN_SIZE, MAIN_SIZE, { fit: 'cover', position: 'centre' })
        .webp({ quality: 82 }).toBuffer();
    fs.writeFileSync(mainOut, mainBuf);
    await sharp(buf, { failOn: 'none' }).rotate()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
        .webp({ quality: 80 }).toFile(thumbOut);
    return versionedAvatarUrl(`${userId}.webp`, mainBuf);
}

// A main avatar, with or without the ?v= token that processAvatar now appends.
const OPTIMIZED_MAIN = /^\/img\/profile_images\/\d+\.webp(\?|$)/;

/** Map an optimized main-avatar URL to its thumbnail; pass anything else through. */
function thumbUrl(url) {
    if (typeof url !== 'string' || !OPTIMIZED_MAIN.test(url)) return url;
    const [file, query] = url.split('?');
    // The thumbnail is regenerated with the main image, so it shares its version token.
    return file.replace(/\.webp$/, '_thumb.webp') + (query ? `?${query}` : '');
}

module.exports = {
    processAvatar, thumbUrl, versionedAvatarUrl, avatarCacheControl,
    AVATAR_DIR, MAIN_SIZE, THUMB_SIZE, RASTER_RE,
};
