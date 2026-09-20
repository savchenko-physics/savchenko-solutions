// The problem finder's URL is its state (2026-09-14): a copied link, a reload or the back
// button must bring back the same results. The owner asked for exactly that after searches on
// /ru/problems lost the difficulty range, the chapter boxes, the solution language and the
// skill axes on reload, none of which the page wrote into its URL.
//
// js/problems-finder.js writes the link (syncUrl) and reads it back into its controls; that half
// was checked in Firefox against the local rig. What is tested here is the other reader of the
// same link, problems.js's applyFilters, which renders the first page before any script runs:
// it must understand every parameter the page writes, the way the page does.

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyFilters, COL } = require('../problems');
const { ratingToPercentileRange } = require('../lib/difficultyRating');

// [name, chapter, section, idx, starred, calibrated, estMinutes, prerequisites, canonicalTags,
//  voteAvg, voteCount, solvedEn, solvedRu, scores]
function row(name, { calibrated = 50, en = 0, ru = 0, scores = [10, 90] } = {}) {
    const r = [];
    r[COL.NAME] = name; r[COL.CHAPTER] = Number(name.split('.')[0]); r[COL.SECTION] = 1; r[COL.IDX] = 1;
    r[COL.STARRED] = 0; r[COL.CALIBRATED] = calibrated; r[COL.EST_MINUTES] = 10;
    r[COL.PREREQUISITES] = []; r[COL.CANONICAL_TAGS] = []; r[COL.VOTE_AVG] = null; r[COL.VOTE_COUNT] = 0;
    r[COL.SOLVED_EN] = en; r[COL.SOLVED_RU] = ru; r[COL.SCORES] = scores;
    return r;
}
const names = (rows) => rows.map((r) => r[COL.NAME]);
const AXES = { axisKeys: ['insight_required', 'elegance'] };

test('rating=lo-hi filters exactly as the percentiles behind those ratings', () => {
    const [lo] = ratingToPercentileRange(1200);
    const [, hi] = ratingToPercentileRange(2400);
    const rows = [row('1.1.1', { calibrated: Math.floor(lo) }), row('1.1.2', { calibrated: Math.ceil(lo) }),
        row('1.1.3', { calibrated: Math.floor(hi) }), row('1.1.4', { calibrated: Math.ceil(hi) + 1 })];
    assert.deepEqual(names(applyFilters(rows, { rating: '1200-2400' }, null, AXES)), names(applyFilters(rows, { min: String(lo), max: String(hi) }, null, AXES)));
    assert.deepEqual(names(applyFilters(rows, { rating: '2400-1200' }, null, AXES)), names(applyFilters(rows, { rating: '1200-2400' }, null, AXES)), 'handles in either order');
    assert.equal(applyFilters(rows, { rating: '800-3500' }, null, AXES).length, 4, 'the full scale filters nothing');
});

test('solved=en|ru|none, bookmarked=1 and ax_<axis>=lo-hi filter on the server as in the page', () => {
    const rows = [row('1.1.1', { en: 1, scores: [20, 80] }), row('1.1.2', { ru: 1, scores: [70, 30] }), row('1.1.3', { scores: null })];
    assert.deepEqual(names(applyFilters(rows, { solved: 'en' }, null, AXES)), ['1.1.1']);
    assert.deepEqual(names(applyFilters(rows, { solved: 'ru' }, null, AXES)), ['1.1.2']);
    assert.deepEqual(names(applyFilters(rows, { solved: 'none' }, null, AXES)), ['1.1.3']);
    assert.deepEqual(names(applyFilters(rows, { ax_elegance: '40-100' }, null, AXES)), ['1.1.1']);
    assert.deepEqual(names(applyFilters(rows, { ax_insight_required: '0-50' }, null, AXES)), ['1.1.1', '1.1.3'], 'unscored rows stay when the range starts at 0, as in the page');
    assert.deepEqual(names(applyFilters(rows, { bookmarked: '1' }, null, { ...AXES, bookmarked: new Set(['1.1.2']) })), ['1.1.2']);
    assert.equal(applyFilters(rows, { ax_elegance: 'nonsense', solved: 'fr' }, null, AXES).length, 3, 'a malformed link filters nothing rather than everything');
});

test('rated=1 keeps the problems readers have rated, and no others', () => {
    const rows = [row('1.1.1'), row('1.1.2'), row('1.1.3')];
    rows[1][COL.VOTE_AVG] = 7.5; rows[1][COL.VOTE_COUNT] = 3;
    assert.deepEqual(names(applyFilters(rows, { rated: '1' }, null, AXES)), ['1.1.2']);
    assert.equal(applyFilters(rows, { rated: '0' }, null, AXES).length, 3, 'only "1" is the switch');
});
