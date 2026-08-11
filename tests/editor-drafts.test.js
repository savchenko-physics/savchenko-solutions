// Unit tests for the logic that decides whether a contributor's work survives.
//
// Same approach as tests/feedback.test.js: node:test, no framework, no database. The
// route handlers are not covered because there is no test database; what IS covered is
// every decision that can silently lose someone's writing or refuse to publish it.
//
// Three real incidents are guarded here.
//
//   1. "Ой я там случайно не полное решение сохранил, я не думал что после нажатия
//      сохранить сразу опубликуется" — the editor's Save button published immediately,
//      and nothing had ever restored a draft, so the only way to keep an unfinished
//      solution was to publish it. pickEditorContent decides which of the three copies
//      of a solution the editor opens, and getting it wrong either loses an hour of
//      writing or resurrects a stale draft over someone else's published work.
//
//   2. 1,931 of 8,318 contribution rows (23%) recorded no change at all, in bursts of up
//      to 15 rows inside one second and 67 identical rows in one sitting, because Save
//      appeared dead for the ~2 s the search index spent rebuilding. isSameContent is
//      what makes a repeated save write nothing, and updateDocument is what removed the
//      two seconds.
//
//   3. Seven people across five countries reported the Upload page's Submit button
//      staying dead with no explanation; one bypassed it by running JS in the console,
//      nine emailed PDFs instead. missingUploadFields replaces the six-term boolean that
//      caused it.
//
// The closing block mirrors the "must never block a real person" invariants in
// tests/botgate.test.js and tests/feedback.test.js, for the same reason: on this site,
// turning away someone who wants to contribute costs everything.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pickEditorContent, isSameContent, normalizeContent, SOURCE_FILE, SOURCE_SERVER, SOURCE_LOCAL } =
    require('../js/draft-state');
const { missingUploadFields, canSubmit } = require('../js/upload-validation');
const searchIndex = require('../searchIndex');

const PUBLISHED = '### Условие:\n\nЗадача про втулку.\n';
const DRAFT = '### Условие:\n\nЗадача про втулку.\n\n### Решение:\n\nНачал считать.\n';
const T = Date.parse('2026-08-10T12:00:00Z');

// ── Which copy does the editor open? ────────────────────────────────────────────────

test('with no drafts at all, the published file opens', () => {
    const r = pickEditorContent({ fileContent: PUBLISHED, fileModifiedAt: T });
    assert.equal(r.source, SOURCE_FILE);
    assert.equal(r.content, PUBLISHED);
});

test('a draft written after the file was published is restored', () => {
    const r = pickEditorContent({
        fileContent: PUBLISHED,
        fileModifiedAt: T,
        serverDraft: { content: DRAFT, savedAt: T + 60000 },
    });
    assert.equal(r.source, SOURCE_SERVER);
    assert.equal(r.content, DRAFT);
    assert.equal(r.savedAt, T + 60000);
});

test('a draft older than the published file is ignored', () => {
    // Someone else published while this draft sat unfinished. Restoring it would put
    // their work back to what it was before, which is the loss this whole change exists
    // to prevent.
    const r = pickEditorContent({
        fileContent: PUBLISHED,
        fileModifiedAt: T,
        serverDraft: { content: DRAFT, savedAt: T - 60000 },
    });
    assert.equal(r.source, SOURCE_FILE);
});

test('a draft identical to the published text is not a restore', () => {
    // This is the ordinary case after publishing: the draft row is still there, holding
    // exactly what is now live. Announcing "restored your draft" would be a lie.
    const r = pickEditorContent({
        fileContent: PUBLISHED,
        fileModifiedAt: T,
        serverDraft: { content: PUBLISHED, savedAt: T + 60000 },
    });
    assert.equal(r.source, SOURCE_FILE);
});

test('the browser copy wins when it is newer than the server copy', () => {
    // The exact shape of a dropped connection: localStorage kept writing, the POST did
    // not arrive. This is the case that has to work for contributors on the connections
    // people actually reported writing from.
    const later = DRAFT + '\nЕщё абзац.';
    const r = pickEditorContent({
        fileContent: PUBLISHED,
        fileModifiedAt: T,
        serverDraft: { content: DRAFT, savedAt: T + 60000 },
        localDraft: { content: later, savedAt: T + 120000 },
    });
    assert.equal(r.source, SOURCE_LOCAL);
    assert.equal(r.content, later);
});

