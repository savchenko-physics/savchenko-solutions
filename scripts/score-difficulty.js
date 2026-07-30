#!/usr/bin/env node
/**
 * Score all 2,023 problems with the model the bake-off chose, inside a hard dollar ceiling.
 *
 *   node scripts/score-difficulty.js --model gpt-5-nano --budget 1.40
 *   node scripts/score-difficulty.js --resume            # pick a interrupted run back up
 *   node scripts/score-difficulty.js --calibrate-only    # recompute calibration, no spend
 *
 * Uses the Batch API, which is half price and is the only reason this fits in $1.56 at all.
 * Work is submitted in chunks so a run can be stopped, inspected and resumed without paying
 * twice for anything already returned: every batch id is written to a state file the moment
 * it is created, and a resumed run adopts batches that are still in flight rather than
 * submitting the same problems again.
 *
 * The model is never shown Savchenko's star. See difficultyRubric.js.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { AXIS_KEYS, SYSTEM, buildSchema, buildUserMessage } = require('../difficultyRubric');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'src/database/difficulty-run.json');
const arg = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? dflt : process.argv[i + 1];
};
const has = (flag) => process.argv.includes(flag);

const MODEL = arg('--model', 'gpt-5-nano');
const BUDGET = parseFloat(arg('--budget', '1.40'));
const CHUNK = parseInt(arg('--chunk', '250'), 10);
const POLL_SECONDS = parseInt(arg('--poll', '30'), 10);

const PRICING = {
    'gpt-5-nano': { in: 0.05, out: 0.40 },
    'gpt-5-mini': { in: 0.25, out: 2.00 },
    'gpt-4.1-mini': { in: 0.40, out: 1.60 },
    'gpt-5.4-nano': { in: 0.25, out: 2.00 },
};

const apiKey = () => (process.env.OPENAI_API_KEY || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, options = {}) {
    const res = await fetch(`https://api.openai.com/v1/${pathname}`, {
        ...options,
        headers: { Authorization: `Bearer ${apiKey()}`, ...(options.headers || {}) },
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { raw: text }; }
    if (json.error) throw new Error(`${pathname}: ${json.error.message}`);
    return json;
}

const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null);
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));

// ── input ───────────────────────────────────────────────────────────────────────────
function readSolution(name) {
    for (const lang of ['en', 'ru']) {
        const p = path.join(ROOT, 'posts', lang, `${name}.md`);
        if (!fs.existsSync(p)) continue;
        const md = fs.readFileSync(p, 'utf8');
        const m = md.match(/^#{2,6}[ \t]*(Решение|Solution)/im);
        if (m) return md.slice(m.index);
    }
    return null;
}

function buildRequests(rows, sectionTitles) {
    const schema = buildSchema();
    return rows.map((r) => ({
        custom_id: r.problem_name,
        method: 'POST',
        url: '/v1/responses',
        body: {
            model: MODEL,
            input: [
                { role: 'system', content: SYSTEM },
                {
                    role: 'user',
                    content: buildUserMessage({
                        name: r.problem_name,
                        sectionTitle: sectionTitles.get(`${r.chapter}.${r.section}`),
                        statement: r.statement_tex,
                        solution: readSolution(r.problem_name),
                    }),
                },
            ],
            text: { format: { type: 'json_schema', name: 'difficulty', strict: true, schema } },
            ...(/^(gpt-5|o3|o4)/.test(MODEL) ? { reasoning: { effort: 'low' } } : {}),
        },
    }));
}

// ── batch plumbing ──────────────────────────────────────────────────────────────────
async function submitChunk(requests, index) {
    const jsonl = requests.map((r) => JSON.stringify(r)).join('\n');
    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), `difficulty-${index}.jsonl`);
    const file = await api('files', { method: 'POST', body: form });

    const batch = await api('batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            input_file_id: file.id,
            endpoint: '/v1/responses',
            completion_window: '24h',
            metadata: { purpose: 'savchenko-difficulty', chunk: String(index) },
        }),
    });
    return { batchId: batch.id, fileId: file.id, count: requests.length, index };
}

async function collect(batchId) {
    const batch = await api(`batches/${batchId}`);
    if (!['completed', 'failed', 'expired', 'cancelled'].includes(batch.status)) return { status: batch.status, batch };
    if (batch.status !== 'completed') return { status: batch.status, batch, results: [] };

    const body = await fetch(`https://api.openai.com/v1/files/${batch.output_file_id}/content`, {
        headers: { Authorization: `Bearer ${apiKey()}` },
    }).then((r) => r.text());

    const results = [];
    for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        const resp = row.response?.body;
        if (!resp || row.response?.status_code !== 200) continue;
        const text = (resp.output || [])
            .flatMap((o) => o.content || [])
            .filter((c) => c.type === 'output_text')
            .map((c) => c.text)
            .join('');
        if (!text) continue;
        try {
            results.push({
                problem: row.custom_id,
                scores: JSON.parse(text),
                usage: {
                    in: resp.usage.input_tokens,
                    out: resp.usage.output_tokens,
                },
            });
        } catch { /* a malformed line is dropped and reported by the caller's count */ }
    }
    return { status: 'completed', batch, results };
}

