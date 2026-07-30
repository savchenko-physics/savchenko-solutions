#!/usr/bin/env node
/**
 * Pick the model to score all 2,023 problems with, on evidence rather than taste.
 *
 *   OPENAI_API_KEY=... node scripts/difficulty-bakeoff.js --budget 0.25
 *
 * The measure is how well a candidate's overall_difficulty separates the problems
 * Savchenko marked with a ∗ from the ones he did not — computed WITHIN each section and
 * then averaged, never globally.
 *
 * That distinction is the whole point. The ∗ means "harder than its neighbours in this
 * section", not "hard in absolute terms". Chapter 14 (relativity, quanta) is intrinsically
 * harder than chapter 1 (kinematics), so a global AUC would mostly measure whether a model
 * knows which topics are advanced, and would flatter any model that does. A six-problem
 * pilot showed exactly this: an UNSTARRED special-relativity problem outscored two starred
 * problems from chapters 3 and 10, which is not model error — it is the star meaning
 * something local.
 *
 * The bar is 0.584, not 0.5. Starred problems have 1.31x longer published solutions
 * (median 1,052 chars against 803), so solution length alone separates them at AUC 0.584.
 * A model that scores 0.60 is not worth a dollar. Target >= 0.75; below ~0.65 the rubric is
 * wrong rather than the model weak, and the fix is the prompt, not a bigger model.
 *
 * The model is never shown the star. See difficultyRubric.js for why.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { SYSTEM, buildSchema, buildUserMessage } = require('../difficultyRubric');

const ROOT = path.join(__dirname, '..');
const arg = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? dflt : process.argv[i + 1];
};
const BUDGET = parseFloat(arg('--budget', '0.25'));
const PAIRS = parseInt(arg('--pairs', '20'), 10);   // starred/unstarred pairs, same section
const OUT = path.join(ROOT, 'src/database/bakeoff-results.json');

// Price per 1M tokens. Where a model's public pricing is not something this script can
// verify, it is priced at the tier above so an estimate can only ever be too pessimistic —
// a bake-off that under-reports cost is how you discover the budget is gone.
const PRICING = {
    'gpt-5-nano': { in: 0.05, out: 0.40, known: true },
    'gpt-5-mini': { in: 0.25, out: 2.00, known: true },
    'gpt-4.1-mini': { in: 0.40, out: 1.60, known: true },
    'gpt-5.4-nano': { in: 0.25, out: 2.00, known: false },   // priced as mini, deliberately
};
const CANDIDATES = Object.keys(PRICING);

const cost = (model, usage) => {
    const p = PRICING[model];
    return (usage.prompt_tokens / 1e6) * p.in + (usage.completion_tokens / 1e6) * p.out;
};

// ── the sample ──────────────────────────────────────────────────────────────────────
// Pair each starred problem with an unstarred one from the SAME section, so every
// comparison the AUC makes is a within-section one by construction. Spread the pairs
// across chapters; a bake-off drawn from three sections measures three sections.
function pickPairs(rows, n) {
    const bySection = new Map();
    for (const r of rows) {
        const key = `${r.chapter}.${r.section}`;
        if (!bySection.has(key)) bySection.set(key, { starred: [], plain: [] });
        bySection.get(key)[r.starred ? 'starred' : 'plain'].push(r);
    }
    const usable = [...bySection.entries()]
        .filter(([, v]) => v.starred.length && v.plain.length)
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));

    // Walk chapters round-robin so the sample is not front-loaded on chapter 1.
    const byChapter = new Map();
    for (const [key, v] of usable) {
        const ch = key.split('.')[0];
        if (!byChapter.has(ch)) byChapter.set(ch, []);
        byChapter.get(ch).push([key, v]);
    }
    const chapters = [...byChapter.keys()];
    const pairs = [];
    for (let round = 0; pairs.length < n && round < 40; round++) {
        for (const ch of chapters) {
            const list = byChapter.get(ch);
            if (round >= list.length || pairs.length >= n) continue;
            const [key, v] = list[round];
            // Deterministic pick — no Math.random, so a re-run compares like with like.
            pairs.push({ section: key, a: v.starred[round % v.starred.length], b: v.plain[round % v.plain.length] });
        }
    }
    return pairs.slice(0, n);
}

// ── scoring one problem ─────────────────────────────────────────────────────────────
async function score(model, problem, apiKey) {
    const body = {
        model,
        input: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: buildUserMessage(problem) },
        ],
        text: {
            format: {
                type: 'json_schema', name: 'difficulty', strict: true, schema: buildSchema(),
            },
        },
    };
    if (/^(gpt-5|o3|o4)/.test(model)) body.reasoning = { effort: 'low' };

    const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${model}: ${json.error.message}`);

    const text = (json.output || [])
        .flatMap((o) => o.content || [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text)
        .join('');
    if (!text) throw new Error(`${model}: no output text`);
    return {
        scores: JSON.parse(text),
        usage: {
            prompt_tokens: json.usage.input_tokens,
            completion_tokens: json.usage.output_tokens,
            reasoning_tokens: json.usage.output_tokens_details?.reasoning_tokens ?? 0,
        },
    };
}

// ── metrics ─────────────────────────────────────────────────────────────────────────
// With one starred and one unstarred problem per pair, the within-section AUC reduces to
// the fraction of pairs ranked correctly, ties counting half. That is the Mann-Whitney
// statistic, and doing it pairwise is what keeps the comparison inside a section.
function pairedAuc(results) {
    let wins = 0, ties = 0;
    for (const r of results) {
        if (r.starredScore > r.plainScore) wins++;
        else if (r.starredScore === r.plainScore) ties++;
    }
    return (wins + ties / 2) / results.length;
}

function spread(values) {
    const s = [...values].sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { min: s[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: s[s.length - 1] };
}

(async () => {
    const apiKey = (process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) { console.error('set OPENAI_API_KEY'); process.exit(1); }

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
    await pool.end();

    const readSolution = (name) => {
        for (const lang of ['en', 'ru']) {
            const p = path.join(ROOT, 'posts', lang, `${name}.md`);
            if (fs.existsSync(p)) {
                const md = fs.readFileSync(p, 'utf8');
                const m = md.match(/^#{2,6}[ \t]*(Решение|Solution)/im);
                if (m) return md.slice(m.index);
            }
        }
        return null;
    };

    const pairs = pickPairs(rows, PAIRS);
    const problems = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
    const withText = new Map(problems.map((p) => [p.problem_name, {
        name: p.problem_name,
        statement: p.statement_tex,
        solution: readSolution(p.problem_name),
    }]));

    console.log(`  pairs           : ${pairs.length} across ${new Set(pairs.map((p) => p.section.split('.')[0])).size} chapters`);
    console.log(`  problems to rate: ${problems.length}`);
    console.log(`  with a solution : ${[...withText.values()].filter((v) => v.solution).length}`);
    console.log(`  budget          : $${BUDGET.toFixed(2)}\n`);

    const report = {};
    let spent = 0;

    for (const model of CANDIDATES) {
        const scores = new Map();
        let usageIn = 0, usageOut = 0, usageReason = 0, failures = 0, modelCost = 0;
        const t0 = Date.now();

        for (const p of problems) {
            if (spent + modelCost > BUDGET) { console.log(`  ${model}: budget reached, stopping`); break; }
            try {
                const r = await score(model, withText.get(p.problem_name), apiKey);
                scores.set(p.problem_name, r.scores);
                usageIn += r.usage.prompt_tokens;
                usageOut += r.usage.completion_tokens;
                usageReason += r.usage.reasoning_tokens;
                modelCost += cost(model, r.usage);
            } catch (err) {
                failures++;
                if (failures <= 2) console.log(`  ${model} failed on ${p.problem_name}: ${err.message.slice(0, 110)}`);
            }
        }
        spent += modelCost;

        const usable = pairs
            .filter((pr) => scores.has(pr.a.problem_name) && scores.has(pr.b.problem_name))
            .map((pr) => ({
                section: pr.section,
                starredScore: scores.get(pr.a.problem_name).overall_difficulty,
                plainScore: scores.get(pr.b.problem_name).overall_difficulty,
            }));

        const all = [...scores.values()].map((s) => s.overall_difficulty);
        const auc = usable.length ? pairedAuc(usable) : NaN;
        const perProblem = scores.size ? modelCost / scores.size : 0;

        report[model] = {
            auc,
            pairsUsed: usable.length,
            failures,
            costPerProblem: perProblem,
            // Batch is half price, and the full run uses it.
            projectedFullRunBatch: perProblem * rows.length * 0.5,
            priceKnown: PRICING[model].known,
            tokens: { in: usageIn, out: usageOut, reasoning: usageReason },
            spread: all.length ? spread(all) : null,
            seconds: Math.round((Date.now() - t0) / 1000),
            scores: Object.fromEntries(scores),
        };

        const r = report[model];
        console.log(`  ${model.padEnd(13)} AUC ${auc.toFixed(3)}  spread ${JSON.stringify(r.spread)}`);
        console.log(`  ${''.padEnd(13)} $${modelCost.toFixed(4)} here, ~$${r.projectedFullRunBatch.toFixed(2)} for all 2,023 via Batch` +
            `${r.priceKnown ? '' : '  (price assumed high)'}`);
        console.log(`  ${''.padEnd(13)} ${Math.round(usageIn / Math.max(1, scores.size))} in / ${Math.round(usageOut / Math.max(1, scores.size))} out ` +
            `(${Math.round(usageReason / Math.max(1, scores.size))} reasoning) per problem, ${r.seconds}s, ${failures} failures\n`);
    }

    fs.writeFileSync(OUT, JSON.stringify({ pairs: pairs.map((p) => ({ section: p.section, starred: p.a.problem_name, plain: p.b.problem_name })), report }, null, 1));

    console.log(`  total spent: $${spent.toFixed(4)} of $${BUDGET.toFixed(2)}`);
    console.log('\n  baseline to beat: 0.584 (solution length alone). Target: 0.75.');
    const ranked = Object.entries(report)
        .filter(([, r]) => r.auc >= 0.75 && r.projectedFullRunBatch < 1.4)
        .sort((a, b) => a[1].projectedFullRunBatch - b[1].projectedFullRunBatch);
    console.log(ranked.length
        ? `  -> cheapest model clearing the bar: ${ranked[0][0]} (AUC ${ranked[0][1].auc.toFixed(3)}, ~$${ranked[0][1].projectedFullRunBatch.toFixed(2)})`
        : '  -> nothing cleared 0.75. Fix the rubric before spending the budget.');
    console.log(`  -> ${OUT}`);
})();