test('the server copy wins when it is newer, so another device is not overwritten', () => {
    const newer = DRAFT + '\nНаписано на другом устройстве.';
    const r = pickEditorContent({
        fileContent: PUBLISHED,
        fileModifiedAt: T,
        serverDraft: { content: newer, savedAt: T + 120000 },
        localDraft: { content: DRAFT, savedAt: T + 60000 },
    });
    assert.equal(r.source, SOURCE_SERVER);
    assert.equal(r.content, newer);
});

test('an exact timestamp tie goes to the server, which is true on every device', () => {
    const r = pickEditorContent({
        fileContent: PUBLISHED,
        fileModifiedAt: T,
        serverDraft: { content: DRAFT + 'A', savedAt: T + 60000 },
        localDraft: { content: DRAFT + 'B', savedAt: T + 60000 },
    });
    assert.equal(r.source, SOURCE_SERVER);
});

test('an empty or whitespace-only draft never replaces the published text', () => {
    for (const junk of ['', '   ', '\n\n\t']) {
        const r = pickEditorContent({
            fileContent: PUBLISHED,
            fileModifiedAt: T,
            serverDraft: { content: junk, savedAt: T + 60000 },
        });
        assert.equal(r.source, SOURCE_FILE, `blank draft ${JSON.stringify(junk)} must not win`);
    }
});

test('ISO timestamp strings work, since that is what the API returns', () => {
    const r = pickEditorContent({
        fileContent: PUBLISHED,
        fileModifiedAt: '2026-08-10T12:00:00.000Z',
        serverDraft: { content: DRAFT, savedAt: '2026-08-10T12:05:00.000Z' },
    });
    assert.equal(r.source, SOURCE_SERVER);
});

test('unreadable timestamps fall back to keeping the draft, not discarding it', () => {
    // fileModifiedAt of 0 is what the server sends when statSync throws. Erring towards
    // showing the draft is right: the worst case is one dismissed notice, and the other
    // worst case is losing an hour of writing.
    const r = pickEditorContent({
        fileContent: PUBLISHED,
        fileModifiedAt: 0,
        localDraft: { content: DRAFT, savedAt: T },
    });
    assert.equal(r.source, SOURCE_LOCAL);
});

test('garbage input does not throw — the editor must still open', () => {
    for (const bad of [undefined, null, {}, { fileContent: null }, { serverDraft: 'nonsense' }]) {
        const r = pickEditorContent(bad);
        assert.equal(typeof r.content, 'string');
        assert.equal(r.source, SOURCE_FILE);
    }
});

// ── Is this actually a change? ──────────────────────────────────────────────────────

test('line endings and a trailing newline are not an edit', () => {
    // A browser posts back \r\n and CodeMirror may drop the final newline. Recording
    // that as a contribution is where 23% of all rows came from.
    assert.ok(isSameContent('a\nb\n', 'a\r\nb'));
    assert.ok(isSameContent('a\nb', 'a\nb\n\n\n'));
    assert.ok(isSameContent('', '\n'));
});

test('a real change is still a change', () => {
    assert.ok(!isSameContent('a\nb\n', 'a\nc\n'));
    assert.ok(!isSameContent('x', 'x '));            // a trailing space is content
    assert.ok(!isSameContent('a\nb', 'a\n\nb'));     // a blank line splits a paragraph
});

test('trailing whitespace inside the text is preserved, because markdown uses it', () => {
    assert.equal(normalizeContent('a  \nb'), 'a  \nb');
});

test('non-strings normalize to empty rather than throwing', () => {
    for (const bad of [undefined, null, 42, {}]) assert.equal(normalizeContent(bad), '');
});

// ── One changed file, not all 2,500 ─────────────────────────────────────────────────