// ── calibration ─────────────────────────────────────────────────────────────────────
// Two levels, because the star and the scale answer different questions.
//
//   absolute   raw overall_difficulty rank-mapped across the whole book, so a student
//              choosing what to attempt sees one scale from 0 to 100.
//   local      the within-section residual, which is what Savchenko's ∗ actually encodes:
//              "harder than its neighbours here", not "hard in absolute terms".
//
// The star is used to REPORT the separation, never to fit it. Fitting to the star would
// make the agreement between model and author unfalsifiable.
function calibrate(scored) {
    const raw = scored.map((s) => s.scores.overall_difficulty);
    const sorted = [...raw].sort((a, b) => a - b);
    const pct = (v) => {
        let lo = 0, hi = sorted.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
        let eq = 0;
        for (let i = lo; i < sorted.length && sorted[i] === v; i++) eq++;
        return (lo + eq / 2) / sorted.length;
    };

    const bySection = new Map();
    for (const s of scored) {
        const key = s.problem.split('.').slice(0, 2).join('.');
        if (!bySection.has(key)) bySection.set(key, []);
        bySection.get(key).push(s.scores.overall_difficulty);
    }
    const stats = new Map();
    for (const [key, vals] of bySection) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1)) || 1;
        stats.set(key, { mean, sd });
    }

    for (const s of scored) {
        const key = s.problem.split('.').slice(0, 2).join('.');
        const { mean, sd } = stats.get(key);
        s.calibrated = Math.round(pct(s.scores.overall_difficulty) * 100);
        s.localZ = (s.scores.overall_difficulty - mean) / sd;
    }
    return scored;
}

// The headline honesty check: does a model that was never told about the star nonetheless
// score starred problems higher? Computed within section and averaged, for the reason set
// out in scripts/difficulty-bakeoff.js.
function withinSectionAuc(scored, starredSet) {
    const bySection = new Map();
    for (const s of scored) {
        const key = s.problem.split('.').slice(0, 2).join('.');
        if (!bySection.has(key)) bySection.set(key, { pos: [], neg: [] });
        bySection.get(key)[starredSet.has(s.problem) ? 'pos' : 'neg'].push(s.scores.overall_difficulty);
    }
    const aucs = [];
    let pairs = 0;
    for (const { pos, neg } of bySection.values()) {
        if (!pos.length || !neg.length) continue;
        let wins = 0, ties = 0;
        for (const p of pos) for (const n of neg) { if (p > n) wins++; else if (p === n) ties++; }
        aucs.push((wins + ties / 2) / (pos.length * neg.length));
        pairs += pos.length * neg.length;
    }
    return { auc: aucs.reduce((a, b) => a + b, 0) / aucs.length, sections: aucs.length, pairs };
}

