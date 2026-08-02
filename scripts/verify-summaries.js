#!/usr/bin/env node
/**
 * verify-summaries.js — remove unverifiable claims from catalog descriptions.
 *
 * The problem this fixes, concretely: easy-physic.ru was described as a
 * "Полный решебник к сборнику задач О.Я. Савченко". Its source note in the
 * research corpus says only "direct Savchenko O.Ya. решебник" — the words
 * "полный" and the olympiad framing were added by the describing model. Nobody
 * checked whether that site's coverage is complete, so the catalog should not
 * say it is.
 *
 * Measured across the corpus, 19.3% of summaries (180 of 934) contain a
 * confidence word absent from their source. But they are not all wrong: calling
 * aps.org "the official site of the American Physical Society" is simply true,
 * and stripping every qualifier would flatten accurate descriptions into mush.
 *
 * So the rule enforced here is narrower than "no adjectives":
 *
 *   - Claims of IDENTITY are fine when they are common knowledge
 *     ("официальный сайт МФО", "Ведущий российский университет").
 *   - Claims about the COMPLETENESS, DEPTH or QUALITY of a resource's content
 *     are not, unless the source says so — "полный", "исчерпывающий",
 *     "подробные решения", "лучший", "все задачи".
 *
 * A second model pass decides which is which and rewrites only the offenders,
 * because the distinction needs judgement rather than a word list.
 *
 * Usage: node scripts/verify-summaries.js --budget 0.40 [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { Client, mapLimit, chunk } = require('./lib/anthropic');

const STATE = path.join(__dirname, '..', 'data', '.build');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
const has = (f) => process.argv.includes(f);

/** Words that assert completeness, depth or primacy of the CONTENT. */
const CLAIM_WORDS = [
    ['полн', /\bcomplete\b|\bfull\b/i],
    ['исчерпыв', /\bexhaustive\b/i],
    ['всеобъемл', /\bcomprehensive\b/i],
    ['подробн', /\bdetailed\b|\bthorough\b|\bworked\b/i],
    ['лучш', /\bbest\b/i],
    ['крупнейш', /\blargest\b|\bbiggest\b/i],
    ['ведущ', /\bleading\b|\bforemost\b/i],
    ['официальн', /\bofficial\b/i],
    ['главн', /\bmain\b|\bprimary\b/i],
    ['все задач', /\ball problems\b/i],
];

function ungroundedClaim(summaryRu, summaryEn, source) {
    const sum = `${summaryRu || ''} ${summaryEn || ''}`.toLowerCase();
    const src = String(source || '').toLowerCase();
    for (const [ru, en] of CLAIM_WORDS) {
        const inSummary = sum.includes(ru) || en.test(sum);
        if (!inSummary) continue;
        const inSource = src.includes(ru) || en.test(src);
        if (!inSource) return ru;
    }
    return null;
}

const SCHEMA = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    i: { type: 'integer' },
                    verdict: { type: 'string', enum: ['keep', 'rewrite'] },
                    summary_ru: { type: 'string' },
                    summary_en: { type: 'string' },
                },
                required: ['i', 'verdict', 'summary_ru', 'summary_en'],
                additionalProperties: false,
            },
        },
    },
    required: ['results'],
    additionalProperties: false,
};

const SYSTEM = `You are checking catalog descriptions for claims nobody verified.

Each item gives a domain, the source note the description was written from, and the description.

Decide between:
- "keep" — the description asserts only the site's IDENTITY or subject, and that assertion is either in the source note or is uncontroversial public knowledge. Calling aps.org the official site of the American Physical Society, or MEPhI a leading Russian university, is fine.
- "rewrite" — the description claims something about the COMPLETENESS, DEPTH, or QUALITY of the site's content that the source note does not support. Examples that must be rewritten: "полный решебник" when the source says only that solutions exist; "подробные решения" when the source does not mention how detailed they are; "все задачи"; "лучший"; claims that a site covers a named textbook in full.

When rewriting, return a description that says only what the source supports. Keep the same language, one sentence each, plain and concrete, no marketing tone. Never add facts. If in doubt, write less.

Always return both summary_ru and summary_en: unchanged when the verdict is "keep", corrected when it is "rewrite".`;

(async () => {
    const budget = parseFloat(arg('--budget', '0.40'));
    const dryRun = has('--dry-run');
    const p1 = path.join(STATE, 'websites-pass1.json');
    if (!fs.existsSync(p1)) { console.error('run scripts/tag-websites.js first'); process.exit(1); }

    const payload = JSON.parse(fs.readFileSync(p1, 'utf8'));
    const described = payload.described || [];

    const flagged = described.filter((d) => ungroundedClaim(d.summaryRu, d.summaryEn, d.evidence));
    console.log(`${described.length} descriptions, ${flagged.length} carry an ungrounded claim `
        + `(${(100 * flagged.length / described.length).toFixed(1)}%)`);
    if (dryRun) {
        flagged.slice(0, 15).forEach((d) => console.log(`  ${d.domain}: ${d.summaryRu.slice(0, 80)}`));
        console.log(`\n[dry-run] projected spend ~$${(flagged.length * 0.0009).toFixed(2)}`);
        return;
    }
    if (!flagged.length) return;

    const client = new Client({ apiKey: process.env.ANTHROPIC_API_KEY, budget });
    const batches = chunk(flagged, 12);
    let done = 0;
    const results = await mapLimit(batches, 5, async (batch) => {
        const user = batch.map((d, n) => `### ITEM ${n + 1}
domain: ${d.domain}
source note: ${d.evidence || '(none)'}
description RU: ${d.summaryRu}
description EN: ${d.summaryEn}`).join('\n\n');
        const out = await client.json({
            system: SYSTEM,
            user: `Check these ${batch.length} descriptions. One result per item by 1-based \`i\`.\n\n${user}`,
            schema: SCHEMA,
            maxTokens: 220 * batch.length,
        });
        done += batch.length;
        process.stdout.write(`  checked ${done}/${flagged.length} | $${client.spent.toFixed(3)}\r`);
        return { batch, out };
    });
    console.log('');

    let rewritten = 0;
    const samples = [];
    for (const r of results) {
        if (!r || r.__error) { console.log(`  ! batch failed: ${r?.__error}`); continue; }
        const byIndex = new Map((r.out.results || []).map((x) => [x.i, x]));
        r.batch.forEach((d, n) => {
            const v = byIndex.get(n + 1);
            if (!v || v.verdict !== 'rewrite') return;
            if (samples.length < 10) samples.push([d.domain, d.summaryRu, v.summary_ru]);
            d.summaryRu = (v.summary_ru || d.summaryRu).trim();
            d.summaryEn = (v.summary_en || d.summaryEn).trim();
            d.verified = true;
            rewritten += 1;
        });
    }

    fs.writeFileSync(p1, JSON.stringify(payload, null, 1));
    console.log(`rewritten ${rewritten} of ${flagged.length} flagged; ${flagged.length - rewritten} judged fine as written`);
    console.log('\nexamples:');
    for (const [dom, before, after] of samples) {
        console.log(`  ${dom}\n    was: ${before.slice(0, 96)}\n    now: ${after.slice(0, 96)}`);
    }
    const rep = client.report();
    console.log(`\nspend: $${rep.spent.toFixed(4)} of $${budget.toFixed(2)}`);
})();
