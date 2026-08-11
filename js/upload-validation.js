/* What is actually missing from the upload form, and what merely deserves a warning.
 *
 * Split out of views/upload_page.ejs so it can be tested, because the thing it replaces
 * was the single most-reported defect on this site. The Submit button used to be
 * `disabled = !isValid` against a six-term boolean, and the page never said which term
 * failed. Two of those terms could not be satisfied by the person at all:
 *
 *   - a problem that already had a solution produced `.text-warning`, which is neither
 *     `.text-success` nor `.text-info`, so the button was dead forever — that is exactly
 *     "when you pick an unsolved problem from the statistics window, submit is not
 *     active" (2025-04-15) and "I wrote random text in the LaTeX field, the send button
 *     is still not active" (2026-05-22);
 *   - a failed /api/verify-problem request produced `.text-danger` and the same dead
 *     button, which is what a slow or filtered connection looks like.
 *
 * Seven people reported this across five countries in eighteen months. One of them got
 * past it by running `btn.disabled = false; btn.click()` in the browser console. Nine
 * more gave up and emailed their solutions as PDF and JPG attachments.
 *
 * The rule here: only refuse for something the browser can be certain about on its own.
 * Anything that needs the server's opinion is a warning — the server validates all of it
 * again on POST (upload.js:68-92) and says why, so a wrong or unreachable answer here can
 * delay an upload but must never make one impossible.
 *
 * Loaded by the browser and require()d by tests/editor-drafts.test.js.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.UploadValidation = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const PROBLEM_FORMAT = /^\d+\.\d+\.\d+$/;

    /* state: {
     *   problemName, method ('scans'|'latex'|null), language ('en'|'ru'|null),
     *   scanCount, latexLength, needsFullName, fullName,
     *   problemStatus ('ok'|'exists'|'other-lang'|'limit'|'format'|'error'|'pending'|'none')
     * }
     * -> { blocking: [code], warnings: [code] }
     */
    function missingUploadFields(state) {
        const s = state || {};
        const blocking = [];
        const warnings = [];

        const problemName = String(s.problemName || '').trim();
        if (!problemName) blocking.push('problem_missing');
        else if (!PROBLEM_FORMAT.test(problemName)) blocking.push('problem_format');

        if (s.method !== 'scans' && s.method !== 'latex') blocking.push('method_missing');
        if (s.language !== 'en' && s.language !== 'ru') blocking.push('language_missing');

        if (s.method === 'scans' && !(Number(s.scanCount) > 0)) blocking.push('scans_missing');
        if (s.method === 'latex' && !(Number(s.latexLength) > 0)) blocking.push('latex_missing');

        if (s.needsFullName && !String(s.fullName || '').trim()) blocking.push('name_missing');

        // Everything below is the server's call, so it informs but never refuses.
        if (s.problemStatus === 'exists') warnings.push('problem_exists');
        else if (s.problemStatus === 'other-lang') warnings.push('problem_other_lang');
        else if (s.problemStatus === 'limit') warnings.push('problem_limit');
        else if (s.problemStatus === 'error') warnings.push('status_unknown');
        else if (s.problemStatus === 'pending') warnings.push('status_pending');

        return { blocking: blocking, warnings: warnings };
    }

    function canSubmit(state) {
        return missingUploadFields(state).blocking.length === 0;
    }

    return {
        PROBLEM_FORMAT: PROBLEM_FORMAT,
        missingUploadFields: missingUploadFields,
        canSubmit: canSubmit,
    };
});
