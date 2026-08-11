/* Pure decision logic for the solution editor's drafts.
 *
 * Lives in js/ and is loaded by the browser, but also require()d by index.js and by
 * tests/editor-drafts.test.js. That is deliberate: the client decides which of three
 * copies of a solution to open, and the server decides whether a submitted copy is
 * actually a change. Both questions are "are these two texts the same?", and if the two
 * sides ever disagreed about the answer the editor would either lose work or record
 * phantom edits. One definition, one file.
 *
 * No DOM, no fetch, no storage access — all of that lives in views/edit_post.ejs.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DraftState = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const SOURCE_FILE = 'file';
    const SOURCE_SERVER = 'server';
    const SOURCE_LOCAL = 'local';

    /* Only the differences a text editor or an HTTP round trip introduces on its own:
     * line endings, and whether the last line has a terminator. Everything else is left
     * byte-exact — trailing spaces are meaningful in markdown, and silently "fixing"
     * them would make a real edit look like a no-op and get dropped. */
    function normalizeContent(text) {
        if (typeof text !== 'string') return '';
        return text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    }

    function isSameContent(a, b) {
        return normalizeContent(a) === normalizeContent(b);
    }

    function isBlank(text) {
        return typeof text !== 'string' || text.trim() === '';
    }

    function toTime(value) {
        if (value === null || value === undefined) return 0;
        if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    /* Which text should the editor open?
     *
     * Three copies can exist: the published file, the draft on the server, and the draft
     * in this browser's localStorage (the one that survives a dead network). The newest
     * wins, but a draft only counts if it says something the published file does not AND
     * was written after the file was last published — otherwise reopening a solution to
     * fix a typo would resurrect a stale draft over someone's published work.
     *
     * Ties go to the server copy: it is the one that is true on every device.
     */
    function pickEditorContent(input) {
        const opts = input || {};
        const fileContent = typeof opts.fileContent === 'string' ? opts.fileContent : '';
        const fileTime = toTime(opts.fileModifiedAt);

        const candidates = [];
        const consider = (draft, source) => {
            if (!draft || isBlank(draft.content)) return;
            if (isSameContent(draft.content, fileContent)) return;
            const savedAt = toTime(draft.savedAt);
            if (savedAt <= fileTime) return;
            candidates.push({ content: draft.content, source: source, savedAt: savedAt });
        };

        consider(opts.serverDraft, SOURCE_SERVER);
        consider(opts.localDraft, SOURCE_LOCAL);

        if (!candidates.length) {
            return { content: fileContent, source: SOURCE_FILE, savedAt: null };
        }

        // Stable: `consider` ran server-first, so an exact tie keeps the server copy.
        candidates.sort((a, b) => b.savedAt - a.savedAt);
        return candidates[0];
    }

    return {
        SOURCE_FILE: SOURCE_FILE,
        SOURCE_SERVER: SOURCE_SERVER,
        SOURCE_LOCAL: SOURCE_LOCAL,
        normalizeContent: normalizeContent,
        isSameContent: isSameContent,
        pickEditorContent: pickEditorContent,
    };
});
