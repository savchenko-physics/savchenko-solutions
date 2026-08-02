/**
 * recommendations.test.js — safety and quality gates for the published catalog.
 *
 * Follows the precedent set by tests/external-assets.test.js: a policy that
 * matters is enforced as a test, not as a note in a document.
 *
 * Two of these gates guard against real incidents rather than hypotheticals:
 *
 *   - The research corpus this catalog is built from contains 733 live Apify API
 *     tokens, a GitHub session cookie, and private founder data. A directory walk
 *     instead of an allowlist would sweep them into the artifact.
 *   - It also contains 1,423 private Telegram invite links — live join-tokens to
 *     closed school cohorts and university department chats. Publishing one is a
 *     privacy incident, and the file that lists them reads exactly like a
 *     directory, which is what makes it dangerous.
 *
 * The last gate is a regression test against the failure that motivated the whole
 * rebuild: the corpus's original taxonomy had `stem` and `physics` true for all
 * 728 channels, `olympiad` identical to `physics_olympiad`, and `research`
 * identical to `physics_research`. Facets like that cannot produce distinct
 * results, so the build must never ship them again.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CATALOG = path.join(__dirname, '..', 'data', 'recommendations.json');

/** Overlap above this within one facet means two tags are returning one list. */
const MAX_JACCARD = 0.6;
/** A facet value covering more than this share of entries carries no information. */
const MAX_VALUE_SHARE = 0.95;

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

function loadCatalog() {
    if (!fs.existsSync(CATALOG)) return null;
    return JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
}

const entriesOf = (catalog) => [
    ...(catalog.telegram?.entries || []),
    ...(catalog.websites?.entries || []),
];

// The catalog is a build artifact, so it may legitimately be absent in a fresh
// checkout. Skip rather than fail, but never silently pass a present-but-bad one.
const catalog = loadCatalog();
const maybe = catalog ? test : test.skip;

test('catalog artifact is present or explicitly absent', () => {
    if (!catalog) {
        console.log('  data/recommendations.json not built — run scripts/build-recommendations.js');
    }
    assert.ok(true);
});

maybe('contains no credentials', () => {
    const raw = fs.readFileSync(CATALOG, 'utf8');
    for (const [label, re] of [
        ['Anthropic API key', /sk-ant-[A-Za-z0-9_\-]{8,}/],
        ['Apify API token', /apify_api_[A-Za-z0-9]{8,}/],
        ['AWS access key', /AKIA[0-9A-Z]{16}/],
        ['generic bearer secret', /whsec_[A-Za-z0-9]{16,}/],
    ]) {
        const hit = raw.match(re);
        assert.strictEqual(hit, null, `${label} leaked into the catalog: ${hit && hit[0].slice(0, 12)}...`);
    }
});

maybe('contains no private Telegram invite links', () => {
    const raw = fs.readFileSync(CATALOG, 'utf8');
    // Public channels are t.me/<username>. Private invites are t.me/+<hash> or
    // the legacy t.me/joinchat/<hash>; both are join-tokens, not addresses.
    for (const re of [/t\.me\/\+/, /joinchat/i]) {
        assert.strictEqual(raw.match(re), null,
            'a private invite link reached the catalog — these are live join-tokens to closed groups');
    }
});

maybe('references no private founder data', () => {
    const raw = fs.readFileSync(CATALOG, 'utf8');
    assert.strictEqual(raw.match(/00_internal/), null,
        'catalog references the private 00_internal/ corpus directory');
});

maybe('every entry carries an id, a link and a summary', () => {
    const entries = entriesOf(catalog);
    assert.ok(entries.length > 0, 'catalog has no entries');
    for (const e of entries) {
        assert.ok(e.id, 'entry missing id');
        assert.ok(e.url, `entry ${e.id} missing url`);
        assert.ok((e.summaryRu || '').trim() || (e.summaryEn || '').trim(),
            `entry ${e.id} has no summary in either language`);
    }
});

maybe('every assigned tag is backed by evidence', () => {
    const missing = entriesOf(catalog)
        .filter((e) => e.rubric && !(e.evidence || '').trim() && !e.lowConfidence)
        .map((e) => e.id);
    assert.strictEqual(missing.length, 0,
        `${missing.length} entries carry a rubric with no supporting quote: ${missing.slice(0, 5).join(', ')}`);
});

maybe('rendered titles carry no emoji', () => {
    const bad = entriesOf(catalog)
        .filter((e) => EMOJI_RE.test(e.title || '') || EMOJI_RE.test(e.summaryRu || '') || EMOJI_RE.test(e.summaryEn || ''))
        .map((e) => e.id);
    assert.strictEqual(bad.length, 0,
        `emoji survived into ${bad.length} entries (design system forbids them): ${bad.slice(0, 5).join(', ')}`);
});

