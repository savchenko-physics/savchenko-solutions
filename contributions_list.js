const { Pool } = require("pg");
const i18n = require('i18n');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

async function getContributionsList(req, res) {
    const { lang, problemName } = req.params;
    i18n.setLocale(res, lang);

    try {
        const rawLimit = parseInt(req.query.limit, 10);
        const rawOffset = parseInt(req.query.offset, 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(50, rawLimit)) : 250;
        const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

        let result;
        let stats;
        let totalRows = 0;
        if (problemName === 'all') {
            const [rowsResult, statsResult] = await Promise.all([
                pool.query(
                `SELECT
                    c.id, c.user_id, c.edited_at, c.problem_name, c.language, c.content_changed, c.source,
                    u.username,
                    u.full_name,
                    u.profile_picture,
                    CASE
                        WHEN ROW_NUMBER() OVER (PARTITION BY c.problem_name ORDER BY c.edited_at ASC, c.id ASC) = 1
                        THEN 1 ELSE 0
                    END AS is_new
                FROM (
                    SELECT
                        id, user_id, edited_at, problem_name, language, false AS content_changed, 'github' AS source
                    FROM github_contributions
                    UNION ALL
                    SELECT
                        id, user_id, edited_at, problem_name, language, content_changed, 'direct' AS source
                    FROM contributions
                ) c
                LEFT JOIN users u ON c.user_id = u.id
                ORDER BY c.edited_at DESC
                LIMIT $1 OFFSET $2
                `,
                [limit, offset]
            ),
                pool.query(
                    `SELECT
                        COUNT(*)::int AS total,
                        COUNT(DISTINCT problem_name)::int AS unique_problems,
                        COUNT(DISTINCT user_id)::int AS unique_contributors
                    FROM (
                        SELECT user_id, problem_name, language
                        FROM github_contributions
                        UNION ALL
                        SELECT user_id, problem_name, language
                        FROM contributions
                    ) c`
                ),
            ]);
            result = rowsResult;
            stats = {
                total: statsResult.rows[0]?.total || 0,
                uniqueProblems: statsResult.rows[0]?.unique_problems || 0,
                uniqueContributors: statsResult.rows[0]?.unique_contributors || 0,
            };
            totalRows = Number(stats.total || 0);
        } else {
            const [rowsResult, statsResult] = await Promise.all([
                pool.query(
                `SELECT
                    c.id, c.user_id, c.edited_at, c.problem_name, c.language, c.content_changed, c.source,
                    u.username,
                    u.full_name,
                    u.profile_picture,
                    CASE
                        WHEN ROW_NUMBER() OVER (PARTITION BY c.problem_name ORDER BY c.edited_at ASC, c.id ASC) = 1
                        THEN 1 ELSE 0
                    END AS is_new
                FROM (
                    SELECT
                        id, user_id, edited_at, problem_name, language, false AS content_changed, 'github' AS source
                    FROM github_contributions
                    UNION ALL
                    SELECT
                        id, user_id, edited_at, problem_name, language, content_changed, 'direct' AS source
                    FROM contributions
                ) c
                LEFT JOIN users u ON c.user_id = u.id
                WHERE c.problem_name = $1 AND c.language = $2
                ORDER BY c.edited_at DESC
                LIMIT $3 OFFSET $4`,
                [problemName, lang, limit, offset]
            ),
                pool.query(
                    `SELECT
                        COUNT(*)::int AS total,
                        COUNT(DISTINCT problem_name)::int AS unique_problems,
                        COUNT(DISTINCT user_id)::int AS unique_contributors
                    FROM (
                        SELECT user_id, problem_name, language
                        FROM github_contributions
                        UNION ALL
                        SELECT user_id, problem_name, language
                        FROM contributions
                    ) c
                    WHERE c.problem_name = $1 AND c.language = $2`,
                    [problemName, lang]
                ),
            ]);
            result = rowsResult;
            stats = {
                total: statsResult.rows[0]?.total || 0,
                uniqueProblems: statsResult.rows[0]?.unique_problems || 0,
                uniqueContributors: statsResult.rows[0]?.unique_contributors || 0,
            };
            totalRows = Number(stats.total || 0);
        }

        const contributions = result.rows.map(row => ({
            ...row,
            isNew: Number(row.is_new) === 1
        }));

        // Group by date
        const grouped = {};
        contributions.forEach(c => {
            const dateKey = new Date(c.edited_at).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
            if (!grouped[dateKey]) grouped[dateKey] = [];
            grouped[dateKey].push(c);
        });

        res.render("contributions_list", {
            __: i18n.__,
            lang,
            problemName,
            contributions,
            grouped,
            stats,
            pagination: {
                limit,
                offset,
                shown: contributions.length,
                hasMore: offset + contributions.length < totalRows,
                nextOffset: offset + contributions.length,
            },
            formatDate: (date) => {
                return new Date(date).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            },
            formatTime: (date) => {
                return new Date(date).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
                    hour: '2-digit',
                    minute: '2-digit'
                });
            },
            usernameCurrent: req.session.username || null,
            userIdCurrent: req.session.userId || null,
            username: req.session.username || null,
        });

    } catch (error) {
        console.error("Error fetching contributions:", error);
        res.status(500).send("Error fetching contributions");
    }
}

module.exports = getContributionsList; 