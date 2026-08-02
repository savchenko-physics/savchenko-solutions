#!/usr/bin/env node
/**
 * discover-taxonomy.js — derive the catalog's rubrics FROM the corpus.
 *
 * Why this exists
 * ---------------
 * The corpus ships a taxonomy that cannot produce distinct results. Over the 728
 * published channels, `stem` and `physics` are true for all of them, `olympiad`
 * and `physics_olympiad` are the same 235 rows, `research` and `physics_research`
 * are the same 500, and `llm_category` is a pure function of the other flags. The
 * effective information is `subject` (4 values, 76% in one bucket) x `level`.
 * That is the "two tags, same result" failure already shipped, so the taxonomy is
 * rebuilt rather than extended.
 *
 * Rubrics are not asserted up front. The pipeline is:
 *
 *   1. ONE content pass per channel over posts sampled across its whole lifetime,
 *      returning a free-text purpose phrase, RU/EN summaries, sparse topics, a
 *      specificity judgement, and a verbatim evidence quote.
 *   2. Cluster the 718 free-text purposes into candidate rubrics — over the
 *      phrases alone, so the content is never re-sent.
 *   3. Earn-a-place: a rubric survives only if it clears a member floor. Anything
 *      smaller is merged or dropped.
 *
 * Sampling is strided across the archive, not recency-weighted: a channel that
 * pivoted last month should still be described by what it mostly is.
 *
 * Usage:
 *   node scripts/discover-taxonomy.js --budget 1.50
 *   node scripts/discover-taxonomy.js --limit 60 --budget 0.25   # slice
 *   node scripts/discover-taxonomy.js --resume                   # reuse cached pass 1
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const corpus = require('./lib/corpus');
const { Client, BudgetExceeded, mapLimit, chunk } = require('./lib/anthropic');

const STATE_DIR = path.join(__dirname, '..', 'data', '.build');
const PASS1 = path.join(STATE_DIR, 'telegram-pass1.json');
const OUT = path.join(STATE_DIR, 'telegram-taxonomy.json');

const arg = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? dflt : process.argv[i + 1];
};
const has = (flag) => process.argv.includes(flag);

const POSTS_PER_CHANNEL = 6;
const CHARS_PER_POST = 420;
const ITEMS_PER_REQUEST = 12;
const CONCURRENCY = 6;
/** A rubric with fewer members than this is a footnote, not a rubric. */
const MEMBER_FLOOR = 12;

// ---------------------------------------------------------------- pass 1

const DESCRIBE_SYSTEM = `You describe Telegram channels for a physics resource catalog aimed at secondary-school and first-year university students across the former USSR who are working through a hard physics problem book and preparing for olympiads and university entrance.

Judge each channel by its ACTUAL POSTS, not its title — titles are often generic, aspirational, or in another language.

For each item return:
- purpose: a short lowercase English noun phrase naming what this channel is FOR, from the reader's point of view. Write what you actually observe, in your own words. Do not pick from a list. Examples of the GRANULARITY wanted (not the vocabulary): "olympiad problem walkthroughs", "university admissions guidance", "lab seminar announcements". Be specific enough that two channels with different purposes get different phrases.
- summary_en / summary_ru: one plain sentence each, describing what a reader gets. Concrete, no marketing language, no emoji. summary_ru must be natural Russian, not a translation artifact.
- topics: physics subfields the channel actually concentrates on. LEAVE EMPTY unless the channel is genuinely concentrated — a channel covering everything gets no topic. Most channels should get zero or one.
- level: the audience it actually addresses.
- specificity: "focused" if nearly all posts serve one clear purpose; "broad" if it spans several related things; "general" if it is a general-interest or general-audience channel that merely touches physics.
- is_physics_education: false if the channel is really about something else (jobs, immigration, funding, politics, personal brand, commerce, a different science) even when physics words appear.
- evidence: one verbatim fragment from the supplied posts, under 200 characters, that justifies your purpose. Copy it exactly. If the posts do not support a confident judgement, return an empty string.`;

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
                                'computational', 'plasma', 'biophysics', 'geophysics'],
                        },
                    },
                    level: { type: 'string', enum: ['school', 'exam_prep', 'olympiad', 'undergraduate', 'research', 'mixed'] },
                    specificity: { type: 'string', enum: ['focused', 'broad', 'general'] },
                    is_physics_education: { type: 'boolean' },
                    evidence: { type: 'string' },
                },
                required: ['i', 'purpose', 'summary_en', 'summary_ru', 'topics', 'level',
                    'specificity', 'is_physics_education', 'evidence'],
                additionalProperties: false,
            },
        },
    },
    required: ['results'],
    additionalProperties: false,
};

