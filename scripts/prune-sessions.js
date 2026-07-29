#!/usr/bin/env node
// prune-sessions.js — reclaim the session table.
//
// Deliberately NOT a migration: scripts/run-migrations.js wraps each file in one
// transaction, and VACUUM cannot run inside a transaction. A 1.4M-row DELETE in a single
// transaction would also bloat WAL and hold locks on a small RDS instance.
//
// Background: index.js used to write req.session.lang on every /en|/ru request, which
// marks a brand-new session dirty and makes express-session persist it — saveUninitialized
// false does not help, because shouldSave() reduces to isModified() for a cookie-less
// request. With a 365-day cookie, connect-pg-simple's pruner (DELETE WHERE expire < now())
// had nothing to delete, ever. Result: 1.46M rows / 498 MB, growing ~2,900/hour.
//
// The code fix is already deployed; this clears the backlog it left behind.
//
// Usage:
//   node scripts/prune-sessions.js --dry-run     # report only, change nothing
//   node scripts/prune-sessions.js               # delete anonymous sessions in batches
//   node scripts/prune-sessions.js --vacuum-full # also return the space to the filesystem
//
// TAKE AN RDS SNAPSHOT FIRST. --vacuum-full takes an ACCESS EXCLUSIVE lock: every request
// touching a session blocks for its duration. Run it at the traffic trough (02:00 MSK).
require('dotenv').config();
const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const VACUUM_FULL = process.argv.includes('--vacuum-full');
const BATCH = 10000;

const pool = new Pool({
    user: (process.env.PG_USER || '').trim(),
    host: (process.env.PG_HOST || '').trim(),
    database: (process.env.PG_DATABASE || '').trim(),
    password: (process.env.PG_PASSWORD || '').trim(),
    port: Number((process.env.PG_PORT || '5432').trim()),
    ssl: { rejectUnauthorized: (process.env.PG_SSL_REJECT_UNAUTHORIZED || '').trim() === 'true' },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const before = await pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE sess->>'userId' IS NOT NULL)::int AS with_user,
                count(*) FILTER (WHERE sess->>'userId' IS NULL)::int AS anonymous,
                pg_size_pretty(pg_total_relation_size('session')) AS size
           FROM session`
    );
    const b = before.rows[0];
    console.log('\nBEFORE');
    console.log(`  total rows      ${b.total.toLocaleString()}`);
    console.log(`  belong to a user ${b.with_user.toLocaleString()}   <- KEPT`);
    console.log(`  anonymous        ${b.anonymous.toLocaleString()}   <- to delete`);
    console.log(`  on disk          ${b.size}\n`);

    if (DRY_RUN) {
        console.log('--dry-run: nothing was changed.\n');
        await pool.end();
        return;
    }

    // Batched so the pool is never starved and autovacuum can keep up.
    let deleted = 0;
    for (;;) {
        const res = await pool.query(
            `DELETE FROM session
              WHERE sid IN (
                    SELECT sid FROM session WHERE sess->>'userId' IS NULL LIMIT $1
              )`,
            [BATCH]
        );
        if (res.rowCount === 0) break;
        deleted += res.rowCount;
        process.stdout.write(`\r  deleted ${deleted.toLocaleString()}...`);
        await sleep(200);
    }
    console.log(`\n  done: ${deleted.toLocaleString()} anonymous sessions removed`);

    // Plain VACUUM returns space to the table's free space map — enough to stop growth,
    // and it takes no exclusive lock.
    console.log('  running VACUUM (ANALYZE) session ...');
    await pool.query('VACUUM (ANALYZE) session');

    if (VACUUM_FULL) {
        console.log('  running VACUUM FULL session (exclusive lock — the site will stall) ...');
        await pool.query('VACUUM FULL session');
    }

    const after = await pool.query(
        `SELECT count(*)::int AS total, pg_size_pretty(pg_total_relation_size('session')) AS size FROM session`
    );
    console.log('\nAFTER');
    console.log(`  total rows ${after.rows[0].total.toLocaleString()}`);
    console.log(`  on disk    ${after.rows[0].size}`);
    if (!VACUUM_FULL) {
        console.log('\n  Note: without --vacuum-full the space is reusable by Postgres but not');
        console.log('  returned to the filesystem, so pg_total_relation_size stays high.\n');
    }
    await pool.end();
})().catch((err) => {
    console.error('prune-sessions failed:', err.message);
    process.exit(1);
});
