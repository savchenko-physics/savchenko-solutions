/**
 * Apply ONLY the Brainstorm Room migration (sql/migrations/026_brainstorm.sql),
 * bypassing the project's forward-only runner.
 *
 * Why this exists: `npm run migrate` applies every pending migration in order and
 * exits on the first failure. If an EARLIER, unrelated migration fails on your DB
 * (e.g. a blog-seed migration whose row already exists — a pre-existing data drift
 * that has nothing to do with brainstorm), the runner never reaches 026. This
 * script lets you install the brainstorm schema without having to fix or skip the
 * unrelated migration first.
 *
 * Safe to run repeatedly: 026 is all `CREATE TABLE IF NOT EXISTS` /
 * `CREATE INDEX IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, and the
 * applied_migrations record uses ON CONFLICT DO NOTHING. It touches nothing but
 * the brainstorm tables and the one new user_preferences column.
 *
 * Run: node scripts/apply-brainstorm-migration.js   (or: npm run migrate:brainstorm)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

async function main() {
    const file = '026_brainstorm.sql';
    const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', file), 'utf8');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            CREATE TABLE IF NOT EXISTS applied_migrations (
                name TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await client.query(sql);
        await client.query(
            'INSERT INTO applied_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
            [file]
        );
        await client.query('COMMIT');
        console.log(`Applied ${file}. Brainstorm tables + user_preferences.brainstorm_display_mode are ready.`);
        console.log('Next: node scripts/seed-brainstorm.js   (or npm run seed:brainstorm)');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Failed to apply ${file}: ${err.message}`);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();
