// Avatar optimization. Profile pictures were stored as raw uploads (up to ~2MB,
// full camera resolution) but displayed at 20–260px. We now generate two WebP
// sizes per user:
//   {id}.webp        320×320  — the profile-page hero (200–260px display)
//   {id}_thumb.webp   96×96   — every small context (chat ≤44px, collaborator
//                               grids 32px, contributions 20px, leaderboard 24px)
// Center-crop (matches the CSS object-fit:cover), EXIF-auto-rotated for phone photos.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const AVATAR_DIR = path.join(__dirname, 'img', 'profile_images');
const MAIN_SIZE = 320;
const THUMB_SIZE = 96;
const RASTER_RE = /\.(jpe?g|png|gif|webp)$/i;

/**
 * Build optimized main + thumbnail WebP avatars for a user from an input image.
 * Returns the public path of the main avatar. Does not delete the input.
 */
async function processAvatar(inputPath, userId) {
    const buf = fs.readFileSync(inputPath); // read once; input path may be reused
    const mainOut = path.join(AVATAR_DIR, `${userId}.webp`);
    const thumbOut = path.join(AVATAR_DIR, `${userId}_thumb.webp`);
    // failOn:'none' tolerates slightly-broken/truncated uploads rather than rejecting.
    await sharp(buf, { failOn: 'none' }).rotate()
        .resize(MAIN_SIZE, MAIN_SIZE, { fit: 'cover', position: 'centre' })
        .webp({ quality: 82 }).toFile(mainOut);
    await sharp(buf, { failOn: 'none' }).rotate()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
        .webp({ quality: 80 }).toFile(thumbOut);
    return `/img/profile_images/${userId}.webp`;
}

/** Map an optimized main-avatar URL to its thumbnail; pass anything else through. */
function thumbUrl(url) {
    if (typeof url === 'string' && /^\/img\/profile_images\/\d+\.webp$/.test(url)) {
        return url.replace(/\.webp$/, '_thumb.webp');
    }
    return url;
}

module.exports = { processAvatar, thumbUrl, AVATAR_DIR, MAIN_SIZE, THUMB_SIZE, RASTER_RE };
