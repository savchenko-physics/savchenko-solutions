const express = require('express');
const router = express.Router();
const i18n = require('i18n');

// Authentication middleware (assuming it's defined elsewhere)
function checkAuthenticated(req, res, next) {
    const lang = req.query.lang || req.body.lang || 'en';
    i18n.setLocale(res, lang);

    if (req.session.userId) {
        return next();
    }

    res.redirect(`/${lang}/login?error=${i18n.__('Please log in to access this page')}`);
}

// Upload page routes
router.get(["/upload", "/:lang/upload"], checkAuthenticated, (req, res) => {
    const lang = req.params.lang || req.query.lang || 'en';
    i18n.setLocale(res, lang);
    
    res.render("upload_page", {
        __: i18n.__,
        lang
    });
});

// Handle file upload
router.post("/api/upload", checkAuthenticated, async (req, res) => {
    try {
        // Here you would process the uploaded files and form data
        // For now, we'll just send a success response
        res.json({
            success: true,
            redirectUrl: `/${req.body.lang || 'en'}/profile`,
            message: 'Upload successful'
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing upload'
        });
    }
});

module.exports = router; 