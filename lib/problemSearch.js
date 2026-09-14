// Text search for /<lang>/problems — where the header search, /find and the old
// /global-search URLs land since 2026-09-14. There used to be a separate results page with a
// design of its own; the owner wanted one place to look for problems, so a query is now just
// another filter on the problem finder, and its results are the finder's cards.
//
// One ranked list of problem numbers per query, from two sources:
//   1. the statements (problem_statements, both languages) — the only text an unsolved
//      problem has, and what a query usually describes;
//   2. the solutions (searchIndex.js, the posts/ full-text index the header's live
//      suggestions use).
// Statement hits come first. A problem found only through its solution carries a snippet, so
// its card can show where the words were.
//
// A problem number ("2.1.32", "2.1") is not searched as text: the finder already matches
// numbers by prefix, and as text its digits hit hundreds of unrelated formulas.

const { Index } = require('flexsearch');
const searchIndex = require('../searchIndex');

const STATEMENT_TTL_MS = 60 * 60 * 1000;
const MAX_RESULTS = 400;

let statementCache = { at: 0, index: null, names: [] };
let building = null;

function isProblemNumberQuery(q) {
    return /^\d{1,2}([.,]\d{0,2}([.,]\d{0,3})?)?$/.test(String(q || '').replace(/\s+/g, ''));
}

// Both indexes match words by prefix, and Russian changes a word's ending with its case:
// "трение" is a prefix of none of "трения", "трением", so the query found 45 problems where 144
// statements say it. Each query word therefore loses a common inflectional ending first (never
// below four letters), and the stem is searched: "трен", "пружин", "сохранен". English plurals
// lose their s the same way. A crude stemmer, but the index only ever needs a prefix.
const RU_ENDINGS = ['иями', 'ями', 'ами', 'ией', 'иям', 'иях', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими',
    'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ый', 'ий', 'ой', 'ую', 'юю', 'ов', 'ев', 'ах', 'ях', 'ом', 'ем',
    'ам', 'ям', 'ию', 'ия', 'ии', 'ей', 'ью', 'ь', 'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'й'];

function stemWord(word) {
    const w = word.toLowerCase();
    if (/[а-яё]/.test(w)) {
        for (const ending of RU_ENDINGS) {
            if (w.endsWith(ending) && w.length - ending.length >= 4) return w.slice(0, -ending.length);
        }
        return w;
    }
    if (/^[a-z]+$/.test(w)) {
        if (w.length > 5 && /(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
        if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    }
    return w;
}

function queryTerms(q) {
    return String(q || '').split(/[\s,.;:!?()«»"]+/).filter(Boolean).map(stemWord);
}

function buildStatementIndex(rows) {
    const index = new Index({ tokenize: 'forward', resolution: 9 });
    const names = [];
    rows.forEach((row, i) => {
        names[i] = row.problem_name;
        index.add(i, searchIndex.stripLatexAndMarkdown(String(row.statement_tex || '')));
    });
    return { index, names };
}

async function statementIndex(pool) {
    if (statementCache.index && Date.now() - statementCache.at < STATEMENT_TTL_MS) return statementCache;
    if (!building) {
        building = pool.query('SELECT problem_name, statement_tex FROM problem_statements ORDER BY problem_name, lang')
            .then(({ rows }) => {
                statementCache = { at: Date.now(), ...buildStatementIndex(rows) };
                return statementCache;
            })
            .catch((err) => {
                if (err.code !== '42P01') console.error('problem search statements:', err.message);
                return statementCache;
            })
            .finally(() => { building = null; });
    }
    return building;
}

// Statement hits in their own order, then solution-only hits with their snippets; each
// problem once.
function mergeHits(statementNames, solutionResults, limit = MAX_RESULTS) {
    const names = [];
    const snippets = {};
    const seen = new Set();
    for (const name of statementNames) {
        if (seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    for (const r of solutionResults) {
        if (seen.has(r.problemName)) continue;
        seen.add(r.problemName);
        names.push(r.problemName);
        if (r.snippet) snippets[r.problemName] = r.snippet;
    }
    const kept = names.slice(0, limit);
    for (const name of Object.keys(snippets)) if (!kept.includes(name)) delete snippets[name];
    return { names: kept, snippets };
}

async function searchProblems(pool, query, lang) {
    const q = String(query || '').trim().slice(0, 200);
    if (q.length < 2 || isProblemNumberQuery(q)) return { q, terms: [], names: [], snippets: {} };
    const terms = queryTerms(q);
    const stemmed = terms.join(' ');
    if (!stemmed) return { q, terms, names: [], snippets: {} };
    const { index, names } = await statementIndex(pool);
    const statementNames = index ? index.search(stemmed, { limit: MAX_RESULTS * 2 }).map((id) => names[id]).filter(Boolean) : [];
    let solutions = [];
    try {
        solutions = searchIndex.search(stemmed, lang === 'ru' ? 'ru' : 'en', MAX_RESULTS);
    } catch (err) {
        console.error('problem search solutions:', err.message);
    }
    return { q, terms, ...mergeHits(statementNames, solutions) };
}

module.exports = { searchProblems, mergeHits, buildStatementIndex, isProblemNumberQuery, stemWord, queryTerms };
