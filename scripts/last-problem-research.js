#!/usr/bin/env node
// Exports what scripts/last-problem-forecast.py needs, from the live database and posts/, as one
// JSON file: when every problem got its first solution, its difficulty metadata and statement,
// and the market's own record for its outcomes. Read-only. Run it on the server:
//
//   node scripts/last-problem-research.js > /tmp/lp-research.json
//
// then copy the file back and run the forecast locally (it needs numpy).
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

(async () => {
    const q = async (sql) => (await pool.query(sql)).rows;
    try {
        // A problem's first solution is the first edit that created its file, in either table.
        const first = await q(`
            SELECT problem_name, MIN(edited_at) AS t FROM (
                SELECT problem_name, edited_at FROM contributions
                 WHERE COALESCE(length(original_content), 0) = 0 AND COALESCE(length(new_content), 0) > 0
                UNION ALL
                SELECT problem_name, edited_at FROM github_contributions
                 WHERE COALESCE(length(original_content), 0) = 0 AND COALESCE(length(new_content), 0) > 0
            ) x GROUP BY problem_name`);
        const diff = await q('SELECT problem_name, calibrated, starred, est_minutes FROM problem_difficulty');
        const st = await q(`SELECT problem_name, lang, length(statement_tex) AS len, COALESCE(array_length(figures, 1), 0) AS figs
                              FROM problem_statements`);
        const market = await q('SELECT problem_name, status, solved_at FROM lp_outcomes');
        const posts = new Set();
        for (const lang of ['ru', 'en']) {
            for (const f of fs.readdirSync(path.join(ROOT, 'posts', lang))) if (f.endsWith('.md')) posts.add(f.slice(0, -3));
        }
        process.stdout.write(JSON.stringify({ now: new Date().toISOString(), first, diff, st, market, posts: [...posts] }));
    } finally {
        await pool.end();
    }
})().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