function renderItem(entry, n) {
    const posts = entry.posts.length
        ? entry.posts.map((p) => `  [${p.date}] ${p.text.slice(0, CHARS_PER_POST)}`).join('\n')
        : '  (no post text available)';
    return `### ITEM ${n}
handle: @${entry.username}
title: ${corpus.stripEmoji(entry.title)}
bio: ${corpus.stripEmoji(entry.description).slice(0, 260) || '(none)'}
subscribers: ${entry.subscribers ?? 'unknown'} | cited by ${entry.inRefs} catalog members | ${entry.total} posts archived
posts sampled across its lifetime:
${posts}`;
}

async function runPass1(client, channels) {
    console.log(`\npass 1 — describing ${channels.length} channels from sampled posts`);
    const sampled = [];
    let thin = 0;
    for (let i = 0; i < channels.length; i += 1) {
        const ch = channels[i];
        const s = await corpus.sampleChannelPosts(ch.username, {
            count: POSTS_PER_CHANNEL, maxChars: CHARS_PER_POST,
        });
        if (s.chars < 5000) thin += 1;
        sampled.push({ ...ch, posts: s.posts, total: s.total, chars: s.chars });
        if ((i + 1) % 150 === 0) process.stdout.write(`  sampled ${i + 1}/${channels.length}\r`);
    }
    console.log(`  sampled ${sampled.length} channels (${thin} thin: under 5k chars, tagged low-confidence)`);

    const batches = chunk(sampled, ITEMS_PER_REQUEST);
    let done = 0;
    const results = await mapLimit(batches, CONCURRENCY, async (batch) => {
        const user = batch.map((e, n) => renderItem(e, n + 1)).join('\n\n');
        const out = await client.json({
            system: DESCRIBE_SYSTEM,
            user: `Describe these ${batch.length} channels. Return one result per item, keyed by its 1-based ITEM number as \`i\`.\n\n${user}`,
            schema: DESCRIBE_SCHEMA,
            maxTokens: 400 * batch.length,
        });
        done += batch.length;
        process.stdout.write(`  described ${done}/${sampled.length} | $${client.spent.toFixed(3)}\r`);
        return { batch, out };
    });
    console.log('');

    const described = [];
    for (const r of results) {
        if (!r || r.__error) { console.log(`  ! batch failed: ${r?.__error}`); continue; }
        const byIndex = new Map((r.out.results || []).map((x) => [x.i, x]));
        r.batch.forEach((entry, n) => {
            const lab = byIndex.get(n + 1);
            if (!lab) return;
            described.push({
                username: entry.username,
                title: corpus.stripEmoji(entry.title),
                subscribers: entry.subscribers,
                inRefs: entry.inRefs,
                pagerank: entry.pagerank,
                kind: entry.kind,
                messages: entry.total,
                chars: entry.chars,
                lowConfidence: entry.chars < 5000,
                purpose: (lab.purpose || '').trim().toLowerCase(),
                summaryEn: (lab.summary_en || '').trim(),
                summaryRu: (lab.summary_ru || '').trim(),
                topics: lab.topics || [],
                level: lab.level,
                specificity: lab.specificity,
                isPhysicsEducation: lab.is_physics_education,
                evidence: (lab.evidence || '').trim(),
            });
        });
    }
    return described;
}

// ---------------------------------------------------------------- pass 2

const CLUSTER_SYSTEM = `You are designing the top-level rubrics for a physics resource catalog, in the spirit of an old-style web directory.

You will be given the observed purposes of every channel in the corpus, each with how many channels share it. Group them into rubrics.

Hard requirements:
- Every rubric must be a distinct REASON A READER WOULD OPEN THE LINK. Two rubrics that would return overlapping sets of channels are one rubric — merge them.
- Derive the rubrics from what you are shown. Do not import a standard category list. If the corpus does not contain a cluster, do not invent a rubric for it.
- The readers are secondary-school and first-year university students in the former USSR working through a hard physics problem book, preparing for olympiads and university entrance. Rubrics should carve the corpus in ways that are USEFUL TO THEM. A cluster that is large but serves them poorly (institutional press releases, for example) should still be its own rubric — so it can be kept separate from the rubrics they do want — but say so.
- Give every rubric an English id (lowercase, underscores), an English name, and a Russian name.
- Assign EVERY supplied purpose phrase to exactly one rubric.
- Mark serves_core_audience false for rubrics that exist mainly to keep material out of the others.

Aim for the number of rubrics the data actually supports — likely between 5 and 12. Fewer, sharper rubrics beat more, blurrier ones.`;

