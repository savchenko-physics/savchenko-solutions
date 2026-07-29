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

function middleware(req, res, next) {
    if (!TRACKER_ENABLED || !pool) return next();
    try {
        if (ASSET.test(req.path)) return next();

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
