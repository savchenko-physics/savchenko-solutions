#!/usr/bin/env node
/**
 * check-liveness.js — fetch every catalog URL and record what actually happens.
 *
 * Everything in the catalog is judged from a crawl taken months ago. Sites die.
 * ipho.org was published as a top olympiad resource and does not open. Nothing
 * in the pipeline would ever notice, because the pipeline only ever reads the
 * archive.
 *
 * This also recovers content the crawl lost. problems.ru is served as KOI8-R and
 * the stored pages have zero high bytes — every Cyrillic character was destroyed
 * at fetch time, leaving " problems.ru | | | | N 57 : : (1347 )". No amount of
 * re-decoding brings that back, but one live request does.
 *
 * Records the outcome without deciding anything: a 403 to a script is usually a
 * bot rule rather than a dead site, and treating it as death is the mistake that
 * lost mccme.ru and ipho-new.org in the first place. Only a DNS failure or a
 * connection refusal is real evidence of absence.
 *
 * Usage: node scripts/check-liveness.js [--concurrency 8] [--timeout 15]
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const OUT = path.join(__dirname, '..', 'data', '.build', 'liveness.json');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };

// Identify as a real browser. Many of these sites serve a challenge page or a
// bare 403 to anything that looks automated, and a 403 tells us nothing about
// whether the site is useful to a student who opens it in Chrome.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function fetchOne(url, timeout) {
    return new Promise((resolve) => {
        execFile('curl', [
            '-sSL', '--max-time', String(timeout), '--max-redirs', '5',
            '-A', UA, '-H', 'Accept-Language: ru,en;q=0.8',
            '-w', '\n__META__%{http_code} %{url_effective} %{size_download}',
            url,
        ], { maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
            const raw = (stdout || Buffer.alloc(0)).toString('utf8');
            const at = raw.lastIndexOf('\n__META__');
            if (at === -1) {
                const msg = String(stderr || err?.message || 'no response').trim().split('\n').pop();
                return resolve({ ok: false, status: 0, error: msg.slice(0, 120) });
            }
            const [code, finalUrl, size] = raw.slice(at + 9).trim().split(' ');
            const body = raw.slice(0, at);
            resolve({
                ok: Number(code) >= 200 && Number(code) < 400,
                status: Number(code),
                finalUrl,
                bytes: Number(size),
                title: ((body.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || '')
                    .replace(/\s+/g, ' ').trim().slice(0, 120),
                // Kept for the subject re-check on sites whose crawl is unusable.
                text: body.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
                    .replace(/\s+/g, ' ').trim().slice(0, 2500),
            });
        });
    });
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = next; next += 1;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    }));
    return out;
}

(async () => {
    const concurrency = parseInt(arg('--concurrency', '8'), 10);
    const timeout = parseInt(arg('--timeout', '15'), 10);
    const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'recommendations.json'), 'utf8'));
    const sites = cat.websites.entries;

    console.log(`checking ${sites.length} websites (${concurrency} at a time, ${timeout}s timeout)`);
    let done = 0;
    const results = await mapLimit(sites, concurrency, async (e) => {
        const r = await fetchOne(e.url, timeout);
        done += 1;
        if (done % 20 === 0) process.stdout.write(`  ${done}/${sites.length}\r`);
        return { id: e.id, url: e.url, rubric: e.rubric, score: e.score, ...r };
    });
    console.log('');

    const record = {};
    for (const r of results) {
        record[r.id] = {
            status: r.status, ok: r.ok, finalUrl: r.finalUrl,
            bytes: r.bytes, title: r.title, error: r.error,
            text: r.text ? r.text.slice(0, 2500) : undefined,
        };
    }
    fs.writeFileSync(OUT, JSON.stringify(record, null, 1));

    const buckets = { live: [], blocked: [], gone: [], unreachable: [] };
    for (const r of results) {
        if (r.ok && r.bytes > 500) buckets.live.push(r);
        else if (r.status === 403 || r.status === 401 || r.status === 429) buckets.blocked.push(r);
        else if (r.status >= 400) buckets.gone.push(r);
        else buckets.unreachable.push(r);
    }
    console.log(`\nlive ${buckets.live.length}  |  blocks us ${buckets.blocked.length}  |  `
        + `HTTP error ${buckets.gone.length}  |  no response ${buckets.unreachable.length}\n`);

    const show = (name, arr, extra) => {
        if (!arr.length) return;
        console.log(`${name} (${arr.length}):`);
        for (const r of arr.sort((a, b) => b.score - a.score).slice(0, 30)) {
            console.log(`  score ${String(r.score).padStart(7)}  ${r.id.padEnd(28)} ${extra(r)}`);
        }
        console.log('');
    };
    show('HTTP ERROR — 4xx/5xx', buckets.gone, (r) => `${r.status}  ${r.url}`);
    show('NO RESPONSE — DNS or connection failure', buckets.unreachable, (r) => `${r.error || '-'}  ${r.url}`);
    show('BLOCKS AUTOMATED FETCH — likely fine in a browser', buckets.blocked, (r) => `${r.status}  ${r.url}`);
    console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
})();
