#!/usr/bin/env node
/**
 * build-recommendations.js — assemble data/recommendations.json.
 *
 * Offline build. The website never calls the Claude API; `CLAUDE.md` permits
 * LLM use only for build-time metadata, which is what this is.
 *
 * Inputs are the cached outputs of scripts/discover-taxonomy.js (descriptions and
 * the earned rubric set) plus scripts/build-web-graph.py (authority). Most of the
 * Telegram work needs no further API calls — pass 1 already produced summaries,
 * topics, level, specificity and evidence per channel. The only new spend here is
 * a language pass over Latin-script channels, because the corpus mislabels every
 * Latin-script channel as "English" and that silently hides the Uzbek ones, who
 * are the site's highest-engagement language segment.
 *
 * Usage:
 *   node scripts/build-recommendations.js --dry-run
 *   node scripts/build-recommendations.js --budget 1.00
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const corpus = require('./lib/corpus');
const { Client, mapLimit, chunk } = require('./lib/anthropic');

const STATE = path.join(__dirname, '..', 'data', '.build');
const OUT = path.join(__dirname, '..', 'data', 'recommendations.json');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
const has = (f) => process.argv.includes(f);

/**
 * Disposition per discovered rubric.
 *
 * The rule, from the project owner: STEM stays but in its own clearly-labelled
 * rubric; anything that is not STEM is thrown away. `core` rubrics are the ones a
 * student working a physics problem book actually wants, and they alone appear on
 * the landing grid.
 */
const DISPOSITION = {
    olympiad_problem_solving: 'core',
    entrance_exam_prep: 'core',
    physics_concepts_resources: 'core',
    astronomy_olympiad: 'core',

    // STEM, but not problem-book material. Kept so it can be found deliberately —
    // and, just as importantly, so it stays out of the rubrics above.
    university_announcements: 'adjacent',
    research_seminars: 'adjacent',
    research_news_preprints: 'adjacent',
    institutional_news_noninstructional: 'adjacent',
    popular_science: 'adjacent',

    // Not STEM content: job boards, funding notices, consulting, personal brands.
    industry_jobs_funding: 'cut',
    not_physics_education: 'cut',
};

const RUBRIC_NAMES = {
    olympiad_problem_solving: { en: 'Olympiad problems', ru: 'Олимпиадные задачи' },
    entrance_exam_prep: { en: 'Entrance exams', ru: 'Вступительные экзамены' },
    physics_concepts_resources: { en: 'Theory and materials', ru: 'Теория и материалы' },
    astronomy_olympiad: { en: 'Astronomy olympiad', ru: 'Олимпиадная астрономия' },
    university_announcements: { en: 'University announcements', ru: 'Объявления вузов' },
    research_seminars: { en: 'Seminars', ru: 'Семинары' },
    research_news_preprints: { en: 'Research news', ru: 'Новости исследований' },
    institutional_news_noninstructional: { en: 'Institutional news', ru: 'Новости учреждений' },
    popular_science: { en: 'Popular science', ru: 'Научпоп' },
    mathematics: { en: 'Mathematics', ru: 'Математика' },
    informatics: { en: 'Informatics', ru: 'Информатика' },
};

/**
 * Per-entry corrections, applied after tagging.
 *
 * Kept here rather than hand-edited into data/recommendations.json so they
 * survive a rebuild — the artifact is regenerated from scratch every run, and an
 * edit made in the output would silently vanish the next time.
 */
const ENTRY_OVERRIDES = {
    // A directory must not recommend the site it lives on.
    'savchenkosolutions.com': { drop: true },
    'narod.ru': {
        // The upstream registry lists this as covering Savchenko. Drop that
        // association: this site charges per problem, and Savchenko solutions are
        // what savchenkosolutions.com itself publishes for free.
        dropBooks: ['Savchenko'],
        strip: [/\s*и\s+Савченко/gi, /\s*and\s+Savchenko/gi, /\s*,?\s*Савченко/gi, /\s*,?\s*Savchenko/gi],
    },
};

