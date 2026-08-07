#!/usr/bin/env node
/**
 * promote-uncrawled.js — admit sites our crawler never reached but the physics
 * web plainly relies on.
 *
 * Some domains are cited by a dozen or more crawled physics sites and yet
 * produced zero pages for us: artofproblemsolving.com (12 citations),
 * ipho-new.org (15, the official IPhO site), caltech.edu (18), imomath.com.
 * They block automated fetches, or they moved, or our crawl simply failed. None
 * of that is evidence the site is useless — and excluding them left the catalog
 * missing resources its readers already use.
 *
 * The blind audit in audit-inclusion.js scored them on merit, so inclusion is
 * decided. What is NOT decided is what the catalog may SAY about them. Every
 * other entry's description is grounded in crawled page text; for these there is
 * nothing to ground in. So this pass writes identity-only descriptions — what
 * the resource IS, the kind of fact that is stable public knowledge — and
 * forbids any claim about coverage, depth, or quality, which is exactly the
 * distinction verify-summaries.js already enforces catalog-wide.
 *
 * Output is a small overrides file that corpus.js reads as a last-resort
 * description source, so these entries then flow through the normal pipeline
 * rather than becoming a parallel code path.
 *
 * Usage: node scripts/promote-uncrawled.js --budget 0.06
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { Client, chunk, mapLimit } = require('./lib/anthropic');

const STATE = path.join(__dirname, '..', 'data', '.build');
const AUDIT = path.join(STATE, 'websites-audit.json');
const OUT = path.join(__dirname, '..', 'data', 'uncrawled-descriptions.json');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };

/** Merit floor, matching the gate applied in build-recommendations.js. */
const FLOOR = 30;

const SYSTEM = `You write one-line catalog entries for well-known websites.

For each domain you are told how many crawled physics sites link to it and why an earlier reviewer judged it worth including. You have no page text — the site blocked our crawler.

Write summary_en and summary_ru saying ONLY what the resource is: its name, who runs it, and what kind of material it holds. One sentence each, plain and concrete.

Because nobody has verified this site's contents, you must not claim anything about how complete, detailed, extensive, or high-quality its material is. Do not write "полный", "подробный", "обширный", "лучший", "comprehensive", "detailed", "extensive", "the best". Do not claim it covers any named textbook in full. Do not invent specific features, section names, or problem counts.

Write what is stable public knowledge about the site's identity, nothing more. If you do not actually know the site, set known to false and leave the summaries empty rather than guessing.`;

const SCHEMA = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    i: { type: 'integer' },
                    known: { type: 'boolean' },
                    summary_en: { type: 'string' },
                    summary_ru: { type: 'string' },
                },
                required: ['i', 'known', 'summary_en', 'summary_ru'],
                additionalProperties: false,
            },
        },
    },
    required: ['results'],
    additionalProperties: false,
};

(async () => {
    const budget = parseFloat(arg('--budget', '0.06'));
    const { judged } = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));

    const targets = judged.filter((j) => (j.status === 'skipped_no_evidence' || j.status === 'dropped_dead')
        && j.verdict === 'include' && j.score >= FLOOR);
    targets.sort((a, b) => b.score - a.score);

    console.log(`${targets.length} uncrawled sites cleared the merit floor:`);
    for (const t of targets) console.log(`  ${String(t.score).padStart(3)}  ${t.domain.padEnd(28)} ${t.reason.slice(0, 56)}`);
    if (!targets.length) return;

    const client = new Client({ apiKey: process.env.ANTHROPIC_API_KEY, budget });
    const batches = chunk(targets, 10);
    const results = await mapLimit(batches, 4, async (batch) => {
        const user = batch.map((t, n) => `### ${n + 1}
domain: ${t.domain}
linked to by: ${t.citedBy} crawled physics sites
reviewer's note: ${t.reason}`).join('\n\n');
        const out = await client.json({
            system: SYSTEM,
            user: `Write entries for these ${batch.length} sites. One result per site by 1-based \`i\`.\n\n${user}`,
            schema: SCHEMA,
            maxTokens: 160 * batch.length,
        });
        return { batch, out };
    });

    const overrides = {};
    let unknown = 0;
    for (const r of results) {
        if (!r || r.__error) { console.log(`  ! batch failed: ${r?.__error}`); continue; }
        const byIndex = new Map((r.out.results || []).map((x) => [x.i, x]));
        r.batch.forEach((t, n) => {
            const v = byIndex.get(n + 1);
            if (!v || !v.known || !v.summary_en) { unknown += 1; return; }
            overrides[t.domain] = {
                summaryEn: v.summary_en.trim(),
                summaryRu: v.summary_ru.trim(),
                citedBy: t.citedBy,
                // Recorded so the entry can never be mistaken for a crawled one,
                // and so a later crawl fix can supersede it.
                source: 'uncrawled_identity',
            };
        });
    }

    fs.writeFileSync(OUT, JSON.stringify(overrides, null, 1));
    console.log(`\nwrote ${Object.keys(overrides).length} overrides to ${path.relative(process.cwd(), OUT)}`
        + (unknown ? ` (${unknown} skipped as unrecognised)` : ''));
    for (const [d, o] of Object.entries(overrides)) console.log(`  ${d.padEnd(26)} ${o.summaryEn.slice(0, 72)}`);
    console.log(`\nspend: $${client.report().spent.toFixed(4)}`);
})();
