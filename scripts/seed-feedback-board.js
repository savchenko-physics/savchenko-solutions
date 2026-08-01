// seed-feedback-board.js: open the public board with the requests already on record.
//
// Run once, after migration 042:   node scripts/seed-feedback-board.js
// Idempotent: every row carries a fixed public_id and is upserted, so re-running changes
// nothing. Add --dry to print without writing.
//
// Why seed at all. A board with three items reads as "nobody uses this" and nobody adds a
// fourth. Every item below was actually asked for, in the September 2025 survey, in the
// forum, in a comment, or in a direct message, and several were asked for more than once
// by different people. Publishing them is not decoration: it is the site finally
// acknowledging requests that in some cases have gone unanswered for a year, and it gives
// the first real visitor something to vote on, which is the only way the owner learns which
// of forty requests actually matter.
//
// Deliberately anonymous. The people who wrote these did not agree to be named on a public
// page, and several wrote privately. The count goes into `base_score`, not `votes`: it is
// the number of DISTINCT people independently recorded asking for that thing: evidenced,
// never invented, 1 where it was one person. It is kept separate from votes cast here
// rather than faked as vote rows with fabricated voters.
//
// `status` is honest about commitment:
//   planned  the owner has stated an intention to do it, in writing
//   new      asked for, not yet decided ("Suggested" on the board)
//
// `at` is when the request was actually made, taken from the survey timestamps and the mail
// and DM archive. It is not decoration. Seeded rows previously carried the moment the script
// ran, so a request from the September 2025 survey displayed as an hour old, and a board
// where every item is minutes old reads as manufactured whether or not it is.
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

const ITEMS = [
    {
        id: 'seed-feedback-page1', at: '2025-10-01',   // survey Q7: 14 of 21 said yes to follow-up
        status: 'done', votes: 14, lang: 'ru',
        title: 'Место, где видно, что стало с предложением',
        body: 'В опросе 14 человек из 21 согласились участвовать в дальнейшем обсуждении, '
            + 'на форуме есть раздел «Обратная связь», а один из авторов прямо спросил в '
            + 'письме, намерены ли здесь вообще поддерживать диалог. Общего места, где видно '
            + 'судьбу предложения, до сих пор не было: жалобы уходили в никуда.',
        reply: 'Сделано: эта страница. Написать можно без аккаунта, в ответ приходит '
            + 'постоянная ссылка, по которой всегда видно статус. Когда предложение '
            + 'выполнено, всем, кто просил и оставил контакт, приходит уведомление.',
    },
    {
        id: 'seed-irodov-000001', at: '2026-03-04',   // survey response 19, 2026-03-04
        status: 'planned', votes: 3, lang: 'ru',
        title: 'Добавить решения задачника Иродова',
        body: 'Запрошено в опросе сентября 2025 отдельно двумя людьми, и ещё раз на форуме. '
            + '«Добавьте книги такие как Иродов или же Прут Овчинкин».',
        reply: 'Расширение за пределы Савченко это направление номер один: за него в опросе '
            + 'высказались 14 человек из 21. Иродов и Овчинкин–Прут названы чаще всего.',
    },
    {
        id: 'seed-ovchinkin-0001', at: '2026-03-10',   // survey response 20, 2026-03-10
        status: 'planned', votes: 2, lang: 'ru',
        title: 'Добавить сборник Овчинкина–Прута',
        body: 'Запрошено в опросе дважды, независимо. Названо как первый кандидат на расширение.',
        reply: 'Планируется как первый сборник после Савченко.',
    },
    {
        id: 'seed-errata-000001', at: '2025-10-15',   // survey response 9, 2025-10-15
        status: 'new', votes: 2, lang: 'ru',
        title: 'Исправленное издание задачника: список опечаток и ошибок',
        body: 'В Савченко много опечаток и ошибок, часть уже отмечена в решениях на сайте. '
            + 'Предложено собрать их на одной странице и сделать онлайн- или PDF-версию '
            + 'исправленного задачника. Один из участников предложил передать собственный '
            + 'список правок, накопленный за годы.',
        reply: null,
    },
    {
        id: 'seed-en-coverage01', at: '2025-11-08',   // survey response 12, 2025-11-08
        status: 'new', votes: 2, lang: 'ru',
        title: 'Догнать английскую версию по покрытию',
        body: 'Английских решений примерно вдвое меньше, чем русских, и часть переведена '
            + 'не полностью: «В английской версии решение не полное».',
        reply: null,
    },
    {
        id: 'seed-upload-fix01', at: '2024-12-28',   // earliest upload-failure email, 2024-12-28
        status: 'new', votes: 6, lang: 'ru',
        title: 'Починить загрузку решения',
        body: 'Люди из Бразилии, Азербайджана, Грузии, Молдовы и Кубы присылали решения '
            + 'письмом, потому что загрузка на сайте не срабатывала. Один участник обошёл '
            + 'неактивную кнопку «Отправить», выполнив скрипт в консоли браузера.',
        reply: null,
    },
    {
        id: 'seed-undo-upload01', at: '2026-06-15',   // DM thread, June 2026
        status: 'new', votes: 3, lang: 'ru',
        title: 'Возможность удалить или отменить своё решение',
        body: 'Кнопки удаления нет: один участник вместо этого стёр текст решения, '
            + 'другой загрузил решение не в ту задачу и написал в личные сообщения, '
            + 'третьему потребовалось перенести решение между задачами вручную.',
        reply: null,
    },
    {
        id: 'seed-photo-upload1', at: '2026-06-20',   // DM thread, June 2026
        status: 'new', votes: 2, lang: 'ru',
        title: 'Загрузка решения фотографией, без перенабора в LaTeX',
        body: 'Перенабор с листа это названный барьер: один из авторов рассказал, что около '
            + 'десяти раз выбрасывал листки с решениями, потому что не хотелось их '
            + 'перенабирать. Другой оформляет задачи в Word, потому что не знает LaTeX.',
        reply: null,
    },
    {
        id: 'seed-review-multi1', at: '2026-07-30',   // DM, 2026-07-30
        status: 'new', votes: 3, lang: 'ru',
        title: 'Проверка решения несколькими людьми',
        body: '«Нельзя просто довериться правоте каждого человека… проверка задач '
            + 'несколькими людьми сильно бы повысила качество». Предлагалось также '
            + 'разделить проверку между несколькими доверенными авторами.',
        reply: null,
    },
    {
        id: 'seed-chapter-tabs1', at: '2025-10-13',   // survey response 8, 2025-10-13
        status: 'planned', votes: 1, lang: 'ru',
        title: 'Кнопки глав и разделов на главной странице',
        body: 'Предложено сделать на главной кнопки с главами и разделами, по нажатию '
            + 'открывается список задач раздела.',
        reply: 'Добавлено в список ближайших улучшений.',
    },
    {
        id: 'seed-quiz-mode001', at: '2025-11-08',   // survey response 12, 2025-11-08
        status: 'new', votes: 1, lang: 'en',
        title: 'Quizzes and self-tests to check understanding',
        body: '«It would be great to create quizzes, tests or something to test the '
            + 'knowledge, it would help a lot.»',
        reply: null,
    },
    {
        id: 'seed-spanish-0001', at: '2025-12-12',   // survey response 15, 2025-12-12
        status: 'new', votes: 2, lang: 'en',
        title: 'Spanish translation',
        body: 'Requested from Argentina: Savchenko is an emblem in South America and Mir '
            + 'Publishers translations circulate widely there. A comment in Spanish has also '
            + 'been left on a solution, and there are readers in Cuba, Peru and Mexico.',
        reply: null,
    },
    {
        id: 'seed-olympiads001', at: '2025-11-26',   // survey response 13, 2025-11-26
        status: 'new', votes: 3, lang: 'ru',
        title: 'Решения международных и национальных олимпиад',
        body: 'Предложены решения задач международных олимпиад по физике, китайских '
            + 'национальных олимпиад и листков mathus.ru.',
        reply: null,
    },
    {
        id: 'seed-theory-wiki1', at: '2025-10-01',   // survey opened 2025-10-01; 10 of 21 chose this option
        status: 'new', votes: 10, lang: 'ru',
        title: 'Совместный учебник: теория, нужная для решения задач',
        body: 'Раздел с теоретической базой: что нужно знать, чтобы решить задачу. '
            + 'В опросе вариант «совместный учебник по физике (как Википедия)» набрал '
            + '10 голосов из 21.',
        reply: null,
    },
    {
        id: 'seed-author-pay01', at: '2025-10-02',   // survey response 3, 2025-10-02
        status: 'new', votes: 1, lang: 'ru',
        title: 'Финансовая поддержка авторов решений',
        body: 'Предложение: платить за создание и рецензирование решений, оставляя чтение '
            + 'бесплатным. Аргумент автора предложения в том, что без этого число регулярных '
            + 'авторов останется очень небольшим.',
        reply: null,
    },
];