/** Apply any override for this entry, in place. @returns false if it should be dropped. */
function applyOverride(entry) {
    const o = ENTRY_OVERRIDES[entry.id];
    if (!o) return true;
    if (o.drop) return false;
    if (o.dropBooks && Array.isArray(entry.books)) {
        entry.books = entry.books.filter((b) => !o.dropBooks.includes(b));
    }
    for (const re of (o.strip || [])) {
        for (const field of ['summaryRu', 'summaryEn', 'evidence', 'title']) {
            if (entry[field]) entry[field] = entry[field].replace(re, '').replace(/\s{2,}/g, ' ').trim();
        }
    }
    return true;
}


/**
 * Crawl-pipeline bookkeeping that must never be shown as a description.
 *
 * The website `evidence` line falls back to a site's trailing comment in
 * sites.yaml, and those comments were written for the person running the crawl,
 * not for a reader: "(verify)" meant unconfirmed at authoring time, "already in
 * sites.yaml" is a dedupe note, "pdf_book_host | search-discovery" is an internal
 * tag pair, "incomplete cert chain" is a TLS workaround. Better to show no quote
 * than to show the scaffolding.
 */
const INTERNAL_NOTE = [
    /\(verify\)/i,
    /already in sites\.yaml/i,
    /search-discovery/i,
    /incomplete cert/i,
    /\bTIER\s*\d/i,
    /\bssc=\d/i,
    /root \d{3}\b/i,
    /\bTODO\b/i,
    /^\s*[-?\s]*$/,
];

/** @returns the quote, or '' when it is pipeline scaffolding rather than prose. */
function cleanEvidence(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (INTERNAL_NOTE.some((re) => re.test(t))) return '';
    // A bare "tag_a | tag_b" pair is an internal taxonomy, not a sentence.
    if (/^[a-z0-9_]+(\s*\|\s*[a-z0-9_]+)+$/i.test(t)) return '';
    return t;
}

const SCRIPT = {
    cyrillic: /[Ѐ-ӿ]/,
    arabic: /[؀-ۿ]/,
    han: /[一-鿿]/,
    devanagari: /[ऀ-ॿ]/,
    hangul: /[가-힯]/,
};

/**
 * Script detection by DOMINANT script, not first match.
 *
 * The previous version tested Cyrillic first and returned immediately, so a
 * single stray Cyrillic character anywhere in the text labelled the whole entry
 * Russian. That is how "فیزیک‌سرای دانشگاه کاشان" — a wholly Persian title —
 * ended up tagged `ru` and sorted to the top of a Russian reader's page. Counting
 * characters and taking the majority makes one stray character harmless.
 */
const SCRIPT_RANGES = [
    ['cyrillic', /[\u0400-\u04FF]/g],
    ['arabic', /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF]/g],
    ['han', /[\u4E00-\u9FFF]/g],
    ['devanagari', /[\u0900-\u097F]/g],
    ['hangul', /[\uAC00-\uD7AF]/g],
    ['latin', /[A-Za-z]/g],
];

function scriptLanguage(text) {
    const s = String(text || '');
    if (!s.trim()) return null;

    const counts = {};
    for (const [name, re] of SCRIPT_RANGES) counts[name] = (s.match(re) || []).length;

    // Latin is the tiebreaker of last resort: Persian and Russian pages routinely
    // carry Latin URLs and handles, which would otherwise win on raw count.
    const nonLatin = SCRIPT_RANGES.filter(([n]) => n !== 'latin').map(([n]) => n);
    let best = null;
    let bestCount = 0;
    for (const n of nonLatin) {
        if (counts[n] > bestCount) { best = n; bestCount = counts[n]; }
    }
    // A non-Latin script wins if it is present at all in meaningful quantity.
    if (best && bestCount >= 2) {
        if (best === 'cyrillic') {
            if (/[әғқңөұүһ]/i.test(s)) return 'kk';
            if (/[іїєґ]/i.test(s)) return 'uk';
            return 'ru';
        }
        if (best === 'arabic') return /[پچژگ]/.test(s) ? 'fa' : 'ar';
        if (best === 'han') return 'zh';
        if (best === 'devanagari') return 'hi';
        if (best === 'hangul') return 'ko';
    }
    return null; // Latin script — undetermined, resolved by the LLM pass below.
}

const LANG_SCHEMA = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    i: { type: 'integer' },
                    lang: {
                        type: 'string',
                        enum: ['en', 'uz', 'tr', 'az', 'es', 'pt', 'id', 'vi', 'fr', 'de',
                            'ro', 'pl', 'it', 'sw', 'other'],
                    },
                },
                required: ['i', 'lang'],
                additionalProperties: false,
            },
        },
    },
    required: ['results'],
    additionalProperties: false,
};

