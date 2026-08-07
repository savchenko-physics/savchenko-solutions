#!/usr/bin/env node
/**
 * verify-rubric.js — check every entry is filed under what it actually is.
 *
 * fizmat.kz is a school. It was filed under olympiad problems, because its
 * description mentions olympiads — as a school's description would. The rubric
 * came from clustering one-line purposes, and a purpose line cannot distinguish
 * "here are olympiad problems" from "we are a school that trains for olympiads".
 * Neither can a subject check: fizmat.kz is unambiguously physics.
 *
 * The missing question is what KIND of thing the link leads to. A reader
 * scanning "Олимпиадные задачи" wants problems to work through; an institution's
 * homepage — however excellent the institution — is an interruption.
 *
 * The hard case is that institutions often host exactly what the reader wants.
 * harvard.edu is in the catalog for David Morin's mechanics solutions and
 * hkust.edu.hk for the HKPhO past papers, and both belong in a content rubric.
 * So the question asked here is not "is this an institution?" but "does this URL
 * land on materials, or on an organisation's own pages?" — which is what the
 * reader experiences when they click.
 *
 * Reassignment is deliberately conservative: only when the model is confident and
 * names a rubric that exists for that corpus. Everything else is left alone and
 * reported, so a wrong verdict costs a log line rather than a shuffled catalog.
 *
 * Usage: node scripts/verify-rubric.js --budget 0.45 [--dry-run] [--apply]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { Client, chunk, mapLimit } = require('./lib/anthropic');

const STATE = path.join(__dirname, '..', 'data', '.build');
const OUT = path.join(STATE, 'rubric-verdicts.json');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
const has = (f) => process.argv.includes(f);

const SYSTEM = `You are checking that each entry in a physics resource catalog is filed under the right heading.

The reader is a school or first-year university student working through a hard physics problem book and preparing for physics olympiads. They scan a heading, then click a name under it. If the heading says "olympiad problems" and the link opens a school's homepage, the catalog has wasted their click.

For each entry you get its name, its link, what it is, and the heading it is currently filed under. You also get the list of headings available for its half of the catalog.

Decide two things.

lands_on — what a reader reaches by following that link:
  "materials"    problems, solutions, past papers, lecture notes, articles, a searchable archive — something to read or work through
  "institution"  an organisation's own pages: a school, university, department, faculty, ministry, society, olympiad committee. Announcements, admissions, staff, history, contact details. It may MENTION olympiads or research without being material to work through.
  "community"    a forum, chat or Q&A where people post and answer
  "tool"         a calculator, simulator, plotter or similar
  "news"         a news or announcements feed

An institution that publishes a real archive of problems, solutions or lecture notes at this link is "materials", not "institution" — judge the destination, not the owner. A university physics department's front page is "institution" even though the department does physics.

rubric — the id of the heading this entry belongs under, chosen from the list given. If it is already right, return the current one.

confidence — "high" only when the entry's own description makes the answer plain. Use "low" whenever you are inferring from the name or the domain alone.

reason — one short clause naming what decided it.`;

const SCHEMA = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    i: { type: 'integer' },
                    lands_on: { type: 'string', enum: ['materials', 'institution', 'community', 'tool', 'news'] },
                    rubric: { type: 'string' },
                    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                    reason: { type: 'string' },
                },
                required: ['i', 'lands_on', 'rubric', 'confidence', 'reason'],
                additionalProperties: false,
            },
        },
    },
    required: ['results'],
    additionalProperties: false,
};

(async () => {
    const budget = parseFloat(arg('--budget', '0.45'));
    const catPath = path.join(__dirname, '..', 'data', 'recommendations.json');
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));

    // Which rubrics exist for each half, with the band they sit in — the model
    // must choose an id that really exists, or the verdict is unusable.
    const rubricsOf = { website: [], telegram: [] };
    const tgRubrics = new Set(cat.telegram.entries.map((e) => e.rubric));
    for (const r of cat.rubrics) {
        (tgRubrics.has(r.id) ? rubricsOf.telegram : rubricsOf.website).push(r);
    }
    const menu = (kind) => rubricsOf[kind]
        .map((r) => `  ${r.id} — ${r.en} (${r.ru})`).join('\n');

    const items = [
        ...cat.websites.entries.map((e) => ({ ...e, kind: 'website' })),
        ...cat.telegram.entries.map((e) => ({ ...e, kind: 'telegram' })),
    ];
    console.log(`checking ${items.length} entries against `
        + `${rubricsOf.website.length} website / ${rubricsOf.telegram.length} telegram headings`);

    if (has('--dry-run')) {
        console.log(`[dry-run] ~${Math.ceil(items.length / 12)} requests, ~$${(items.length * 0.0005).toFixed(2)}`);
        return;
    }

    const client = new Client({ apiKey: process.env.ANTHROPIC_API_KEY, budget });
    // Batched within one corpus so a single heading menu covers the whole batch.
    const batches = [
        ...chunk(items.filter((e) => e.kind === 'website'), 12),
        ...chunk(items.filter((e) => e.kind === 'telegram'), 12),
    ];
    let done = 0;

    const results = await mapLimit(batches, 6, async (batch) => {
        const kind = batch[0].kind;
        const user = `Available headings for this half of the catalog:\n${menu(kind)}\n\n`
            + batch.map((e, n) => `### ${n + 1}
name: ${e.title}
link: ${e.url}
what it is: ${e.summaryEn || e.summaryRu || '(no description)'}
currently filed under: ${e.rubric}`).join('\n\n');
        const out = await client.json({
            system: SYSTEM,
            user: `Check these ${batch.length}. One result per entry by 1-based \`i\`.\n\n${user}`,
            schema: SCHEMA,
            maxTokens: 100 * batch.length,
        });
        done += batch.length;
        process.stdout.write(`  ${done}/${items.length}  $${client.spent.toFixed(3)}\r`);
        return { batch, out };
    });
    console.log('');

    const verdicts = {};
    for (const r of results) {
        if (!r || r.__error) { console.log(`  ! batch failed: ${r?.__error}`); continue; }
        const valid = new Set(rubricsOf[r.batch[0].kind].map((x) => x.id));
        const byIndex = new Map((r.out.results || []).map((x) => [x.i, x]));
        r.batch.forEach((e, n) => {
            const v = byIndex.get(n + 1);
            if (!v) return;
            verdicts[`${e.kind}:${e.id}`] = {
                landsOn: v.lands_on,
                // A rubric the corpus does not have is not a reassignment.
                rubric: valid.has(v.rubric) ? v.rubric : e.rubric,
                confidence: v.confidence,
                reason: v.reason,
                was: e.rubric,
            };
        });
    }
    fs.writeFileSync(OUT, JSON.stringify(verdicts, null, 1));

    const all = Object.entries(verdicts);
    const moves = all.filter(([, v]) => v.rubric !== v.was && v.confidence === 'high');
    const byLanding = {};
    for (const [, v] of all) byLanding[v.landsOn] = (byLanding[v.landsOn] || 0) + 1;
    console.log(`\nwhat a reader reaches:`, byLanding);
    console.log(`\nconfident reassignments: ${moves.length} of ${all.length}`);

    const grouped = {};
    for (const [key, v] of moves) (grouped[`${v.was} -> ${v.rubric}`] ||= []).push(key.split(':')[1]);
    for (const [move, ids] of Object.entries(grouped).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${String(ids.length).padStart(3)}  ${move}`);
        console.log(`       ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ' …' : ''}`);
    }

    const inst = all.filter(([, v]) => v.landsOn === 'institution' && v.rubric === v.was);
    if (inst.length) {
        console.log(`\nreach an institution but stay put (${inst.length}) — heading already institutional, or low confidence`);
    }
    console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
    console.log(`spend: $${client.report().spent.toFixed(4)} of $${budget.toFixed(2)}`);
    console.log('re-run scripts/build-recommendations.js to apply');
})();
