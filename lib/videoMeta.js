// Pixel size of an uploaded video, read from its container, so a chat bubble can reserve the
// right box before the browser has fetched a byte of it — what sharp does for images. The box
// has no ffprobe, and the two containers browsers play are simple enough to read directly.
//
// ISO base media (mp4, m4v, mov): boxes of [size:4][type:4]; size 1 means a 64-bit size follows,
// size 0 means "to the end of the file". moov → trak → tkhd carries the track's presentation
// size as 16.16 fixed point and a 3×3 matrix. A phone held upright stores the landscape sensor
// frame with a 90° matrix and players rotate it on display, so a 90° / 270° matrix swaps the
// two. Audio tracks have size 0. When tkhd says 0 for the video track as well (some muxers), the
// sample entry in stsd has the coded size. A phone writes moov after the media data, so the
// top-level boxes are walked with seeks and only moov is read into memory, capped at MOOV_MAX.
//
// Matroska / WebM: EBML elements of [id: vint keeping its marker bit][size: vint, marker
// stripped; all ones = unknown]. Segment → Tracks → TrackEntry → Video → PixelWidth /
// PixelHeight, or DisplayWidth / DisplayHeight when present (how non-square pixels are
// declared). Tracks precede the first Cluster, so only the head of the file is read (HEAD_MAX).
//
// Anything unreadable yields null: the bubble then sizes itself once the metadata arrives.
// Every loop is bounded by the file's declared structure and the caps below, so a hostile file
// cannot make this allocate or loop without limit. tests/video-meta.test.js.

const fs = require('fs');

const MOOV_MAX = 16 * 1024 * 1024;
const HEAD_MAX = 4 * 1024 * 1024;
const MAX_DIM = 16384;
const MAX_BOXES = 4096;

function sane(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
    if (width <= 0 || height <= 0 || width > MAX_DIM || height > MAX_DIM) return null;
    return { width, height };
}

// ── ISO base media ─────────────────────────────────────────────────────────────

// Header of the box at `off` within [off, end): { size, type, header } or null.
function boxHeader(buf, off, end) {
    if (off + 8 > end) return null;
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) {
        if (off + 16 > end) return null;
        const big = buf.readBigUInt64BE(off + 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(big);
        header = 16;
    } else if (size === 0) {
        size = end - off;
    }
    if (size < header || off + size > end) return null;
    return { size, type, header };
}

function* boxes(buf, start, end) {
    let off = start;
    let n = 0;
    while (off < end && n++ < MAX_BOXES) {
        const h = boxHeader(buf, off, end);
        if (!h) return;
        yield { off, ...h };
        off += h.size;
    }
}

function findBox(buf, start, end, type) {
    for (const b of boxes(buf, start, end)) if (b.type === type) return b;
    return null;
}

function findPath(buf, box, types) {
    let cur = box;
    for (const t of types) {
        cur = findBox(buf, cur.off + cur.header, cur.off + cur.size, t);
        if (!cur) return null;
    }
    return cur;
}

// tkhd: { width, height, rotated } as the track header declares them (width/height may be 0).
function trackHeader(buf, tkhd) {
    const p = tkhd.off + tkhd.header;
    const end = tkhd.off + tkhd.size;
    if (p + 4 > end) return null;
    const version = buf[p];
    const matrix = p + 4 + (version === 1 ? 32 : 20) + 16;
    if (matrix + 44 > end) return null;
    const a = buf.readInt32BE(matrix), b = buf.readInt32BE(matrix + 4);
    const c = buf.readInt32BE(matrix + 12), d = buf.readInt32BE(matrix + 16);
    const width = Math.round(buf.readUInt32BE(matrix + 36) / 65536);
    const height = Math.round(buf.readUInt32BE(matrix + 40) / 65536);
    const rotated = a === 0 && d === 0 && b !== 0 && c !== 0;
    return { width, height, rotated };
}

// The coded size from the first visual sample entry in stsd. The entry is a box (8 bytes) followed
// by 6 reserved bytes and a 2-byte data reference index, then 16 bytes of pre-defined fields, then
// width and height as 16-bit integers: offsets 32 and 34 from the entry's start.
function sampleEntrySize(buf, trak) {
    const stsd = findPath(buf, trak, ['mdia', 'minf', 'stbl', 'stsd']);
    if (!stsd) return null;
    const p = stsd.off + stsd.header + 8;      // version/flags (4) + entry_count (4)
    const entry = boxHeader(buf, p, stsd.off + stsd.size);
    if (!entry || entry.size < 36) return null;
    return { width: buf.readUInt16BE(p + 32), height: buf.readUInt16BE(p + 34) };
}

// Dimensions from a moov box held in `buf` at [moov.off, moov.off + moov.size).
function isoDimensions(buf, moov) {
    for (const trak of boxes(buf, moov.off + moov.header, moov.off + moov.size)) {
        if (trak.type !== 'trak') continue;
        const tkhd = findBox(buf, trak.off + trak.header, trak.off + trak.size, 'tkhd');
        if (!tkhd) continue;
        const head = trackHeader(buf, tkhd);
        if (!head) continue;
        let { width, height } = head;
        if (!width || !height) {
            const coded = sampleEntrySize(buf, trak);
            if (!coded || !coded.width || !coded.height) continue;   // an audio track
            width = coded.width; height = coded.height;
        }
        if (head.rotated) [width, height] = [height, width];
        const dims = sane(width, height);
        if (dims) return dims;
    }
    return null;
}

