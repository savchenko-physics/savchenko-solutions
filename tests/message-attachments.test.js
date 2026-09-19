// What the chats accept as an attachment, and how large: lib/messageAttachments.js.
//
// Asked in the Russian community chat on 2026-09-19: "видео файлы можно в чате высылать?
// ограничений на размер есть?" Until then a video was refused outright ("File type not allowed"),
// and the 25 MB ceiling was written in three places (multer, the alert, the input's accept list)
// that could disagree. Now one module answers both questions and the page renders from it.
//
// Not covered: the upload itself (multer, the disk check) and the bubble markup, which need a
// request and a browser; the rules those apply are what is tested here.

const test = require('node:test');
const assert = require('node:assert');
const a = require('../lib/messageAttachments');

test('a video plays inline, a document is a card, markup is never accepted', () => {
    assert.equal(a.kindOf('IMG_0042.MOV'), 'video');
    assert.equal(a.kindOf('screen.mp4'), 'video');
    assert.equal(a.kindOf('clip.webm'), 'video');
    assert.equal(a.kindOf('film.m4v'), 'video');
    assert.equal(a.kindOf('obs.mkv'), 'file');           // accepted, but a download card
    assert.equal(a.kindOf('old.avi'), 'file');
    assert.equal(a.kindOf('photo.JPG'), 'image');
    assert.equal(a.kindOf('notes.pdf'), 'file');
    for (const bad of ['page.html', 'x.htm', 'icon.svg', 'run.js', 'data.xml', 'noext', '', 'a.mp4.exe']) {
        assert.equal(a.kindOf(bad), null, bad);
        assert.equal(a.isAccepted(bad), false, bad);
        assert.equal(a.limitFor(bad), 0, bad);
    }
});

test('videos get the video limit, everything else the file limit', () => {
    assert.equal(a.limitFor('a.mov'), a.VIDEO_MAX_BYTES);
    assert.equal(a.limitFor('a.mkv'), a.VIDEO_MAX_BYTES);
    assert.equal(a.limitFor('a.png'), a.MAX_BYTES);
    assert.equal(a.limitFor('a.zip'), a.MAX_BYTES);
    assert.ok(a.VIDEO_MAX_BYTES > a.MAX_BYTES);
    assert.equal(a.MAX_BYTES, 25 * 1024 * 1024);
    assert.equal(a.VIDEO_MAX_BYTES, 100 * 1024 * 1024);
});

test('the accept list names every accepted extension and nothing else', () => {
    const accept = a.acceptAttribute().split(',');
    assert.deepEqual(accept.slice(0, 2), ['image/*', 'video/*']);
    const exts = accept.slice(2).map((x) => x.replace(/^\./, ''));
    assert.deepEqual(new Set(exts), new Set(a.ALL_EXTENSIONS));
    for (const ext of exts) assert.ok(a.isAccepted(`f.${ext}`), ext);
});

test('what the page receives is the same rule set', () => {
    const rules = a.clientRules();
    assert.equal(rules.maxBytes, a.MAX_BYTES);
    assert.equal(rules.videoMaxBytes, a.VIDEO_MAX_BYTES);
    assert.deepEqual([...rules.image, ...rules.video, ...rules.videoFile, ...rules.other], a.ALL_EXTENSIONS);
    assert.ok(JSON.stringify(rules).length < 1000);
});
