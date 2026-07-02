/**
 * Seed a small amount of realistic Brainstorm Room data so the UI (Phases 2–3)
 * can be developed against something. The room is UNIFIED per problem (all
 * languages together), so we deliberately mix Russian and English messages on the
 * same problem to exercise that.
 *
 * Idempotent: does nothing if brainstorm_messages already has rows.
 * Reuses the real link parser from brainstorm.js so seeded cross-links match what
 * the API would produce at runtime.
 *
 * Run: node scripts/seed-brainstorm.js   (after `npm run migrate`)
 */

require('dotenv').config();
const { Pool } = require('pg');
const { parseProblemLinks, ALLOWED_REACTIONS } = require('../brainstorm');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

// problem_name, language tag, author slot (index into the picked users), content, pinned
const SEED_MESSAGES = [
    {
        problem: '6.4.8', lang: 'ru', author: 0, pinned: true,
        content: 'Давайте соберёмся: ключ к задаче — записать сохранение энергии в системе отсчёта, связанной с центром масс. Там геометрия сразу упрощается. Кто-нибудь пробовал так?',
    },
    {
        problem: '6.4.8', lang: 'en', author: 1, pinned: false,
        content: 'Building on that — once you are in the CoM frame, the trick is identical to [the energy-balance argument from](#6.4.7). The cross term vanishes by symmetry.',
    },
    {
        problem: '6.4.8', lang: 'en', author: 2, pinned: false,
        content: 'Wait, does the symmetry really hold if the masses differ? I think we need the reduced mass here. Compare with #2.4.44 where the same subtlety bit us.',
    },
    {
        problem: '6.4.8', lang: 'ru', author: 3, pinned: false,
        content: 'Точно, приведённая масса всё решает. Тогда ответ совпадает с табличным. Красиво!',
    },
    {
        problem: '1.1.1', lang: 'en', author: 1, pinned: true,
        content: 'Classic opener. The whole problem is a frame-of-reference question in disguise — pick the river frame and the boy swims a straight line. Everything else is bookkeeping.',
    },
    {
        problem: '1.1.1', lang: 'ru', author: 0, pinned: false,
        content: 'Согласен. Интересно сравнить с [похожей идеей про относительную скорость](#1.1.14) — там тоже выигрываешь, меняя систему отсчёта.',
    },
];

// Which message indices get reactions, and how many distinct users react.
const REACTION_PLAN = [
    { msg: 0, reactors: 5 },
    { msg: 1, reactors: 3 },
    { msg: 4, reactors: 6 },
    { msg: 2, reactors: 1 },
];

async function main() {
    const client = await pool.connect();
    try {
        const existing = await client.query('SELECT COUNT(*) FROM brainstorm_messages');
        if (parseInt(existing.rows[0].count, 10) > 0) {
            console.log(`brainstorm_messages already has ${existing.rows[0].count} rows. Skipping seed.`);
            return;
        }

        // Pick real, active users to author the messages (most prolific commenters
        // first; fall back to any users on a fresh DB).
        let users = (await client.query(
            `SELECT u.id, u.username
             FROM users u
             ORDER BY (SELECT COUNT(*) FROM solution_comments sc WHERE sc.user_id = u.id) DESC, u.id ASC
             LIMIT 8`
        )).rows;
        if (users.length < 2) {
            users = (await client.query('SELECT id, username FROM users ORDER BY id ASC LIMIT 8')).rows;
        }
        if (users.length < 2) {
            console.error('Not enough users in the database to seed brainstorm messages.');
            return;
        }
        const userId = (slot) => users[slot % users.length].id;

        await client.query('BEGIN');

        const insertedIds = [];
        for (const m of SEED_MESSAGES) {
            const r = await client.query(
                `INSERT INTO brainstorm_messages
                   (problem_name, language, user_id, content, is_pinned)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id`,
                [m.problem, m.lang, userId(m.author), m.content, m.pinned]
            );
            const id = r.rows[0].id;
            insertedIds.push(id);

            // Mirror the runtime behaviour: persist structured wiki cross-links.
            for (const link of parseProblemLinks(m.content)) {
                await client.query(
                    `INSERT INTO brainstorm_message_links (message_id, target_problem_name, link_text)
                     VALUES ($1, $2, $3)`,
                    [id, link.targetProblemName, link.linkText.slice(0, 255)]
                );
            }
        }

        // Add reactions from distinct users (skip the author to be realistic).
        for (const plan of REACTION_PLAN) {
            const messageId = insertedIds[plan.msg];
            let added = 0;
            for (let i = 0; i < users.length && added < plan.reactors; i++) {
                const reactorId = users[i].id;
                const emoji = ALLOWED_REACTIONS[i % ALLOWED_REACTIONS.length];
                try {
                    await client.query(
                        `INSERT INTO brainstorm_reactions (message_id, user_id, emoji)
                         VALUES ($1, $2, $3)
                         ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
                        [messageId, reactorId, emoji]
                    );
                    added++;
                } catch (_) { /* ignore */ }
            }
        }

        // Sync the denormalized popularity counter.
        await client.query(
            `UPDATE brainstorm_messages m
             SET reaction_count = (SELECT COUNT(*) FROM brainstorm_reactions r WHERE r.message_id = m.id)
             WHERE m.id = ANY($1)`,
            [insertedIds]
        );

        await client.query('COMMIT');
        console.log(`Seeded ${insertedIds.length} brainstorm messages across 2 problems, with reactions and cross-links.`);
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('Seed failed:', err);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();
