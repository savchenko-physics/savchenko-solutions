#!/usr/bin/env node
/**
 * verify-subject.js — settle a site's subject from its own pages, not from a note.
 *
 * problems.ru shipped as the top entry of "Олимпиадные задачи и соревнования".
 * It is a mathematics archive. The subject pass had one line to go on — the
 * corpus note "huge RU olympiad DB" — and reasonably guessed "mixed", which was
 * enough to keep it in a physics rubric and at the top of it.
 *
 * The fix is not a better prompt on the same thin input. These sites have
 * thousands of crawled pages, and a list of their page TITLES answers the
 * question outright: a site whose titles read "Планиметрия", "Теория чисел",
 * "Комбинаторика" is a maths site, whatever its one-line note says. Titles are
 * also cheap — a few thousand characters covers a whole site's subject mix.
 *
 * Only entries sitting in a physics rubric while classified as something other
 * than physics or astronomy are re-judged; the rest are not in question.
 *
 * A site judged `math` is moved to the mathematics rubric. It is not removed —
 * problems.ru is excellent and a physics olympiad student does use it. It just
 * stops being the first thing shown to someone looking for physics problems.
 *
 * Usage: node scripts/verify-subject.js --budget 0.12
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const corpus = require('./lib/corpus');
const { Client, chunk, mapLimit } = require('./lib/anthropic');

const STATE = path.join(__dirname, '..', 'data', '.build');
const FIT = path.join(STATE, 'rank-fit.json');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };

/** Rubrics that promise physics. An entry here must actually be physics. */
const PHYSICS_RUBRICS = new Set([
    'olympiad_problems', 'problem_sets_and_solutions', 'physics_theory_and_reference',
    'exams_and_entrance_prep', 'homework_help_and_qa', 'lecture_notes_and_courses',
]);

/**
 * Page titles across a site, which is what reveals its subject mix. Reads a
 * bounded prefix — these files run to 1.3 GB.
 */
function sampleTitles(corpusRoot, siteIds, want = 45) {
    const titles = [];
    const seen = new Set();
    for (const sid of siteIds) {
        const file = path.join(corpusRoot, '01_competitors', sid, 'pages.jsonl');
        if (!fs.existsSync(file)) continue;
        let fd;
        try {
            fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(3 * 1024 * 1024);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
                if (titles.length >= want) break;
                if (!line.trim()) continue;
                let rec;
                try { rec = JSON.parse(line); } catch { continue; }
                const t = corpus.sanitizeText(String(rec.title || '')).replace(/\s+/g, ' ').trim();
                if (!t || t.length < 3 || seen.has(t)) continue;
                seen.add(t);
                titles.push(t.slice(0, 90));
            }
        } catch { /* unreadable shard, skip */ } finally {
            if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        if (titles.length >= want) break;
    }
    return titles;
}

/**
 * Read a site's own front page, honouring the charset it declares.
 *
 * The crawl is unusable for some entries and the reason is always encoding.
 * problems.ru is served as KOI8-R; its stored pages contain zero high bytes,
 * so every Cyrillic character was destroyed at fetch time and no re-decode can
 * recover it. One live request, decoded correctly, gives the site's own subject
 * catalogue — which for problems.ru lists Алгебра, Геометрия, Комбинаторика and
 * no physics whatsoever.
 *
 * Used ONLY to establish subject. Nothing here decides whether a site is alive:
 * a 403 from Cloudflare and a VPN-blocked .ru domain look identical from here,
 * and treating either as death is how mccme.ru was lost in the first place.
 */
function readLive(url, timeout = 20) {
    const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    try {
        const buf = execFileSync('curl', ['-sSL', '--max-time', String(timeout), '--max-redirs', '5', '-A', UA, url],
            { maxBuffer: 8 * 1024 * 1024 });
        if (!buf || buf.length < 200) return '';
        const declared = (buf.toString('latin1').match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
        let html;
        try { html = new TextDecoder(declared).decode(buf); } catch { html = buf.toString('utf8'); }
        const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ').trim();
        // A Cloudflare interstitial is not the site's content and must not be
        // classified as though it were.
        if (/Attention Required|Just a moment|Enable JavaScript and cookies/i.test(text.slice(0, 300))) return '';
        return text.slice(0, 1400);
    } catch {
        return '';
    }
}

const SYSTEM = `You are told a website's name and a sample of its actual page titles, taken from a crawl of the site.

Decide what subject the site's material actually is. The page titles are the evidence — trust them over any expectation you have about the domain name.

subject:
  "physics"   the material is predominantly physics
  "astronomy" predominantly astronomy or astrophysics
  "math"      predominantly mathematics, including maths olympiads and maths problem archives
  "cs"        predominantly programming, algorithms or informatics
  "mixed"     genuinely covers physics AND another subject at comparable depth, with physics a substantial share
  "other"     something else

Use "mixed" only when physics is a real and substantial part of the site. A maths archive with a small physics corner is "math", not "mixed".

physics_share: 0-100, the percentage of the site's material that is physics. Estimate it from the proportion of titles that are physics.

fit: 0-100, how directly this helps a Russian-speaking school or first-year student working through a hard physics problem book and preparing for physics olympiads. Physics problems with solutions at olympiad level score 90+. An excellent maths olympiad archive scores about 35 — first-rate, but not what this reader came for.

evidence: quote two or three phrases from the supplied text that decided it for you. Copy them exactly.`;

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
                    physics_share: { type: 'integer' },
                    fit: { type: 'integer' },
                    evidence: { type: 'string' },
                },
                required: ['i', 'subject', 'physics_share', 'fit', 'evidence'],
                additionalProperties: false,
            },
        },
    },
    required: ['results'],
    additionalProperties: false,
};

