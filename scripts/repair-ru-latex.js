#!/usr/bin/env node
/**
 * Re-typeset the maths in the Russian statements recovered from the printed book.
 *
 *   node scripts/repair-ru-latex.js --dry-run     # show what would change, spend nothing
 *   node scripts/repair-ru-latex.js --limit 10    # do ten, read them, then do the rest
 *   node scripts/repair-ru-latex.js
 *
 * pdftotext flattens everything: "τy = τx /3" instead of "$\tau_y = \tau_x/3$", bare "v1"
 * for a subscript, "sin" as prose, "10−18" with a Unicode minus for an exponent. The text
 * is a faithful transcription and unusable as LaTeX. This turns it into the site's own
 * "$...$" convention.
 *
 * Only the rows that actually contain maths are touched — about 160 of the 2,023, the rest
 * being clean prose that would only be put at risk. And the English statement goes in as a
 * reference, because it already carries the same formulas correctly typeset: that turns an
 * open-ended "write LaTeX" task into a matching exercise, which is why gpt-5-nano is enough
 * and why the whole job costs a few cents.
 *
 * The model is told to change nothing but the notation. Statements are the one thing on
 * this site that must not drift from the book.
 */
require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
const has = (f) => process.argv.includes(f);
const DRY = has('--dry-run');
const LIMIT = parseInt(arg('--limit', '0'), 10);
const MODEL = arg('--model', 'gpt-5-nano');
const SOURCES = has('--redo') ? "IN ('pdf', 'pdf+llm')" : "= 'pdf'";
const PRICE = { 'gpt-5-nano': { in: 0.05, out: 0.40 }, 'gpt-5-mini': { in: 0.25, out: 2.00 } };

// Anything here means the row has notation to fix. Rows matching none of it are prose and
// are left strictly alone.
const HAS_MATHS = /[α-ωΑ-Ω]|−|·|×|≤|≥|∫|√|(?<![\\A-Za-z0-9])[a-zA-Z]\d|(?<![\\A-Za-zа-яА-Я])(sin|cos|tg|ctg|ln|lg|arcsin|arctg)(?![A-Za-zа-яА-Я])|[a-zA-Z]\s*=/;

const SYSTEM = `You convert Russian physics problem statements to the site's LaTeX
convention. The text was extracted from a scanned book, so its mathematics is flattened
Unicode rather than markup.

Rules:
- Wrap every mathematical expression in single dollars: $...$.
- Greek letters become commands: α -> $\\alpha$, ω -> $\\omega$, τ -> $\\tau$, Ω -> $\\Omega$.
- Subscripts get an underscore: v1 -> $v_1$, τy -> $\\tau_y$, E_к -> $E_\\text{к}$.
- Trigonometric and log functions get a backslash: sin -> $\\sin$, cos -> $\\cos$, ln -> $\\ln$.
  For tg and ctg use $\\operatorname{tg}$ and $\\operatorname{ctg}$ — MathJax defines no
  \\tg or \\ctg command and they would render as an error.
- Exponents: 10−18 -> $10^{-18}$, 3 · 108 -> $3 \\cdot 10^{8}$. Use \\cdot for multiplication.
- Degrees: 30◦ -> $30^\\circ$. Units stay outside the maths as ordinary Russian words, or
  inside as \\text{}: "$0.1$ м", "$R = 0{,}1~\\text{м}$".
- Russian decimal commas stay commas: 0,5 -> $0{,}5$.

Change NOTHING else. Do not translate, reword, shorten, explain, correct the physics, or
add anything. Every Russian word must come back exactly as it was, in the same order, with
none removed — including the small ones that sit next to a formula, like "по закону",
"равна", "вида". Reproduce them and then typeset the formula. If a passage has no
mathematics, return it unchanged.

An English translation of the same problem is supplied for reference — it already has the
formulas typeset correctly, so use it to resolve what a mangled symbol was meant to be.
Never copy its wording; the output is Russian.

Return only the corrected Russian statement.`;

async function repair(ru, en, apiKey, previousFailure) {
    const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: MODEL,
            input: [
                { role: 'system', content: SYSTEM },
                { role: 'user', content:
                    `English reference (do not copy its wording):\n${en || '(none available)'}\n\n`
                    + `Russian statement to re-typeset:\n${ru}`
                    + (previousFailure ? `\n\nYour previous attempt was rejected: ${previousFailure}. Reproduce every Russian word this time.` : '') },
            ],
            ...(/^gpt-5/.test(MODEL) ? { reasoning: { effort: 'low' } } : {}),
        }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    const text = (json.output || [])
        .flatMap((o) => o.content || [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text)
        .join('')
        .trim();
    return { text, usage: json.usage };
}

