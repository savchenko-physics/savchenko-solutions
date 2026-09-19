// lib/videoMeta.js reads a video's pixel size out of its container, so a chat bubble can reserve
// the box before the browser fetches anything (as sharp does for images). The box has no ffprobe.
//
// The containers are built by hand here, box by box, so every branch is exercised: a phone's
// moov-at-the-end mp4, the 64-bit box size, the size-0 "to the end" box, a 90° rotation matrix,
// an audio track listed first, a video track whose header says 0×0 (the coded size in stsd is
// then used), and for WebM the unknown-size Segment a live muxer writes, DisplayWidth over
// PixelWidth, and a file without a video track. When ffmpeg is installed the same is checked on
// real files it writes, rotation included; that block is skipped where it is not.
//
// A hostile file must not make the parser allocate or loop without limit: a moov declared larger
// than MOOV_MAX and a box that runs past the end both yield null.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { videoDimensions, dimensionsFromBuffer, MOOV_MAX } = require('../lib/videoMeta');

// ── ISO base media builders ────────────────────────────────────────────────────
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
function box(type, ...parts) {
    const body = Buffer.concat(parts);
    return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
}
function tkhd({ width, height, rotate = 0, version = 0 }) {
    const parts = [Buffer.from([version, 0, 0, 0])];
    if (version === 1) parts.push(Buffer.alloc(8), Buffer.alloc(8), u32(1), u32(0), Buffer.alloc(8));
    else parts.push(u32(0), u32(0), u32(1), u32(0), u32(0));
    parts.push(Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0));
    const one = 0x00010000, w = 0x40000000;
    const matrix = { 0: [one, 0, 0, 0, one, 0, 0, 0, w], 90: [0, one, 0, -one, 0, 0, 0, 0, w],
        180: [-one, 0, 0, 0, -one, 0, 0, 0, w], 270: [0, -one, 0, one, 0, 0, 0, 0, w] }[rotate];
    parts.push(...matrix.map(i32), u32(width * 65536), u32(height * 65536));
    return box('tkhd', ...parts);
}
function videoStsd(width, height) {
    const avc1 = box('avc1', Buffer.alloc(6), u16(1), u16(0), u16(0), Buffer.alloc(12), u16(width), u16(height), Buffer.alloc(50));
    return box('mdia', box('minf', box('stbl', box('stsd', u32(0), u32(1), avc1))));
}
function trak(opts) {
    return box('trak', tkhd(opts), ...(opts.stsd ? [videoStsd(opts.stsd[0], opts.stsd[1])] : []));
}
const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2mp41'));
const mdat = (n) => box('mdat', Buffer.alloc(n, 7));

// ── EBML builders ──────────────────────────────────────────────────────────────
function vintSize(n) {
    for (let len = 1; len <= 8; len++) {
        if (n <= 2 ** (7 * len) - 2) {
            const b = Buffer.alloc(len);
            let v = n;
            for (let i = len - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); }
            b[0] |= 0x80 >> (len - 1);
            return b;
        }
    }
    throw new Error('too large');
}
const el = (id, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from(id), vintSize(body.length), body]); };
const elUnknown = (id, ...parts) => Buffer.concat([Buffer.from(id), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), ...parts]);
const uintEl = (id, n) => { const bytes = []; do { bytes.unshift(n % 256); n = Math.floor(n / 256); } while (n > 0); return el(id, Buffer.from(bytes)); };
const EBML = el([0x1A, 0x45, 0xDF, 0xA3], uintEl([0x42, 0x86], 1), el([0x42, 0x82], Buffer.from('webm')));
const SEGMENT = [0x18, 0x53, 0x80, 0x67], TRACKS = [0x16, 0x54, 0xAE, 0x6B], ENTRY = [0xAE], VIDEO = [0xE0], AUDIO = [0xE1];
const CLUSTER = [0x1F, 0x43, 0xB6, 0x75];
const videoTrack = (w, h, extra = Buffer.alloc(0)) => el(ENTRY, uintEl([0xD7], 1), uintEl([0x83], 1), el(VIDEO, uintEl([0xB0], w), uintEl([0xBA], h), extra));
const audioTrack = () => el(ENTRY, uintEl([0xD7], 2), uintEl([0x83], 2), el(AUDIO, uintEl([0xB5], 48000)));

test('mp4: moov after mdat, as a phone writes it', () => {
    const file = Buffer.concat([ftyp, mdat(5000), box('moov', trak({ width: 1920, height: 1080 }))]);
    assert.deepEqual(dimensionsFromBuffer(file), { width: 1920, height: 1080 });
});

test('mp4: a 90° or 270° matrix swaps the sides, 180° does not', () => {
    for (const [rotate, expected] of [[90, [1080, 1920]], [270, [1080, 1920]], [180, [1920, 1080]], [0, [1920, 1080]]]) {
        const file = Buffer.concat([ftyp, box('moov', trak({ width: 1920, height: 1080, rotate })), mdat(10)]);
        assert.deepEqual(dimensionsFromBuffer(file), { width: expected[0], height: expected[1] }, `rotate ${rotate}`);
    }
});

test('mp4: an audio track first, a version-1 track header, and a 0×0 header with the size in stsd', () => {
    const audio = trak({ width: 0, height: 0 });
    const file = Buffer.concat([ftyp, box('moov', audio, trak({ width: 640, height: 360, version: 1 }))]);
    assert.deepEqual(dimensionsFromBuffer(file), { width: 640, height: 360 });
    const coded = Buffer.concat([ftyp, box('moov', audio, trak({ width: 0, height: 0, rotate: 90, stsd: [1280, 720] }))]);
    assert.deepEqual(dimensionsFromBuffer(coded), { width: 720, height: 1280 });
    const audioOnly = Buffer.concat([ftyp, box('moov', audio)]);
    assert.equal(dimensionsFromBuffer(audioOnly), null);
});

