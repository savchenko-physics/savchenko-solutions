#!/usr/bin/env node
/**
 * Populate problem_statements: one row per problem per language, 4,046 in total.
 *
 *   node scripts/build-statements.js --dry-run   # parse and report, touch nothing
 *   node scripts/build-statements.js --sample    # dry-run, and print a spread of rows
 *   node scripts/build-statements.js             # upsert into the database
 *
 * Sources, in the order the plan calls for — site content first, book second:
 *
 *   English  src/database/main.tex — the complete translation, 2,023 \item across 77
 *            labelled enumerates, maths already in $...$. Used for every English row so
 *            the corpus is stylistically uniform; posts/en/*.md covers only ~640 and is
 *            derived from this same translation anyway.
 *   Russian  posts/ru/*.md, split between the statement and solution headers. This is the
 *            curated text people actually read, and it carries the site's image syntax.
 *   Russian  src/database/savchenko_ru_pdf.json for whatever the markdown does not cover.
 *            Produced by scripts/extract-pdf-ru.py; the maths in it is flattened Unicode,
 *            so those rows are flagged needs_review until scripts/repair-ru-latex.js runs.
 *
 * The script asserts full coverage and exits non-zero if either language is short. A
 * statements table that is quietly 40 rows light is worse than none at all — every
 * consumer would trust it.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const SAMPLE = process.argv.includes('--sample');
const DRY = process.argv.includes('--dry-run') || SAMPLE;

// ── the authoritative problem list ──────────────────────────────────────────────────
// sections.csv column 3 is how many problems the book has in that section. It sums to
// exactly 2,023 and matches the TeX per-section counts for all 77 sections.
function authoritativeProblems() {
    const csv = fs.readFileSync(path.join(ROOT, 'src/database/sections.csv'), 'utf8')
        .replace(/^﻿/, '');                       // the RU copies carry a BOM
    const out = [];
    for (const line of csv.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const idx = t.lastIndexOf(',');
        const maximum = parseInt(t.slice(idx + 1), 10);
        const ref = t.slice(0, t.indexOf(','));
        if (!/^\d+\.\d+$/.test(ref) || !maximum) continue;
        for (let i = 1; i <= maximum; i++) out.push(`${ref}.${i}`);
    }
    return out;
}

// ── repairing the maths ─────────────────────────────────────────────────────────────
// The Overleaf translation lost some markup on its way through OCR: Greek names dropped
// their backslash ("$mu$", "$Omega = 103$"), trig functions became prose ("$E_0 sin
// \omega t$"), exponents flattened ("$3 \cdot 108$" for the speed of light), and one
// degree sign slid a character ("$456\circ$" for 45°). 41 sites in 2,023 items. Each was
// checked against the Russian before being listed here, so these are corrections of a
// known defect, not guesses at intent.
//
// \tg and \ctg are deliberately NOT emitted: MathJax defines neither and the site sets up
// no macros, so they would render as red errors. The site's own markdown already settled
// on \operatorname{tg}, which is followed here.
const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
    'theta', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'rho', 'sigma', 'tau', 'phi', 'varphi',
    'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Sigma', 'Phi', 'Psi',
    'Omega', 'pi'];
const TRIG = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'sin', 'cos', 'tan',
    'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'lim', 'max', 'min'];
const TRIG_RU = ['arctg', 'arcctg', 'ctg', 'tg'];   // no MathJax command exists for these
const fixes = {};
const bump = (k) => { fixes[k] = (fixes[k] || 0) + 1; };

function repairMath(text) {
    // Operate only inside $...$ — "sin" in an English sentence must stay prose, and
    // "Omega" could legitimately be a word. Display $$...$$ spans are covered too.
    return text.replace(/(\$\$?)([^$]+)(\$\$?)/g, (whole, open, body, close) => {
        let s = body;
        s = s.replace(new RegExp(`(?<![\\\\A-Za-z])(${TRIG.join('|')})(?![A-Za-z])`, 'g'),
            (_, w) => { bump('trig'); return `\\${w}`; });
        s = s.replace(new RegExp(`(?<![\\\\A-Za-z{])(${TRIG_RU.join('|')})(?![A-Za-z}])`, 'g'),
            (_, w) => { bump('trig'); return `\\operatorname{${w}}`; });
        s = s.replace(new RegExp(`(?<![\\\\A-Za-z])(${GREEK.join('|')})(?![A-Za-z])`, 'g'),
            (_, w) => { bump('greek'); return `\\${w}`; });
        // "\cdot 103" is 10^3. Only ever applied where the item proves it has the defect;
        // see the caller — a bare "$100$ m" is a legitimate hundred metres.
        s = s.replace(/(\\cdot\s*)10(\d{1,2})(?!\^|\d)/g,
            (_, c, d) => { bump('exponent'); return `${c}10^{${d}}`; });
        return open + s + close;
    });
}

// Defects that are one-offs rather than a class, corrected by name instead of by rule.
// Every one was read against the Russian before being listed here.
//
// A general "bare 10NN is a flattened exponent" rule was tried and removed: it cannot tell
// 6.3.2's "$109$ cm/s" (really 10⁹) from 5.2.1's "$1001$ m/s" (really one thousand and
// one, sitting next to $999$), and it duly corrupted the latter. Of the 84 bare 10NN in
// the book all but four are honest hundreds and thousands — 5.5.17's "$1013$" is a real
// standard atmosphere in hPa — so naming the four is both safer and shorter than any rule.
//
//   13.4.2  "$456\circ$" between 30° and 60°; the Russian reads "30◦ , 45◦ , 60◦", so the
//           caret of "45^\circ" was read as a 6.
//   11.2.5  "the linear density of these $15$ currents"; the Russian has no such number —
//           a page number landed mid-sentence during typesetting.
//   12.2.3  "$\alpha_1 = \alpha-3$"; the Russian has "(α1 = α3 )", so the subscript
//           underscore was read as a hyphen.
//   6.3.2   electron at "$109$ cm/s", 10⁹ cm/s = 10⁷ m/s.
//   6.1.12  hydrogen electron at "$1016$ rad/s", 10¹⁶ rad/s.
//   8.2.4   ring at "$Omega = 103$ rad/s", 10³ rad/s. The Greek rule fixes \Omega; only
//           the exponent is listed here.
//
// 8.2.4 also reads "during the time $\pi = 10^{-3}$", where τ would be expected. That is
// left alone: the printed Russian says π too, so it is the book's own symbol choice and
// not a transcription defect. Correcting it would be editing Savchenko, not the OCR.
const ONE_OFFS = {
    '13.4.2': [[/\$456\\circ\$/g, '$45^\\circ$']],
    '11.2.5': [[/ \$15\$ currents/g, ' currents']],
    '12.2.3': [[/\\alpha-3/g, '\\alpha_3']],
    '6.3.2': [[/\$109\$/g, '$10^{9}$']],
    '6.1.12': [[/\$1016\$/g, '$10^{16}$']],
    '8.2.4': [[/(\\Omega = )103\b/g, '$1' + '10^{3}']],
};

function applyOneOffs(name, text) {
    for (const [re, to] of ONE_OFFS[name] || []) {
        const fixed = text.replace(re, to);
        if (fixed === text) throw new Error(`one-off correction for ${name} no longer matches — re-verify it`);
        bump('one-off');
        text = fixed;
    }
    return text;
}

// ── English, from the Overleaf TeX ──────────────────────────────────────────────────
function englishStatements() {
    const tex = fs.readFileSync(path.join(ROOT, 'src/database/main.tex'), 'utf8');
    const out = new Map();
    // 77 labelled enumerates, none nested, every \item at the start of a line.
    const block = /\\begin\{enumerate\}\[label=(\d{1,2}\.\d{1,2})\.\\arabic\*\]([\s\S]*?)\\end\{enumerate\}/g;
    let m;
    while ((m = block.exec(tex)) !== null) {
        const ref = m[1];
        const items = m[2].split(/^[ \t]*\\item\b/m).slice(1);
        items.forEach((raw, i) => {
            const figures = [...raw.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((f) => f[1]);
            let text = raw
                .replace(/\\begin\{center\}[\s\S]*?\\end\{center\}/g, ' ')  // figure blocks
                .replace(/\\includegraphics(?:\[[^\]]*\])?\{[^}]+\}/g, ' ')
                .replace(/\\label\{[^}]*\}/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{2,}/g, '\n')
                .trim();
            const name = `${ref}.${i + 1}`;
            text = applyOneOffs(name, repairMath(text));
            out.set(name, { text, texFigures: figures });
        });
    }
    return out;
}

// ── Russian, from the site's own markdown ───────────────────────────────────────────
// The statement header has four whitespace variants plus one typo, and the solution
// header that ends it has its own set. utils.js:664 buildMetaDescription does the same
// split in production; this is the widened version of that rule.
const STATEMENT_H = /^#{2,6}[ \t]*(Условие|Услловие|Задача|Statement|Problem Statement|Problem|Condition)[ \t]*:?[ \t]*$/im;
const SOLUTION_H = /^#{2,6}[ \t]*(Решение|Решения|Альтернативное решение|Ответ|Ответы|Solution|Alternative solution|Answer|Proof|Доказательство)/im;

// Statements open with their own number: "$1.1.1.$", "$ 1.1.1.$", or "$2.2.24^*.$" where
// the caret-star is Savchenko's harder-problem marker carried over from the book. The
// English TeX has no such prefix, so it is stripped for consistency — but the star has to
// be consumed with it. Miss it and 2.2.24 begins with the debris "^*.$".
const NUMBER_PREFIX = /^\s*\$?\s*\d{1,2}\.\d{1,2}\.\d{1,3}\s*(?:\^\s*\{?\s*[*∗]\s*\}?)?\s*\.?\s*\$?[.\s]*/;
const MD_STAR = /^\s*\$?\s*\d{1,2}\.\d{1,2}\.\d{1,3}\s*\^\s*\{?\s*[*∗]/;

function markdownStatement(md) {
    const s = md.match(STATEMENT_H);
    if (!s) return null;
    let body = md.slice(s.index + s[0].length);
    const e = body.match(SOLUTION_H);
    if (e) body = body.slice(0, e.index);
    const starred = MD_STAR.test(body);
    return { text: body.replace(NUMBER_PREFIX, '').trim(), mdStarred: starred };
}

function fromMarkdown(lang) {
    const dir = path.join(ROOT, 'posts', lang);
    const out = new Map();
    if (!fs.existsSync(dir)) return out;
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md')) continue;
        const name = file.slice(0, -3);
        if (!/^\d{1,2}\.\d{1,2}\.\d{1,3}$/.test(name)) continue;
        const parsed = markdownStatement(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (!parsed || !parsed.text) continue;
        // Image paths are stored as the site writes them, mojibake filenames included:
        // 4.2.22 references a Cyrillic screenshot name that was saved as UTF-8 bytes read
        // back as Latin-1. It resolves on disk, so "correcting" it would 404.
        const figures = [...parsed.text.matchAll(/!\[[^\]]*\]\(\.\.\/\.\.\/img\/([^)/]+)\/([^)]+)\)/g)]
            .map((f) => `/img/${f[1]}/${f[2]}`);
        out.set(name, { ...parsed, figures });
    }
    return out;
}

