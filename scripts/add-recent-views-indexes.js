#!/usr/bin/env node
// add-recent-views-indexes.js — index the dedupe lookup on recent_views.
//
// post.js:51 runs a four-predicate lookup against recent_views on every solution page
// render. On 2026-07-29 that table held 1,781,298 rows / 159 MB and had exactly one
// index: recent_views_pkey. So the query sequentially scanned the whole table on every
// page view — a cost that bot volume multiplies directly.
//
// CREATE INDEX CONCURRENTLY cannot run inside a transaction, which is why this is a
// standalone script and not a migration file (the runner wraps each file in BEGIN/COMMIT).
// CONCURRENTLY means no write lock: the site keeps serving while it builds.
//
// Usage:
//   node scripts/add-recent-views-indexes.js --explain   # show the plan, change nothing
//   node scripts/add-recent-views-indexes.js
require('dotenv').config();
const { Pool } = require('pg');

const EXPLAIN_ONLY = process.argv.includes('--explain');

// Not pooled: CREATE INDEX CONCURRENTLY must run on a single dedicated connection.
const pool = new Pool({
    user: (process.env.PG_USER || '').trim(),
    host: (process.env.PG_HOST || '').trim(),
    database: (process.env.PG_DATABASE || '').trim(),
    password: (process.env.PG_PASSWORD || '').trim(),
    port: Number((process.env.PG_PORT || '5432').trim()),
    ssl: { rejectUnauthorized: (process.env.PG_SSL_REJECT_UNAUTHORIZED || '').trim() === 'true' },
    max: 1,
});

// Exactly the shape post.js issues.
const HOT_QUERY = `
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT COUNT(*) AS count FROM recent_views
     WHERE ip_address = '203.0.113.1' AND problem_name = '1.1.1' AND language = 'ru'
       AND timestamp > now() - interval '1 minute'`;

const INDEXES = [
    ['idx_recent_views_dedupe',
     `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_recent_views_dedupe
        ON recent_views (ip_address, problem_name, language, timestamp DESC)`],
    ['idx_recent_views_ts',
     `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_recent_views_ts
        ON recent_views (timestamp)`],
];

(async () => {
    console.log('\nexisting indexes on recent_views:');
    const existing = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'recent_views' ORDER BY 1`
    );
    existing.rows.forEach((r) => console.log(`  ${r.indexname}`));

    console.log('\nplan BEFORE:');
    (await pool.query(HOT_QUERY)).rows.forEach((r) => console.log(`  ${r['QUERY PLAN']}`));

    if (EXPLAIN_ONLY) {
        console.log('\n--explain: nothing was changed.\n');
        await pool.end();
        return;
    }

    for (const [name, sql] of INDEXES) {
        process.stdout.write(`\nbuilding ${name} (concurrently, no write lock) ... `);
        const t0 = Date.now();
        await pool.query(sql);
        console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    await pool.query('ANALYZE recent_views');

    console.log('\nplan AFTER:');
    (await pool.query(HOT_QUERY)).rows.forEach((r) => console.log(`  ${r['QUERY PLAN']}`));

    console.log('\nsizes:');
    const sizes = await pool.query(
        `SELECT indexrelname AS index, pg_size_pretty(pg_relation_size(indexrelid)) AS size
           FROM pg_stat_user_indexes WHERE relname = 'recent_views' ORDER BY 1`
    );
    sizes.rows.forEach((r) => console.log(`  ${r.index.padEnd(30)} ${r.size}`));
    console.log();
    await pool.end();
})().catch((err) => {
    // A failed CONCURRENTLY build leaves an INVALID index behind; say so explicitly.
    console.error('\nfailed:', err.message);
    console.error('If an index is left INVALID, drop it before retrying:');
    console.error('  DROP INDEX CONCURRENTLY IF EXISTS idx_recent_views_dedupe;');
    process.exit(1);
});
