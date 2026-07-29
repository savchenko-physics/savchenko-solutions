#!/usr/bin/env node
// traffic-report.js — read the standing request log and answer the two questions that
// matter during a bot wave:
//
//   1. What is hitting the site right now, and what would the classifier do about it?
//   2. Did anything that looks like a person get caught?
//
// Usage:
//   node scripts/traffic-report.js                 # last 30 minutes
//   node scripts/traffic-report.js --minutes 120
//   node scripts/traffic-report.js --watch         # refresh every 30s
//   node scripts/traffic-report.js --humans        # ONLY the would-block safety audit
//   node scripts/traffic-report.js --compare 60    # before/after around a change
require('dotenv').config();
const { Pool } = require('pg');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const MINUTES = Number(flag('minutes', 30));
const WATCH = Boolean(flag('watch', false));
const HUMANS_ONLY = Boolean(flag('humans', false));
const COMPARE = flag('compare', null);

const pool = new Pool({
    user: (process.env.PG_USER || '').trim(),
    host: (process.env.PG_HOST || '').trim(),
    database: (process.env.PG_DATABASE || '').trim(),
    password: (process.env.PG_PASSWORD || '').trim(),
    port: Number((process.env.PG_PORT || '5432').trim()),
    ssl: { rejectUnauthorized: (process.env.PG_SSL_REJECT_UNAUTHORIZED || '').trim() === 'true' },
});

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const win = `now() - ($1 || ' minutes')::interval`;

async function overview() {
    console.log(`\n=== last ${MINUTES} min: verdicts ===`);
    console.table(await q(
        `SELECT verdict, count(*)::int AS requests, count(DISTINCT ip)::int AS ips,
                round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1) AS pct
           FROM request_log WHERE ts > ${win}
          GROUP BY verdict ORDER BY 2 DESC`, [MINUTES]));

    console.log(`=== which rule fired ===`);
    console.table(await q(
        `SELECT r AS reason, count(*)::int AS requests, count(DISTINCT ip)::int AS ips
           FROM request_log, unnest(reasons) AS r
          WHERE ts > ${win} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [MINUTES]));

    console.log(`=== top /24 networks ===`);
    console.table(await q(
        `SELECT regexp_replace(ip, '\\.[0-9]+$', '') AS net24,
                count(*)::int AS requests, count(DISTINCT ip)::int AS ips,
                count(*) FILTER (WHERE accept_language IS NULL)::int AS no_lang,
                (array_agg(DISTINCT verdict))[1:3] AS verdicts
           FROM request_log WHERE ts > ${win} AND ip ~ '^[0-9.]+$'
          GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [MINUTES]));

    console.log(`=== top user agents ===`);
    console.table(await q(
        `SELECT left(coalesce(user_agent,'(none)'), 70) AS user_agent,
                count(*)::int AS requests, count(DISTINCT ip)::int AS ips, min(verdict) AS verdict
           FROM request_log WHERE ts > ${win}
          GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [MINUTES]));

    console.log(`=== Accept-Language present vs absent (the strongest single signal) ===`);
    console.table(await q(
        `SELECT CASE WHEN accept_language IS NULL THEN 'ABSENT (machine-like)' ELSE 'present' END AS accept_language,
                count(*)::int AS requests, count(DISTINCT ip)::int AS ips
           FROM request_log WHERE ts > ${win} GROUP BY 1 ORDER BY 2 DESC`, [MINUTES]));
}

// The safety audit. In observe mode nothing is actually blocked, so this shows what WOULD
// be blocked — which is exactly what you want to inspect before enforcing anything.
async function safetyAudit() {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`SAFETY AUDIT — would-be blocks in the last ${MINUTES} min that look human`);
    console.log('='.repeat(72));

    const suspicious = await q(
        `SELECT ip, user_agent, accept_language, accept_encoding, sec_ch_ua,
                count(*)::int AS requests, array_agg(DISTINCT r) AS reasons
           FROM request_log, unnest(reasons) AS r
          WHERE ts > ${win}
            AND verdict = 'block'
            -- A real browser sends Accept-Language and does not name itself a bot.
            AND accept_language IS NOT NULL
            AND user_agent !~* 'bot|crawler|spider|headless|curl|wget|python|scrapy|http-client'
          GROUP BY 1,2,3,4,5 ORDER BY 6 DESC LIMIT 40`, [MINUTES]);

    if (suspicious.length === 0) {
        console.log('\n  CLEAN — every would-be block either named itself a bot or omitted');
        console.log('  Accept-Language. No plausible human in the block set.\n');
    } else {
        console.log(`\n  ${suspicious.length} REQUEST GROUP(S) NEED A HUMAN LOOK:\n`);
        for (const s of suspicious) {
            console.log(`  ${s.requests}x ${s.ip}`);
            console.log(`      UA:       ${s.user_agent}`);
            console.log(`      Lang:     ${s.accept_language}`);
            console.log(`      Encoding: ${s.accept_encoding}`);
            console.log(`      Reasons:  ${(s.reasons || []).join(', ')}\n`);
        }
        console.log('  If any of these is a person, DEMOTE THAT RULE. The analytics stay');
        console.log('  clean with it set to count-nothing instead of block.\n');
    }

    // The allowlists must be visibly holding.
    const guarded = await q(
        `SELECT ip, verdict, count(*)::int AS requests
           FROM request_log
          WHERE ts > ${win}
            AND (ip LIKE '84.237.49.%' OR ip LIKE '162.120.%')
          GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`, [MINUTES]);
    if (guarded.length) {
        console.log('  Allowlisted ranges seen in this window (must never be "block"):');
        console.table(guarded);
    }
}

// Before/after around a change: compare the two halves of a window.
async function compare(minutesEach) {
    const m = Number(minutesEach) || 60;
    console.log(`\n=== BEFORE (${m * 2}–${m} min ago)  vs  AFTER (last ${m} min) ===`);
    console.table(await q(
        `SELECT verdict,
                count(*) FILTER (WHERE ts <  now() - ($1 || ' minutes')::interval)::int AS before_reqs,
                count(DISTINCT ip) FILTER (WHERE ts <  now() - ($1 || ' minutes')::interval)::int AS before_ips,
                count(*) FILTER (WHERE ts >= now() - ($1 || ' minutes')::interval)::int AS after_reqs,
                count(DISTINCT ip) FILTER (WHERE ts >= now() - ($1 || ' minutes')::interval)::int AS after_ips
           FROM request_log
          WHERE ts > now() - (($1::int * 2) || ' minutes')::interval
          GROUP BY 1 ORDER BY 4 DESC`, [m]));

    console.log('=== human traffic specifically (this number must NOT fall) ===');
    console.table(await q(
        `SELECT date_trunc('hour', ts) AS hour,
                count(*) FILTER (WHERE verdict = 'human')::int AS human_reqs,
                count(DISTINCT ip) FILTER (WHERE verdict = 'human')::int AS human_ips
           FROM request_log WHERE ts > now() - interval '24 hours'
          GROUP BY 1 ORDER BY 1 DESC LIMIT 24`));
}

async function once() {
    if (COMPARE) return compare(COMPARE);
    if (!HUMANS_ONLY) await overview();
    await safetyAudit();
    return undefined;
}

(async () => {
    try {
        if (WATCH) {
            for (;;) {
                process.stdout.write('\x1Bc');
                console.log(new Date().toISOString());
                await once();
                await new Promise((r) => setTimeout(r, 30000));
            }
        } else {
            await once();
            await pool.end();
        }
    } catch (err) {
        console.error('traffic-report failed:', err.message);
        process.exit(1);
    }
})();
