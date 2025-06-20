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

async function getUserProfile(req, res) {
    const { username } = req.params;
    const lang = req.query.lang || req.session.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        // Get user data with social stats
        const userResult = await pool.query(`
            SELECT 
                u.*,
                (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id) as followers_count,
                (SELECT COUNT(*) FROM user_follows WHERE follower_id = u.id) as following_count,
                (SELECT COUNT(*) FROM solution_likes WHERE user_id = u.id) as total_likes_given,
                (SELECT COUNT(*) FROM starred_solutions WHERE user_id = u.id) as starred_count
            FROM users u 
            WHERE u.username = $1
        `, [username]);

        if (userResult.rows.length === 0) {
            return res.status(404).render("404", {
                __: i18n.__,
                pageUrl: req.originalUrl,
                lang
            });
        }

        const user = userResult.rows[0];
        
        // Check if current user is following this user
        let isFollowing = false;
        let isOwnProfile = false;
        
        if (req.session.userId) {
            isOwnProfile = req.session.userId === user.id;
            
            if (!isOwnProfile) {
                const followResult = await pool.query(
                    "SELECT id FROM user_follows WHERE follower_id = $1 AND following_id = $2",
                    [req.session.userId, user.id]
                );
                isFollowing = followResult.rows.length > 0;
            }
        }

        // Get user contributions with pagination
        const offset = parseInt(req.query.offset) || 0;
        const limit = 25;
        
        const contributionsResult = await pool.query(`
            (SELECT 
                problem_name, 
                language, 
                edited_at, 
                id,
                'contribution' as type
            FROM contributions 
            WHERE user_id = $1 AND content_changed = true
            UNION ALL
            SELECT 
                problem_name, 
                language, 
                edited_at, 
                id,
                'github' as type
            FROM github_contributions 
            WHERE user_id = $1)
            ORDER BY edited_at DESC 
            LIMIT $2 OFFSET $3
        `, [user.id, limit, offset]);

        // Get user's starred solutions
        const starredResult = await pool.query(`
            SELECT problem_name, language, created_at
            FROM starred_solutions 
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT 10
        `, [user.id]);

        // Get user interests
        const interestsResult = await pool.query(
            "SELECT interest_tag, proficiency_level FROM user_interests WHERE user_id = $1",
            [user.id]
        );

        // Get user's recent activities
        const activitiesResult = await pool.query(`
            SELECT 
                activity_type, 
                target_problem, 
                target_language,
                target_user_id,
                metadata,
                created_at,
                (SELECT username FROM users WHERE id = ua.target_user_id) as target_username
            FROM user_activities ua
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT 10
        `, [user.id]);

        // Get followers and following lists (first 10 of each)
        const followersResult = await pool.query(`
            SELECT u.username, u.full_name, u.profile_picture
            FROM user_follows uf
            JOIN users u ON uf.follower_id = u.id
            WHERE uf.following_id = $1
            ORDER BY uf.created_at DESC
            LIMIT 10
        `, [user.id]);

        const followingResult = await pool.query(`
            SELECT u.username, u.full_name, u.profile_picture
            FROM user_follows uf
            JOIN users u ON uf.following_id = u.id
            WHERE uf.follower_id = $1
            ORDER BY uf.created_at DESC
            LIMIT 10
        `, [user.id]);

        // Get frequent collaborators
        const frequentCollaboratorsResult = await pool.query(`
            WITH user_problems AS (
                SELECT DISTINCT problem_name FROM contributions WHERE user_id = $1
                UNION
                SELECT DISTINCT problem_name FROM github_contributions WHERE user_id = $1
            ),
            collaborators AS (
                SELECT 
                    c.user_id as collaborator_id,
                    COUNT(DISTINCT c.problem_name) as collaboration_count
                FROM contributions c
                INNER JOIN user_problems up ON c.problem_name = up.problem_name
                WHERE c.user_id != $1 AND c.user_id IS NOT NULL
                GROUP BY c.user_id
                UNION ALL
                SELECT 
                    gc.user_id as collaborator_id,
                    COUNT(DISTINCT gc.problem_name) as collaboration_count
                FROM github_contributions gc
                INNER JOIN user_problems up ON gc.problem_name = up.problem_name
                WHERE gc.user_id != $1 AND gc.user_id IS NOT NULL
                GROUP BY gc.user_id
            )
            SELECT 
                u.username as collaborator_username,
                u.full_name,
                u.profile_picture,
                SUM(c.collaboration_count) as collaboration_count
            FROM collaborators c
            JOIN users u ON c.collaborator_id = u.id
            GROUP BY u.id, u.username, u.full_name, u.profile_picture
            ORDER BY collaboration_count DESC
            LIMIT 5
        `, [user.id]);

        // Calculate total contributions
        const totalContributionsResult = await pool.query(`
            SELECT COUNT(*) as total FROM (
                SELECT problem_name FROM contributions WHERE user_id = $1 AND content_changed = true
                UNION ALL
                SELECT problem_name FROM github_contributions WHERE user_id = $1
            ) combined_contributions
        `, [user.id]);

        // Calculate unique solutions and translations
        const solutionStatsResult = await pool.query(`
            SELECT 
                COUNT(DISTINCT CASE WHEN language = 'en' THEN problem_name END) as unique_translations,
                COUNT(DISTINCT CASE WHEN language = 'ru' THEN problem_name END) as unique_solutions,
                COUNT(DISTINCT problem_name) as total_unique_problems
            FROM (
                SELECT problem_name, language FROM contributions WHERE user_id = $1 AND content_changed = true
                UNION
                SELECT problem_name, language FROM github_contributions WHERE user_id = $1
            ) all_contributions
        `, [user.id]);

        const stats = solutionStatsResult.rows[0];

        // Get current user's profile data for header
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

        res.render("user_profile", {
            __: i18n.__,
            lang,
            username: user.username,
            fullName: user.full_name,
            email: user.email,
            bio: user.bio,
            countryLocation: user.country_location,
            isVerifiedUser: user.is_verified_user,
            linkedin: user.linkedin,
            github: user.github,
            instagram: user.instagram,
            personalWebsite: user.personal_website,
            profilePicture: user.profile_picture || `/img/profile_images/${user.id}.png`,
            
            // Social stats
            followersCount: parseInt(user.followers_count),
            followingCount: parseInt(user.following_count),
            totalLikesGiven: parseInt(user.total_likes_given),
            starredCount: parseInt(user.starred_count),
            
            // Follow status
            isFollowing,
            isOwnProfile,
            canFollow: req.session.userId && !isOwnProfile,
            
            // Contributions
            contributions: contributionsResult.rows,
            totalContributions: parseInt(totalContributionsResult.rows[0].total),
            uniqueSolutions: parseInt(stats.unique_solutions),
            uniqueTranslations: parseInt(stats.unique_translations),
            totalUniqueProblems: parseInt(stats.total_unique_problems),
            
            // Social content
            starredSolutions: starredResult.rows,
            interests: interestsResult.rows,
            activities: activitiesResult.rows,
            followers: followersResult.rows,
            following: followingResult.rows,
            frequentCollaborators: frequentCollaboratorsResult.rows,
            
            // Pagination
            offset,
            hasMore: contributionsResult.rows.length === limit,
            
            // Current user data for header
            usernameCurrent: currentUserProfile?.username,
            profilePictureCurrent: currentUserProfile?.profile_picture || '/img/profile_images/Default_placeholder.svg',
            
            // User ID for API calls
            userId: user.id
        });

    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).render("404", {
            __: i18n.__,
            pageUrl: req.originalUrl,
            lang
        });
    }
}

module.exports = getUserProfile; 