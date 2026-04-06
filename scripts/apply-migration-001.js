require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

async function main() {
    const sqlPath = path.join(__dirname, "..", "sql", "migrations", "001_settings_profile_columns.sql");
    const sql = fs.readFileSync(sqlPath, "utf8");
    await pool.query(sql);
    console.log("Migration 001 applied.");
    await pool.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