/**
 * The corpus derives language from Unicode script alone and buckets everything
 * Latin as "English" — 176 channels in its own count. That bucket actually holds
 * Uzbek, Turkish, Azeri, Portuguese, Spanish and Indonesian channels. Uzbek
 * visitors have the highest engagement rate of any language on the site (72.9%),
 * so publishing them as English would hide exactly the audience that engages most.
 */
async function resolveLatinLanguages(client, entries) {
    const latin = entries.filter((e) => !e.language);
    if (!latin.length || !client) return;
    console.log(`  resolving language for ${latin.length} Latin-script entries`);
    const batches = chunk(latin, 40);
    const out = await mapLimit(batches, 4, async (batch) => {
        const user = batch.map((e, n) => `${n + 1}. ${e.title} — ${(e.summaryEn || '').slice(0, 110)}`).join('\n');
        const r = await client.json({
            system: 'Identify the language each channel is written in, from its title and description. '
                + 'These are all Latin-script, so do not default to English — many are Uzbek, Turkish, '
                + 'Azeri, Portuguese, Spanish or Indonesian. Return an ISO 639-1 code.',
            user,
            schema: LANG_SCHEMA,
            maxTokens: 20 * batch.length + 120,
        });
        return { batch, r };
    });
    for (const res of out) {
        if (!res || res.__error) continue;
        const byIndex = new Map((res.r.results || []).map((x) => [x.i, x.lang]));
        res.batch.forEach((e, n) => { e.language = byIndex.get(n + 1) || 'en'; });
    }
    for (const e of latin) if (!e.language) e.language = 'en';
}


const SITE_LANG_SCHEMA = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    i: { type: 'integer' },
                    lang: {
                        type: 'string',
                        enum: ['ru', 'uk', 'kk', 'be', 'uz', 'en', 'de', 'fr', 'es', 'pt', 'it',
                            'pl', 'cs', 'ro', 'bg', 'hu', 'he', 'tr', 'az', 'fa', 'ar', 'zh',
                            'ja', 'ko', 'vi', 'th', 'id', 'hi', 'other'],
                    },
                },
                required: ['i', 'lang'],
                additionalProperties: false,
            },
        },
    },
    required: ['results'],
    additionalProperties: false,
};

/**
 * Detect the language a site's CONTENT is written in.
 *
 * The country code in a domain is not the language: aversev.by and 4ipho.ru and
 * sdamgia.ru all publish in Russian, and getting that wrong hid them from the
 * Russian page entirely. So this asks about the content and treats the TLD as a
 * hint only.
 */
async function resolveSiteLanguages(client, entries) {
    const need = entries.filter((e) => !e.language || e.language === 'und' || e.language.length > 2);
    if (!need.length || !client) return;
    console.log(`  detecting language for ${need.length} sites`);
    const batches = chunk(need, 40);
    const out = await mapLimit(batches, 5, async (batch) => {
        const user = batch.map((e, n) =>
            `${n + 1}. ${e.id} — ${(e.summaryEn || e.evidence || '').slice(0, 120)}`).join('\n');
        const r = await client.json({
            system: 'For each site, give the language its CONTENT is written in, as an ISO 639-1 code. '
                + 'The country code in the domain is only a hint, not the answer: most .by, .kz and '
                + '.uz educational sites publish in Russian, while .ua sites may be Ukrainian or Russian. '
                + 'Judge from the description and what you know of the site. Never answer "other" if a '
                + 'specific language is plausible.',
            user,
            schema: SITE_LANG_SCHEMA,
            maxTokens: 20 * batch.length + 150,
        });
        return { batch, r };
    });
    for (const res of out) {
        if (!res || res.__error) { console.log(`  ! language batch failed: ${res?.__error}`); continue; }
        const byIndex = new Map((res.r.results || []).map((x) => [x.i, x.lang]));
        res.batch.forEach((e, n) => { e.language = byIndex.get(n + 1) || e.language; });
    }
    // Last resort: infer from the TLD rather than shipping an "undetermined"
    // bucket, which is a filter value no reader can act on.
    const TLD = { ru: 'ru', by: 'ru', kz: 'ru', ua: 'uk', uz: 'uz', pl: 'pl', de: 'de', fr: 'fr',
        cz: 'cs', ro: 'ro', bg: 'bg', hu: 'hu', il: 'he', tr: 'tr', cn: 'zh', jp: 'ja',
        kr: 'ko', vn: 'vi', th: 'th', id: 'id', ir: 'fa', in: 'en', br: 'pt', es: 'es', it: 'it' };
    for (const e of entries) {
        if (e.language && e.language !== 'und' && e.language.length === 2) continue;
        e.language = TLD[String(e.id).split('.').pop()] || 'en';
    }
}

