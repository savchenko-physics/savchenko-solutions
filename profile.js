const { pool } = require('./db'); // Assuming you have a db.js file for database connection
const bcrypt = require('bcrypt');
const i18n = require('i18n');

// Profile routes
async function getProfile(req, res) {
    const lang = req.params.lang || req.query.lang || 'en';
    i18n.setLocale(res, lang);

    try {
        const userResult = await pool.query(
            "SELECT * FROM users WHERE id = $1",
            [req.session.userId]
        );

        const contributionsResult = await pool.query(
            "SELECT * FROM contributions WHERE user_id = $1 ORDER BY edited_at DESC",
            [req.session.userId]
        );

        const user = userResult.rows[0];
        const contributions = contributionsResult.rows;

        res.render("profile", {
            __: i18n.__,
            lang,
            username: user.username,
            email: user.email,
            fullName: user.full_name,
            joinDate: new Date(user.created_at),
            contributions,
            totalEdits: contributions.length,
            error: req.query.error || "",
            success: req.query.success || ""
        });
    } catch (error) {
        console.error(error);
        res.redirect(`/${lang}/login?error=${i18n.__('Something went wrong')}`);
    }
}

// Profile update routes
async function updateProfile(req, res) {
    const { fullname, email, lang } = req.body;
    const language = req.params.lang || lang || 'en';

    try {
        await pool.query(
            "UPDATE users SET full_name = $1, email = $2 WHERE id = $3",
            [fullname, email, req.session.userId]
        );

        res.redirect(`/${language}/profile?success=${i18n.__('Profile updated successfully')}`);
    } catch (error) {
        console.error(error);
        res.redirect(`/${language}/profile?error=${i18n.__('Failed to update profile')}`);
    }
}

// Password update routes
async function updatePassword(req, res) {
    const { currentPassword, newPassword, lang } = req.body;
    const language = req.params.lang || lang || 'en';

    try {
        const result = await pool.query(
            "SELECT password FROM users WHERE id = $1",
            [req.session.userId]
        );

        const validPassword = await bcrypt.compare(currentPassword, result.rows[0].password);

        if (!validPassword) {
            return res.redirect(`/${language}/profile?error=${i18n.__('Current password is incorrect')}`);
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query(
            "UPDATE users SET password = $1 WHERE id = $2",
            [hashedPassword, req.session.userId]
        );

        res.redirect(`/${language}/profile?success=${i18n.__('Password updated successfully')}`);
    } catch (error) {
        console.error(error);
        res.redirect(`/${language}/profile?error=${i18n.__('Failed to update password')}`);
    }
}

module.exports = {
    getProfile,
    updateProfile,
    updatePassword
}; 