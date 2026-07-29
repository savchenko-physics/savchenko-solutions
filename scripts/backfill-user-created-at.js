#!/usr/bin/env node
// backfill-user-created-at.js — give the platform a signup date it can actually use.
//
// users.created_at was NULL for all 963 rows, so there was no cohort, no growth rate and
// no retention curve — for anyone, ever. This reconstructs a date per account from the
// earliest trace that account left anywhere in the database.
//
// TWO RULES, both deliberate:
//
//   1. An inferred date is an UPPER BOUND, not a signup date. It says "this account
//      existed by at least this moment". Someone who registered in 2024 and first
//      commented in 2026 will be dated 2026. That is a known, one-directional bias and it
//      is recorded in created_at_source so cohort work can exclude it.
//
//   2. An account with no trace anywhere stays NULL, marked 'unknown'. Writing now() into
//      848 dormant accounts would be inventing data, and the whole reason this script
//      exists is that invented growth numbers are what got quoted to a YC partner.
//
// Usage:
//   node scripts/backfill-user-created-at.js --dry-run   # report only
//   node scripts/backfill-user-created-at.js
require('dotenv').config();
const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
    user: (process.env.PG_USER || '').trim(),
    host: (process.env.PG_HOST || '').trim(),
    database: (process.env.PG_DATABASE || '').trim(),
    password: (process.env.PG_PASSWORD || '').trim(),
    port: Number((process.env.PG_PORT || '5432').trim()),
    ssl: { rejectUnauthorized: (process.env.PG_SSL_REJECT_UNAUTHORIZED || '').trim() === 'true' },
});

// Tables that record something the ACCOUNT DID. `contributions` is the one the
// recommendation names; the rest only ever move the estimate earlier, never later, so
// including them strictly improves the bound.
//
// EXCLUDED ON PURPOSE — things done TO a user, not BY them:
//   notifications              951 users, all from a 2026-05-12 fanout
//   notifications_fanout_backup  same data
//   email_events               147 users, the 2026-07-24 Practicum campaign
// A first version of this script included them and dated 796 of 963 accounts to July
// 2026 — it was reading our own broadcast as the user's first appearance. A passive
// recipient row is not evidence of anything except that we had their address already.
const EVIDENCE = [
    ['contributions', 'edited_at'],
    ['github_contributions', 'edited_at'],
    ['special_contributions', 'edited_at'],
    ['solutions', 'created_at'],
    ['solution_comments', 'created_at'],
    ['solution_likes', 'created_at'],
    ['solution_reports', 'created_at'],
    ['comments', 'created_at'],
    ['votes', 'created_at'],
    ['starred_solutions', 'created_at'],
    ['user_activities', 'created_at'],
    ['user_interests', 'created_at'],
    ['user_preferences', 'created_at'],
    ['forum_posts', 'created_at'],
    ['forum_topics', 'created_at'],
    ['forum_post_votes', 'created_at'],
    ['blog_comments', 'created_at'],
    ['brainstorm_messages', 'created_at'],
    ['brainstorm_reactions', 'created_at'],
    ['message_reactions', 'created_at'],
    ['bank_attempts', 'created_at'],
    ['bank_comments', 'created_at'],
    ['password_reset_requests', 'created_at'],
];

async function tableExists(name) {
    const r = await pool.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
    return r.rows[0].t !== null;
}

(async () => {
    const before = await pool.query(
        `SELECT count(*)::int AS total,
                count(created_at)::int AS dated,
                count(last_seen_at)::int AS seen
           FROM users`
    );
    const b = before.rows[0];
    console.log('\nBEFORE');
    console.log(`  accounts        ${b.total}`);
    console.log(`  with created_at ${b.dated}`);
    console.log(`  ever seen       ${b.seen}\n`);

    // Build one UNION ALL over whichever evidence tables actually exist.
    const parts = [];
    console.log('evidence tables:');
    for (const [table, col] of EVIDENCE) {
        if (!(await tableExists(table))) { console.log(`  -- ${table} (absent, skipped)`); continue; }
        const r = await pool.query(
            `SELECT count(DISTINCT user_id)::int AS users, min(${col}) AS earliest
               FROM ${table} WHERE user_id IS NOT NULL AND ${col} IS NOT NULL`
        );
        const row = r.rows[0];
        console.log(`  ${table.padEnd(26)} ${String(row.users).padStart(4)} users   earliest ${row.earliest ? new Date(row.earliest).toISOString().slice(0, 10) : '—'}`);
        parts.push(`SELECT user_id, ${col}::timestamptz AS ts FROM ${table} WHERE user_id IS NOT NULL AND ${col} IS NOT NULL`);
    }

    const earliestCte = `
        WITH evidence AS (${parts.join(' UNION ALL ')}),
        earliest AS (SELECT user_id, min(ts) AS first_seen FROM evidence GROUP BY user_id)`;

    const preview = await pool.query(
        `${earliestCte}
         SELECT count(*)::int AS datable,
                min(first_seen) AS oldest,
                max(first_seen) AS newest
           FROM earliest JOIN users u ON u.id = earliest.user_id`
    );
    const p = preview.rows[0];
    console.log(`\n  datable accounts: ${p.datable} of ${b.total}`);
    console.log(`  range: ${p.oldest ? new Date(p.oldest).toISOString().slice(0, 10) : '—'} .. ${p.newest ? new Date(p.newest).toISOString().slice(0, 10) : '—'}`);
    console.log(`  undatable (stay NULL, marked 'unknown'): ${b.total - p.datable}\n`);

    console.log('inferred signups by month (the cohort chart that did not exist):');
    const months = await pool.query(
        `${earliestCte}
         SELECT to_char(date_trunc('month', first_seen), 'YYYY-MM') AS month, count(*)::int AS accounts
           FROM earliest JOIN users u ON u.id = earliest.user_id
          GROUP BY 1 ORDER BY 1`
    );
    for (const m of months.rows) {
        console.log(`  ${m.month}  ${String(m.accounts).padStart(4)}  ${'#'.repeat(Math.min(60, m.accounts))}`);
    }

    if (DRY_RUN) {
        console.log('\n--dry-run: nothing was changed.\n');
        await pool.end();
        return;
    }

    await pool.query('BEGIN');
    try {
        const updated = await pool.query(
            `${earliestCte}
             UPDATE users u
                SET created_at = e.first_seen,
                    created_at_source = 'inferred'
               FROM earliest e
              WHERE u.id = e.user_id AND u.created_at IS NULL`
        );
        const unknown = await pool.query(
            `UPDATE users SET created_at_source = 'unknown'
              WHERE created_at IS NULL AND created_at_source IS NULL`
        );
        await pool.query('COMMIT');
        console.log(`\n  ${updated.rowCount} accounts dated (source='inferred')`);
        console.log(`  ${unknown.rowCount} accounts left undated (source='unknown')`);
    } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
    }

    const after = await pool.query(
        `SELECT created_at_source, count(*)::int AS accounts FROM users GROUP BY 1 ORDER BY 2 DESC`
    );
    console.log('\nAFTER');
    for (const r of after.rows) console.log(`  ${String(r.created_at_source ?? '(null)').padEnd(10)} ${r.accounts}`);
    console.log();
    await pool.end();
})().catch((err) => {
    console.error('backfill failed:', err.message);
    process.exit(1);
});
