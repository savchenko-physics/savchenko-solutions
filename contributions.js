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
        // Get current user's profile picture if logged in
        let profilePictureCurrent = null;
        if (req.session.userId) {
            const currentUserResult = await pool.query(
                "SELECT profile_picture FROM users WHERE id = $1",
                [req.session.userId]
            );
            profilePictureCurrent = currentUserResult.rows[0]?.profile_picture;
        }

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
                END as editor_name,
                c.caption,
                c.commit
            FROM (
                SELECT 
                    id, user_id, edited_at, problem_name, language, 
                    original_content, new_content, ip_address, content_changed, 
                    NULL as caption, NULL as commit, coauthors
                FROM contributions
                UNION ALL
                SELECT 
                    id, user_id, edited_at, problem_name, language, 
                    original_content, new_content, NULL as ip_address, 
                    false as content_changed, caption, commit, coauthors
                FROM github_contributions
            ) c
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

        // Calculate changes
        for (let i = 0; i < Math.max(originalLines.length, newLines.length); i++) {
            if (originalLines[i] !== newLines[i]) {
                if (originalLines[i] && !newLines[i]) {
                    changes.push({ type: 'removed', line: originalLines[i], lineNumber: i + 1 });
                } else if (!originalLines[i] && newLines[i]) {
                    changes.push({ type: 'added', line: newLines[i], lineNumber: i + 1 });
                } else {
                    changes.push({ type: 'modified', line: newLines[i], lineNumber: i + 1 });
                }
            }
        }

        // Render the EJS template with the diff HTML
        res.render("contribution", {
            __: i18n.__,
            lang,
            contribution: {
                ...result.rows[0],
                isAnonymous: !result.rows[0].user_id
            },
            usernameCurrent: req.session.username,
            userIdCurrent: req.session.userId,
            profilePictureCurrent,
            newContent: contribution.new_content,
            originalContent: contribution.original_content,
            changes, // Pass the changes array to the template
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

async function getContributionsByUserId(userId, limit, offset) {
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
            WHERE c.user_id = $1
            ORDER BY c.edited_at DESC
            LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        return result.rows;
    } catch (error) {
        console.error("Error fetching contributions by user ID:", error);
        throw error;
    }
}

async function getTotalContributions(userId) {
    const result = await pool.query(
        `
        SELECT COUNT(*) AS total_contributions
        FROM (
            SELECT 
                id, user_id, edited_at, problem_name, language, original_content, new_content, NULL::text AS ip_address, false AS content_changed
            FROM github_contributions
            UNION ALL
            SELECT 
                id, user_id, edited_at, problem_name, language, original_content, new_content, ip_address, content_changed
            FROM contributions
        ) c
        WHERE c.user_id = $1
        `,
        [userId]
    );
    return result.rows[0].total_contributions;
}

async function getUniqueContributions(userId) {
    const result = await pool.query(
        `
        SELECT COUNT(*) AS total_contributions
        FROM (
            SELECT 
                id, user_id, edited_at, problem_name, language, original_content, new_content, NULL::text AS ip_address, false AS content_changed
            FROM github_contributions
            UNION ALL
            SELECT 
                id, user_id, edited_at, problem_name, language, original_content, new_content, ip_address, content_changed
            FROM contributions
        ) c
        WHERE c.user_id = $1
        `,
        [userId]
    );
    return result.rows[0].total_contributions;
}

async function getUniqueSolutions(userId) {
    const result = await pool.query(
        `
        SELECT COUNT(DISTINCT problem_name) AS unique_solutions
        FROM (
            SELECT 
                problem_name
            FROM github_contributions
            WHERE user_id = $1
            UNION ALL
            SELECT 
                problem_name
            FROM contributions
            WHERE user_id = $1
        ) c
        `,
        [userId]
    );
    return result.rows[0].unique_solutions;
}

async function getTranslations(userId) {
    const result = await pool.query(
        `
        SELECT COUNT(*) AS unique_translations
        FROM (
            (
                SELECT problem_name
                FROM github_contributions
                WHERE user_id = $1 AND language = 'ru'
                UNION ALL
                SELECT problem_name
                FROM contributions
                WHERE user_id = $1 AND language = 'ru'
            )
            INTERSECT
            (
                SELECT problem_name
                FROM github_contributions
                WHERE user_id = $1 AND language = 'en'
                UNION ALL
                SELECT problem_name
                FROM contributions
                WHERE user_id = $1 AND language = 'en'
            )
        ) c
        `,
        [userId]
    );
    return result.rows[0].unique_translations;
}

async function getFrequentCollaborators(userId) {
    const result = await pool.query(
        `
        SELECT 
            u.id AS collaborator_id,
            u.username AS collaborator_username,
            COUNT(*) AS collaboration_count
        FROM (
            SELECT 
                c1.problem_name, 
                c2.user_id AS collaborator_id
            FROM contributions c1
            JOIN contributions c2 ON c1.problem_name = c2.problem_name AND c1.user_id <> c2.user_id
            WHERE c1.user_id = $1
            UNION ALL
            SELECT 
                gc1.problem_name, 
                gc2.user_id AS collaborator_id
            FROM github_contributions gc1
            JOIN github_contributions gc2 ON gc1.problem_name = gc2.problem_name AND gc1.user_id <> gc2.user_id
            WHERE gc1.user_id = $1
        ) collaborations
        JOIN users u ON collaborations.collaborator_id = u.id
        GROUP BY u.id, u.username
        ORDER BY collaboration_count DESC
        `,
        [userId]
    );
    return result.rows;
}

module.exports = { getContribution, getContributionsByUserId, getTotalContributions, getUniqueContributions, getUniqueSolutions, getTranslations, getFrequentCollaborators }; 