// Walk the top-level boxes of a reader { size, read(off, len) → Buffer } and parse moov.
function isoFromReader(reader) {
    let off = 0;
    let n = 0;
    while (off + 8 <= reader.size && n++ < MAX_BOXES) {
        const head = reader.read(off, 16);
        if (head.length < 8) return null;
        let size = head.readUInt32BE(0);
        const type = head.toString('latin1', 4, 8);
        let header = 8;
        if (size === 1) {
            if (head.length < 16) return null;
            const big = head.readBigUInt64BE(8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            size = Number(big);
            header = 16;
        } else if (size === 0) {
            size = reader.size - off;
        }
        if (size < header || off + size > reader.size) return null;
        if (type === 'moov') {
            if (size > MOOV_MAX) return null;
            const buf = reader.read(off, size);
            if (buf.length < size) return null;
            return isoDimensions(buf, { off: 0, size, header, type });
        }
        off += size;
    }
    return null;
}

// ── Matroska / WebM ────────────────────────────────────────────────────────────

const EBML_MAGIC = 0x1A45DFA3;
const ID = {
    Segment: 0x18538067, Tracks: 0x1654AE6B, TrackEntry: 0xAE, Video: 0xE0,
    PixelWidth: 0xB0, PixelHeight: 0xBA, DisplayWidth: 0x54B0, DisplayHeight: 0x54BA,
    Cluster: 0x1F43B675,
};

// A variable-length integer at `off`: { value, length, unknown }. IDs keep their marker bit.
function vint(buf, off, end, keepMarker) {
    if (off >= end) return null;
    const first = buf[off];
    if (first === 0) return null;
    let length = 1, mask = 0x80;
    while (!(first & mask)) { length++; mask >>= 1; }
    if (off + length > end) return null;
    let value = keepMarker ? first : (first & (mask - 1));
    let allOnes = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < length; i++) {
        const b = buf[off + i];
        if (b !== 0xff) allOnes = false;
        value = value * 256 + b;
    }
    return { value, length, unknown: !keepMarker && allOnes };
}

function* elements(buf, start, end) {
    let off = start;
    let n = 0;
    while (off < end && n++ < MAX_BOXES) {
        const id = vint(buf, off, end, true);
        if (!id) return;
        const size = vint(buf, off + id.length, end, false);
        if (!size) return;
        const dataStart = off + id.length + size.length;
        const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
        yield { id: id.value, dataStart, dataEnd };
        off = dataEnd;
    }
}

function uint(buf, start, end) {
    let v = 0;
    const n = Math.min(end - start, 8);
    for (let i = 0; i < n; i++) v = v * 256 + buf[start + i];
    return v;
}

function videoElementSize(buf, video) {
    let pw = 0, ph = 0, dw = 0, dh = 0;
    for (const e of elements(buf, video.dataStart, video.dataEnd)) {
        if (e.id === ID.PixelWidth) pw = uint(buf, e.dataStart, e.dataEnd);
        else if (e.id === ID.PixelHeight) ph = uint(buf, e.dataStart, e.dataEnd);
        else if (e.id === ID.DisplayWidth) dw = uint(buf, e.dataStart, e.dataEnd);
        else if (e.id === ID.DisplayHeight) dh = uint(buf, e.dataStart, e.dataEnd);
    }
    return sane(dw, dh) || sane(pw, ph);
}

function matroskaDimensions(buf, end) {
    if (end < 4 || buf.readUInt32BE(0) !== EBML_MAGIC) return null;
    for (const top of elements(buf, 0, end)) {
        if (top.id !== ID.Segment) continue;
        for (const seg of elements(buf, top.dataStart, top.dataEnd)) {
            if (seg.id === ID.Cluster) return null;
            if (seg.id !== ID.Tracks) continue;
            for (const track of elements(buf, seg.dataStart, seg.dataEnd)) {
                if (track.id !== ID.TrackEntry) continue;
                for (const part of elements(buf, track.dataStart, track.dataEnd)) {
                    if (part.id !== ID.Video) continue;
                    const dims = videoElementSize(buf, part);
                    if (dims) return dims;
                }
            }
            return null;
        }
    }
    return null;
}

// ── Entry points ───────────────────────────────────────────────────────────────

function bufferReader(buf) {
    return { size: buf.length, read: (off, len) => buf.subarray(off, Math.min(buf.length, off + len)) };
}

function fileReader(fd, size) {
    return {
        size,
        read(off, len) {
            const out = Buffer.alloc(len);
            const n = fs.readSync(fd, out, 0, len, off);
            return n === len ? out : out.subarray(0, n);
        },
    };
}

/** { width, height } of the first video track a reader holds, or null. */
function dimensionsFromReader(reader) {
    try {
        const head = reader.read(0, 4);
        if (head.length >= 4 && head.readUInt32BE(0) === EBML_MAGIC) {
            const buf = reader.read(0, Math.min(reader.size, HEAD_MAX));
            return matroskaDimensions(buf, buf.length);
        }
        return isoFromReader(reader);
    } catch (err) {
        return null;
    }
}

function dimensionsFromBuffer(buf) {
    return dimensionsFromReader(bufferReader(buf));
}

/** { width, height } of the video file at `filePath`, or null when it cannot be read. */
function videoDimensions(filePath) {
    let fd = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const { size } = fs.fstatSync(fd);
        return dimensionsFromReader(fileReader(fd, size));
    } catch (err) {
        return null;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* nothing to do */ } }
    }
}

module.exports = { videoDimensions, dimensionsFromBuffer, MOOV_MAX, HEAD_MAX, MAX_DIM };