maybe('excluded clusters are actually excluded', () => {
    const entries = entriesOf(catalog);
    const ids = new Set(entries.map((e) => String(e.id).toLowerCase()));

    // Pseudoscience and scam. ssgeosurvey is the 15th-largest channel in the raw
    // set, which is exactly why it is named here rather than left to a heuristic.
    for (const banned of ['ssgeosurvey', 'ssgeos_edu', 'chogrbe', 'oseniloaether',
        'net8_token', 'qgph_en', 'qgph_ru', 'prism_of_perception']) {
        assert.ok(!ids.has(banned), `pseudoscience entry "${banned}" is in the catalog`);
    }
    // Broken: a bot, and a dead self-destructing channel.
    for (const broken of ['physics17_bot', 'bioelectromagnetic']) {
        assert.ok(!ids.has(broken), `broken entry "${broken}" is in the catalog`);
    }
    // Non-STEM. Kept out by policy: the user's rule is that STEM stays in its own
    // labelled rubric and everything else goes.
    for (const offtopic of ['gleb_solomin', 'swedishjobs', 'quantumiasofficial']) {
        assert.ok(!ids.has(offtopic), `non-STEM entry "${offtopic}" is in the catalog`);
    }
});

maybe('no partitioning facet is near-constant', () => {
    // Applies to facets whose job is to CARVE the catalog into comparable groups.
    // If one value covers nearly everything, the facet cannot separate results —
    // which is what went wrong in the corpus's own taxonomy, where `stem` and
    // `physics` were true for all 728 channels.
    //
    // Deliberately excludes `format`. It is a capability flag, not a partition:
    // only 22 of 600 entries are groups you can actually post in, and that 4%
    // minority is the entire answer to "where can I ask a question". Rarity there
    // is the signal, not a defect — a scarce-but-meaningful value is the opposite
    // of a constant one.
    const entries = entriesOf(catalog);
    for (const facet of ['rubric', 'level', 'language']) {
        const counts = new Map();
        let total = 0;
        for (const e of entries) {
            const v = e[facet];
            if (v == null || v === '') continue;
            counts.set(v, (counts.get(v) || 0) + 1);
            total += 1;
        }
        if (total < 20) continue;
        for (const [value, n] of counts) {
            const share = n / total;
            assert.ok(share <= MAX_VALUE_SHARE,
                `facet "${facet}" value "${value}" covers ${(share * 100).toFixed(1)}% of entries `
                + '— a near-constant facet carries no information and cannot separate results');
        }
    }
});

maybe('capability facets retain a usable minority', () => {
    // The complementary check: a capability flag is broken when it is empty or
    // absolute, not when it is rare.
    const entries = entriesOf(catalog);
    const counts = new Map();
    for (const e of entries) if (e.format) counts.set(e.format, (counts.get(e.format) || 0) + 1);
    if (counts.size === 0) return;
    assert.ok(counts.size >= 2,
        'format collapsed to a single value — the "can I post here?" distinction is gone');
    const askable = counts.get('group') || 0;
    assert.ok(askable > 0,
        'no discussion groups survived — students would have nowhere to ask a question');
});

maybe('no two tags within a facet return the same set', () => {
    const entries = entriesOf(catalog);
    const facets = { rubric: new Map(), level: new Map(), topic: new Map() };

    for (const e of entries) {
        for (const [facet, bucket] of Object.entries(facets)) {
            const values = facet === 'topic' ? (e.topics || []) : (e[facet] ? [e[facet]] : []);
            for (const v of values) {
                if (!bucket.has(v)) bucket.set(v, new Set());
                bucket.get(v).add(e.id);
            }
        }
    }

    for (const [facet, bucket] of Object.entries(facets)) {
        const tags = [...bucket.entries()].filter(([, set]) => set.size >= 5);
        for (let i = 0; i < tags.length; i += 1) {
            for (let j = i + 1; j < tags.length; j += 1) {
                const [aName, a] = tags[i];
                const [bName, b] = tags[j];
                let inter = 0;
                for (const id of a) if (b.has(id)) inter += 1;
                const jaccard = inter / (a.size + b.size - inter);
                assert.ok(jaccard <= MAX_JACCARD,
                    `${facet} tags "${aName}" and "${bName}" overlap at Jaccard ${jaccard.toFixed(2)} `
                    + `(limit ${MAX_JACCARD}) — they are one tag wearing two names`);
            }
        }
    }
});

maybe('general-audience entries are quarantined out of specific rubrics', () => {
    // The whole point of the genericity flag: a Forbes-30-under-30 entrepreneur
    // podcast must not sit in the same rubric as a paper feed.
    const leaked = entriesOf(catalog)
        .filter((e) => e.generic && e.rubric && e.rubric !== 'general')
        .map((e) => e.id);
    assert.strictEqual(leaked.length, 0,
        `${leaked.length} general-audience entries leaked into specific rubrics: ${leaked.slice(0, 5).join(', ')}`);
});