test('mp4: 64-bit box sizes and a size-0 last box', () => {
    const moov = box('moov', trak({ width: 320, height: 180 }));
    const big = Buffer.concat([u32(1), Buffer.from('mdat'), Buffer.alloc(8), Buffer.alloc(100)]);
    big.writeBigUInt64BE(BigInt(16 + 100), 8);
    const file = Buffer.concat([ftyp, big, moov]);
    assert.deepEqual(dimensionsFromBuffer(file), { width: 320, height: 180 });
    const toEnd = Buffer.concat([ftyp, moov, u32(0), Buffer.from('mdat'), Buffer.alloc(40)]);
    assert.deepEqual(dimensionsFromBuffer(toEnd), { width: 320, height: 180 });
});

test('mp4: what cannot be trusted yields null', () => {
    assert.equal(dimensionsFromBuffer(Buffer.from('not a video')), null);
    assert.equal(dimensionsFromBuffer(Buffer.alloc(0)), null);
    const truncated = Buffer.concat([ftyp, box('moov', trak({ width: 320, height: 180 }))]).subarray(0, 60);
    assert.equal(dimensionsFromBuffer(truncated), null);
    const huge = Buffer.concat([ftyp, u32(0), Buffer.from('moov')]);   // "to the end" but tiny: no tkhd
    assert.equal(dimensionsFromBuffer(huge), null);
    const declared = Buffer.concat([ftyp, u32(MOOV_MAX + 8), Buffer.from('moov'), Buffer.alloc(16)]);
    assert.equal(dimensionsFromBuffer(declared), null);                 // runs past the end: refused
    const absurd = Buffer.concat([ftyp, box('moov', trak({ width: 60000, height: 2 }))]);
    assert.equal(dimensionsFromBuffer(absurd), null);
});

test('webm: Tracks inside a Segment, DisplayWidth preferred, unknown-size Segment, no video track', () => {
    const plain = Buffer.concat([EBML, el(SEGMENT, el(TRACKS, audioTrack(), videoTrack(640, 480)))]);
    assert.deepEqual(dimensionsFromBuffer(plain), { width: 640, height: 480 });
    const display = Buffer.concat([EBML, el(SEGMENT, el(TRACKS, videoTrack(720, 576, Buffer.concat([uintEl([0x54, 0xB0], 1024), uintEl([0x54, 0xBA], 576)]))))]);
    assert.deepEqual(dimensionsFromBuffer(display), { width: 1024, height: 576 });
    const live = Buffer.concat([EBML, elUnknown(SEGMENT, el(TRACKS, videoTrack(1280, 720)), el(CLUSTER, Buffer.alloc(30)))]);
    assert.deepEqual(dimensionsFromBuffer(live), { width: 1280, height: 720 });
    const audioOnly = Buffer.concat([EBML, el(SEGMENT, el(TRACKS, audioTrack()))]);
    assert.equal(dimensionsFromBuffer(audioOnly), null);
    const clusterFirst = Buffer.concat([EBML, el(SEGMENT, el(CLUSTER, Buffer.alloc(8)), el(TRACKS, videoTrack(1, 1)))]);
    assert.equal(dimensionsFromBuffer(clusterFirst), null);
});

test('reading from a path, including a missing one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-meta-'));
    const file = path.join(dir, 'a.mp4');
    fs.writeFileSync(file, Buffer.concat([ftyp, mdat(3000), box('moov', trak({ width: 1080, height: 1920 }))]));
    assert.deepEqual(videoDimensions(file), { width: 1080, height: 1920 });
    assert.equal(videoDimensions(path.join(dir, 'missing.mp4')), null);
    fs.rmSync(dir, { recursive: true, force: true });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('files ffmpeg writes: mp4, faststart, mov, m4v, webm, mkv and a rotated phone clip', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-meta-ffmpeg-'));
    const run = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: dir, timeout: 60000 });
    assert.equal(run(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'plain.mp4']).status, 0);
    const expect = { 'plain.mp4': [320, 180] };
    const copies = [['faststart.mp4', ['-movflags', '+faststart']], ['clip.mov', []], ['clip.m4v', []], ['clip.mkv', []],
        ['audiofirst.mp4', ['-map', '0:a', '-map', '0:v']]];
    for (const [name, extra] of copies) {
        if (run(['-i', 'plain.mp4', ...extra, '-c', 'copy', name]).status === 0) expect[name] = [320, 180];
    }
    if (run(['-i', 'plain.mp4', '-c:v', 'libvpx-vp9', '-b:v', '100k', '-an', '-t', '1', 'clip.webm']).status === 0) expect['clip.webm'] = [320, 180];
    if (run(['-display_rotation', '90', '-i', 'plain.mp4', '-c', 'copy', 'portrait.mp4']).status === 0) expect['portrait.mp4'] = [180, 320];
    for (const [name, [width, height]] of Object.entries(expect)) {
        assert.deepEqual(videoDimensions(path.join(dir, name)), { width, height }, name);
    }
    assert.ok(Object.keys(expect).length >= 4, `only ${Object.keys(expect).length} files produced`);
    fs.rmSync(dir, { recursive: true, force: true });
});
