// tracker.js — standing request log, so a traffic wave can be characterised from a
// dashboard instead of from tcpdump on the production box.
//
// The waves are bursty (803 GA users in one half-hour, ~100 three minutes later, 176 in a
// minute after that), so by the time anyone looks the shape has already changed. This
// records every non-asset request with the headers that actually discriminate machines
// from people, plus the classifier's verdict.
//
// The verdict is recorded even in observe mode, where nothing is blocked. That is the
// whole point: it lets you answer "what WOULD have been blocked, and was any of it a
// person?" from data, before enforcement is ever switched on — and then compare the same
// query before and after the switch.
//
// COST DISCIPLINE. This runs on a 2-vCPU box with a $10/month database, so:
//   - static assets are never logged (they are ~half of all requests and tell us nothing),
//   - rows are buffered in memory and written in one multi-row INSERT,
//   - the insert is never awaited on the request path,
//   - the buffer is capped and drops (counting) rather than growing without bound,
//   - rows are pruned after RETENTION_DAYS; an hourly rollup keeps the long view.
const TRACKER_ENABLED = String(process.env.TRACKER_ENABLED || 'true').trim().toLowerCase() !== 'false';
const RETENTION_DAYS = Number(process.env.TRACKER_RETENTION_DAYS || 14);

const FLUSH_MS = 5000;
const FLUSH_ROWS = 500;
const MAX_BUFFER = 20000;

// Static assets carry no classification signal and would triple the row count.
const ASSET = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|map|pdf)(\?|$)/i;

// Query-string keys whose values must never be written down.
const SECRET_PARAM = /(api_key|apikey|token|password|passwd|secret|sig|signature)=[^&]*/gi;

let pool = null;
let buffer = [];
let dropped = 0;
let flushing = false;
let flushTimer = null;

function scrubPath(url) {
    return String(url || '').replace(SECRET_PARAM, (m) => `${m.split('=')[0]}=[redacted]`).slice(0, 500);
}

function truncate(v, n) {
    if (v === undefined || v === null) return null;
    return String(v).slice(0, n);
}

