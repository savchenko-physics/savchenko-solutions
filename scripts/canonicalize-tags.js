#!/usr/bin/env node
/**
 * canonicalize-tags.js — replace problem_difficulty's free-text `prerequisites`
 * (2,084 distinct strings across 2,023 problems — "Newton's laws" and "Newton's
 * second law" both exist) with a fixed, LeetCode/Codeforces-style tag taxonomy
 * that the problem finder can actually filter by.
 *
 * Offline metadata script, sanctioned the same way scripts/score-difficulty.js and
 * scripts/rank-fit.js are: it classifies existing human-authored problems into a
 * fixed vocabulary, it never authors physics. CLAUDE.md forbids runtime AI
 * features — this never runs on the server, only here, once.
 *
 * Two phases, run separately on purpose: a taxonomy proposed by a model should be
 * read by a person before 2,023 problems get classified against it.
 *
 *   node scripts/canonicalize-tags.js --taxonomy-only
 *     Proposes a ~50-90 tag taxonomy from the distinct raw `prerequisites` values,
 *     writes it to data/topic-taxonomy.json (committed — review/edit it by hand
 *     before running the classify phase), then stops. Spends almost nothing.
 *
 *   node scripts/canonicalize-tags.js --budget 3.5
 *     Requires data/topic-taxonomy.json to already exist. Classifies every
 *     problem into 1-4 tags from that fixed list, batched (16/call) and resumable
 *     via data/.build/canonicalize-tags.json (gitignored state — a killed run
 *     costs nothing to resume), then writes problem_difficulty.canonical_tags.
 *
 *   node scripts/canonicalize-tags.js --budget 0.10 --limit 50
 *     Cheap smoke test before committing to the full run.
 *
 * Never touches problem_difficulty.prerequisites (left as-is for per-problem
 * display) or .scores/.calibrated (the AI difficulty scores — unrelated data).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { readCSV } = require('../parents');
const { Client, chunk, mapLimit } = require('./lib/anthropic');

const ROOT = path.join(__dirname, '..');
const TAXONOMY_PATH = path.join(ROOT, 'data', 'topic-taxonomy.json');
const STATE_PATH = path.join(ROOT, 'data', '.build', 'canonicalize-tags.json');

const arg = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? dflt : process.argv[i + 1];
};
const has = (flag) => process.argv.includes(flag);

const pool = new Pool({
    user: process.env.PG_USER, host: process.env.PG_HOST, database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD, port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

// ── phase 1: propose the taxonomy ──────────────────────────────────────────────
const TAXONOMY_SCHEMA = {
    type: 'object',
    properties: {
        tags: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    key: { type: 'string' },
                    labelEn: { type: 'string' },
                    labelRu: { type: 'string' },
                    description: { type: 'string' },
                },
                required: ['key', 'labelEn', 'labelRu', 'description'],
                additionalProperties: false,
            },
        },
    },
    required: ['tags'],
    additionalProperties: false,
};

function chapterTitles() {
    try {
        const csv = path.join(ROOT, 'src', 'database', 'chapters.csv');
        return readCSV(csv, 1);
    } catch { return []; }
}

async function proposeTaxonomy(client) {
    const { rows } = await pool.query(
        `SELECT unnest(prerequisites) AS tag, COUNT(*)::int AS n
           FROM problem_difficulty GROUP BY tag ORDER BY n DESC LIMIT 400`
    );
    const chapters = chapterTitles();

    const system = `You are designing a fixed topic-tag taxonomy for a physics problem site, in
the style of Codeforces' or LeetCode's tag lists: a controlled vocabulary of 50-90 tags that a
reader can filter problems by. You are given the book's 14 chapter titles and the most frequent
raw AI-generated topic labels already on file (free text, so near-duplicates exist — e.g.
"Newton's laws" and "Newton's second law" should collapse into one tag).

Design 50-90 tags. Rules:
- Each tag needs a short snake_case key (e.g. "gauss_law", "rotating_frames"), an English label,
  a Russian label, and a one-sentence description a filter panel could show as a tooltip.
- Prefer specific, recognizable physics/math concepts over vague buckets ("energy_conservation",
  not "mechanics_misc"). A reader should be able to guess what a tag means from its label alone.
- Merge near-duplicates from the raw list into one tag; do not keep both "newtons_laws" and
  "newtons_second_law" if they mean the same filtering intent.
- Cover the full book: every chapter should have several tags a problem in it could plausibly get.
- Do not exceed 90 tags. A LeetCode-sized list (a few dozen to ~90) is more useful to filter by
  than an exhaustive one.`;

    const user = `Chapters:\n${chapters.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n`
        + `Most frequent raw topic labels already generated per-problem (label: count):\n`
        + rows.map((r) => `${r.tag}: ${r.n}`).join('\n');

    return client.json({ system, user, schema: TAXONOMY_SCHEMA, maxTokens: 8000 });
}

// ── phase 2: classify every problem against the fixed taxonomy ─────────────────
function classifySchema() {
    return {
        type: 'object',
        properties: {
            results: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        i: { type: 'integer' },
                        tags: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['i', 'tags'],
                    additionalProperties: false,
                },
            },
        },
        required: ['results'],
        additionalProperties: false,
    };
}

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(state) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
}

async function classifyAll(client, taxonomy, { chunkSize, concurrency, limit }) {
    const { rows } = await pool.query(
        `SELECT pd.problem_name, pd.key_idea, pd.prerequisites,
                ps.chapter, ps.section, ps.statement_tex
           FROM problem_difficulty pd
           JOIN problem_statements ps ON ps.problem_name = pd.problem_name AND ps.lang = 'en'
          ORDER BY pd.problem_name`
    );

    const state = loadState();
    let todo = rows.filter((r) => !state[r.problem_name]);
    if (limit) todo = todo.slice(0, limit);
    console.log(`  ${rows.length} problems total, ${Object.keys(state).length} already classified, ${todo.length} to do`);
    if (!todo.length) return state;

    const tagList = taxonomy.tags.map((t) => `${t.key}: ${t.description}`).join('\n');
    const validKeys = new Set(taxonomy.tags.map((t) => t.key));

    const system = `You tag physics problems from Savchenko's "Problems in Physics" against a
fixed taxonomy. For each problem, pick 1-4 tags from the list below that best describe the
physics/math content actually needed to solve it. Only use keys from this exact list — never
invent a new one. The problem's existing raw labels are a hint, not ground truth (they are
free text and sometimes noisy or too specific).

Tags:
${tagList}`;

    const batches = chunk(todo, chunkSize);
    let done = 0;
    await mapLimit(batches, concurrency, async (batch) => {
        const user = batch.map((r, n) => {
            const stmt = (r.statement_tex || '').slice(0, 900);
            return `### ${n + 1}\nproblem ${r.problem_name} (chapter ${r.chapter})\n`
                + `statement: ${stmt}\n`
                + (r.key_idea ? `key idea: ${r.key_idea}\n` : '')
                + (r.prerequisites?.length ? `existing raw labels: ${r.prerequisites.join(', ')}` : '');
        }).join('\n\n');

        const out = await client.json({
            system,
            user: `Tag these ${batch.length} problems. One result per problem by 1-based \`i\`.\n\n${user}`,
            schema: classifySchema(),
            maxTokens: 60 * batch.length,
        });

        const byIndex = new Map((out.results || []).map((x) => [x.i, x]));
        batch.forEach((r, n) => {
            const v = byIndex.get(n + 1);
            const tags = (v?.tags || []).filter((t) => validKeys.has(t)).slice(0, 4);
            state[r.problem_name] = { tags, at: new Date().toISOString().slice(0, 10) };
        });
        done += batch.length;
        saveState(state); // written after every batch — a killed run resumes for free
        process.stdout.write(`  ${done}/${todo.length}  $${client.spent.toFixed(3)}\r`);
    });
    console.log('');
    return state;
}

async function writeToDatabase(state) {
    const entries = Object.entries(state).filter(([, v]) => v.tags.length);
    console.log(`\nwriting canonical_tags for ${entries.length} problems...`);
    await pool.query('BEGIN');
    try {
        for (const [problemName, v] of entries) {
            await pool.query(
                'UPDATE problem_difficulty SET canonical_tags = $1 WHERE problem_name = $2',
                [v.tags, problemName]
            );
        }
        await pool.query('COMMIT');
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('  write failed, rolled back:', err.message);
        process.exit(1);
    }
    const { rows: [check] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE canonical_tags <> '{}') AS tagged, COUNT(*) AS total FROM problem_difficulty`
    );
    console.log(`  in database: ${check.tagged}/${check.total} problems now have canonical_tags`);
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) { console.error('set ANTHROPIC_API_KEY'); process.exit(1); }

    if (has('--taxonomy-only')) {
        const client = new Client({ apiKey, budget: parseFloat(arg('--budget', '0.20')) });
        console.log('proposing taxonomy from raw prerequisites...');
        const taxonomy = await proposeTaxonomy(client);
        fs.writeFileSync(TAXONOMY_PATH, JSON.stringify(taxonomy, null, 1));
        console.log(`  proposed ${taxonomy.tags.length} tags -> ${path.relative(ROOT, TAXONOMY_PATH)}`);
        console.log(`  spend: $${client.report().spent.toFixed(4)}`);
        console.log('\n  Review this file by hand (merge/rename/drop tags as needed) before running the classify phase.');
        await pool.end();
        return;
    }

    if (!fs.existsSync(TAXONOMY_PATH)) {
        console.error(`no taxonomy at ${path.relative(ROOT, TAXONOMY_PATH)} — run with --taxonomy-only first, review it, then re-run.`);
        process.exit(1);
    }
    const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
    if (taxonomy.tags.length < 20 || taxonomy.tags.length > 120) {
        console.error(`taxonomy has ${taxonomy.tags.length} tags — that's outside a sane 20-120 range; check ${path.relative(ROOT, TAXONOMY_PATH)} before continuing.`);
        process.exit(1);
    }

    const budget = parseFloat(arg('--budget', '3.5'));
    const client = new Client({ apiKey, budget });
    const state = await classifyAll(client, taxonomy, {
        chunkSize: parseInt(arg('--chunk', '16'), 10),
        concurrency: parseInt(arg('--concurrency', '6'), 10),
        limit: arg('--limit', null) ? parseInt(arg('--limit', '0'), 10) : null,
    });

    console.log(`\nclassified ${Object.keys(state).length} problems total, spend $${client.report().spent.toFixed(4)} of $${budget.toFixed(2)}`);

    if (has('--dry-run')) { console.log('--dry-run: database untouched'); await pool.end(); return; }
    await writeToDatabase(state);
    await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