// ── figures on disk ─────────────────────────────────────────────────────────────────
function diskFigure(problem) {
    const p = path.join(ROOT, 'img', problem, 'statement.png');
    return fs.existsSync(p) ? `/img/${problem}/statement.png` : null;
}

async function main() {
    const problems = authoritativeProblems();
    const en = englishStatements();
    const ruMd = fromMarkdown('ru');
    const enMd = fromMarkdown('en');
    const pdfPath = path.join(ROOT, 'src/database/savchenko_ru_pdf.json');
    const pdf = fs.existsSync(pdfPath) ? JSON.parse(fs.readFileSync(pdfPath, 'utf8')) : {};

    console.log(`  authoritative problems : ${problems.length}`);
    console.log(`  english from TeX       : ${en.size}`);
    console.log(`  russian from markdown  : ${ruMd.size}`);
    console.log(`  russian from PDF       : ${Object.keys(pdf).length}`);

    // The markdown carries the star independently, as "$2.2.24^*.$". That is a second
    // witness to the same fact, transcribed by a different person from the same book, so
    // it audits scripts/extract-pdf-ru.py for free: agreement on the overlap means the
    // regex that produced the 565 is finding real markers, not artefacts of pdftotext.
    const audit = { both: 0, agree: 0, mdOnly: [], pdfOnly: [] };
    for (const name of problems) {
        const m = ruMd.get(name) || enMd.get(name);
        if (!m || !pdf[name]) continue;
        audit.both++;
        if (m.mdStarred === pdf[name].starred) audit.agree++;
        else if (m.mdStarred) audit.mdOnly.push(name);
        else audit.pdfOnly.push(name);
    }
    const pct = ((audit.agree / audit.both) * 100).toFixed(1);
    console.log(`\n  ∗ cross-check vs markdown: ${audit.agree}/${audit.both} agree (${pct}%)`);
    console.log(`    md says ∗, pdf does not : ${audit.mdOnly.length} ${audit.mdOnly.slice(0, 6).join(' ')}`);
    console.log(`    pdf says ∗, md does not : ${audit.pdfOnly.length} ${audit.pdfOnly.slice(0, 6).join(' ')}`);

    const rows = [];
    const missing = { en: [], ru: [] };

    for (const name of problems) {
        const [chapter, section, idx] = name.split('.').map(Number);
        const starred = Boolean(pdf[name] && pdf[name].starred);
        const fallbackFig = diskFigure(name);

        const e = en.get(name);
        if (!e || !e.text) missing.en.push(name);
        else {
            const figures = fallbackFig ? [fallbackFig] : [];
            rows.push([name, 'en', chapter, section, idx, e.text, figures, starred, 'tex', false]);
        }

        const md = ruMd.get(name);
        if (md && md.text) {
            const figures = md.figures.length ? md.figures : (fallbackFig ? [fallbackFig] : []);
            rows.push([name, 'ru', chapter, section, idx, md.text, figures, starred, 'md', false]);
        } else if (pdf[name] && pdf[name].text) {
            const figures = fallbackFig ? [fallbackFig] : [];
            // Flagged for review: pdftotext flattens the maths, so this is a faithful
            // transcription rather than valid LaTeX until repair-ru-latex.js runs.
            rows.push([name, 'ru', chapter, section, idx, pdf[name].text, figures, starred, 'pdf', true]);
        } else missing.ru.push(name);
    }

    // The English is a translation of the same statement, so any integer that appears in
    // the English and in neither the Russian nor the book has no physical origin. That is
    // how page numbers leak in — 11.2.5 reads "the linear density of these $15$ currents",
    // where 15 is the page it was typeset on. Reported, not auto-stripped: a wrong "fix"
    // to a physical constant is far worse than a stray numeral.
    const numbers = (s) => new Set((s.match(/\d+(?:[.,]\d+)?/g) || []).filter((n) => /^\d{1,3}$/.test(n)));
    const leaks = [];
    for (const name of problems) {
        const e = en.get(name);
        const ru = (ruMd.get(name) || {}).text || (pdf[name] || {}).text;
        if (!e || !ru) continue;
        const inRu = numbers(ru);
        const orphans = [...numbers(e.text)].filter((n) => !inRu.has(n) && !name.includes(n));
        if (orphans.length) leaks.push(`${name}:${orphans.join(',')}`);
    }
    console.log(`\n  english numerals absent from the Russian: ${leaks.length} problems`);
    console.log(`    ${leaks.slice(0, 12).join('  ')}`);
    console.log(`\n  math repairs applied: ${JSON.stringify(fixes)}`);

    const bySource = rows.reduce((a, r) => ({ ...a, [r[8]]: (a[r[8]] || 0) + 1 }), {});
    console.log(`\n  rows to write          : ${rows.length}`);
    console.log(`  by source              : ${JSON.stringify(bySource)}`);
    console.log(`  starred                : ${rows.filter((r) => r[7]).length / 2} problems`);
    console.log(`  with a figure          : ${rows.filter((r) => r[6].length).length}`);

    if (missing.en.length || missing.ru.length) {
        console.error(`\n  MISSING en: ${missing.en.length} ${missing.en.slice(0, 8)}`);
        console.error(`  MISSING ru: ${missing.ru.length} ${missing.ru.slice(0, 8)}`);
        console.error('\n  Refusing to write a partial table.');
        process.exit(1);
    }
    if (rows.length !== problems.length * 2) {
        console.error(`\n  expected ${problems.length * 2} rows, built ${rows.length}`);
        process.exit(1);
    }

    if (SAMPLE) {
        // One problem from each chapter, plus the calibration anchors named in the plan,
        // so a bad regex shows up as text rather than as a count that happens to add up.
        const want = ['1.1.1', '2.2.24', '3.4.6', '4.2.22', '5.2.1', '6.3.2', '7.3.5',
            '8.2.4', '9.1.5', '10.2.8', '11.2.5', '12.2.3', '13.4.2', '14.5.13'];
        for (const name of want) {
            for (const r of rows.filter((x) => x[0] === name)) {
                const [, lang, , , , text, figures, starred, source] = r;
                console.log(`\n── ${name} ${lang} [${source}]${starred ? ' ∗' : ''}${figures.length ? ` ${figures.join(' ')}` : ''}`);
                console.log(`   ${text.slice(0, 320).replace(/\n/g, '\n   ')}${text.length > 320 ? ' …' : ''}`);
            }
        }
        console.log();
    }
    if (DRY) { console.log('\n  --dry-run: nothing written.\n'); return; }

    const c = (k) => (process.env[k] || '').trim();
    const pool = new Pool({
        user: c('PG_USER'), host: c('PG_HOST'), database: c('PG_DATABASE'),
        password: c('PG_PASSWORD'), port: Number(c('PG_PORT')) || 5432,
        ssl: { rejectUnauthorized: c('PG_SSL_REJECT_UNAUTHORIZED') === 'true' },
    });
    await pool.query('BEGIN');
    try {
        for (const r of rows) {
            await pool.query(
                `INSERT INTO problem_statements
                   (problem_name, lang, chapter, section, idx, statement_tex, figures, starred, source, needs_review)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 ON CONFLICT (problem_name, lang) DO UPDATE SET
                   statement_tex = EXCLUDED.statement_tex, figures = EXCLUDED.figures,
                   starred = EXCLUDED.starred, source = EXCLUDED.source,
                   needs_review = EXCLUDED.needs_review, updated_at = now()`,
                r
            );
        }
        await pool.query('COMMIT');
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('  failed, rolled back:', err.message);
        process.exit(1);
    }
    const { rows: check } = await pool.query(
        'SELECT lang, count(*)::int n, count(*) FILTER (WHERE starred)::int starred FROM problem_statements GROUP BY lang ORDER BY lang'
    );
    console.log('\n  in database now:');
    for (const x of check) console.log(`    ${x.lang}: ${x.n} rows, ${x.starred} starred`);
    await pool.end();
}

// Guarded so the pure parts above can be unit-tested without opening a database
// connection or writing anything. See tests/statements.test.js.
if (require.main === module) main();
module.exports = { repairMath, applyOneOffs, markdownStatement, ONE_OFFS };