const RUBRIC_SCHEMA = {
    type: 'object',
    properties: {
        rubrics: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name_en: { type: 'string' },
                    name_ru: { type: 'string' },
                    definition: { type: 'string' },
                    serves_core_audience: { type: 'boolean' },
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
                required: ['i', 'rubric'],
                additionalProperties: false,
            },
        },
    },
    required: ['assignments'],
    additionalProperties: false,
};

/**
 * Two steps, deliberately.
 *
 * Asking one call to both invent the rubrics AND list their members means the
 * response has to echo every purpose phrase back — with ~510 near-unique phrases
 * that overruns the output budget and the call dies on retry. Proposing the
 * rubrics alone is a small response; assigning phrases to them is then a cheap
 * batched pass whose output is one short line per phrase.
 */
async function runPass2(client, described) {
    const counts = new Map();
    for (const d of described) {
        if (!d.purpose) continue;
        counts.set(d.purpose, (counts.get(d.purpose) || 0) + 1);
    }
    const phrases = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\npass 2a — proposing rubrics from ${phrases.length} distinct purpose phrases`);

    const listing = phrases.map(([p, n]) => `${n}\t${p}`).join('\n');
    const proposed = await client.json({
        system: CLUSTER_SYSTEM,
        user: `Observed purposes across ${described.length} channels, as "count<TAB>purpose". `
            + `Propose the rubric set. Do not list members — assignment happens separately.\n\n${listing}`,
        schema: RUBRIC_SCHEMA,
        maxTokens: 3000,
    });
    const rubrics = (proposed.rubrics || []).map((r) => ({ ...r, purposes: [] }));
    if (!rubrics.length) throw new Error('no rubrics proposed');
    console.log(`  proposed ${rubrics.length}: ${rubrics.map((r) => r.id).join(', ')}`);

    console.log(`pass 2b — assigning ${phrases.length} phrases to rubrics`);
    const menu = rubrics.map((r) => `${r.id}: ${r.definition}`).join('\n');
    const batches = chunk(phrases.map(([p]) => p), 40);
    const valid = new Set(rubrics.map((r) => r.id));
    const byId = new Map(rubrics.map((r) => [r.id, r]));
    let assigned = 0;

    const results = await mapLimit(batches, CONCURRENCY, async (batch) => {
        const out = await client.json({
            system: 'Assign each purpose phrase to exactly one rubric id from the menu. '
                + 'Choose the rubric whose definition best matches. Return the id verbatim.',
            user: `RUBRICS:\n${menu}\n\nPHRASES:\n`
                + batch.map((p, n) => `${n + 1}. ${p}`).join('\n'),
            schema: ASSIGN_SCHEMA,
            maxTokens: 40 * batch.length + 200,
        });
        return { batch, out };
    });

    for (const r of results) {
        if (!r || r.__error) { console.log(`  ! assignment batch failed: ${r?.__error}`); continue; }
        const byIndex = new Map((r.out.assignments || []).map((a) => [a.i, a.rubric]));
        r.batch.forEach((phrase, n) => {
            const id = byIndex.get(n + 1);
            if (!id || !valid.has(id)) return;
            byId.get(id).purposes.push(phrase);
            assigned += 1;
        });
    }
    console.log(`  assigned ${assigned}/${phrases.length} phrases`);
    return { rubrics, phrases };
}

// ---------------------------------------------------------------- pass 3

function earnAPlace(rubrics, described) {
    const purposeToRubric = new Map();
    for (const r of rubrics) for (const p of r.purposes) purposeToRubric.set(p.trim().toLowerCase(), r.id);

    const members = new Map(rubrics.map((r) => [r.id, []]));
    const unassigned = [];
    for (const d of described) {
        const id = purposeToRubric.get(d.purpose);
        if (!id || !members.has(id)) { unassigned.push(d); continue; }
        members.get(id).push(d);
    }

    const survivors = [];
    const dropped = [];
    for (const r of rubrics) {
        const list = members.get(r.id) || [];
        (list.length >= MEMBER_FLOOR ? survivors : dropped).push({ ...r, count: list.length });
    }
    return { survivors, dropped, members, unassigned, purposeToRubric };
}

// ---------------------------------------------------------------- main

(async () => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const budget = parseFloat(arg('--budget', '1.50'));
    const limit = parseInt(arg('--limit', '0'), 10);

    const client = new Client({ apiKey: process.env.ANTHROPIC_API_KEY, budget });

    const { channels, dropped: excluded } = corpus.loadTelegramChannels();
    console.log(`corpus: ${channels.length} channels after removing `
        + `${excluded.pseudoscience.length} pseudoscience + ${excluded.broken.length} broken`);
    const subset = limit > 0 ? channels.slice(0, limit) : channels;

    // Pass 1 is gap-filling, not all-or-nothing. A request that fails takes its
    // whole batch of 12 with it, so a single bad string can cost 200 descriptions;
    // re-describing everything to recover them would be paying twice for work
    // already done. --resume tops up only what is missing.
    let described = [];
    if (has('--resume') && fs.existsSync(PASS1)) {
        described = JSON.parse(fs.readFileSync(PASS1, 'utf8')).described || [];
        const have = new Set(described.map((d) => d.username));
        const missing = subset.filter((c) => !have.has(c.username));
        console.log(`resumed pass 1 from cache: ${described.length} cached, ${missing.length} missing`);
        if (missing.length) {
            try {
                described = described.concat(await runPass1(client, missing));
            } catch (err) {
                if (err instanceof BudgetExceeded) console.log(`\nstopped filling gaps: ${err.message}`);
                else throw err;
            }
            fs.writeFileSync(PASS1, JSON.stringify({ described, spend: client.report() }, null, 1));
            console.log(`  cache topped up -> ${described.length} descriptions`);
        }
    } else {
        try {
            described = await runPass1(client, subset);
        } catch (err) {
            if (err instanceof BudgetExceeded) { console.log(`\nstopped: ${err.message}`); process.exit(1); }
            throw err;
        }
        fs.writeFileSync(PASS1, JSON.stringify({ described, spend: client.report() }, null, 1));
        console.log(`  cached -> ${path.relative(process.cwd(), PASS1)}`);
    }
    const coverage = (100 * described.length / subset.length).toFixed(1);
    console.log(`  coverage: ${described.length}/${subset.length} channels described (${coverage}%)`);

    const notEducation = described.filter((d) => !d.isPhysicsEducation);
    const general = described.filter((d) => d.specificity === 'general');
    console.log(`\n  flagged not-physics-education: ${notEducation.length}`);
    console.log(`  flagged general-audience:      ${general.length}`);
    if (general.length) {
        console.log('  largest general-audience channels (these must not sit beside specific rubrics):');
        general.sort((a, b) => (b.subscribers || 0) - (a.subscribers || 0)).slice(0, 6)
            .forEach((d) => console.log(`    ${String(d.subscribers ?? '?').padStart(7)}  @${d.username} — ${d.purpose}`));
    }

    const { rubrics } = await runPass2(client, described);
    const { survivors, dropped, members, unassigned } = earnAPlace(rubrics, described);

    console.log(`\npass 3 — earn a place (floor: ${MEMBER_FLOOR} members)\n`);
    console.log('  SURVIVING RUBRICS');
    for (const r of survivors.sort((a, b) => b.count - a.count)) {
        const flag = r.serves_core_audience ? '' : '   [kept separate — not core audience]';
        console.log(`    ${String(r.count).padStart(4)}  ${r.id.padEnd(26)} ${r.name_ru}${flag}`);
    }
    if (dropped.length) {
        console.log('\n  DROPPED — below the member floor, merged into nothing:');
        for (const r of dropped.sort((a, b) => b.count - a.count)) {
            console.log(`    ${String(r.count).padStart(4)}  ${r.id.padEnd(26)} ${r.name_ru}`);
        }
    }
    if (unassigned.length) console.log(`\n  unassigned channels: ${unassigned.length}`);

    fs.writeFileSync(OUT, JSON.stringify({
        generated: 'discover-taxonomy.js',
        memberFloor: MEMBER_FLOOR,
        rubrics: survivors,
        droppedRubrics: dropped,
        assignments: Object.fromEntries([...members].map(([id, list]) => [id, list.map((d) => d.username)])),
        unassigned: unassigned.map((d) => ({ username: d.username, purpose: d.purpose })),
        spend: client.report(),
    }, null, 1));

    const rep = client.report();
    console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
    console.log(`spend: $${rep.spent.toFixed(4)} of $${budget.toFixed(2)}  `
        + `(${rep.calls} calls, ${rep.tokensIn} in / ${rep.tokensOut} out)`);
})();
