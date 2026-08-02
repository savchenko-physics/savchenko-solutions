#!/usr/bin/env node
/**
 * tag-websites.js — describe and cluster the website corpus.
 *
 * Mirrors scripts/discover-taxonomy.js, with one difference: websites already
 * carry usable prose. 93% of the 986 kept candidates have a description from one
 * of the research registries, so there is no need to re-read the 26 GB of crawled
 * pages — the existing note plus the site's own classification is enough input.
 *
 * Websites are clustered SEPARATELY from Telegram. Problem archives, textbook
 * solution sets and simulation tools have no Telegram analogue, and Telegram has
 * study chats and admissions channels the web corpus lacks. Forcing one rubric set
 * onto both would blur exactly the distinctions this catalog exists to draw.
 *
 * Usage: node scripts/tag-websites.js --budget 1.20
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const corpus = require('./lib/corpus');
const { Client, BudgetExceeded, mapLimit, chunk } = require('./lib/anthropic');

const STATE = path.join(__dirname, '..', 'data', '.build');
const PASS1 = path.join(STATE, 'websites-pass1.json');
const OUT = path.join(STATE, 'websites-taxonomy.json');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
const has = (f) => process.argv.includes(f);

const ITEMS_PER_REQUEST = 20;
const CONCURRENCY = 6;
const MEMBER_FLOOR = 10;

const DESCRIBE_SYSTEM = `You describe physics websites for a catalog aimed at secondary-school and first-year university students across the former USSR who are working through a hard physics problem book and preparing for olympiads and university entrance.

You are given each site's domain, its category from a prior classification, and a short note about it. Judge from that.

For each item return:
- purpose: a short lowercase English noun phrase naming what a reader GETS from this site. Write what you observe, in your own words, not from a fixed list. Be specific enough that sites with different purposes get different phrases.
- summary_en / summary_ru: one plain sentence each. Concrete, no marketing language. summary_ru must read as natural Russian.
  Say only what the note supports. Do NOT add claims about how complete, detailed or authoritative the
  content is — no "полный", "исчерпывающий", "подробные решения", "все задачи", "лучший", "complete",
  "comprehensive" — unless the note says so. Nobody has checked those, and the catalog must not assert them.
  Stating what a site IS (an official society page, a university portal) is fine.
- topics: physics subfields the site concentrates on. LEAVE EMPTY unless genuinely concentrated. Most sites get zero or one.
- level: the audience it addresses.
- useful_to_students: false if this is an institution homepage, a news outlet, a paper repository, a vendor, or infrastructure rather than something a student would actually study from.`;

const DESCRIBE_SCHEMA = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    i: { type: 'integer' },
                    purpose: { type: 'string' },
                    summary_en: { type: 'string' },
                    summary_ru: { type: 'string' },
                    topics: {
                        type: 'array',
                        items: {
                            type: 'string',
                            enum: ['astronomy', 'quantum', 'mechanics', 'electromagnetism',
                                'thermodynamics', 'condensed_matter', 'particle_nuclear',
                                'relativity_gravitation', 'optics', 'mathematical_methods',
                                'computational'],
                        },
                    },
                    level: { type: 'string', enum: ['school', 'exam_prep', 'olympiad', 'undergraduate', 'research', 'mixed'] },
                    useful_to_students: { type: 'boolean' },
                },
                required: ['i', 'purpose', 'summary_en', 'summary_ru', 'topics', 'level', 'useful_to_students'],
                additionalProperties: false,
            },
        },
    },
    required: ['results'],
    additionalProperties: false,
};

const CLUSTER_SYSTEM = `You are designing the top-level rubrics for the WEBSITES half of a physics resource catalog, in the spirit of an old-style web directory.

You will be given the observed purposes of every site, each with how many sites share it. Group them into rubrics.

Requirements:
- Every rubric must be a distinct REASON A READER WOULD OPEN THE LINK. Two rubrics that would return overlapping sets are one rubric — merge them.
- Derive rubrics from what you are shown. Do not import a standard list.
- Readers are secondary-school and first-year university students in the former USSR working a hard physics problem book. Their strongest need is MORE PROBLEMS, then worked solutions to the other standard textbooks, then theory. Rubrics should carve the corpus in ways useful to them.
- Mark serves_core_audience false for rubrics that exist mainly to keep material out of the others.
- Give each rubric an id (lowercase, underscores), an English name, and a Russian name.

Aim for the number the data supports — likely 5 to 10.`;

const RUBRIC_SCHEMA = {
    type: 'object',
    properties: {
        rubrics: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' }, name_en: { type: 'string' }, name_ru: { type: 'string' },
                    definition: { type: 'string' }, serves_core_audience: { type: 'boolean' },
                },
                required: ['id', 'name_en', 'name_ru', 'definition', 'serves_core_audience'],
                additionalProperties: false,
            },
        },
    },
    required: ['rubrics'],
    additionalProperties: false,
};

const ASSIGN_SCHEMA = {
    type: 'object',
    properties: {
        assignments: {
            type: 'array',
            items: {
                type: 'object',
                properties: { i: { type: 'integer' }, rubric: { type: 'string' } },
                required: ['i', 'rubric'], additionalProperties: false,
            },
        },
    },
    required: ['assignments'], additionalProperties: false,
};

const render = (c, n) => `### ITEM ${n}
domain: ${c.domain}
classification: ${c.classifiedCategory || c.types[0] || c.categories[0] || 'unknown'}
${c.books.length ? `textbooks covered: ${c.books.join(', ')}\n` : ''}note: ${corpus.sanitizeText(c.description).slice(0, 300) || '(none)'}`;

(async () => {
    fs.mkdirSync(STATE, { recursive: true });
    const budget = parseFloat(arg('--budget', '1.20'));
    const limit = parseInt(arg('--limit', '0'), 10);
    const client = new Client({ apiKey: process.env.ANTHROPIC_API_KEY, budget });

    const graph = fs.existsSync(path.join(__dirname, '..', 'data', 'web-graph.json'))
        ? JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'web-graph.json'), 'utf8'))
        : null;
    const { kept, dropped } = corpus.loadWebsiteCandidates(corpus.DEFAULT_CORPUS, graph);

    // Only describe sites we could actually say something about. A domain with no
    // note and no classification would produce an invented description, which is
    // exactly what the evidence rule exists to prevent.
    let pool = kept.filter((c) => c.description || c.classifiedCategory || c.books.length);
    pool.sort((a, b) => (b.citedBy || 0) - (a.citedBy || 0));
    if (limit > 0) pool = pool.slice(0, limit);

    console.log(`websites: ${kept.length} kept (${dropped.excluded.length} excluded, `
        + `${dropped.dead.length} dead), ${pool.length} describable`);

    let described = [];
    if (has('--resume') && fs.existsSync(PASS1)) {
        described = JSON.parse(fs.readFileSync(PASS1, 'utf8')).described || [];
        const have = new Set(described.map((d) => d.domain));
        pool = pool.filter((c) => !have.has(c.domain));
        console.log(`  resumed: ${described.length} cached, ${pool.length} to go`);
    }

    if (pool.length) {
        const batches = chunk(pool, ITEMS_PER_REQUEST);
        let done = 0;
        const results = await mapLimit(batches, CONCURRENCY, async (batch) => {
            const out = await client.json({
                system: DESCRIBE_SYSTEM,
                user: `Describe these ${batch.length} sites. One result per item, keyed by 1-based ITEM number as \`i\`.\n\n`
                    + batch.map((c, n) => render(c, n + 1)).join('\n\n'),
                schema: DESCRIBE_SCHEMA,
                maxTokens: 260 * batch.length,
            });
            done += batch.length;
            process.stdout.write(`  described ${done}/${pool.length} | $${client.spent.toFixed(3)}\r`);
            return { batch, out };
        }).catch((e) => { if (e instanceof BudgetExceeded) { console.log(`\n${e.message}`); return []; } throw e; });
        console.log('');

        for (const r of results) {
            if (!r || r.__error) { console.log(`  ! batch failed: ${r?.__error}`); continue; }
            const byIndex = new Map((r.out.results || []).map((x) => [x.i, x]));
            r.batch.forEach((c, n) => {
                const lab = byIndex.get(n + 1);
                if (!lab) return;
                described.push({
                    domain: c.domain, url: c.url, citedBy: c.citedBy || 0, pagerank: c.pagerank || 0,
                    langs: c.langs, books: c.books, features: c.features, access: c.access || null,
                    classifiedCategory: c.classifiedCategory || null,
                    purpose: (lab.purpose || '').trim().toLowerCase(),
                    summaryEn: (lab.summary_en || '').trim(),
                    summaryRu: (lab.summary_ru || '').trim(),
                    topics: lab.topics || [], level: lab.level,
                    usefulToStudents: lab.useful_to_students,
                    evidence: corpus.sanitizeText(c.description).slice(0, 200),
                });
            });
        }
        fs.writeFileSync(PASS1, JSON.stringify({ described, spend: client.report() }, null, 1));
        console.log(`  cached ${described.length} descriptions`);
    }

    // Cluster.
    const counts = new Map();
    for (const d of described) if (d.purpose) counts.set(d.purpose, (counts.get(d.purpose) || 0) + 1);
    const phrases = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\nclustering ${phrases.length} purposes`);
    const proposed = await client.json({
        system: CLUSTER_SYSTEM,
        user: `Observed purposes across ${described.length} sites, "count<TAB>purpose". Propose rubrics only.\n\n`
            + phrases.map(([p, n]) => `${n}\t${p}`).join('\n'),
        schema: RUBRIC_SCHEMA,
        maxTokens: 3000,
    });
    const rubrics = (proposed.rubrics || []).map((r) => ({ ...r, purposes: [] }));
    console.log(`  proposed ${rubrics.length}: ${rubrics.map((r) => r.id).join(', ')}`);

    const menu = rubrics.map((r) => `${r.id}: ${r.definition}`).join('\n');
    const valid = new Map(rubrics.map((r) => [r.id, r]));
    const aRes = await mapLimit(chunk(phrases.map(([p]) => p), 40), CONCURRENCY, async (batch) => {
        const out = await client.json({
            system: 'Assign each purpose phrase to exactly one rubric id from the menu. Return the id verbatim.',
            user: `RUBRICS:\n${menu}\n\nPHRASES:\n${batch.map((p, n) => `${n + 1}. ${p}`).join('\n')}`,
            schema: ASSIGN_SCHEMA,
            maxTokens: 40 * batch.length + 200,
        });
        return { batch, out };
    });
    for (const r of aRes) {
        if (!r || r.__error) continue;
        const byIndex = new Map((r.out.assignments || []).map((a) => [a.i, a.rubric]));
        r.batch.forEach((p, n) => {
            const id = byIndex.get(n + 1);
            if (id && valid.has(id)) valid.get(id).purposes.push(p);
        });
    }

    const purposeToRubric = new Map();
    for (const r of rubrics) for (const p of r.purposes) purposeToRubric.set(p, r.id);
    const members = new Map(rubrics.map((r) => [r.id, []]));
    for (const d of described) {
        const id = purposeToRubric.get(d.purpose);
        if (id && members.has(id)) members.get(id).push(d.domain);
    }
    const survivors = rubrics.map((r) => ({ ...r, count: (members.get(r.id) || []).length }))
        .filter((r) => r.count >= MEMBER_FLOOR);
    const droppedR = rubrics.map((r) => ({ ...r, count: (members.get(r.id) || []).length }))
        .filter((r) => r.count < MEMBER_FLOOR);

    console.log(`\nearn a place (floor ${MEMBER_FLOOR}):`);
    for (const r of survivors.sort((a, b) => b.count - a.count)) {
        console.log(`  ${String(r.count).padStart(4)}  ${r.id.padEnd(30)} ${r.name_ru}`
            + (r.serves_core_audience ? '' : '   [not core]'));
    }
    if (droppedR.length) console.log(`  dropped below floor: ${droppedR.map((r) => `${r.id}(${r.count})`).join(', ')}`);

    fs.writeFileSync(OUT, JSON.stringify({
        rubrics: survivors, droppedRubrics: droppedR,
        assignments: Object.fromEntries([...members]),
        spend: client.report(),
    }, null, 1));
    const rep = client.report();
    console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
    console.log(`spend: $${rep.spent.toFixed(4)} of $${budget.toFixed(2)}`);
})();
