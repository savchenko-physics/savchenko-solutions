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
        let result;
        if (problemName === 'all') {
            result = await pool.query(
                `SELECT
                    c.id, c.user_id, c.edited_at, c.problem_name, c.language, c.content_changed, c.source,
                    u.username,
                    u.full_name,
                    u.profile_picture,
                    (SELECT COUNT(*) FROM contributions c2 WHERE c2.problem_name = c.problem_name AND c2.edited_at <= c.edited_at) AS edit_number
                FROM (
                    SELECT
                        id, user_id, edited_at, problem_name, language, false AS content_changed, 'github' AS source
                    FROM github_contributions
                    UNION ALL
                    SELECT
                        id, user_id, edited_at, problem_name, language, content_changed, 'direct' AS source
                    FROM contributions
                    WHERE invisible = false
                ) c
                LEFT JOIN users u ON c.user_id = u.id
                WHERE c.language = $1
                ORDER BY c.edited_at DESC
                LIMIT 100`,
                [lang]
            );
        } else {
            result = await pool.query(
                `SELECT
                    c.id, c.user_id, c.edited_at, c.problem_name, c.language, c.content_changed, c.source,
                    u.username,
                    u.full_name,
                    u.profile_picture,
                    (SELECT COUNT(*) FROM contributions c2 WHERE c2.problem_name = c.problem_name AND c2.edited_at <= c.edited_at) AS edit_number
                FROM (
                    SELECT
                        id, user_id, edited_at, problem_name, language, false AS content_changed, 'github' AS source
                    FROM github_contributions
                    UNION ALL
                    SELECT
                        id, user_id, edited_at, problem_name, language, content_changed, 'direct' AS source
                    FROM contributions
                    WHERE invisible = false
                ) c
                LEFT JOIN users u ON c.user_id = u.id
                WHERE c.problem_name = $1 AND c.language = $2
                ORDER BY c.edited_at DESC`,
                [problemName, lang]
            );
        }

        const contributions = result.rows.map(row => ({
            ...row,
            isNew: parseInt(row.edit_number) === 1
        }));

        // Compute stats
        const uniqueProblems = new Set(contributions.map(c => c.problem_name)).size;
        const uniqueContributors = new Set(contributions.filter(c => c.username).map(c => c.username)).size;

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
            stats: {
                total: contributions.length,
                uniqueProblems,
                uniqueContributors
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