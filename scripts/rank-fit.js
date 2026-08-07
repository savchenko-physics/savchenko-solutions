#!/usr/bin/env node
/**
 * rank-fit.js — score how directly an entry serves a physics student.
 *
 * The merit audit asked "is this useful to our readers?" and problems.ru and
 * math.ru answer yes: they are excellent problem archives, heavily cited, and a
 * physics olympiad student does use them. So they scored high and sorted to the
 * top of the catalog — above physics problem archives.
 *
 * That is the wrong order. Someone stuck on a Savchenko mechanics problem wants
 * physics problems first; a maths olympiad archive is a genuine but secondary
 * resource. Usefulness and subject-fit are different axes, and collapsing them
 * into one number loses the ordering that matters.
 *
 * So this pass adds the second axis. It does not remove anything — maths, and
 * the astronomy and computing entries alongside it, stay in the catalog and stay
 * findable. They simply stop outranking physics.
 *
 * Usage: node scripts/rank-fit.js --budget 0.25
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { Client, chunk, mapLimit } = require('./lib/anthropic');

const STATE = path.join(__dirname, '..', 'data', '.build');
const OUT = path.join(STATE, 'rank-fit.json');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };

const SYSTEM = `You are ordering a catalog of resources for one specific reader.

That reader is a secondary-school or first-year university student, Russian-speaking, working alone through O.Ya. Savchenko's physics problem book — 2023 hard olympiad-level physics problems — and preparing for physics olympiads and university entrance exams.

For each resource, judge two separate things.

subject — what the material actually is:
  "physics"        physics problems, physics theory, physics olympiads, physics courses
  "astronomy"      astronomy and astrophysics, including astronomy olympiads
  "math"           mathematics of any kind, including maths olympiads and maths problem archives
  "cs"             programming, algorithms, competitive programming, informatics olympiads
  "mixed"          genuinely covers physics AND another subject at comparable depth
  "other"          anything else

fit — 0-100, how directly this helps THAT reader with THAT task:
  90+   physics problems with worked solutions at olympiad level; solutions to the standard physics problem books; physics olympiad past papers
  70-89 physics theory and lecture notes at the right level; active physics Q&A where they could ask; national physics olympiad sites
  50-69 physics material at the wrong level (too elementary or graduate-only), or physics-adjacent reference they would consult occasionally
  30-49 maths or astronomy material a physics olympiad student genuinely uses, but is not what they came for
  10-29 material for a different subject or a different audience that still touches science
  0-9   no bearing on this reader's work

A first-rate maths olympiad archive is a 35, not an 85: excellent, but not what this reader needs. Judge fit by how close the material is to the reader's actual task, never by how good the resource is in general — quality is already accounted for elsewhere.

Also return physics_share: 0-100, the share of the resource's material that is physics.`;

const SCHEMA = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    i: { type: 'integer' },
                    subject: { type: 'string', enum: ['physics', 'astronomy', 'math', 'cs', 'mixed', 'other'] },
                    fit: { type: 'integer' },
                    physics_share: { type: 'integer' },
                },
                required: ['i', 'subject', 'fit', 'physics_share'],
                additionalProperties: false,
            },
        },
    },
    required: ['results'],
    additionalProperties: false,
};

(async () => {
    const budget = parseFloat(arg('--budget', '0.25'));
    const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'recommendations.json'), 'utf8'));

    // Resume rather than re-score. The merit gate was later changed from the
    // audit's binary verdict to its calibrated score, which re-admitted 153 sites
    // AFTER this pass had run — so they carried no subject-fit at all and skipped
    // the fit multiplier entirely, ranking above properly-scored physics sites.
    // Verdicts already grounded in page content (verify-subject.js) are never
    // overwritten.
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* first run */ }
    const items = [
        ...cat.websites.entries.map((e) => ({ ...e, kind: 'website' })),
        ...cat.telegram.entries.map((e) => ({ ...e, kind: 'telegram' })),
    ].filter((e) => !existing[`${e.kind}:${e.id}`]);
    if (Object.keys(existing).length) console.log(`  resuming: ${Object.keys(existing).length} already scored`);
    if (!items.length) { console.log('nothing to score'); return; }
    console.log(`scoring subject-fit for ${items.length} entries `
        + `(${cat.websites.entries.length} websites, ${cat.telegram.entries.length} channels)`);

    const client = new Client({ apiKey: process.env.ANTHROPIC_API_KEY, budget });
    const batches = chunk(items, 16);
    let done = 0;
    const results = await mapLimit(batches, 6, async (batch) => {
        const user = batch.map((e, n) => `### ${n + 1}
name: ${e.title}
what it is: ${e.summaryEn || e.summaryRu || '(no summary)'}
rubric: ${e.rubric}${e.books && e.books.length ? `\ntextbooks covered: ${e.books.join(', ')}` : ''}`).join('\n\n');
        const out = await client.json({
            system: SYSTEM,
            user: `Judge these ${batch.length}. One result per entry by 1-based \`i\`.\n\n${user}`,
            schema: SCHEMA,
            maxTokens: 70 * batch.length,
        });
        done += batch.length;
        process.stdout.write(`  ${done}/${items.length}  $${client.spent.toFixed(3)}\r`);
        return { batch, out };
    });
    console.log('');

    const fit = { ...existing };
    let missing = 0;
    for (const r of results) {
        if (!r || r.__error) { missing += r?.batch?.length || 16; continue; }
        const byIndex = new Map((r.out.results || []).map((x) => [x.i, x]));
        r.batch.forEach((e, n) => {
            const v = byIndex.get(n + 1);
            if (!v) { missing += 1; return; }
            fit[`${e.kind}:${e.id}`] = { subject: v.subject, fit: v.fit, physicsShare: v.physics_share };
        });
    }
    fs.writeFileSync(OUT, JSON.stringify(fit, null, 1));

    const bySubject = {};
    for (const v of Object.values(fit)) bySubject[v.subject] = (bySubject[v.subject] || 0) + 1;
    console.log(`\nscored ${Object.keys(fit).length}${missing ? ` (${missing} missing)` : ''}:`, bySubject);

    const web = cat.websites.entries
        .map((e) => ({ e, f: fit[`website:${e.id}`] })).filter((x) => x.f);
    const nonPhysics = web.filter((x) => x.f.subject !== 'physics' && x.f.subject !== 'mixed')
        .sort((a, b) => b.e.score - a.e.score);
    console.log(`\nnon-physics sites currently ranked highest (these are what move down):`);
    for (const { e, f } of nonPhysics.slice(0, 14)) {
        console.log(`  rank-score ${String(e.score).padStart(7)}  fit ${String(f.fit).padStart(3)}  ${f.subject.padEnd(9)} ${e.id}`);
    }
    console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
    console.log(`spend: $${client.report().spent.toFixed(4)} of $${budget.toFixed(2)}`);
})();
