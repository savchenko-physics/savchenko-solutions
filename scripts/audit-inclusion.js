#!/usr/bin/env node
/**
 * audit-inclusion.js — re-judge the catalog's include/exclude boundary, blind.
 *
 * The boundary was never decided on merit. It fell out of two mechanical
 * accidents in the corpus loader:
 *
 *   1. A site was describable only if sites.yaml carried a trailing comment.
 *      164 of 369 entries have one, so pho.rs, mathus.ru, physicsforums.com and
 *      49 others were skipped despite thousands of crawled pages each.
 *   2. A registered site our crawler got zero pages from was marked dead — so
 *      mccme.ru (Kvant's host, cited by 17) and ipho-new.org (the official IPhO
 *      site, cited by 15) were discarded because of a fetch failure on our end.
 *
 * Both are fixed in corpus.js, but a fix that only rescues the sites I happened
 * to notice is not a boundary — it is a longer list of accidents. So this pass
 * scores every domain the loader saw, whatever bucket it landed in, on one
 * scale.
 *
 * It is deliberately BLIND: the model is never told whether a site is currently
 * in the catalog. Otherwise it would ratify the existing split, which is the one
 * thing this pass exists to test. Every site is described from the same raw
 * evidence — the corpus note or crawled page text, never a summary an earlier
 * model pass wrote — so included and excluded sites compete on equal footing.
 *
 * `basis` separates two very different grounds for inclusion. "evidence" means
 * the supplied text supports the verdict. "prior_knowledge" means the model is
 * going on what it knows about the domain because our crawl produced nothing —
 * legitimate for deciding whether artofproblemsolving.com belongs in a physics
 * olympiad catalog, but not a licence to write a description we cannot source.
 * Those entries get identity-only descriptions downstream.
 *
 * Usage: node scripts/audit-inclusion.js --budget 0.55 [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const corpus = require('./lib/corpus');
const { Client, mapLimit, chunk } = require('./lib/anthropic');

const STATE = path.join(__dirname, '..', 'data', '.build');
const OUT = path.join(STATE, 'websites-audit.json');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
const has = (f) => process.argv.includes(f);

/**
 * The audience, as measured — not as imagined. These numbers come from 21 months
 * of GA4/Metrika on savchenkosolutions.com and from its outbound click log; they
 * are what makes this a catalog for a specific reader rather than a directory of
 * physics-adjacent domains.
 */
const AUDIENCE = `The readers are visitors to savchenkosolutions.com, a site of worked solutions to Savchenko's physics problem book (2023 problems, olympiad difficulty).

Measured facts about them:
- Overwhelmingly Russian-speaking, across the post-Soviet space: Russia 30.7%, Belarus 4.7%, Kazakhstan 4.6%, Ukraine 1.8%, Uzbekistan, Kyrgyzstan. The most engaged are NOT in Russia — Kyrgyzstan averages 841s per session against Russia's 395s.
- Secondary-school and first-year university students preparing for physics olympiads and university entrance, working through a hard problem book largely alone.
- 57.8% of their pageviews are solution pages. Site search is essentially unused: they browse, they do not query.
- What they actually click on the way out, in order: problem PDFs (savchenko.pdf 2220, belphol long-problem sets 669), Kvant on kvant.mccme.ru (340), problem archives (physprob 207), Telegram channels (219), pho.rs (91), mathus.ru olympiad theory notes (86).

Their priority of need, highest first: (1) more problems, (2) solutions to the other standard books (Irodov, Чертов, Волькенштейн, Савельев), (3) olympiad preparation, (4) university admission, (5) somewhere to ask a question, (6) theory and reference.`;

const SYSTEM = `You are deciding which websites belong in a physics resource catalog.

${AUDIENCE}

For each site you get its domain, whatever the research corpus recorded about it, how many other crawled physics sites link to it, and how many of its pages were crawled.

Return for each:

- score: 0-100, how useful this site is to the reader above. Anchor the scale:
    90+  a resource they would use directly and repeatedly — problem archives with solutions, olympiad past papers, the standard textbook solution sites, Kvant.
    70-89 strongly useful — national olympiad sites, serious theory references, active physics Q&A communities, high-quality lecture notes.
    50-69 useful in a narrower way — general reference wikis, simulation and visualisation tools, exam-prep portals for one country.
    30-49 marginal — university department pages, publisher and society sites, science news.
    10-29 off-topic for this reader — general news, shopping, jobs, unrelated academia.
    0-9   actively bad — AI answer-generator spam, pirated textbook mirrors, pseudoscience, dead or parked domains.
- verdict: "include" or "exclude". Exclude anything under 30, anything that exists to sell AI-generated answers, anything pirated, and anything that is not science.
- basis: "evidence" if the supplied text is what convinced you; "prior_knowledge" if the supplied text is empty or uninformative and you are going on what you already know about this domain; "none" if you have neither and are guessing.
- reason: one short clause. State the concrete thing the site offers, not an adjective.

Judge the site, not the quality of our notes. Crawl statistics describe our crawler, not the site: zero pages crawled often means the site blocked us. A domain you recognise as a major physics or olympiad resource should score on what it is, with basis "prior_knowledge".

Be honest about ignorance. If the evidence is empty and the domain means nothing to you, use basis "none" and a low-confidence score rather than inventing a plausible purpose.`;

const SCHEMA = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    i: { type: 'integer' },
                    score: { type: 'integer' },
                    verdict: { type: 'string', enum: ['include', 'exclude'] },
                    basis: { type: 'string', enum: ['evidence', 'prior_knowledge', 'none'] },
                    reason: { type: 'string' },
                },
                required: ['i', 'score', 'verdict', 'basis', 'reason'],
                additionalProperties: false,
            },
        },
    },
    required: ['results'],
    additionalProperties: false,
};