/**
 * Genericity — a computed flag, not an assertion.
 *
 * Three independent signals, because any one alone is gameable: the model's own
 * specificity read, an audience-to-citation ratio (a large following that the
 * physics graph does not cite is the signature of a general-interest channel that
 * merely mentions physics), and topic breadth. `@science` at 120,000 subscribers
 * and `gleb_solomin` at 58,500 are what this is for.
 */
function isGeneric(entry) {
    if (entry.specificity === 'general') return true;
    const subs = entry.subscribers || 0;
    if (subs >= 20000 && (entry.inRefs || 0) <= 2) return true;
    if ((entry.topics || []).length >= 4 && entry.specificity !== 'focused') return true;
    return false;
}

/**
 * Rank inside a rubric.
 *
 *   authority^alpha  x  tag lift  x  audience fit
 *
 * Authority alone puts the biggest institutional accounts on top of every rubric.
 * The lift term is TF-IDF's idea applied to the tag dimension: an entry that is
 * distinctively about a tag outranks a larger generalist that merely touches it.
 * Audience fit encodes who this catalog is actually for — school and olympiad
 * level, a language the reader reads, alive, and specific.
 */
/**
 * How much of this site's real audience can read a given language.
 *
 * Measured, not guessed. From GA (bots excluded): Russia 30.7%, Belarus 4.7%,
 * Kazakhstan 4.6%, Ukraine 1.8%, Uzbekistan 1.0%, Kyrgyzstan 0.8% — against
 * United States 6.7%, India 1.7%, Germany 1.4%. Iran is 203 users, about 0.1%.
 *
 * The corpus does not reflect that at all: 125 of the 600 kept entries are
 * Persian, 21% of the catalog serving a tenth of a percent of readers. Without
 * this term a Persian channel with strong graph position outranks Лютый Физик in
 * a Russian student's olympiad rubric, which is precisely the failure this whole
 * ranking exists to prevent. Language is a filter in the UI as well; this weight
 * governs the DEFAULT order for someone who has not filtered.
 */
const AUDIENCE_LANGUAGE_FIT = {
    ru: 1.0, uk: 0.9, kk: 0.9, uz: 0.9, be: 0.9,
    en: 0.8,
    az: 0.5, tr: 0.4, hy: 0.5, ka: 0.5, ro: 0.4,
    fa: 0.15, ar: 0.15, zh: 0.15, hi: 0.2, ko: 0.15, vi: 0.2,
};

function scoreFor(entry, tag, prevalence, total) {
    const authority = Math.pow(1 + (entry.inRefs || 0), 0.7);
    const p = prevalence.get(tag) || 1;
    const lift = Math.min(4, (total / p) ** 0.35);

    let fit = AUDIENCE_LANGUAGE_FIT[entry.language] ?? 0.35;
    if (entry.level === 'olympiad' || entry.level === 'school' || entry.level === 'exam_prep') fit *= 1.35;
    if (entry.level === 'research') fit *= 0.75;
    if (entry.generic) fit *= 0.25;
    if (entry.lowConfidence) fit *= 0.8;
    if (!entry.evidence) fit *= 0.85;
    return authority * lift * fit;
}