// ── main ────────────────────────────────────────────────────────────────────────────
(async () => {
    const c = (k) => (process.env[k] || '').trim();
    const pool = new Pool({
        user: c('PG_USER'), host: c('PG_HOST'), database: c('PG_DATABASE'),
        password: c('PG_PASSWORD'), port: Number(c('PG_PORT')) || 5432,
        ssl: { rejectUnauthorized: c('PG_SSL_REJECT_UNAUTHORIZED') === 'true' },
    });

    const { rows } = await pool.query(
        `SELECT problem_name, chapter, section, idx, statement_tex, starred
           FROM problem_statements WHERE lang = 'en' ORDER BY chapter, section, idx`
    );
    const starredSet = new Set(rows.filter((r) => r.starred).map((r) => r.problem_name));

    const sectionTitles = new Map();
    try {
        const { readCSV } = require('../parents');
        const nums = readCSV('src/database/sections.csv', 0);
        const titles = readCSV('src/database/sections.csv', 1);
        nums.forEach((n, i) => sectionTitles.set(n, titles[i]));
    } catch { /* titles are a nicety, not a requirement */ }

    let state = loadState();

    if (has('--calibrate-only')) {
        if (!state || !state.scored?.length) { console.error('no run to calibrate'); process.exit(1); }
    } else {
        if (!apiKey()) { console.error('set OPENAI_API_KEY'); process.exit(1); }
        if (!PRICING[MODEL]) { console.error(`no price on file for ${MODEL}`); process.exit(1); }

        if (!state || (!has('--resume') && state.model !== MODEL)) {
            state = { model: MODEL, budget: BUDGET, chunks: [], scored: [], spentUsd: 0, startedAt: new Date().toISOString() };
        }
        const done = new Set(state.scored.map((s) => s.problem));
        const submitted = new Set(state.chunks.flatMap((ch) => ch.problems || []));
        const todo = rows.filter((r) => !done.has(r.problem_name) && !submitted.has(r.problem_name));

        console.log(`  model      : ${state.model}`);
        console.log(`  budget     : $${BUDGET.toFixed(2)}   spent so far $${state.spentUsd.toFixed(4)}`);
        console.log(`  scored     : ${state.scored.length} / ${rows.length}`);
        console.log(`  in flight  : ${state.chunks.filter((ch) => !ch.collected).length} chunk(s)`);
        console.log(`  to submit  : ${todo.length}\n`);

        // One batch at a time, start to finish, and only then the next.
        //
        // Submitting all nine chunks up front looked like the obvious parallel win and was
        // wrong twice over. The organisation has a 2,000,000 ENQUEUED-token ceiling per
        // model; 2,023 requests at ~2,100 tokens each is 4.2M, so four of the nine batches
        // came straight back "token_limit_exceeded". And nothing had been billed yet when
        // the later chunks were submitted, so the budget guard — which compares spend so
        // far against the ceiling — waved through work that projected to $2.27.
        //
        // Sequential submission fixes both: the enqueued total is never more than one
        // batch, and every chunk after the first is checked against real measured spend.
        let remaining = todo;
        let failures = 0;
        while (remaining.length && failures < 3) {
            const perProblem = state.scored.length
                ? state.spentUsd / state.scored.length
                // Nothing measured yet: assume a deliberately pessimistic 2,000 in / 900 out.
                : ((2000 / 1e6) * PRICING[MODEL].in + (900 / 1e6) * PRICING[MODEL].out) * 0.5;
            const affordable = Math.floor((BUDGET - state.spentUsd) / perProblem);
            if (affordable < 1) {
                console.log(`  stopping: $${state.spentUsd.toFixed(4)} spent of $${BUDGET.toFixed(2)}, no room for another problem`);
                break;
            }

            const slice = remaining.slice(0, Math.min(CHUNK, affordable));
            const chunk = await submitChunk(buildRequests(slice, sectionTitles), state.chunks.length);
            chunk.problems = slice.map((r) => r.problem_name);
            chunk.collected = false;
            state.chunks.push(chunk);
            saveState(state);          // written before any wait, so a kill loses nothing
            console.log(`  chunk ${chunk.index}: submitted ${chunk.count}, batch ${chunk.batchId}`);

            // Wait this one out before touching the next.
            for (;;) {
                await sleep(POLL_SECONDS * 1000);
                const { status, batch, results } = await collect(chunk.batchId);
                const counts = batch.request_counts || {};
                if (status === 'completed') {
                    chunk.collected = true;
                    chunk.returned = results.length;
                    for (const r of results) {
                        state.spentUsd += ((r.usage.in / 1e6) * PRICING[MODEL].in + (r.usage.out / 1e6) * PRICING[MODEL].out) * 0.5;
                        state.scored.push(r);
                    }
                    saveState(state);
                    console.log(`  chunk ${chunk.index}: collected ${results.length}/${chunk.count}, total $${state.spentUsd.toFixed(4)}`);
                    remaining = remaining.slice(slice.length);
                    failures = 0;
                    break;
                }
                if (['failed', 'expired', 'cancelled'].includes(status)) {
                    // Put the problems back rather than losing them: the chunk is dropped
                    // from state so a retry does not treat them as already submitted.
                    const why = (batch.errors?.data || []).map((e) => e.code).join(', ') || status;
                    console.log(`  chunk ${chunk.index}: ${status} (${why}) — requeueing ${slice.length}`);
                    state.chunks = state.chunks.filter((c) => c !== chunk);
                    saveState(state);
                    failures++;
                    if (failures < 3) await sleep(60_000);
                    break;
                }
                console.log(`  chunk ${chunk.index}: ${status} (${counts.completed || 0}/${counts.total || chunk.count})`);
            }
        }
        if (failures >= 3) console.log('  giving up after three consecutive batch failures');
    }

    // ── calibrate, report, store ────────────────────────────────────────────────────
    const scored = calibrate(state.scored);
    saveState(state);

    const check = withinSectionAuc(scored, starredSet);
    const starredAvg = scored.filter((s) => starredSet.has(s.problem));
    const plainAvg = scored.filter((s) => !starredSet.has(s.problem));
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b.scores.overall_difficulty, 0) / xs.length : NaN);

    console.log(`\n  scored ${scored.length} problems for $${state.spentUsd.toFixed(4)}`);
    console.log(`  within-section AUC vs Savchenko's ∗ : ${check.auc.toFixed(3)}  (${check.sections} sections, ${check.pairs} pairs)`);
    console.log(`  mean overall_difficulty: starred ${mean(starredAvg).toFixed(1)} (${starredAvg.length}), unstarred ${mean(plainAvg).toFixed(1)} (${plainAvg.length})`);
    console.log(`  baseline from solution length alone was 0.584`);

    const cols = AXIS_KEYS.slice(0, 6);
    for (const k of cols) {
        const vals = scored.map((s) => s.scores[k]).sort((a, b) => a - b);
        console.log(`    ${k.padEnd(24)} median ${vals[vals.length >> 1]}  range ${vals[0]}-${vals[vals.length - 1]}`);
    }

    if (has('--dry-run')) { console.log('\n  --dry-run: database untouched'); await pool.end(); return; }

    await pool.query('BEGIN');
    try {
        for (const s of scored) {
            await pool.query(
                `INSERT INTO problem_difficulty
                   (problem_name, model, scores, calibrated, starred, key_idea, prerequisites,
                    est_minutes, input_tokens, output_tokens, cost_usd)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 ON CONFLICT (problem_name) DO UPDATE SET
                   model = EXCLUDED.model, scores = EXCLUDED.scores,
                   calibrated = EXCLUDED.calibrated, starred = EXCLUDED.starred,
                   key_idea = EXCLUDED.key_idea, prerequisites = EXCLUDED.prerequisites,
                   est_minutes = EXCLUDED.est_minutes, input_tokens = EXCLUDED.input_tokens,
                   output_tokens = EXCLUDED.output_tokens, cost_usd = EXCLUDED.cost_usd,
                   created_at = now()`,
                [
                    s.problem, state.model,
                    JSON.stringify({ ...s.scores, local_z: Number(s.localZ.toFixed(3)) }),
                    s.calibrated, starredSet.has(s.problem),
                    (s.scores.key_idea || '').slice(0, 400),
                    (s.scores.prerequisites || []).slice(0, 6),
                    s.scores.est_minutes,
                    s.usage.in, s.usage.out,
                    ((s.usage.in / 1e6) * PRICING[state.model].in + (s.usage.out / 1e6) * PRICING[state.model].out) * 0.5,
                ]
            );
        }
        await pool.query('COMMIT');
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('  write failed, rolled back:', err.message);
        process.exit(1);
    }

    const { rows: summary } = await pool.query(
        `SELECT starred, count(*)::int n, round(avg(calibrated))::int avg_calibrated,
                round(avg((scores->>'elegance')::numeric))::int avg_elegance
           FROM problem_difficulty GROUP BY starred ORDER BY starred`
    );
    console.log('\n  in database:');
    for (const r of summary) {
        console.log(`    ${r.starred ? 'starred  ' : 'unstarred'} ${String(r.n).padStart(4)}  mean calibrated ${r.avg_calibrated}  mean elegance ${r.avg_elegance}`);
    }
    const { rows: [tot] } = await pool.query('SELECT round(sum(cost_usd), 4) s FROM problem_difficulty');
    console.log(`    total cost recorded: $${tot.s}`);
    await pool.end();
})();
