// Every video sent to a chat must play in every browser. Browsers agree on exactly one thing:
// H.264 (8-bit 4:2:0, Baseline/Main/High) with AAC in an mp4. Phones write that, but not
// always (an iPhone's "High Efficiency" setting is HEVC, which Firefox never plays), OpenCV
// writes MPEG-4 part 2 ("mp4v", which nothing plays: the first video sent to the site, on
// 2026-09-19), OBS writes mkv, browsers record webm, and 10-bit or 4:4:4 H.264 from a
// careful encoder fails too. So an upload that is not already that one thing is converted to
// it here, on the box, with ffmpeg (installed 2026-09-19): re-encoded at up to 1280 px on the
// long side, or only re-wrapped when the streams are already right and just the container
// is wrong (a mov or an mkv holding H.264 and AAC).
//
// Cost on a t3a.micro: libx264 "veryfast" on one thread does about 30 frames a second at
// 720p, so a minute of phone video takes a minute or two. The process runs at nice 19 and
// with oom_score_adj 900 (choom), so the site keeps its CPU and, if memory ever runs out, the
// kernel kills the converter, never the app. Jobs run one at a time. A job is remembered in
// the database (messages.attachment_status = 'converting'), so a restart mid-way resumes it
// (messages.js resumeConversions at startup) and a failure leaves a download card
// ('failed') rather than a broken player.
//
// tests/video-transcode.test.js covers the decision and the arguments; when ffmpeg is
// installed it also converts a real mp4v file and checks what comes out.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_SIDE = 1280;                 // never upscale; 1080p phone video becomes 720p
const TIMEOUT_MS = 20 * 60 * 1000;     // a job past this is killed and marked failed
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// What every browser plays.
const PLAYABLE_VIDEO = new Set(['h264']);
const PLAYABLE_H264_PROFILES = new Set(['Baseline', 'Constrained Baseline', 'Main', 'High']);
const PLAYABLE_PIX_FMTS = new Set(['yuv420p', 'yuvj420p']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3']);
const MP4_CONTAINERS = new Set(['mp4', 'm4v']);

/** ffprobe's view of a file, reduced to what the decision needs; null when ffprobe is
 *  missing or the file is not a video it understands. */
function probe(filePath) {
    return new Promise((resolve) => {
        execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
            { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
                if (err) return resolve(null);
                let info;
                try { info = JSON.parse(stdout); } catch (e) { return resolve(null); }
                resolve(summarize(info));
            });
    });
}

function summarize(info) {
    const streams = (info && info.streams) || [];
    const video = streams.find((s) => s.codec_type === 'video' && !isCoverArt(s));
    if (!video) return null;
    const audio = streams.find((s) => s.codec_type === 'audio');
    const rotation = Number((video.side_data_list || []).find((d) => d.rotation !== undefined)?.rotation || 0);
    return {
        formats: String((info.format && info.format.format_name) || '').split(','),
        duration: Number((info.format && info.format.duration) || video.duration || 0) || 0,
        video: {
            codec: video.codec_name, profile: video.profile || '', pixFmt: video.pix_fmt || '',
            width: Number(video.width) || 0, height: Number(video.height) || 0, rotation,
        },
        audio: audio ? { codec: audio.codec_name, channels: Number(audio.channels) || 0 } : null,
        extraStreams: streams.length > (audio ? 2 : 1),
    };
}
function isCoverArt(s) {
    return s.disposition && s.disposition.attached_pic === 1;
}

/** 'none' when the file already plays everywhere, 'remux' when only the container is wrong,
 *  'transcode' otherwise. `ext` is the upload's extension, lower-case, without the dot. */
function conversionNeeded(info, ext) {
    if (!info) return 'transcode';
    const v = info.video;
    const streamsPlayable = PLAYABLE_VIDEO.has(v.codec)
        && PLAYABLE_H264_PROFILES.has(v.profile)
        && PLAYABLE_PIX_FMTS.has(v.pixFmt)
        && (!info.audio || PLAYABLE_AUDIO.has(info.audio.codec))
        && !info.extraStreams
        && Math.max(v.width, v.height) <= 1920 * 2;   // 4K and above is re-encoded down
    if (!streamsPlayable) return 'transcode';
    return MP4_CONTAINERS.has(ext) ? 'none' : 'remux';
}

