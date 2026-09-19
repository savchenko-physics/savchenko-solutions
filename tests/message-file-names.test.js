// A file's name arrives as the browser sent it, in UTF-8.
//
// Browsers put the name into the multipart header as UTF-8 and busboy reads it as Latin-1, so a
// Cyrillic name reached the database as mojibake: "Савченко.pdf" was shown and offered for
// download as "Ð¡Ð°Ð²ÑÐµÐ½ÐºÐ¾.pdf" (message 1181, 2026-08-14, and every non-ASCII name before
// 2026-09-19). messages.js reads the bytes back as UTF-8 before anything else looks at the name;
// a name that really was Latin-1, which the round trip would break, is kept as it came.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The function lives in messages.js, which opens a database pool when required; take it from the source.
const src = fs.readFileSync(path.join(__dirname, '..', 'messages.js'), 'utf8');
const m = /function fixFileName[\s\S]*?\n}\n/.exec(src);
assert.ok(m, 'fixFileName is in messages.js');
const fixFileName = new Function(`${m[0]}; return fixFileName;`)();

const asLatin1 = (utf8) => Buffer.from(utf8, 'utf8').toString('latin1');

test('names browsers send come back as they were typed', () => {
    for (const name of ['Савченко.pdf', 'конспект.json', 'Задача 5.8.9 — решение.png', 'café.mov', 'Übung.mp4', '物理.pdf', 'IMG_0042.MOV']) {
        assert.equal(fixFileName(asLatin1(name)), name);
    }
});

test('a plain ASCII name or one that is already right is untouched', () => {
    assert.equal(fixFileName('plain.mp4'), 'plain.mp4');
    assert.equal(fixFileName('Савченко.pdf'), 'Савченко.pdf');
    assert.equal(fixFileName(''), '');
    assert.equal(fixFileName(undefined), '');
});

test('a name that was really Latin-1 is not mangled the other way', () => {
    assert.equal(fixFileName('résumé.pdf'), 'résumé.pdf');      // é alone is not a UTF-8 sequence
});
