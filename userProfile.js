const { Pool } = require("pg");
const i18n = require('i18n');
const { getTotalContributions, getContributionsByUserId, getUniqueSolutions, getTranslations, getFrequentCollaborators } = require('./contributions.js');

// Assuming pool is already configured and exported from another module
const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

async function getUserProfile(req, res) {
    console.log(req.params);
    const { username } = req.params;
    const limit = 25;
    const offset = parseInt(req.query.offset) || 0;

    try {
        // Query the database for the user's information, including new columns
        const userResult = await pool.query(
            "SELECT id, full_name, country_location, is_verified_user, bio, profile_picture, linkedin, github, instagram, personal_website FROM users WHERE username = $1",
            [username]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).render("404", {
                __: i18n.__,
                pageUrl: req.originalUrl,
                lang: req.query.lang || 'en'
            });
        }

        const user = userResult.rows[0];

        // Get contributions with pagination
        const contributions = await getContributionsByUserId(user.id, limit, offset);

        // Get total contributions
        const totalContributions = await getTotalContributions(user.id);
        console.log(`Total contributions: ${totalContributions}`);

        // Get unique solutions
        const uniqueSolutions = await getUniqueSolutions(user.id);

        // Get unique translations
        const uniqueTranslations = await getTranslations(user.id);

        // Get frequent collaborators
        const frequentCollaborators = await getFrequentCollaborators(user.id);

        // Render the user profile page with new data
        res.render("user_profile", {
            __: i18n.__,
            lang: req.query.lang || 'en',
            username,
            usernameCurrent: req.session.username,
            userIdCurrent: req.session.userId,
            fullName: user.full_name,
            contributions,
            totalContributions,
            uniqueSolutions,
            uniqueTranslations,
            offset: offset + limit,
            hasMore: offset + limit < totalContributions,
            userId: user.id,
            countryLocation: user.country_location,
            isVerifiedUser: user.is_verified_user,
            bio: user.bio,
            profilePicture: user.profile_picture,
            linkedin: user.linkedin,
            github: user.github,
            instagram: user.instagram,
            personalWebsite: user.personal_website,
            frequentCollaborators,
        });
    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).render("500", {
            __: i18n.__,
            lang: req.query.lang || 'en'
        });
    }
}

module.exports = getUserProfile; 