/** Deterministic order, so a resumed or repeated run batches items identically. */
function shuffleKey(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

/** The raw corpus evidence — never a summary an earlier model pass produced. */
function evidenceFor(c) {
    const bits = [];
    if (c.description) bits.push(String(c.description).replace(/\s+/g, ' ').trim().slice(0, 240));
    if (c.classifiedCategory) bits.push(`category: ${c.classifiedCategory}`);
    if (c.books && c.books.length) bits.push(`textbook solutions: ${c.books.slice(0, 4).join(', ')}`);
    if (c.access) bits.push(`access: ${c.access}`);
    return bits.join(' | ') || '(nothing recorded)';
}

(async () => {
    const budget = parseFloat(arg('--budget', '0.55'));
    const graph = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'web-graph.json'), 'utf8'));
    const { kept, dropped } = corpus.loadWebsiteCandidates(corpus.DEFAULT_CORPUS, graph);

    // Every bucket, tagged with where it currently sits. The tag is for the
    // report at the end; it is never sent to the model.
    const universe = [];
    const seen = new Set();
    const add = (c, status) => {
        if (!c || !c.domain || seen.has(c.domain)) return;
        seen.add(c.domain);
        universe.push({ ...c, status });
    };
    for (const c of kept) {
        const describable = c.description || c.classifiedCategory || (c.books && c.books.length);
        add(c, describable ? 'in_catalog' : 'skipped_no_evidence');
    }
    for (const c of (dropped.dead || [])) add(c, 'dropped_dead');
    for (const c of (dropped.excluded || [])) add(c, 'dropped_excluded');

    universe.sort((a, b) => shuffleKey(a.domain) - shuffleKey(b.domain));

    const byStatus = universe.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m; }, {});
    console.log(`auditing ${universe.length} domains:`, byStatus);

    if (has('--dry-run')) {
        console.log(`[dry-run] ~${Math.ceil(universe.length / 14)} requests, projected ~$${(universe.length * 0.00036).toFixed(2)}`);
        return;
    }

    const client = new Client({ apiKey: process.env.ANTHROPIC_API_KEY, budget });
    const batches = chunk(universe, 14);
    let done = 0;

    const results = await mapLimit(batches, 6, async (batch) => {
        const user = batch.map((c, n) => `### ${n + 1}
domain: ${c.domain}
linked to by: ${c.citedBy || 0} other crawled physics sites
pages we crawled: ${c.pages || 0}
recorded: ${evidenceFor(c)}`).join('\n\n');
        const out = await client.json({
            system: SYSTEM,
            user: `Score these ${batch.length} sites. One result per site, by 1-based \`i\`.\n\n${user}`,
            schema: SCHEMA,
            maxTokens: 110 * batch.length,
        });
        done += batch.length;
        process.stdout.write(`  ${done}/${universe.length}  $${client.spent.toFixed(3)}\r`);
        return { batch, out };
    });
    console.log('');

    const judged = [];
    let failed = 0;
    for (const r of results) {
        if (!r || r.__error) { failed += r?.batch?.length || 14; continue; }
        const byIndex = new Map((r.out.results || []).map((x) => [x.i, x]));
        r.batch.forEach((c, n) => {
            const v = byIndex.get(n + 1);
            if (!v) { failed += 1; return; }
            judged.push({
                domain: c.domain, url: c.url, status: c.status,
                citedBy: c.citedBy || 0, pages: c.pages || 0,
                score: v.score, verdict: v.verdict, basis: v.basis, reason: v.reason,
            });
        });
    }

    fs.writeFileSync(OUT, JSON.stringify({ judged, spend: client.report() }, null, 1));
    if (failed) console.log(`(${failed} items got no verdict)`);

    const pct = (arr, p) => {
        if (!arr.length) return 0;
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.floor((s.length - 1) * p)];
    };
    const inCat = judged.filter((j) => j.status === 'in_catalog');
    const inScores = inCat.map((j) => j.score);
    const floor = pct(inScores, 0.25);
    console.log(`\ncurrently in catalog: n=${inCat.length}  median ${pct(inScores, 0.5)}  p25 ${floor}  p10 ${pct(inScores, 0.1)}`);

    // The question this pass was run to answer: does anything outside the
    // catalog outrank the bottom quarter of what is inside it?
    const outside = judged.filter((j) => j.status !== 'in_catalog');
    const promote = outside.filter((j) => j.verdict === 'include' && j.score >= floor)
        .sort((a, b) => b.score - a.score);
    const demote = inCat.filter((j) => j.verdict === 'exclude').sort((a, b) => a.score - b.score);

    console.log(`\nOUTSIDE the catalog but scoring at or above its p25 (${floor}): ${promote.length}`);
    for (const j of promote.slice(0, 45)) {
        console.log(`  ${String(j.score).padStart(3)} ${j.basis === 'evidence' ? ' ' : '~'} ${j.domain.padEnd(30)} ${j.status.padEnd(20)} ${j.reason.slice(0, 66)}`);
    }
    console.log(`\nIN the catalog but judged excludable: ${demote.length}`);
    for (const j of demote.slice(0, 30)) {
        console.log(`  ${String(j.score).padStart(3)}   ${j.domain.padEnd(30)} ${j.reason.slice(0, 76)}`);
    }
    const rep = client.report();
    console.log(`\nspend: $${rep.spent.toFixed(4)} of $${budget.toFixed(2)}  (${rep.calls} calls)`);
    console.log(`wrote ${OUT}`);
})();
