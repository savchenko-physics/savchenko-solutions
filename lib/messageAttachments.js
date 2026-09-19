// What a chat message may carry, stated once. messages.js applies it to uploads, the messenger
// page renders from it (the composer's accept list and the "up to N MB" hint come from here as
// JSON), and tests/message-attachments.test.js holds it to the rules below.
//
// Three kinds. An image renders inline (sharp reads its size for the placeholder box). A video
// renders inline in a <video> when the browser can play the container — mp4, m4v, mov, webm —
// and as a download card otherwise (mkv from OBS, avi); its pixel size is read from the container
// by lib/videoMeta.js so the bubble reserves the box, as image bubbles do. Anything else on the
// list is a download card. html, htm, svg, js and xml stay off the list on purpose: an uploaded
// file must never be served as executable markup from this origin.
//
// Since 2026-09-19 (asked in the Russian chat: "видео файлы можно в чате высылать? ограничений на
// размер есть?"): videos are accepted, up to VIDEO_MAX_BYTES; everything else keeps MAX_BYTES.
// The video limit is what the box can afford, not what a phone produces: the server's disk is
// 16 GB with a few GB free, and a minute of 1080p is 60–150 MB, so a clip is expected to be short
// or compressed. A larger limit needs storage off the box first.

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm'];          // played inline
const VIDEO_FILE_EXTENSIONS = ['mkv', 'avi'];                    // video-sized, but a download card
const OTHER_EXTENSIONS = ['pdf', 'txt', 'md', 'tex', 'csv', 'json', 'rtf', 'doc', 'docx', 'xls', 'xlsx',
    'ppt', 'pptx', 'odt', 'ods', 'odp', 'zip', 'rar', '7z'];

const MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;

const ALL_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...VIDEO_FILE_EXTENSIONS, ...OTHER_EXTENSIONS];

function extensionOf(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
}

/** 'image' | 'video' (plays inline) | 'file' (download card) | null (not accepted). */
function kindOf(name) {
    const ext = extensionOf(name);
    if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
    if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
    if (VIDEO_FILE_EXTENSIONS.includes(ext) || OTHER_EXTENSIONS.includes(ext)) return 'file';
    return null;
}

/** The size ceiling for this file name, or 0 when the type is not accepted. */
function limitFor(name) {
    const ext = extensionOf(name);
    if (VIDEO_EXTENSIONS.includes(ext) || VIDEO_FILE_EXTENSIONS.includes(ext)) return VIDEO_MAX_BYTES;
    return kindOf(name) ? MAX_BYTES : 0;
}

function isAccepted(name) {
    return kindOf(name) !== null;
}

/** The <input type="file" accept="…"> value: every accepted extension, plus the image and video
 *  media types so phone pickers offer the camera roll. */
function acceptAttribute() {
    return ['image/*', 'video/*', ...ALL_EXTENSIONS.map((e) => '.' + e)].join(',');
}

/** What the page's script needs, as plain data. */
function clientRules() {
    return {
        maxBytes: MAX_BYTES,
        videoMaxBytes: VIDEO_MAX_BYTES,
        image: IMAGE_EXTENSIONS,
        video: VIDEO_EXTENSIONS,
        videoFile: VIDEO_FILE_EXTENSIONS,
        other: OTHER_EXTENSIONS,
    };
}

module.exports = {
    IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, VIDEO_FILE_EXTENSIONS, OTHER_EXTENSIONS, ALL_EXTENSIONS,
    MAX_BYTES, VIDEO_MAX_BYTES,
    extensionOf, kindOf, limitFor, isAccepted, acceptAttribute, clientRules,
};
