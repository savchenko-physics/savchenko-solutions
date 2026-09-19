// lib/videoTranscode.js makes every chat video play in every browser.
//
// The first video sent to the site (2026-09-19) was an OpenCV animation: an .mp4 holding
// MPEG-4 part 2, which no browser decodes, so the player errored and the bubble fell back to a
// download card. Browsers agree on one thing only, H.264 8-bit 4:2:0 with AAC in an mp4, and
// this module decides per upload whether the file already is that (left alone), only needs
// re-wrapping (a mov or mkv with the right streams), or must be re-encoded, and runs ffmpeg
// with the arguments that produce it. The decision table and the arguments are tested on
// ffprobe output written down here; with ffmpeg installed a real mp4v file is converted and
// what comes out is probed.
//
// Not covered: the queue's effect on the live box (nice 19, choom 900, one thread), and the
// database side in messages.js (status 'converting' → NULL/'failed', the SSE update).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const t = require('../lib/videoTranscode');

const stream = (over) => ({ codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 1920, height: 1080, ...over });
const audio = (over) => ({ codec_type: 'audio', codec_name: 'aac', channels: 2, ...over });
const info = (streams, format = 'mov,mp4,m4a,3gp,3g2,mj2') => t.summarize({ streams, format: { format_name: format, duration: '3.0' } });

test('what already plays everywhere is left alone; the wrong container is re-wrapped', () => {
    assert.equal(t.conversionNeeded(info([stream(), audio()]), 'mp4'), 'none');
    assert.equal(t.conversionNeeded(info([stream({ profile: 'Main' })]), 'm4v'), 'none');          // no audio
    assert.equal(t.conversionNeeded(info([audio(), stream()]), 'mp4'), 'none');                      // audio first
    assert.equal(t.conversionNeeded(info([stream({ pix_fmt: 'yuvj420p' }), audio({ codec_name: 'mp3' })]), 'mp4'), 'none');
    assert.equal(t.conversionNeeded(info([stream(), audio()]), 'mov'), 'remux');
    assert.equal(t.conversionNeeded(info([stream(), audio()], 'matroska,webm'), 'mkv'), 'remux');
});

test('anything a browser may refuse is re-encoded', () => {
    assert.equal(t.conversionNeeded(info([stream({ codec_name: 'mpeg4', profile: 'Simple Profile' })]), 'mp4'), 'transcode');
    assert.equal(t.conversionNeeded(info([stream({ codec_name: 'hevc', profile: 'Main' }), audio()]), 'mov'), 'transcode');
    assert.equal(t.conversionNeeded(info([stream({ profile: 'High 4:4:4 Predictive', pix_fmt: 'yuv444p' })]), 'mp4'), 'transcode');
    assert.equal(t.conversionNeeded(info([stream({ profile: 'High 10', pix_fmt: 'yuv420p10le' })]), 'mp4'), 'transcode');
    assert.equal(t.conversionNeeded(info([stream({ codec_name: 'vp9', profile: 'Profile 0' })], 'matroska,webm'), 'webm'), 'transcode');
    assert.equal(t.conversionNeeded(info([stream(), audio({ codec_name: 'opus' })]), 'mp4'), 'transcode');
    assert.equal(t.conversionNeeded(info([stream({ width: 3840, height: 2160 }), audio()]), 'mp4'), 'none');
    assert.equal(t.conversionNeeded(info([stream({ width: 7680, height: 4320 })]), 'mp4'), 'transcode');
    assert.equal(t.conversionNeeded(info([stream(), audio(), { codec_type: 'subtitle', codec_name: 'mov_text' }]), 'mp4'), 'transcode');
    assert.equal(t.conversionNeeded(null, 'mp4'), 'transcode');                                   // ffprobe could not read it
    assert.equal(t.summarize({ streams: [audio()] }), null);                                        // no video at all
});

test('the ffmpeg arguments produce H.264 4:2:0 + AAC in a faststart mp4, at most 1280 px, one thread', () => {
    const args = t.ffmpegArgs('transcode', '/in/a.mkv', '/out/a-web.mp4');
    const has = (...seq) => assert.ok(args.some((_, i) => seq.every((v, j) => args[i + j] === v)), seq.join(' '));
    has('-c:v', 'libx264'); has('-pix_fmt', 'yuv420p'); has('-profile:v', 'high'); has('-threads', '1');
    has('-c:a', 'aac'); has('-movflags', '+faststart'); has('-f', 'mp4', '/out/a-web.mp4'); has('-map', '0:a:0?');
    has('-map_metadata', '-1');                       // no GPS or device tags leave the box
    const vf = args[args.indexOf('-vf') + 1];
    assert.match(vf, /min\(1280,iw\)/); assert.match(vf, /force_divisible_by=2/); assert.match(vf, /setsar=1/);
    const remux = t.ffmpegArgs('remux', '/in/a.mov', '/out/a-web.mp4');
    assert.ok(remux.includes('copy') && !remux.includes('libx264') && remux.includes('+faststart'));
    assert.equal(t.outputPathFor('/img/messages/1789850925987-0boc27.MOV'), '/img/messages/1789850925987-0boc27-web.mp4');
});

test('a remux that fails falls back to a transcode; a job that fails leaves no file behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-'));
    const dst = path.join(dir, 'out.mp4');
    const calls = [];
    const runner = async (args) => { calls.push(args.includes('copy') ? 'remux' : 'transcode'); if (args.includes('copy')) throw new Error('no'); fs.writeFileSync(dst, 'x'); };
    assert.equal(await t.convert('/in', dst, 'remux', runner), 'transcode');
    assert.deepEqual(calls, ['remux', 'transcode']);
    const failing = async () => { fs.writeFileSync(dst, ''); throw new Error('ffmpeg exit 1: bad'); };
    await assert.rejects(() => t.convert('/in', dst, 'transcode', failing), /bad/);
    assert.equal(fs.existsSync(dst), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the queue runs jobs one after another and survives a failure', async () => {
    const q = t.createQueue();
    const order = [];
    const p1 = q.add(async () => { await new Promise((r) => setTimeout(r, 30)); order.push(1); });
    const p2 = q.add(async () => { order.push(2); throw new Error('boom'); });
    const p3 = q.add(async () => { order.push(3); });
    assert.equal(q.pending, 3);
    await Promise.all([p1, p2, p3]);
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(q.pending, 0);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('with ffmpeg: an OpenCV-style mp4v file becomes a playable H.264 mp4 with a placeholder', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-ffmpeg-'));
    const src = path.join(dir, 'anim.mp4');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1500x800:rate=2', '-t', '2', '-c:v', 'mpeg4', '-q:v', '5', src], { timeout: 60000 });
    assert.equal(made.status, 0, String(made.stderr));
    const before = await t.probe(src);
    assert.equal(before.video.codec, 'mpeg4');
    const mode = t.conversionNeeded(before, 'mp4');
    assert.equal(mode, 'transcode');
    const dst = t.outputPathFor(src);
    assert.equal(await t.convert(src, dst, mode), 'transcode');
    const after = await t.probe(dst);
    assert.equal(after.video.codec, 'h264');
    assert.equal(after.video.profile, 'High');
    assert.equal(after.video.pixFmt, 'yuv420p');
    assert.deepEqual([after.video.width, after.video.height], [1280, 682]);
    assert.equal(t.conversionNeeded(after, 'mp4'), 'none');
    const poster = await t.posterPlaceholder(dst);
    assert.match(poster, /^data:image\/jpeg;base64,/);
    assert.ok(poster.length < 8000);
    fs.rmSync(dir, { recursive: true, force: true });
});