async function flush() {
    if (flushing || buffer.length === 0 || !pool) return;
    flushing = true;
    const rows = buffer;
    buffer = [];
    try {
        // One multi-row INSERT: 13 columns per row.
        const cols = 13;
        const values = [];
        const params = [];
        rows.forEach((r, i) => {
            const b = i * cols;
            values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13})`);
            params.push(r.ts, r.ip, r.method, r.path, r.status, r.duration_ms, r.user_agent,
                r.accept_language, r.accept_encoding, r.sec_ch_ua, r.referer, r.verdict, r.reasons);
        });
        await pool.query(
            `INSERT INTO request_log
                (ts, ip, method, path, status, duration_ms, user_agent,
                 accept_language, accept_encoding, sec_ch_ua, referer, verdict, reasons)
             VALUES ${values.join(',')}`,
            params
        );
    } catch (err) {
        // Never resurrect the rows — a persistent DB error would otherwise grow the
        // buffer until the process dies. Losing diagnostics is strictly better.
        console.error('tracker flush failed:', err.message);
    } finally {
        flushing = false;
    }
}

// ── Attempt counters ────────────────────────────────────────────────────────────────
// Counted for EVERY request, assets included. request_log deliberately skips assets, but
// a blocked bot's traffic is almost entirely assets — during one capture the farm made
// ~1,000 requests from two /24s in 90 seconds and every one was a CSS/JS/font fetch
// returning 403, so the row table saw almost none of it. Counting is cheap enough to do
// on everything; storing bodies is not.
//
// `requests` is written as a delta and therefore stays exact across restarts.
// `distinct_ips` comes from an in-memory Set that lives for the current hour, so it is
// exact in normal operation and can undercount if the process restarts mid-hour.
const attempts = new Map();  // "hour|verdict|rule|reason" -> { requests, assets, ips:Set }
const networks = new Map();  // "day|net16|verdict"        -> { requests, ips:Set }

function bucketKeys(d) {
    const hour = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()));
    return { hour, day: hour.toISOString().slice(0, 10) };
}

function countAttempt(req, isAsset) {
    const now = new Date();
    const { hour, day } = bucketKeys(now);
    const bot = req.bot || {};
    const verdict = bot.cls || 'unclassified';
    const rule = bot.rule === undefined || bot.rule === null ? '-' : String(bot.rule);
    // One row per distinct signal, so "how often did rule 5 fire" is a direct query.
    const reasons = (bot.reasons && bot.reasons.length) ? bot.reasons : ['-'];
    const ip = String(req.ip || '').slice(0, 64);

    for (const reason of reasons) {
        const key = `${hour.toISOString()}|${verdict}|${rule}|${String(reason).slice(0, 48)}`;
        let e = attempts.get(key);
        if (!e) { e = { hour, verdict, rule, reason: String(reason).slice(0, 48), requests: 0, assets: 0, ips: new Set() }; attempts.set(key, e); }
        e.requests++;
        if (isAsset) e.assets++;
        if (ip && e.ips.size < 50000) e.ips.add(ip);
    }

    // Networks: only non-human verdicts, which is what keeps this table small and is the
    // only part anyone would act on.
    if (verdict !== 'human' && /^\d+\.\d+\./.test(ip)) {
        const net16 = ip.split('.').slice(0, 2).join('.');
        const key = `${day}|${net16}|${verdict}`;
        let e = networks.get(key);
        if (!e) { e = { day, net16, verdict, requests: 0, ips: new Set() }; networks.set(key, e); }
        e.requests++;
        if (e.ips.size < 50000) e.ips.add(ip);
    }
}

async function flushCounters() {
    if (!pool) return;
    const nowHour = bucketKeys(new Date()).hour.toISOString();

    // Take the deltas and reset the request counts; keep the IP sets for the current
    // hour so distinct counts stay cumulative, and drop them once the hour has passed.
    const attemptRows = [];
    for (const [key, e] of attempts) {
        if (e.requests > 0) attemptRows.push({ ...e, ips: e.ips.size });
        e.requests = 0; e.assets = 0;
        if (e.hour.toISOString() !== nowHour) attempts.delete(key);
    }
    const networkRows = [];
    for (const [key, e] of networks) {
        if (e.requests > 0) networkRows.push({ ...e, ips: e.ips.size });
        e.requests = 0;
        if (e.day !== bucketKeys(new Date()).day) networks.delete(key);
    }

    try {
        for (const r of attemptRows) {
            await pool.query(
                `INSERT INTO bot_defence_hourly (hour, verdict, rule, reason, requests, distinct_ips, assets)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (hour, verdict, rule, reason) DO UPDATE
                   SET requests     = bot_defence_hourly.requests + EXCLUDED.requests,
                       assets       = bot_defence_hourly.assets   + EXCLUDED.assets,
                       distinct_ips = GREATEST(bot_defence_hourly.distinct_ips, EXCLUDED.distinct_ips)`,
                [r.hour, r.verdict, r.rule, r.reason, r.requests, r.ips, r.assets]
            );
        }
        for (const r of networkRows) {
            await pool.query(
                `INSERT INTO bot_network_daily (day, net16, verdict, requests, distinct_ips)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (day, net16, verdict) DO UPDATE
                   SET requests     = bot_network_daily.requests + EXCLUDED.requests,
                       distinct_ips = GREATEST(bot_network_daily.distinct_ips, EXCLUDED.distinct_ips)`,
                [r.day, r.net16, r.verdict, r.requests, r.ips]
            );
        }
    } catch (err) {
        console.error('tracker counter flush failed:', err.message);
    }
}

function middleware(req, res, next) {
    if (!TRACKER_ENABLED || !pool) return next();
    try {
        const isAsset = ASSET.test(req.path);
        // Counted first, and for everything — this is the only place blocked asset
        // traffic gets recorded at all.
        res.on('finish', () => { try { countAttempt(req, isAsset); } catch (_e) {} });
        if (isAsset) return next();

        const started = process.hrtime.bigint();
        // Capture headers now: res.on('finish') fires after the response, and some
        // middleware mutates req in between.
        const snapshot = {
            ip: truncate(req.ip, 64),
            method: req.method,
            path: scrubPath(req.originalUrl || req.url),
            user_agent: truncate(req.headers['user-agent'], 300),
            // Distinguish "absent" (null) from "present but empty" — absence is the signal.
            accept_language: req.headers['accept-language'] === undefined ? null : truncate(req.headers['accept-language'], 120),
            accept_encoding: truncate(req.headers['accept-encoding'], 120),
            sec_ch_ua: truncate(req.headers['sec-ch-ua'], 200),
            referer: truncate(req.headers.referer, 300),
        };

        res.on('finish', () => {
            try {
                if (buffer.length >= MAX_BUFFER) { dropped++; return; }
                const verdict = req.bot ? req.bot.cls : 'unclassified';
                const reasons = req.bot ? [...(req.bot.reasons || []), `rule:${req.bot.rule}`] : [];
                buffer.push({
                    ts: new Date(),
                    ...snapshot,
                    status: res.statusCode,
                    duration_ms: Number((process.hrtime.bigint() - started) / 1000000n),
                    verdict,
                    reasons,
                });
                if (buffer.length >= FLUSH_ROWS) flush();
            } catch (_err) { /* logging must never affect the response */ }
        });
    } catch (_err) { /* ditto */ }
    return next();
}

async function prune() {
    if (!pool) return;
    try {
        // Roll the window up before deleting it, so the long-run picture survives.
        await pool.query(
            `INSERT INTO request_log_hourly (hour, verdict, requests, distinct_ips)
             SELECT date_trunc('hour', ts), verdict, count(*), count(DISTINCT ip)
               FROM request_log
              WHERE ts < now() - ($1 || ' days')::interval
              GROUP BY 1, 2
             ON CONFLICT (hour, verdict) DO UPDATE
                SET requests = EXCLUDED.requests, distinct_ips = EXCLUDED.distinct_ips`,
            [RETENTION_DAYS]
        );
        const res = await pool.query(
            `DELETE FROM request_log WHERE ts < now() - ($1 || ' days')::interval`,
            [RETENTION_DAYS]
        );
        if (res.rowCount > 0) console.log(`tracker: pruned ${res.rowCount} request_log rows`);
    } catch (err) {
        console.error('tracker prune failed:', err.message);
    }
}

function init(sharedPool) {
    if (!TRACKER_ENABLED) return;
    pool = sharedPool;

    flushTimer = setInterval(flush, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();

    // Counters go out every minute. They are tiny (a few dozen upserts) and this is the
    // record that outlives the 14-day raw retention, so losing a chunk of it to a restart
    // matters more than the write cost.
    const counterTimer = setInterval(flushCounters, 60 * 1000);
    if (counterTimer.unref) counterTimer.unref();

    const pruneTimer = setInterval(prune, 60 * 60 * 1000);
    if (pruneTimer.unref) pruneTimer.unref();

    const stats = setInterval(() => {
        if (dropped > 0) { console.warn(`tracker: dropped ${dropped} rows (buffer full)`); dropped = 0; }
    }, 60 * 1000);
    if (stats.unref) stats.unref();

    // A pm2 restart mid-wave must not lose the tail — that is exactly the window worth
    // keeping.
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => { flush().finally(() => process.exit(0)); });
    }
}

module.exports = { middleware, init, flush, prune };
