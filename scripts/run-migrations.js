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
    // Create migrations tracking table if it doesn't exist
    await pool.query(`
        CREATE TABLE IF NOT EXISTS applied_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    const migrationsDir = path.join(__dirname, '..', 'sql', 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    const applied = await pool.query('SELECT name FROM applied_migrations');
    const appliedSet = new Set(applied.rows.map(r => r.name));

    let count = 0;
    for (const file of files) {
        if (appliedSet.has(file)) {
            console.log(`  skip  ${file} (already applied)`);
            continue;
        }
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await pool.query('BEGIN');
        try {
            await pool.query(sql);
            await pool.query(
                'INSERT INTO applied_migrations (name) VALUES ($1)',
                [file]
            );
            await pool.query('COMMIT');
            console.log(`  apply ${file}`);
            count++;
        } catch (err) {
            await pool.query('ROLLBACK');
            console.error(`  FAIL  ${file}: ${err.message}`);
            process.exit(1);
        }
    }

    console.log(`\nDone. ${count} migration(s) applied, ${appliedSet.size} already up to date.`);
    await pool.end();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
