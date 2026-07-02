// Focused unit tests for the Brainstorm Room backend's pure logic.
//
// The project has no test framework configured (package.json `test` was a
// placeholder). Rather than add a dependency (Jest), these use Node's built-in
// `node:test` runner: `npm test` (or `node --test tests/`).
//
// Coverage gap (noted intentionally): the DB-backed route handlers in
// brainstorm.js are not integration-tested here because there is no test
// database/harness in the project. The riskiest *pure* logic — the wiki-link
// parser that feeds the cross-reference graph — is fully covered below.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseProblemLinks, ALLOWED_REACTIONS } = require('../brainstorm');

test('descriptive link [text](#x.y.z) yields target + descriptive text', () => {
    const out = parseProblemLinks('Use [the relativistic Doppler trick](#7.3.6) here.');
    assert.deepEqual(out, [{ targetProblemName: '7.3.6', linkText: 'the relativistic Doppler trick' }]);
});

test('bare mention #x.y.z yields target with "#x.y.z" as text', () => {
    const out = parseProblemLinks('See #2.4.44 for the same subtlety.');
    assert.deepEqual(out, [{ targetProblemName: '2.4.44', linkText: '#2.4.44' }]);
});

test('two-digit chapter/section/problem ids are matched', () => {
    const out = parseProblemLinks('Compare #14.5.24 and [hard one](#10.2.11).');
    assert.deepEqual(out, [
        { targetProblemName: '14.5.24', linkText: '#14.5.24' },
        { targetProblemName: '10.2.11', linkText: 'hard one' },
    ]);
});

test('a number inside a descriptive link is NOT double-counted as a bare mention', () => {
    const out = parseProblemLinks('[see the energy argument](#6.4.7)');
    assert.deepEqual(out, [{ targetProblemName: '6.4.7', linkText: 'see the energy argument' }]);
});

test('mixed descriptive + bare links are both captured, in order', () => {
    const out = parseProblemLinks('Start from [CoM frame idea](#6.4.7); contrast with #2.4.44.');
    assert.deepEqual(out, [
        { targetProblemName: '6.4.7', linkText: 'CoM frame idea' },
        { targetProblemName: '2.4.44', linkText: '#2.4.44' },
    ]);
});

test('exact duplicate links are de-duplicated', () => {
    const out = parseProblemLinks('#1.1.1 and again #1.1.1');
    assert.deepEqual(out, [{ targetProblemName: '1.1.1', linkText: '#1.1.1' }]);
});

test('same target with different display text is kept as two links', () => {
    const out = parseProblemLinks('[first phrasing](#1.1.1) vs [second phrasing](#1.1.1)');
    assert.deepEqual(out, [
        { targetProblemName: '1.1.1', linkText: 'first phrasing' },
        { targetProblemName: '1.1.1', linkText: 'second phrasing' },
    ]);
});

test('a "#" glued to a word char is not a problem link', () => {
    assert.deepEqual(parseProblemLinks('issue123#1.2.3'), []);
});

test('plain numbers, @mentions and prose are not mistaken for links', () => {
    assert.deepEqual(parseProblemLinks('At t = 1.2.3 s, ask @astrosander about version 2.0.'), []);
});

test('empty / non-string input returns an empty array', () => {
    assert.deepEqual(parseProblemLinks(''), []);
    assert.deepEqual(parseProblemLinks(null), []);
    assert.deepEqual(parseProblemLinks(undefined), []);
    assert.deepEqual(parseProblemLinks(42), []);
});

test('the reaction set is exactly the six chat reactions', () => {
    assert.equal(ALLOWED_REACTIONS.length, 6);
    assert.deepEqual(ALLOWED_REACTIONS, ['\u{1F44D}', '\u{1F44E}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F622}', '\u{1F914}']);
});