/** Pairwise Jaccard within a facet. Two tags above the limit are one tag. */
function distinctness(entries, facet, limit = 0.6) {
    const sets = new Map();
    for (const e of entries) {
        const values = facet === 'topics' ? (e.topics || []) : (e[facet] ? [e[facet]] : []);
        for (const v of values) {
            if (!sets.has(v)) sets.set(v, new Set());
            sets.get(v).add(e.id);
        }
    }
    const tags = [...sets.entries()].filter(([, s]) => s.size >= 5);
    const pairs = [];
    for (let i = 0; i < tags.length; i += 1) {
        for (let j = i + 1; j < tags.length; j += 1) {
            const [an, a] = tags[i]; const [bn, b] = tags[j];
            let inter = 0;
            for (const id of a) if (b.has(id)) inter += 1;
            const jac = inter / (a.size + b.size - inter);
            pairs.push({ a: an, b: bn, jaccard: jac, violates: jac > limit });
        }
    }
    return { facet, tags: tags.length, pairs: pairs.sort((x, y) => y.jaccard - x.jaccard) };
}

// ---------------------------------------------------------------- main

(async () => {
    const budget = parseFloat(arg('--budget', '1.00'));
    const dryRun = has('--dry-run');

    const pass1Path = path.join(STATE, 'telegram-pass1.json');
    const taxPath = path.join(STATE, 'telegram-taxonomy.json');
    for (const p of [pass1Path, taxPath]) {
        if (!fs.existsSync(p)) {
            console.error(`missing ${path.relative(process.cwd(), p)} — run scripts/discover-taxonomy.js first`);
            process.exit(1);
        }
    }

    const client = dryRun ? null : new Client({ apiKey: process.env.ANTHROPIC_API_KEY, budget });

    const described = JSON.parse(fs.readFileSync(pass1Path, 'utf8')).described;
    const tax = JSON.parse(fs.readFileSync(taxPath, 'utf8'));
    const rubricOf = new Map();
    for (const [rubricId, usernames] of Object.entries(tax.assignments || {})) {
        for (const u of usernames) rubricOf.set(u, rubricId);
    }

    console.log(`telegram: ${described.length} described, ${tax.rubrics.length} rubrics earned a place`);

    // Assemble, applying disposition.
    const entries = [];
    const cut = { rubric: 0, notEducation: 0 };
    for (const d of described) {
        let rubric = rubricOf.get(d.username);
        const disposition = DISPOSITION[rubric] || 'adjacent';

        if (disposition === 'cut') {
            // One carve-out: maths and informatics are STEM, so per the owner's
            // rule they move to their own labelled rubric instead of being dropped.
            const text = `${d.purpose} ${d.summaryEn}`.toLowerCase();
            if (/\bmath|olympiad math|geometry|algebra/.test(text) && !/physic/.test(text)) rubric = 'mathematics';
            else if (/informatic|programming|computer olympiad|coding/.test(text)) rubric = 'informatics';
            else { cut.rubric += 1; continue; }
        }
        if (!d.isPhysicsEducation && !['mathematics', 'informatics'].includes(rubric)
            && DISPOSITION[rubric] === 'core') {
            // The model says this is not physics education but the rubric is a core
            // one — trust the per-channel read over the cluster.
            cut.notEducation += 1;
            continue;
        }

        const e = {
            id: d.username,
            type: 'telegram',
            url: `https://t.me/${d.username}`,
            title: corpus.stripEmoji(d.title) || d.username,
            summaryEn: corpus.stripEmoji(d.summaryEn),
            summaryRu: corpus.stripEmoji(d.summaryRu),
            evidence: cleanEvidence(corpus.stripEmoji(d.evidence)).slice(0, 200),
            rubric,
            rubricClass: DISPOSITION[rubric] || 'adjacent',
            topics: d.topics || [],
            level: d.level,
            format: d.kind === 'group' ? 'group' : 'channel',
            subscribers: d.subscribers ?? null,
            inRefs: d.inRefs || 0,
            pagerank: d.pagerank || 0,
            messages: d.messages || 0,
            lowConfidence: !!d.lowConfidence,
            specificity: d.specificity,
            // TITLE ONLY. The evidence field cannot be trusted for this: it was
            // meant to be a verbatim post excerpt, but the model sometimes returns a
            // Russian translation instead — @phskashan has a wholly Persian title
            // and an evidence line carrying 119 Cyrillic characters against 21
            // Arabic, which detected as Russian and put a Persian channel at the top
            // of a Russian reader's page. A title is the channel's own text and is
            // never paraphrased; Latin-script titles fall through to the LLM pass.
            language: scriptLanguage(d.title),
        };
        e.generic = isGeneric(e);
        if (e.generic) { e.rubric = 'general'; e.rubricClass = 'general'; }
        entries.push(e);
    }

    console.log(`  cut ${cut.rubric} (non-STEM rubric) + ${cut.notEducation} (not physics education)`);
    console.log(`  kept ${entries.length}`);
    const generic = entries.filter((e) => e.generic).length;
    console.log(`  quarantined as general-audience: ${generic}`);

    if (!dryRun) {
        await resolveLatinLanguages(client, entries);
    } else {
        const latin = entries.filter((e) => !e.language).length;
        console.log(`  [dry-run] would resolve language for ${latin} Latin-script entries`);
        for (const e of entries) if (!e.language) e.language = 'und';
    }

    for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (!applyOverride(entries[i])) entries.splice(i, 1);
    }

    // Ranking.
    const prevalence = new Map();
    for (const e of entries) prevalence.set(e.rubric, (prevalence.get(e.rubric) || 0) + 1);
    for (const e of entries) e.score = Number(scoreFor(e, e.rubric, prevalence, entries.length).toFixed(4));
    entries.sort((a, b) => b.score - a.score);

    // Distinctness gate.
    console.log('\ndistinctness (pairwise Jaccard within facet)');
    const gates = ['rubric', 'level', 'topics'].map((f) => distinctness(entries, f));
    let violations = 0;
    for (const g of gates) {
        const worst = g.pairs[0];
        console.log(`  ${g.facet.padEnd(8)} ${String(g.tags).padStart(3)} tags, `
            + `worst overlap ${worst ? `${worst.a} vs ${worst.b} = ${worst.jaccard.toFixed(3)}` : 'n/a'}`);
        violations += g.pairs.filter((p) => p.violates).length;
    }
    console.log(violations ? `  ! ${violations} pairs exceed the limit` : '  all facets pass');

    const langCounts = {};
    for (const e of entries) langCounts[e.language] = (langCounts[e.language] || 0) + 1;

    // ---------------------------------------------------------------- websites
    // Clustered separately from Telegram on purpose: problem archives and textbook
    // solution sets have no Telegram analogue, and Telegram has study chats and
    // admissions channels the web corpus lacks.
    const webEntries = [];
    const webRubricMeta = [];
    const webPass1 = path.join(STATE, 'websites-pass1.json');
    const webTax = path.join(STATE, 'websites-taxonomy.json');
    if (fs.existsSync(webPass1) && fs.existsSync(webTax)) {
        const wd = JSON.parse(fs.readFileSync(webPass1, 'utf8')).described || [];
        const wt = JSON.parse(fs.readFileSync(webTax, 'utf8'));
        const wRubricOf = new Map();
        for (const [id, domains] of Object.entries(wt.assignments || {})) {
            for (const d of domains) wRubricOf.set(d, id);
        }
        /**
         * Same rule as Telegram: STEM stays in its own labelled rubric, non-STEM is
         * thrown away. The two big non-STEM clusters here are news/culture (160) and
         * infrastructure platforms (111) — CDNs, hosting, generic SaaS that the crawl
         * picked up because everything links to it. Neither belongs in a catalog for
         * students, and leaving them in would put 271 useless rows in front of the
         * 272 useful ones.
         */
        const WEB_DISPOSITION = {
            olympiad_problems_solutions: 'core',
            textbook_problem_solutions: 'core',
            physics_theory_reference: 'core',
            exam_preparation: 'core',
            interactive_learning: 'core',

            university_portals: 'adjacent',
            research_papers_journals: 'adjacent',
            general_reference: 'adjacent',

            news_culture_unrelated: 'cut',
            infrastructure_platforms: 'cut',
        };

        const surviving = new Set((wt.rubrics || [])
            .filter((r) => (WEB_DISPOSITION[r.id] || 'adjacent') !== 'cut')
            .map((r) => r.id));
        for (const r of wt.rubrics || []) {
            const cls = WEB_DISPOSITION[r.id] || (r.serves_core_audience ? 'core' : 'adjacent');
            if (cls === 'cut') continue;
            webRubricMeta.push({ id: r.id, en: r.name_en, ru: r.name_ru, class: cls, count: 0 });
        }
        for (const d of wd) {
            const rubric = wRubricOf.get(d.domain);
            if (!rubric || !surviving.has(rubric)) continue;
            if (!d.usefulToStudents && (webRubricMeta.find((r) => r.id === rubric) || {}).class === 'core') continue;
            webEntries.push({
                id: d.domain,
                type: 'website',
                url: d.url && d.url.startsWith('http') ? d.url : `https://${d.domain}`,
                title: d.domain,
                summaryEn: corpus.stripEmoji(d.summaryEn),
                summaryRu: corpus.stripEmoji(d.summaryRu),
                evidence: cleanEvidence(corpus.stripEmoji(d.evidence)).slice(0, 200),
                rubric,
                rubricClass: (webRubricMeta.find((r) => r.id === rubric) || {}).class || 'adjacent',
                topics: d.topics || [],
                level: d.level,
                // 120 of the 186 sites with a capability profile run a forum or Q&A.
                // "Somewhere I can actually ask when stuck" is one of the strongest
                // needs this catalog serves, and it was sitting unused in the data.
                format: (d.features && d.features.forumQa) ? 'forum' : 'site',
                // The website graph's own diagnostics showed PageRank compressing to
                // 1.98x while in-degree spans 4x, so in-degree is the number shown.
                inRefs: d.citedBy || 0,
                pagerank: d.pagerank || 0,
                books: d.books || [],
                paywall: !!(d.features && d.features.paywall),
                language: null, // detected below; the registry field is too sparse and inconsistent
                generic: false,
                // Computed from the CLEANED quote: an entry whose only note turned
                // out to be crawl scaffolding has nothing supporting its tags, and
                // must say so rather than look as well-sourced as the rest.
                lowConfidence: !cleanEvidence(d.evidence),
            });
        }
        for (let i = webEntries.length - 1; i >= 0; i -= 1) {
            if (!applyOverride(webEntries[i])) webEntries.splice(i, 1);
        }
        await resolveSiteLanguages(client, webEntries);

        const wPrev = new Map();
        for (const e of webEntries) wPrev.set(e.rubric, (wPrev.get(e.rubric) || 0) + 1);
        for (const e of webEntries) {
            e.score = Number(scoreFor(e, e.rubric, wPrev, webEntries.length).toFixed(4));
        }
        webEntries.sort((a, b) => b.score - a.score);
        for (const r of webRubricMeta) r.count = wPrev.get(r.id) || 0;
        console.log(`\nwebsites: ${webEntries.length} entries across `
            + `${webRubricMeta.filter((r) => r.count).length} rubrics`);
    } else {
        console.log('\nwebsites: no tagged data yet (run scripts/tag-websites.js) — tab will be empty');
    }

    const byRubric = {};
    for (const e of entries) (byRubric[e.rubric] ||= []).push(e.id);

    const catalog = {
        generated: new Date().toISOString().slice(0, 10),
        method: {
            taxonomy: 'discovered by clustering free-text purposes derived from posts sampled '
                + 'across each channel lifetime; rubrics kept only above a member floor',
            authority: 'in_refs — how many other catalog members cite this entry',
            ranking: 'authority^0.7 x tag-lift x audience-fit',
        },
        rubrics: [
            ...Object.entries(RUBRIC_NAMES)
                .filter(([id]) => byRubric[id]?.length)
                .map(([id, n]) => ({
                    id, ...n,
                    class: DISPOSITION[id] || 'adjacent',
                    count: byRubric[id].length,
                })),
            ...webRubricMeta.filter((r) => r.count > 0),
        ],
        telegram: { entries },
        websites: { entries: webEntries },
        diagnostics: {
            described: described.length,
            kept: entries.length,
            cut,
            generic,
            languages: langCounts,
            distinctness: gates,
        },
    };

    if (dryRun) {
        console.log('\n[dry-run] not writing. projected spend for the language pass: '
            + `~$${(entries.filter((e) => e.language === 'und').length * 0.00008).toFixed(3)}`);
        process.exit(0);
    }

    fs.writeFileSync(OUT, JSON.stringify(catalog, null, 1));
    console.log(`\nwrote ${path.relative(process.cwd(), OUT)} (${entries.length} entries, `
        + `${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`);
    console.log('languages:', Object.entries(langCounts).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`).join(' '));
    if (client) {
        const r = client.report();
        console.log(`spend: $${r.spent.toFixed(4)} of $${budget.toFixed(2)}`);
    }
})();
