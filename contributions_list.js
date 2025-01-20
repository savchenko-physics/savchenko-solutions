const { Pool } = require("pg");
const i18n = require('i18n');

// Assuming pool is initialized somewhere globally or passed as a parameter
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
        const result = await pool.query(
            `SELECT 
                c.*, 
                u.username,
                u.full_name
            FROM (
                SELECT 
                    id, user_id, edited_at, problem_name, language, original_content, new_content, NULL::text AS ip_address, false AS content_changed
                FROM github_contributions
                UNION ALL
                SELECT 
                    id, user_id, edited_at, problem_name, language, original_content, new_content, ip_address, content_changed
                FROM contributions
            ) c
            LEFT JOIN users u ON c.user_id = u.id
            WHERE c.problem_name = $1 AND c.language = $2
            ORDER BY c.edited_at DESC`,
            [problemName, lang]
        );

        console.log(result.rows);

        const contributions = result.rows;

        res.render("contributions_list", {
            __: i18n.__,
            lang,
            problemName,
            contributions,
            formatDate: (date) => {
                return new Date(date).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            }
        });

    } catch (error) {
        console.error("Error fetching contributions:", error);
        res.status(500).send("Error fetching contributions");
    }
}

module.exports = getContributionsList; 