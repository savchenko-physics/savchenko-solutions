const express = require('express');
const router = express.Router();
const i18n = require('i18n');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const fileUpload = require('express-fileupload');
const { Pool } = require("pg");
require("dotenv").config();

// Add pool configuration
const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

// Add this near the top of the file, after the requires
router.use(fileUpload());
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Handle file upload
router.post("/api/upload", async (req, res) => {
    try {
        console.log("Request body:", req.body);
        console.log("Request files:", req.files);
        
        const lang = req.body.lang || 'en';
        
        if (!req.body.problemName || !req.body.method) {
            return res.status(400).json({
                success: false,
                message: 'Problem name and solution method are required'
            });
        }

        // Check if user is authenticated or provided full name
        if (!req.session.userId && !req.body.fullName) {
            return res.status(400).json({
                success: false,
                message: 'Please provide your full name or login to continue'
            });
        }

        const problemNumber = req.body.problemName;
        const solution = req.body.method === 'latex' ? req.body.latexContent : '';

        // Validate problem number format
        if (!problemNumber || !problemNumber.match(/^\d+\.\d+\.\d+$/)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid problem number format'
            });
        }

        // Generate markdown content based on language
        const content = lang === 'ru' ?
            `### Условие

$${problemNumber}.$ ${solution}

### Решение

[Здесь должно быть ваше решение]

#### Ответ

[Вставьте краткий ответ или результат в рамке]`
            :
            `### Statement

$${problemNumber}.$ ${solution}

### Solution

[Your solution should be placed here]

#### Answer

[Insert a concise answer or boxed result]`;

        // Create directory if it doesn't exist
        const problemsDir = path.join(__dirname, "posts", lang);
        fs.mkdirSync(problemsDir, { recursive: true });
        const filePath = path.join(problemsDir, `${problemNumber}.md`);

        // Check if file already exists
        if (fs.existsSync(filePath)) {
            return res.status(400).json({
                success: false,
                message: "Problem file already exists."
            });
        }

        // Update the files check to properly handle FormData uploads
        const uploadedFiles = [];
        if (req.files) {
            // Handle both 'files' and 'illustrations' arrays if they exist
            const fileArrays = ['files', 'illustrations'];
            
            for (const fileType of fileArrays) {
                if (req.files[fileType]) {
                    const files = Array.isArray(req.files[fileType]) 
                        ? req.files[fileType] 
                        : [req.files[fileType]];
                    uploadedFiles.push(...files);
                }
            }
        }

        console.log("Processed uploaded files:", uploadedFiles);

        const imageResults = [];

        // Create base img directory if it doesn't exist
        const baseImgDir = path.join(__dirname, 'img', problemNumber);
        fs.mkdirSync(baseImgDir, { recursive: true });

        console.log(uploadedFiles);
        
        // Process images only if files were uploaded
        if (uploadedFiles.length > 0) {
            const uploadDir = path.join(__dirname, 'img', problemNumber);
            fs.mkdirSync(uploadDir, { recursive: true });

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
                
                // Use Sharp to process and save the image
                const imageBuffer = file.data;
                await sharp(imageBuffer)
                    .toFile(filePath);

                // Get image dimensions using Sharp
                try {
                    const metadata = await sharp(filePath).metadata();
                    imageResults.push({
                        imagePath: `/img/${problemNumber}/${file.name}`,
                        width: metadata.width,
                        height: metadata.height
                    });
                } catch (err) {
                    console.error("Error getting image metadata:", err);
                }
            }
        }

        // Write the markdown file
        await fs.promises.writeFile(filePath, content);

        // Record the creation in contributions table
        const userId = req.session.userId || null;
        const fullName = req.body.fullName || null;
        const clientIp = req.headers["x-forwarded-for"] || req.ip;

        await pool.query(
            `INSERT INTO contributions (
                user_id, 
                problem_name, 
                language, 
                edited_at,
                original_content,
                new_content,
                ip_address,
                content_changed,
                full_name
            ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8)`,
            [userId, problemNumber, lang, '', content, clientIp, false, fullName]
        );

        return res.json({
            success: true,
            message: lang === 'ru' ?
                `Задача ${problemNumber} успешно создана!` :
                `Problem ${problemNumber} created successfully!`,
            redirectUrl: `/${lang}/edit/${problemNumber}`,
            images: imageResults
        });

    } catch (error) {
        console.error('Upload error:', error);
        const lang = req.body.lang || 'en';
        res.status(500).json({
            success: false,
            message: lang === 'ru' ?
                "Не удалось создать файл задачи." :
                "Failed to create problem file."
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
router.get(["/upload", "/:lang([a-z]{2})/upload"], async (req, res) => {
    const lang = req.params.lang || req.query.lang || 'en';
    i18n.setLocale(res, lang);
    
    // Get current user's profile picture if logged in
    let profilePictureCurrent = null;
    if (req.session.userId) {
        const currentUserResult = await pool.query(
            "SELECT profile_picture FROM users WHERE id = $1",
            [req.session.userId]
        );
        profilePictureCurrent = currentUserResult.rows[0]?.profile_picture;
    }
    
    res.render("upload_page", {
        __: i18n.__,
        lang,
        usernameCurrent: req.session.username,
        profilePictureCurrent
    });
});

// Add new route for problem verification
router.get("/api/verify-problem/:id", async (req, res) => {
    try {
        const problemNumber = req.params.id;
        const lang = req.query.lang || 'en';
        
        // Check if problem exists in the posts directory
        const problemPath = path.join(__dirname, "posts", lang, `${problemNumber}.md`);
        const exists = fs.existsSync(problemPath);

        res.json({ exists });
    } catch (error) {
        console.error('Problem verification error:', error);
        res.status(500).json({ error: 'Failed to verify problem' });
    }
});

module.exports = router;