async function main() {
    const dry = process.argv.includes('--dry');
    let written = 0;
    for (const it of ITEMS) {
        if (dry) {
            console.log(`[dry] ${it.at}  ${it.status.padEnd(8)} ${String(it.votes).padStart(2)}  ${it.title}`);
            continue;
        }
        // ON CONFLICT on the fixed public_id makes a re-run a no-op rather than a duplicate.
        await pool.query(
            `INSERT INTO feedback_items
                (public_id, category, body, lang, status, is_public, public_title, public_reply, base_score, votes, created_at, resolved_at)
             VALUES ($1, 'idea', $2, $3, $4, true, $5, $6, $7, $7, $8,
                     CASE WHEN $4 IN ('done','declined') THEN COALESCE($9::timestamptz, now()) ELSE NULL END)
             ON CONFLICT (public_id) DO UPDATE
               SET body = EXCLUDED.body,
                   lang = EXCLUDED.lang,
                   category = EXCLUDED.category,
                   status = EXCLUDED.status,
                   public_title = EXCLUDED.public_title,
                   public_reply = EXCLUDED.public_reply,
                   is_public = true,
                   base_score = EXCLUDED.base_score,
                   votes = EXCLUDED.base_score + feedback_items.upvotes - feedback_items.downvotes,
                   created_at = EXCLUDED.created_at,
                   resolved_at = EXCLUDED.resolved_at`,
            [it.id, it.body, it.lang, it.status, it.title, it.reply, it.votes, it.at, it.resolvedAt || null]
        );
        written += 1;
        console.log(`seeded  ${it.title}`);
    }
    console.log(dry ? `\n${ITEMS.length} items (dry run, nothing written)` : `\n${written} items on the board`);
    await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