function scaleFilter() {
    return `scale='min(${MAX_SIDE},iw)':'min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
}

function ffmpegArgs(mode, src, dst) {
    const common = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
        '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1'];
    const out = ['-movflags', '+faststart', '-f', 'mp4', dst];
    if (mode === 'remux') return [...common, '-c', 'copy', ...out];
    return [...common,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.1',
        '-pix_fmt', 'yuv420p', '-vf', scaleFilter(), '-threads', '1',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-max_muxing_queue_size', '1024',
        ...out];
}

// Run ffmpeg politely: lowest CPU priority, first in line for the OOM killer, one thread.
function runFfmpeg(args, { timeoutMs = TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const wrappers = [];
        if (process.platform === 'linux') {
            wrappers.push('nice', '-n', '19');
            if (fs.existsSync('/usr/bin/choom')) wrappers.push('choom', '-n', '900', '--');
        }
        const [cmd, ...rest] = [...wrappers, FFMPEG, ...args];
        const child = spawn(cmd, rest, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg ${signal ? `killed by ${signal}` : `exit ${code}`}: ${stderr.trim().slice(0, 500)}`));
        });
    });
}

/** Convert `src` into a universally playable mp4 at `dst`. Tries a remux first when the
 *  streams are already right; falls back to a full transcode if that fails. Resolves with
 *  the mode used; rejects when nothing worked (dst is removed). */
async function convert(src, dst, mode, runner = runFfmpeg) {
    const modes = mode === 'remux' ? ['remux', 'transcode'] : ['transcode'];
    let lastErr = null;
    for (const m of modes) {
        try {
            await runner(ffmpegArgs(m, src, dst));
            const st = await fs.promises.stat(dst);
            if (st.size > 0) return m;
            lastErr = new Error('ffmpeg wrote an empty file');
        } catch (err) {
            lastErr = err;
        }
        await fs.promises.unlink(dst).catch(() => {});
    }
    throw lastErr || new Error('conversion failed');
}

/** Jobs run one after another; a rejected job does not stop the queue. */
function createQueue() {
    let tail = Promise.resolve();
    let pending = 0;
    return {
        add(job) {
            pending++;
            const run = tail.then(job).catch((err) => { console.error('video conversion:', err && err.message); })
                .finally(() => { pending--; });
            tail = run;
            return run;
        },
        get pending() { return pending; },
    };
}

/** Name of the playable file for an upload: <base>-web.mp4 next to it. */
function outputPathFor(src) {
    const dir = path.dirname(src);
    const base = path.basename(src).replace(/\.[A-Za-z0-9]+$/, '');
    return path.join(dir, `${base}-web.mp4`);
}

/** A 24-px blurred JPEG of the first frame as a data URI, the placeholder an image bubble gets
 *  from sharp, so the box is not blank while the browser fetches the metadata. null on failure. */
function posterPlaceholder(filePath) {
    return new Promise((resolve) => {
        execFile(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', '0.3', '-i', filePath, '-frames:v', '1',
            '-vf', "scale='min(24,iw)':'min(24,ih)':force_original_aspect_ratio=decrease", '-c:v', 'mjpeg', '-q:v', '12', '-f', 'image2pipe', 'pipe:1'],
        { timeout: 20000, encoding: 'buffer', maxBuffer: 1024 * 1024 }, (err, stdout) => {
            if (err || !stdout || stdout.length < 100 || stdout.length > 8000) return resolve(null);
            resolve('data:image/jpeg;base64,' + stdout.toString('base64'));
        });
    });
}

function toolsAvailable() {
    return new Promise((resolve) => {
        execFile(FFPROBE, ['-version'], { timeout: 5000 }, (err) => resolve(!err));
    });
}

module.exports = {
    probe, summarize, conversionNeeded, ffmpegArgs, runFfmpeg, convert, createQueue,
    outputPathFor, posterPlaceholder, toolsAvailable, MAX_SIDE, TIMEOUT_MS,
};