(async () => {
    const budget = parseFloat(arg('--budget', '0.12'));
    const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'recommendations.json'), 'utf8'));
    const graph = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'web-graph.json'), 'utf8'));
    const { kept } = corpus.loadWebsiteCandidates(corpus.DEFAULT_CORPUS, graph);
    const siteIdsOf = new Map(kept.map((c) => [c.domain, c.siteIds || []]));

    const suspect = cat.websites.entries.filter((e) => PHYSICS_RUBRICS.has(e.rubric)
        && e.subject && e.subject !== 'physics' && e.subject !== 'astronomy');
    console.log(`${suspect.length} entries sit in a physics rubric without being classified physics`);

    const withTitles = suspect.map((e) => ({
        entry: e,
        titles: sampleTitles(corpus.DEFAULT_CORPUS, siteIdsOf.get(e.id) || []),
    }));
    const haveContent = withTitles.filter((x) => x.titles.length >= 4);
    console.log(`  ${haveContent.length} have enough crawled titles to judge from content`);

    // The rest lost their content to an encoding fault at crawl time. Read them.
    const needLive = withTitles.filter((x) => x.titles.length < 4);
    if (needLive.length) {
        console.log(`  reading ${needLive.length} sites whose stored pages are unusable`);
        for (const x of needLive) {
            const text = readLive(x.entry.url);
            if (!text) { process.stdout.write(`    - ${x.entry.id}: no readable content\n`); continue; }
            x.liveText = text;
            haveContent.push(x);
            process.stdout.write(`    + ${x.entry.id}: ${text.length} chars\n`);
        }
    }
    if (!haveContent.length) return;

    const client = new Client({ apiKey: process.env.ANTHROPIC_API_KEY, budget });
    const batches = chunk(haveContent, 5);
    let done = 0;
    const results = await mapLimit(batches, 5, async (batch) => {
        const user = batch.map((x, n) => `### ${n + 1}
site: ${x.entry.id}
${x.liveText
            ? `text from the site's own front page:\n  ${x.liveText}`
            : `page titles from the crawl:\n${x.titles.map((t) => `  - ${t}`).join('\n')}`}`).join('\n\n');
        const out = await client.json({
            system: SYSTEM,
            user: `Judge these ${batch.length} sites from the evidence given. One result per site by 1-based \`i\`.\n\n${user}`,
            schema: SCHEMA,
            maxTokens: 220 * batch.length,
        });
        done += batch.length;
        process.stdout.write(`  ${done}/${haveContent.length}  $${client.spent.toFixed(3)}\r`);
        return { batch, out };
    });
    console.log('');

    const fit = JSON.parse(fs.readFileSync(FIT, 'utf8'));
    let changed = 0;
    const moves = [];
    for (const r of results) {
        if (!r || r.__error) { console.log(`  ! batch failed: ${r?.__error}`); continue; }
        const byIndex = new Map((r.out.results || []).map((x) => [x.i, x]));
        r.batch.forEach((x, n) => {
            const v = byIndex.get(n + 1);
            if (!v) return;
            const key = `website:${x.entry.id}`;
            const before = fit[key] || {};
            if (before.subject !== v.subject || before.fit !== v.fit) changed += 1;
            fit[key] = {
                subject: v.subject,
                fit: v.fit,
                physicsShare: v.physics_share,
                // Recorded so the next build knows this verdict came from page
                // content rather than a one-line note, and should not be overwritten.
                verifiedFrom: 'page_titles',
            };
            moves.push({
                id: x.entry.id,
                from: `${before.subject || '?'}/${before.fit ?? '?'}`,
                to: `${v.subject}/${v.fit}`,
                physicsShare: v.physics_share,
                evidence: v.evidence.replace(/\s+/g, ' ').slice(0, 88),
            });
        });
    }
    fs.writeFileSync(FIT, JSON.stringify(fit, null, 1));

    moves.sort((a, b) => a.physicsShare - b.physicsShare);
    console.log(`\nre-judged ${moves.length} sites from their own pages (${changed} verdicts changed):\n`);
    for (const m of moves) {
        console.log(`  ${m.id.padEnd(24)} ${m.from.padEnd(12)} -> ${m.to.padEnd(12)} phys ${String(m.physicsShare).padStart(3)}%  ${m.evidence}`);
    }
    console.log(`\nspend: $${client.report().spent.toFixed(4)} of $${budget.toFixed(2)}`);
    console.log('re-run scripts/build-recommendations.js to apply');
})();
