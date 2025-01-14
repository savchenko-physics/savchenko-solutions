const { Pool } = require("pg");
const i18n = require('i18n');

// Assuming pool is already configured and exported from another module
const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

async function getContribution(req, res) {
    const { lang, problemName } = req.params;
    i18n.setLocale(res, lang);

    try {
        const result = await pool.query(
            `SELECT 
                c.*, 
                u.username,
                u.full_name,
                CASE 
                    WHEN c.user_id IS NULL THEN c.ip_address
                    ELSE u.username
                END as editor_identifier,
                CASE 
                    WHEN c.user_id IS NULL THEN c.ip_address
                    ELSE u.full_name
                END as editor_name
            FROM contributions c
            LEFT JOIN users u ON c.user_id = u.id
            WHERE c.id = $1`,
            [problemName]
        );

        if (result.rows.length === 0) {
            return res.status(404).render("404", {
                __: i18n.__,
                pageUrl: req.originalUrl,
                lang
            });
        }

        const contribution = result.rows[0];
        const originalLines = contribution.original_content.split('\n');
        const newLines = contribution.new_content.split('\n');
        const changes = [];
        const maxLength = Math.max(originalLines.length, newLines.length);

        for (let i = 0; i < maxLength; i++) {
            if (originalLines[i] !== newLines[i]) {
                changes.push({
                    lineNumber: i + 1,
                    original: originalLines[i] || '',
                    new: newLines[i] || '',
                    type: !originalLines[i] ? 'added' :
                        !newLines[i] ? 'removed' :
                            'modified'
                });
            }
        }

        res.render("contribution", {
            __: i18n.__,
            lang,
            contribution: {
                ...result.rows[0],
                isAnonymous: !result.rows[0].user_id
            },
            changes,
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
        console.error("Error fetching contribution:", error);
        res.status(500).send("Error fetching contribution details");
    }
}

module.exports = { getContribution }; 