// A repair that drops or invents Russian text is a worse outcome than leaving the flattened
// maths in place, so the prose is checked exactly rather than approximately.
//
// The first version of this allowed 15% drift in word count, on the theory that notation
// changes might legitimately absorb a word. It does not: only notation is meant to change,
// so the sequence of Russian words must come back identical. A tolerance let 3.4.18 through
// with "происходят по закону x1 = ..." silently rewritten to "происходят по $x_1 = ...$" —
// one missing word, well inside 15%, and a statement that no longer says what the book says.
function acceptable(before, after) {
    if (!after || after.length < 20) return 'empty or truncated';
    if (!/\$/.test(after)) return 'no maths markup produced';
    if ((after.match(/\$/g) || []).length % 2) return 'unbalanced $';

    const words = (s) => (s.match(/[А-Яа-яЁё]+/g) || []).map((w) => w.toLowerCase());
    const b = words(before), a = words(after);
    if (b.join(' ') !== a.join(' ')) {
        const missing = b.filter((w, i) => a[i] !== w).slice(0, 3);
        return `Russian prose changed (${b.length} -> ${a.length} words${missing.length ? `, first divergence "${missing[0]}"` : ''})`;
    }
    return null;
}

(async () => {
    const apiKey = (process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey && !DRY) { console.error('set OPENAI_API_KEY'); process.exit(1); }

    const c = (k) => (process.env[k] || '').trim();
    const pool = new Pool({
        user: c('PG_USER'), host: c('PG_HOST'), database: c('PG_DATABASE'),
        password: c('PG_PASSWORD'), port: Number(c('PG_PORT')) || 5432,
        ssl: { rejectUnauthorized: c('PG_SSL_REJECT_UNAUTHORIZED') === 'true' },
    });

    const { rows } = await pool.query(
        `SELECT r.problem_name, r.statement_tex AS ru, e.statement_tex AS en
           FROM problem_statements r
           LEFT JOIN problem_statements e
             ON e.problem_name = r.problem_name AND e.lang = 'en'
          WHERE r.lang = 'ru' AND r.source ${SOURCES}
          ORDER BY r.chapter, r.section, r.idx`
    );

    const needing = rows.filter((r) => HAS_MATHS.test(r.ru));
    const todo = LIMIT ? needing.slice(0, LIMIT) : needing;
    console.log(`  pdf-sourced Russian rows : ${rows.length}`);
    console.log(`  containing maths         : ${needing.length}`);
    console.log(`  prose, left alone        : ${rows.length - needing.length}`);
    console.log(`  this run                 : ${todo.length}\n`);

    if (DRY) {
        for (const r of todo.slice(0, 5)) console.log(`── ${r.problem_name}\n   ${r.ru.replace(/\n/g, ' ').slice(0, 200)}\n`);
        console.log('  --dry-run: nothing sent, nothing written.');
        await pool.end();
        return;
    }

    let spent = 0, changed = 0, rejected = 0, failed = 0;
    for (const r of todo) {
        try {
            // Two attempts: a dropped word is usually a one-off slip, and the second try is
            // told exactly what went wrong. Still rejected after that, the row keeps its
            // flattened maths — which is honest, and flagged needs_review either way.
            let text = null, why = null;
            for (let attempt = 0; attempt < 2 && !text; attempt++) {
                const got = await repair(r.ru, r.en, apiKey, why);
                spent += (got.usage.input_tokens / 1e6) * PRICE[MODEL].in
                       + (got.usage.output_tokens / 1e6) * PRICE[MODEL].out;
                why = acceptable(r.ru, got.text);
                if (!why) text = got.text;
            }
            if (!text) {
                rejected++;
                console.log(`  reject ${r.problem_name}: ${why}`);
                continue;
            }
            await pool.query(
                `UPDATE problem_statements
                    SET statement_tex = $1, source = 'pdf+llm', updated_at = now()
                  WHERE problem_name = $2 AND lang = 'ru'`,
                [text, r.problem_name]
            );
            changed++;
            if (changed <= 3) console.log(`── ${r.problem_name}\n   before: ${r.ru.replace(/\n/g, ' ').slice(0, 150)}\n   after : ${text.replace(/\n/g, ' ').slice(0, 150)}\n`);
        } catch (err) {
            failed++;
            if (failed <= 3) console.log(`  fail ${r.problem_name}: ${err.message.slice(0, 100)}`);
        }
    }

    console.log(`\n  repaired ${changed}, rejected ${rejected}, failed ${failed}`);
    console.log(`  cost $${spent.toFixed(4)} on ${MODEL}`);
    const { rows: [s] } = await pool.query(
        `SELECT count(*) FILTER (WHERE source = 'pdf')::int pdf,
                count(*) FILTER (WHERE source = 'pdf+llm')::int repaired
           FROM problem_statements WHERE lang = 'ru'`
    );
    console.log(`  now: ${s.pdf} raw pdf, ${s.repaired} re-typeset`);
    await pool.end();
})();
