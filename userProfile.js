const { Pool } = require("pg");
const i18n = require("i18n");

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

async function getUserProfile(req, res) {
    const { username } = req.params;
    const lang = req.query.lang || req.session.lang || "en";
    i18n.setLocale(res, lang);

    try {
        const userResult = await pool.query(
            `
            SELECT id, username, full_name, profile_picture
            FROM users
            WHERE username = $1
        `,
            [username]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).render("404", {
                __: i18n.__,
                pageUrl: req.originalUrl,
                lang,
            });
        }

        const user = userResult.rows[0];

        let currentUserProfile = null;
        if (req.session.userId) {
            const currentUserResult = await pool.query(
                "SELECT username, profile_picture FROM users WHERE id = $1",
                [req.session.userId]
            );
            if (currentUserResult.rows.length > 0) {
                currentUserProfile = currentUserResult.rows[0];
            }
        }

        const isOwner = req.session.userId === user.id;

        // If viewing own profile, fetch activity data
        let starredSolutions = [];
        let recentForumActivity = [];
        let challengeHistory = [];
        if (isOwner) {
            const [starredResult, forumResult, challengeResult] = await Promise.all([
                pool.query(
                    `SELECT problem_name, language, created_at FROM starred_solutions
                     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
                    [user.id]
                ),
                pool.query(
                    `(SELECT 'topic' AS type, ft.title, ft.id AS topic_id, ft.slug,
                             fc.slug AS category_slug, ft.created_at
                      FROM forum_topics ft
                      JOIN forum_categories fc ON ft.category_id = fc.id
                      WHERE ft.user_id = $1
                      ORDER BY ft.created_at DESC LIMIT 10)
                     UNION ALL
                     (SELECT 'reply' AS type, ft.title, ft.id AS topic_id, ft.slug,
                             fc.slug AS category_slug, fp.created_at
                      FROM forum_posts fp
                      JOIN forum_topics ft ON fp.topic_id = ft.id
                      JOIN forum_categories fc ON ft.category_id = fc.id
                      WHERE fp.user_id = $1
                      ORDER BY fp.created_at DESC LIMIT 10)
                     ORDER BY created_at DESC LIMIT 10`,
                    [user.id]
                ),
                pool.query(
                    `SELECT cs.id, cs.challenge_id, cs.status, cs.score, cs.submitted_at,
                            wc.title AS challenge_title
                     FROM challenge_submissions cs
                     JOIN weekly_challenges wc ON cs.challenge_id = wc.id
                     WHERE cs.user_id = $1
                     ORDER BY cs.submitted_at DESC LIMIT 10`,
                    [user.id]
                ).catch(() => ({ rows: [] })),
            ]);
            starredSolutions = starredResult.rows;
            recentForumActivity = forumResult.rows;
            challengeHistory = challengeResult.rows;
        }

        return res.render("user_profile", {
            __: i18n.__,
            lang,
            username: user.username,
            profileUserId: user.id,
            isOwner,
            starredSolutions,
            recentForumActivity,
            challengeHistory,
            usernameCurrent: currentUserProfile?.username || null,
            profilePictureCurrent: currentUserProfile
                ? (currentUserProfile.profile_picture || "/img/profile_images/Default_placeholder.svg")
                : null,
            sessionUsername: req.session.username || null,
        });
    } catch (error) {
        console.error("Error fetching user profile:", error);
        return res.status(500).render("404", {
            __: i18n.__,
            pageUrl: req.originalUrl,
            lang,
        });
    }
}

module.exports = getUserProfile;