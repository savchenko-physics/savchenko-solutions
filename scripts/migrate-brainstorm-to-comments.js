/**
 * One-off migration: move the genuine Brainstorm Room messages into the regular
 * solution_comments thread, marked with is_brainstorm = true.
 *
 * WHY: the Brainstorm Room never grew a real audience (see the usage analysis), so
 * its handful of real, substantive messages are folded back into the comment system
 * that people actually read. The room's own tables are left in place; the migrated
 * source rows are soft-deleted so they no longer surface in the room.
 *
 * WHAT MOVES: non-deleted brainstorm_messages that are neither
 *   - seed/demo content (problems 6.4.8 and 1.1.1, planted by seed-brainstorm.js), nor
 *   - test junk (bare numbers like '1'..'5', or anything shorter than 6 chars).
 * At time of writing that is exactly 12 messages (ids 15-26).
 *
 * SCOPING: the room was unified per problem; comments are scoped by
 * (problem_name, language). Each message lands in the comment thread of the language
 * it was written in (brainstorm_messages.language), defaulting to 'ru' if unset.
 *
 * SAFETY: runs in a single transaction, is idempotent (already-migrated rows are
 * soft-deleted and therefore skipped on re-run, and a duplicate-content guard adds a
 * second layer), preserves the original created_at, and posts nothing to the
 * notification / activity feeds. Requires migration 045 (the is_brainstorm column).
 *
 * Run:  node scripts/migrate-brainstorm-to-comments.js [--dry-run]
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const DRY_RUN = process.argv.includes('--dry-run');

// A message is genuine (worth migrating) when it is not soft-deleted, not seed/demo
// content, and not test junk. Kept as a single reusable predicate (parameterised by
// table prefix) so the preview, insert and soft-delete cannot drift apart.
const genuineWhere = (p = '') => `
    ${p}is_deleted = false
    AND ${p}problem_name NOT IN ('6.4.8', '1.1.1')
    AND btrim(${p}content) !~ '^[0-9]{1,3}$'
    AND char_length(btrim(${p}content)) >= 6
`;

async function main() {
    const candidates = await pool.query(
        `SELECT id, problem_name, COALESCE(language, 'ru') AS language, user_id,
                created_at, content
         FROM brainstorm_messages
         WHERE ${genuineWhere()}
         ORDER BY id`
    );

    console.log(`Found ${candidates.rowCount} genuine brainstorm message(s) to migrate:\n`);
    for (const r of candidates.rows) {
        const snippet = r.content.replace(/\s+/g, ' ').slice(0, 70);
        console.log(`  #${r.id}  ${r.problem_name} [${r.language}] u${r.user_id}  ${snippet}${r.content.length > 70 ? '…' : ''}`);
    }
    console.log('');

    if (DRY_RUN) {
        console.log('--dry-run: no changes written.');
        return;
    }
    if (candidates.rowCount === 0) {
        console.log('Nothing to migrate.');
        return;
    }

    // Guard: the target column must exist (migration 045) before we write.
    const col = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'solution_comments' AND column_name = 'is_brainstorm'`
    );
    if (col.rowCount === 0) {
        throw new Error('solution_comments.is_brainstorm is missing — run migration 045 first (npm run migrate).');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Insert into comments, preserving author, language and timestamp. The
        // NOT EXISTS guard makes a re-run before soft-delete a no-op as well.
        const inserted = await client.query(
            `INSERT INTO solution_comments
                (user_id, problem_name, language, content, parent_id, is_brainstorm, created_at, updated_at)
             SELECT b.user_id, b.problem_name, COALESCE(b.language, 'ru'), b.content,
                    NULL, true, b.created_at, b.created_at
             FROM brainstorm_messages b
             WHERE ${genuineWhere('b.')}
               AND NOT EXISTS (
                   SELECT 1 FROM solution_comments c
                   WHERE c.user_id = b.user_id
                     AND c.problem_name = b.problem_name
                     AND c.content = b.content
                     AND c.is_brainstorm = true
               )
             RETURNING id`
        );

        // Soft-delete the source rows so they leave the (retired) room.
        const softDeleted = await client.query(
            `UPDATE brainstorm_messages
             SET is_deleted = true, updated_at = NOW()
             WHERE ${genuineWhere()}`
        );

        await client.query('COMMIT');
        console.log(`Inserted ${inserted.rowCount} comment(s); soft-deleted ${softDeleted.rowCount} brainstorm message(s).`);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

main()
    .then(() => pool.end())
    .catch((err) => {
        console.error(err);
        pool.end();
        process.exit(1);
    });
