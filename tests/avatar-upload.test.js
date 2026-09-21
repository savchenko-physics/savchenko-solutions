// Receiving a profile picture — avatar.js acceptAvatarFile / avatarUploadProblem, and the
// multer configuration index.js builds from them.
//
// Guards 2026-09-21: the owner chose a new photo on /ru/settings?tab=profile and nothing
// could be saved. Two faults sat behind that. The settings page left the file input out
// of its "has anything changed" snapshot, so a chosen photo never enabled the Save button
// (that half lives in the template's script and is checked by hand in a browser). And the
// route accepted at most 5 MB, less than a phone photo, and let multer's LIMIT_FILE_SIZE
// fall through to the 500 page, so the one person who did get a photo submitted saw the
// site break. The route now answers those two refusals with the form's own message, and
// this file pins what it classifies as the person's doing and what stays a server fault.
//
// No database: the route handler itself is not run. What is run is multer with the same
// filter and limit, over a real HTTP request, so the error codes are the ones multer emits
// rather than ones this file assumes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const multer = require('multer');

const { acceptAvatarFile, avatarUploadProblem, MAX_UPLOAD_BYTES } = require('../avatar');

// ── The filter ────────────────────────────────────────────────────────────────

test('a jpeg, png, gif or webp with a matching type is accepted', () => {
    for (const [name, type] of [['me.jpg', 'image/jpeg'], ['me.JPEG', 'image/pjpeg'], ['me.png', 'image/png'],
        ['me.gif', 'image/gif'], ['me.webp', 'image/webp']]) {
        assert.equal(acceptAvatarFile({ originalname: name, mimetype: type }), null, name);
    }
});

test('a file with no type from the browser is judged by its extension', () => {
    assert.equal(acceptAvatarFile({ originalname: 'photo.jpg', mimetype: '' }), null);
    assert.equal(acceptAvatarFile({ originalname: 'photo.jpg' }), null);
    assert.equal(acceptAvatarFile({ originalname: 'cv.pdf' }).code, 'AVATAR_NOT_IMAGE');
});

test('a document, an svg or an image with a lying extension is refused by name', () => {
    for (const file of [
        { originalname: 'cv.pdf', mimetype: 'application/pdf' },
        { originalname: 'logo.svg', mimetype: 'image/svg+xml' },
        { originalname: 'photo.jpg', mimetype: 'text/html' },
        { originalname: 'photo.heic', mimetype: 'image/heic' },
        { originalname: '', mimetype: 'image/jpeg' },
    ]) {
        const err = acceptAvatarFile(file);
        assert.ok(err instanceof Error, JSON.stringify(file));
        assert.equal(err.code, 'AVATAR_NOT_IMAGE');
    }
});

// ── The classification ────────────────────────────────────────────────────────

test('the two things a person can do wrong are named; everything else is a fault', () => {
    assert.equal(avatarUploadProblem({ code: 'LIMIT_FILE_SIZE' }), 'tooLarge');
    assert.equal(avatarUploadProblem({ code: 'AVATAR_NOT_IMAGE' }), 'notImage');
    assert.equal(avatarUploadProblem(new Error('ENOSPC: no space left on device')), null);
    assert.equal(avatarUploadProblem({ code: 'LIMIT_UNEXPECTED_FILE' }), null);
    assert.equal(avatarUploadProblem(null), null);
    assert.equal(avatarUploadProblem(undefined), null);
});

test('the ceiling is above a phone photo', () => {
    assert.ok(MAX_UPLOAD_BYTES >= 10 * 1024 * 1024, 'a camera JPEG is 3–8 MB; the old 5 MB refused them');
});

// ── multer, for real ──────────────────────────────────────────────────────────
// The same configuration as index.js, minus the diskStorage destination, over HTTP.

async function receive(fileName, mimeType, bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-upload-'));
    const upload = multer({
        storage: multer.diskStorage({ destination: dir, filename: (req, file, cb) => cb(null, 'out') }),
        limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
        fileFilter: (req, file, cb) => {
            const problem = acceptAvatarFile(file);
            if (problem) return cb(problem);
            cb(null, true);
        },
    });
    const app = express();
    app.post('/p', (req, res) => {
        upload.single('profilePicture')(req, res, (err) => {
            res.json({ problem: avatarUploadProblem(err), fault: Boolean(err && !avatarUploadProblem(err)), got: Boolean(req.file) });
        });
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const boundary = 'b' + Date.now();
        const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fullName"\r\n\r\nA\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="profilePicture"; filename="${fileName}"\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`);
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([head, bytes, tail]);
        return await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port: server.address().port, path: '/p', method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
            }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve(JSON.parse(data)));
            });
            req.on('error', reject);
            req.end(body);
        });
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('a photo under the ceiling arrives', async () => {
    const r = await receive('me.jpg', 'image/jpeg', Buffer.alloc(2 * 1024 * 1024, 1));
    assert.deepEqual(r, { problem: null, fault: false, got: true });
});

test('a photo over the ceiling is "tooLarge", not a fault', async () => {
    const r = await receive('me.jpg', 'image/jpeg', Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1));
    assert.deepEqual(r, { problem: 'tooLarge', fault: false, got: false });
});

test('a pdf is "notImage", not a fault', async () => {
    const r = await receive('cv.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    assert.deepEqual(r, { problem: 'notImage', fault: false, got: false });
});

// ── Must never ────────────────────────────────────────────────────────────────

test('must never: classify a real fault as the person\'s doing', () => {
    for (const err of [new Error('EACCES'), Object.assign(new Error('x'), { code: 'ENOENT' }),
        Object.assign(new Error('x'), { code: 'LIMIT_PART_COUNT' })]) {
        assert.equal(avatarUploadProblem(err), null);
    }
});
