const express = require('express');
const router = express.Router();
const i18n = require('i18n');
const path = require('path');
const fs = require('fs');

// Handle file upload
router.post("/api/upload", checkAuthenticated, async (req, res) => {
    try {
        // Log only relevant request info instead of entire req object
        console.log('Request body:', req.body);
        console.log('Request files:', req.files);

        // Add solution text validation
        if (!req.body || !req.body.solution) {
            return res.status(400).json({
                success: false,
                message: 'Solution text is required'
            });
        }

        const problemNumber = req.body.problemNumber;
        // Validate problem number format (x.x.x)
        if (!problemNumber || !problemNumber.match(/^\d+\.\d+\.\d+$/)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid problem number format'
            });
        }

        // Files are optional now
        if (req.files && Object.keys(req.files).length > 0) {
            // Create directory if it doesn't exist
            const uploadDir = path.join(__dirname, 'img', problemNumber);
            fs.mkdirSync(uploadDir, { recursive: true });

            // Process each uploaded file
            const uploadedFiles = Array.isArray(req.files.files) ? req.files.files : [req.files.files];
            
            // Add size validation
            const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
            const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 20MB
            let totalSize = 0;

            for (const file of uploadedFiles) {
                // Check individual file size
                if (file.size > MAX_FILE_SIZE) {
                    return res.status(400).json({
                        success: false,
                        message: `File ${file.name} exceeds maximum size of 5MB`
                    });
                }

                // Check total upload size
                totalSize += file.size;
                if (totalSize > MAX_TOTAL_SIZE) {
                    return res.status(400).json({
                        success: false,
                        message: 'Total upload size exceeds maximum of 20MB'
                    });
                }

                // Validate file type
                const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'];
                if (!allowedTypes.includes(file.mimetype)) {
                    return res.status(400).json({
                        success: false,
                        message: `File ${file.name} has invalid type. Only JPG, PNG, GIF and SVG are allowed`
                    });
                }

                const filePath = path.join(uploadDir, file.name);
                await file.mv(filePath);
            }
        }

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
router.get(["/upload", "/:lang([a-z]{2})/upload"], checkAuthenticated, (req, res) => {
    const lang = req.params.lang || req.query.lang || 'en';
    i18n.setLocale(res, lang);
    
    res.render("upload_page", {
        __: i18n.__,
        lang
    });
});


module.exports = router; 