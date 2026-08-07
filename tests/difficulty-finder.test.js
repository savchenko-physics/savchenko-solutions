/**
 * difficulty-finder.test.js — regression guards for the difficulty methodology
 * page and problem finder (lib/difficultyAxes.js, lib/ruPlural.js,
 * data/topic-taxonomy.json).
 *
 * The axis-completeness test is what makes lib/difficultyAxes.js's job durable:
 * without it, adding a 23rd axis to difficultyRubric.js without writing its label
 * and explanation would silently render a blank row on the methodology page
 * instead of failing a test.
 *
 * The taxonomy tests follow the precedent in tests/recommendations.test.js: skip
 * when the build artifact is absent (it's a build artifact, not always present in
 * a fresh checkout), never silently pass a present-but-bad one.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { AXIS_KEYS } = require('../difficultyRubric');
const { AXIS_META, AXIS_BY_KEY, label, explain, axesByCategory } = require('../lib/difficultyAxes');
const { ruPlural, ruVotes } = require('../lib/ruPlural');

test('every difficultyRubric axis has a complete difficultyAxes entry', () => {
    for (const key of AXIS_KEYS) {
        const a = AXIS_BY_KEY.get(key);
        assert.ok(a, `missing lib/difficultyAxes.js entry for axis "${key}"`);
        assert.ok(a.labelEn && a.labelEn.trim(), `${key}: empty labelEn`);
        assert.ok(a.labelRu && a.labelRu.trim(), `${key}: empty labelRu`);
        assert.ok(a.explainEn && a.explainEn.trim(), `${key}: empty explainEn`);
        assert.ok(a.explainRu && a.explainRu.trim(), `${key}: empty explainRu`);
        assert.ok(['headline', 'cost', 'shape', 'reward'].includes(a.category), `${key}: bad category "${a.category}"`);
    }
    // And nothing in difficultyAxes.js that difficultyRubric.js doesn't know about.
    assert.strictEqual(AXIS_META.length, AXIS_KEYS.length, 'difficultyAxes.js has axes not in difficultyRubric.js (or vice versa)');
});

test('axis categories match the documented 1 headline / 9 cost / 5 shape / 7 reward split', () => {
    assert.strictEqual(axesByCategory('headline').length, 1);
    assert.strictEqual(axesByCategory('cost').length, 9);
    assert.strictEqual(axesByCategory('shape').length, 5);
    assert.strictEqual(axesByCategory('reward').length, 7);
});

test('label()/explain() fall back to the key for an unknown axis rather than throwing', () => {
    assert.strictEqual(label('not_a_real_axis', 'en'), 'not_a_real_axis');
    assert.strictEqual(explain('not_a_real_axis', 'en'), '');
});

test('ruPlural picks the correct Russian plural form (mod10/mod100 rule)', () => {
    const cases = [
        [1, 'голос'], [2, 'голоса'], [3, 'голоса'], [4, 'голоса'],
        [5, 'голосов'], [10, 'голосов'],
        [11, 'голосов'], [12, 'голосов'], [14, 'голосов'],
        [21, 'голос'], [22, 'голоса'], [25, 'голосов'],
        [101, 'голос'], [111, 'голосов'],
    ];
    for (const [n, expected] of cases) {
        assert.strictEqual(ruPlural(n, 'голос', 'голоса', 'голосов'), expected, `n=${n}`);
    }
});

test('ruVotes formats with the count prefixed', () => {
    assert.strictEqual(ruVotes(1), '1 голос');
    assert.strictEqual(ruVotes(21), '21 голос');
    assert.strictEqual(ruVotes(11), '11 голосов');
});

// ── topic taxonomy (data/topic-taxonomy.json) — build artifact, may be absent ──
const TAXONOMY_PATH = path.join(__dirname, '..', 'data', 'topic-taxonomy.json');
function loadTaxonomy() {
    if (!fs.existsSync(TAXONOMY_PATH)) return null;
    return JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
}
const taxonomy = loadTaxonomy();
const maybe = taxonomy ? test : test.skip;

test('topic taxonomy artifact is present or explicitly absent', () => {
    if (!taxonomy) {
        console.log('  data/topic-taxonomy.json not built — run scripts/canonicalize-tags.js --taxonomy-only');
    }
    assert.ok(true);
});

maybe('taxonomy has a LeetCode-sized tag count (50-90), matching the finder brief', () => {
    assert.ok(taxonomy.tags.length >= 50 && taxonomy.tags.length <= 90,
        `expected 50-90 tags, got ${taxonomy.tags.length}`);
});

maybe('taxonomy keys are unique', () => {
    const keys = taxonomy.tags.map((t) => t.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'duplicate tag keys found');
});

maybe('every tag has a snake_case key and both language labels', () => {
    for (const t of taxonomy.tags) {
        assert.match(t.key, /^[a-z][a-z0-9_]*$/, `bad key "${t.key}"`);
        assert.ok(t.labelEn && t.labelEn.trim(), `${t.key}: empty labelEn`);
        assert.ok(t.labelRu && t.labelRu.trim(), `${t.key}: empty labelRu`);
        assert.ok(t.description && t.description.trim(), `${t.key}: empty description`);
    }
});