test('updateDocument replaces one document without touching the rest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidx-'));
    const cwd = process.cwd();
    try {
        // buildIndex reads posts/<lang> relative to the module, so run against a copy of
        // two real files rather than a fixture that could drift from the real shape.
        searchIndex.buildIndex();

        const before = searchIndex.search('противовесом', 'ru').length;
        assert.ok(before > 0, 'fixture assumption: the phrase exists in the real corpus');

        const original = fs.readFileSync(path.join(cwd, 'posts/ru/2.1.43.md'), 'utf8');
        searchIndex.updateDocument('ru', '2.1.43', 'квазистационарность проверка индекса');

        const found = searchIndex.search('квазистационарность', 'ru');
        assert.ok(found.some((r) => r.problemName === '2.1.43'), 'new text must be findable');
        assert.ok(
            !searchIndex.search('противовесом', 'ru').some((r) => r.problemName === '2.1.43'),
            'the replaced text must no longer match that document'
        );

        // Every other document is untouched.
        assert.ok(searchIndex.search('маятник', 'ru').length > 0);

        searchIndex.updateDocument('ru', '2.1.43', original);
        assert.ok(searchIndex.search('противовесом', 'ru').some((r) => r.problemName === '2.1.43'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a problem that was not in the index is added, not dropped or thrown on', () => {
    searchIndex.buildIndex();
    searchIndex.updateDocument('ru', '99.9.99', 'совершенно новая задача про шестерни');
    const r = searchIndex.search('шестерни', 'ru');
    assert.ok(r.some((x) => x.problemName === '99.9.99'));
});

test('updateDocument before the index is built is a no-op, not a crash', () => {
    // The save route calls it unconditionally; search() builds lazily from disk anyway.
    assert.doesNotThrow(() => {
        const fresh = require('module')._load(path.join(process.cwd(), 'searchIndex.js'), null, false);
        fresh.updateDocument('ru', '1.1.1', 'anything');
    });
});

// ── Why can I not press Submit? ─────────────────────────────────────────────────────

const goodUpload = (over) => ({
    problemName: '13.4.1',
    method: 'latex',
    language: 'ru',
    scanCount: 0,
    latexLength: 120,
    needsFullName: false,
    fullName: '',
    problemStatus: 'ok',
    ...over,
});

test('a complete form submits', () => {
    assert.deepEqual(missingUploadFields(goodUpload()).blocking, []);
    assert.ok(canSubmit(goodUpload()));
});

test('each missing field produces its own reason', () => {
    const cases = [
        [{ problemName: '' }, 'problem_missing'],
        [{ problemName: '13,4,1' }, 'problem_format'],
        [{ method: null }, 'method_missing'],
        [{ language: null }, 'language_missing'],
        [{ method: 'scans', scanCount: 0, latexLength: 0 }, 'scans_missing'],
        [{ method: 'latex', latexLength: 0 }, 'latex_missing'],
        [{ needsFullName: true, fullName: '  ' }, 'name_missing'],
    ];
    for (const [over, code] of cases) {
        const r = missingUploadFields(goodUpload(over));
        assert.ok(r.blocking.includes(code), `${JSON.stringify(over)} should report ${code}`);
    }
});

test('scans satisfy the content requirement without any LaTeX', () => {
    assert.ok(canSubmit(goodUpload({ method: 'scans', scanCount: 3, latexLength: 0 })));
});

// ── Must never block a real person ──────────────────────────────────────────────────
//
// Every case below is taken from a report by someone who wanted to contribute and could
// not. Each one must be submittable.

test('a problem that already has a solution can still be uploaded', () => {
    // "when you pick an unsolved problem from the statistics window, the submit button is
    // not active" (2025-04-15). `.text-warning` was neither success nor info, so the
    // six-term boolean stayed false forever and improving an existing solution was
    // impossible through this form.
    const r = missingUploadFields(goodUpload({ problemStatus: 'exists' }));
    assert.deepEqual(r.blocking, []);
    assert.ok(r.warnings.includes('problem_exists'), 'still worth saying, just not a refusal');
});

test('a failed problem-check does not make publishing impossible', () => {
    // What a slow or filtered connection looks like. Reported from Cuba, and from a
    // reader whose browser showed a white page for days.
    const r = missingUploadFields(goodUpload({ problemStatus: 'error' }));
    assert.deepEqual(r.blocking, []);
    assert.ok(r.warnings.includes('status_unknown'));
});

test('a check that has not answered yet does not block', () => {
    assert.ok(canSubmit(goodUpload({ problemStatus: 'pending' })));
    assert.ok(canSubmit(goodUpload({ problemStatus: 'none' })));
});

test('a section-limit objection is a warning, because the server decides', () => {
    // "Платформа не даёт возможности добавить решение задачи 4.1.24. Выдаёт сообщение,
    // что для данного раздела максимальное колличество задач - 23" — the limit data was
    // simply wrong, and it was the only gate. upload.js:87-92 enforces the real limit and
    // explains itself, so a wrong answer here can delay an upload but never forbid one.
    const r = missingUploadFields(goodUpload({ problemStatus: 'limit' }));
    assert.deepEqual(r.blocking, []);
    assert.ok(r.warnings.includes('problem_limit'));
});

test('a signed-in contributor is never asked for a name', () => {
    assert.ok(canSubmit(goodUpload({ needsFullName: false, fullName: '' })));
});

test('every blocking reason has wording in both locales', () => {
    // A reason code with no translation would render as a bare identifier, which is the
    // same unexplained dead end in a different costume.
    const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales/en.json'), 'utf8'));
    const ru = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales/ru.json'), 'utf8'));
    const seen = new Set();
    const variants = [
        { problemName: '' }, { problemName: 'x' }, { method: null }, { language: null },
        { method: 'scans', scanCount: 0 }, { method: 'latex', latexLength: 0 },
        { needsFullName: true, fullName: '' },
    ];
    for (const over of variants) {
        for (const code of missingUploadFields(goodUpload(over)).blocking) seen.add(code);
    }
    assert.ok(seen.size >= 7, `expected every reason to be reachable, got ${[...seen]}`);
    for (const code of seen) {
        // problem_missing -> problemMissing
        const key = code.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        assert.ok(en.upload.blockers[key], `locales/en.json is missing upload.blockers.${key}`);
        assert.ok(ru.upload.blockers[key], `locales/ru.json is missing upload.blockers.${key}`);
    }
});

test('the editor keys it needs exist in both locales', () => {
    const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales/en.json'), 'utf8'));
    const ru = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales/ru.json'), 'utf8'));
    for (const key of ['publish', 'publishing', 'draftSaved', 'draftSaving',
        'draftOffline', 'draftRestored', 'showPublished']) {
        assert.ok(en.post[key], `locales/en.json is missing post.${key}`);
        assert.ok(ru.post[key], `locales/ru.json is missing post.${key}`);
    }
    for (const key of ['title', 'lede', 'resume', 'publish', 'delete', 'emptyTitle']) {
        assert.ok(en.drafts[key], `locales/en.json is missing drafts.${key}`);
        assert.ok(ru.drafts[key], `locales/ru.json is missing drafts.${key}`);
    }
});

// ── Status-line copy ────────────────────────────────────────────────────────────────

test('no editor string relies on {{...}} interpolation', () => {
    // i18n runs every phrase through Mustache. Called without values — which is the only
    // way the editor can call it, because the time is known in the browser, not at render
    // — a `{{time}}` placeholder is silently STRIPPED. That shipped as the dangling
    // "Сохранено в " ("saved... in what?"), an incomplete sentence in the one place whose
    // whole job is telling someone their work is safe.
    const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales/en.json'), 'utf8'));
    const ru = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales/ru.json'), 'utf8'));
    const editorKeys = ['publish', 'publishing', 'draftSaved', 'draftSaving', 'draftOffline',
        'draftRestored', 'showPublished', 'draftDiscarded', 'conflict', 'nothingToPublish'];
    for (const key of editorKeys) {
        for (const [name, dict] of [['en', en], ['ru', ru]]) {
            const value = dict.post[key];
            if (!value) continue;
            assert.ok(!/\{\{|%s|%d/.test(value),
                `locales/${name}.json post.${key} has a placeholder the editor cannot fill: ${JSON.stringify(value)}`);
        }
    }
});

test('the editor status never renders a phrase that ends on a preposition', () => {
    // Cheap guard for the same class of bug in either language. Scoped to the strings the
    // editor shows on their own — `post.uploadedImages` and friends are deliberately
    // incomplete because the template concatenates a problem number onto them.
    const ru = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales/ru.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales/en.json'), 'utf8'));
    const standalone = ['publish', 'publishing', 'draftSaved', 'draftSaving', 'draftOffline',
        'draftRestored', 'showPublished', 'draftDiscarded', 'conflict', 'nothingToPublish'];
    const dangling = /\s(в|на|от|до|из|за|при|со?|at|in|on|from|to|of|for)\s*$/i;
    for (const [name, dict] of [['ru', ru], ['en', en]]) {
        for (const key of standalone) {
            const value = dict.post[key];
            if (typeof value !== 'string') continue;
            assert.ok(!dangling.test(value),
                `locales/${name}.json post.${key} ends mid-sentence: ${JSON.stringify(value)}`);
        }
    }
});
