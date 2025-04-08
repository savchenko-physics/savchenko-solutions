module.exports = function(mainPool) {
    const express = require('express');
    const path = require('path');
    const bodyParser = require('body-parser');
    const app = express();
    const expressLayouts = require('express-ejs-layouts');
    const session = require('express-session');
    const passport = require('passport');
    const flash = require('express-flash');
    const connectPgSimple = require('connect-pg-simple');
    const LocalStrategy = require('passport-local').Strategy;
    const bcrypt = require('bcrypt');
    require('dotenv').config({ path: '../.env' });
    const multer = require('multer');
    const fs = require('fs');

    // Use the shared pool instead of creating a new one
    const pool = mainPool;

    // Add i18n configuration
    const i18n = require('i18n');
    i18n.configure({
        locales: ['en', 'ru'],
        directory: path.join(__dirname, '../locales'),
        defaultLocale: 'en',
        objectNotation: true,
        updateFiles: false,
        cookie: 'lang'
    });

    // Add i18n middleware
    app.use(i18n.init);

    // Set EJS as the template engine
    app.set('view engine', 'ejs');
    app.use(expressLayouts);

    app.set('layout', 'layout'); 

    // Set the views directory (could also leave as default 'views')
    app.set('views', path.join(__dirname, 'views'));

    // Serve static files from /public
    app.use(express.static(path.join(__dirname, 'public')));

    // Middleware
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(bodyParser.json());

    // Add these middleware configurations before your routes
    app.use(session({
        store: new (connectPgSimple(session))({
            pool: pool,
            tableName: 'session'
        }),
        secret: process.env.SESSION_SECRET || "your_secret_key",
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.NODE_ENV === 'production',
            maxAge: 1000 * 60 * 60 * 24 * 365,
            httpOnly: true,
            sameSite: 'lax'
        },
    }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(flash());

    // Add middleware to make user data available globally
    app.use((req, res, next) => {
        res.locals.username = req.session.username;
        res.locals.userId = req.session.userId;
        next();
    });

    // Update authentication middleware to make it optional
    function checkAuthenticated(req, res, next) {
        // Always proceed to next middleware, regardless of authentication status
        return next();
    }

    // Update multer configuration to handle both files and illustrations
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            const uploadDir = path.join(__dirname, 'public/uploads');
            // Create the uploads directory if it doesn't exist
            if (!fs.existsSync(uploadDir)){
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        },
        filename: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, uniqueSuffix + path.extname(file.originalname));
        }
    });
    const upload = multer({
        storage: storage,
        fileFilter: (req, file, cb) => {
            // Accept images only
            if (!file.originalname.match(/\.(jpg|JPG|jpeg|JPEG|png|PNG|gif|GIF)$/)) {
                req.fileValidationError = 'Only image files are allowed!';
                return cb(null, false);
            }
            cb(null, true);
        }
    }).fields([
        { name: 'files', maxCount: 10 },      // For scan uploads
        { name: 'illustrations', maxCount: 5 }, // For LaTeX illustrations
        { name: 'comment_images', maxCount: 5 }  // For comment images
    ]);

    // ====================== ROUTES ======================

    // 1) Home route (just a placeholder)
    // app.get('/', (req, res) => {
    //   res.render('index', { pageTitle: 'Savchenko Solutions Home' });
    // });

    // 2) Sandbox – List all solutions
    app.get(['/', '/sandbox', '/:lang/sandbox'], checkAuthenticated, async (req, res) => {
      const lang = req.params.lang || 'en';
      i18n.setLocale(res, lang);
      try {
        const result = await pool.query(`SELECT * FROM solutions ORDER BY created_at DESC`);
        res.render('sandbox/sandbox-list', {
          pageTitle: 'Sandbox Solutions',
          solutions: result.rows,
          user: req.user || null,  // Handle case when user is not logged in
          __: i18n.__,
          lang
        });
      } catch (err) {
        console.error(err);
        res.send('Error fetching solutions.');
      }
    });

    // 3) Show form to submit a new solution
    app.get(['/sandbox/new', '/:lang/sandbox/new'], checkAuthenticated, (req, res) => {
      const lang = req.params.lang || 'en';
      i18n.setLocale(res, lang);
      res.render('sandbox/sandbox-new', { 
        pageTitle: 'Post a New Solution',
        user: req.user,
        __: i18n.__,
        lang
      });
    });

    // 4) Handle new solution submission
    app.post('/sandbox', checkAuthenticated, async (req, res) => {
      try {
        const { title, content, subject, difficulty, problem_book } = req.body;
        await pool.query(
          `INSERT INTO solutions 
           (title, content, subject, difficulty, problem_book, user_id) 
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [title, content, subject, difficulty, problem_book, req.session.userId]
        );
        res.redirect('/sandbox');
      } catch (err) {
        console.error(err);
        res.send('Error saving the solution.');
      }
    });

    // 5) View a single solution (and comments)
    app.get(['/sandbox/:id', '/:lang/sandbox/:id'], async (req, res) => {
      try {
        const solutionId = req.params.id;
        const lang = req.params.lang || 'en';
        i18n.setLocale(res, lang);
        
        const solutionResult = await pool.query(
          `SELECT s.*, 
            COALESCE(SUM(CASE WHEN v.vote_value = 1 THEN 1 ELSE 0 END), 0) as upvotes,
            COALESCE(SUM(CASE WHEN v.vote_value = -1 THEN 1 ELSE 0 END), 0) as downvotes
           FROM solutions s
           LEFT JOIN votes v ON s.id = v.solution_id
           WHERE s.id = $1
           GROUP BY s.id`,
          [solutionId]
        );
        
        const commentsResult = await pool.query(
          `SELECT * FROM comments WHERE solution_id = $1 ORDER BY created_at ASC`,
          [solutionId]
        );

        if (solutionResult.rows.length === 0) {
          return res.send('Solution not found');
        }

        // Check if user has already voted
        let userVote = null;
        if (req.session.userId) {
          const voteResult = await pool.query(
            `SELECT vote_value FROM votes 
             WHERE solution_id = $1 AND user_id = $2`,
            [solutionId, req.session.userId]
          );
          if (voteResult.rows.length > 0) {
            userVote = voteResult.rows[0].vote_value;
          }
        }

        res.render('sandbox/sandbox-show', {
          pageTitle: `Viewing: ${solutionResult.rows[0].title}`,
          solution: solutionResult.rows[0],
          comments: commentsResult.rows,
          userVote,
          __: i18n.__,
          lang
        });
      } catch (err) {
        console.error(err);
        res.send('Error retrieving solution or comments.');
      }
    });

    // 6) Post a comment on a solution
    app.post('/sandbox/:id/comment', checkAuthenticated, upload, async (req, res) => {
      try {
        const solutionId = req.params.id;
        const { comment_text } = req.body;
        
        // Handle uploaded images
        const uploadedImages = [];
        if (req.files && req.files.comment_images) {
          uploadedImages.push(...req.files.comment_images.map(f => f.filename));
        }
        
        await pool.query(
          `INSERT INTO comments (solution_id, comment_text, author, images) 
           VALUES ($1, $2, $3, $4)`,
          [solutionId, comment_text, req.session.username, uploadedImages.length > 0 ? uploadedImages : null]
        );
        
        res.redirect(`/sandbox/${solutionId}`);
      } catch (err) {
        console.error(err);
        res.send('Error posting comment.');
      }
    });

    // 7) Voting on a solution
    app.post('/sandbox/:id/vote', checkAuthenticated, async (req, res) => {
      try {
        const solutionId = req.params.id;
        const { vote_value } = req.body;
        
        // Check if user has already voted
        const existingVote = await pool.query(
          `SELECT * FROM votes WHERE solution_id = $1 AND user_id = $2`,
          [solutionId, req.session.userId]
        );

        if (existingVote.rows.length > 0) {
          // Update existing vote
          await pool.query(
            `UPDATE votes SET vote_value = $1 
             WHERE solution_id = $2 AND user_id = $3`,
            [vote_value, solutionId, req.session.userId]
          );
        } else {
          // Insert new vote
          await pool.query(
            `INSERT INTO votes (solution_id, vote_value, user_id) 
             VALUES ($1, $2, $3)`,
            [solutionId, vote_value, req.session.userId]
          );
        }
        
        res.redirect(`/sandbox/${solutionId}`);
      } catch (err) {
        console.error(err);
        res.send('Error registering vote.');
      }
    });

    // Update the upload API endpoint
    app.post('/api/upload', upload, async (req, res) => {
        try {
            const {
                problemName,
                method,
                lang,
                latexContent,
                title,
                subject,
                difficulty,
                problem_book,
                fullName
            } = req.body;

            // Combine all uploaded files
            const uploadedFiles = [];
            if (req.files) {
                if (req.files.files) {
                    uploadedFiles.push(...req.files.files.map(f => f.filename));
                }
                if (req.files.illustrations) {
                    uploadedFiles.push(...req.files.illustrations.map(f => f.filename));
                }
            }

            // Set content based on method - use empty string for scans
            const content = method === 'latex' ? latexContent : '';

            // Get author name - use session username if logged in, otherwise use provided fullName
            const authorName = req.session.username || fullName || 'Anonymous';

            // Insert the solution into the database
            const result = await pool.query(
                `INSERT INTO solutions 
                (title, content, subject, difficulty, problem_book, user_id, method, language, files, author) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING id`,
                [
                    problemName,
                    content,
                    subject || null,
                    difficulty || null,
                    problem_book || null,
                    req.session.userId || null,
                    method,
                    lang,
                    uploadedFiles.length > 0 ? uploadedFiles : null,
                    authorName
                ]
            );

            res.json({
                success: true,
                redirectUrl: `/${lang}/sandbox/${result.rows[0].id}`
            });
        } catch (err) {
            console.error('Upload error:', err);
            res.status(500).json({
                success: false,
                message: 'Error uploading solution: ' + err.message
            });
        }
    });

    // Add these API routes before your existing routes
    app.get('/api/verify-problem/:name', async (req, res) => {
        try {
            const problemName = req.params.name;
            const language = req.query.language || 'en';

            // Just check if solution exists, without language check for now
            const result = await pool.query(
                `SELECT * FROM solutions WHERE title = $1`,
                [problemName]
            );

            res.json({
                exists: result.rows.length > 0,
                existsInOtherLang: false // Set to false until language support is added
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error' });
        }
    });

    app.get('/api/validate-limits/:chapter/:section/:problem', async (req, res) => {
        const { chapter, section, problem } = req.params;
        const language = req.query.language || 'en';

        try {
            // Add your validation logic here
            // For example, checking if chapter/section/problem numbers are within valid ranges
            const isValid = validateProblemLimits(chapter, section, problem);
            
            if (isValid) {
                res.json({ valid: true });
            } else {
                res.json({
                    valid: false,
                    message: language === 'ru' ? 
                        'Неверный номер главы, раздела или задачи' :
                        'Invalid chapter, section, or problem number'
                });
            }
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error' });
        }
    });

    function validateProblemLimits(chapter, section, problem) {
        // Add your validation logic here
        // For example:
        const chapterNum = parseInt(chapter);
        const sectionNum = parseInt(section);
        const problemNum = parseInt(problem);

        // Basic validation example - adjust these limits according to your needs
        return (
            chapterNum >= 1 && chapterNum <= 14 &&
            sectionNum >= 1 && sectionNum <= 10 &&
            problemNum >= 1 && problemNum <= 50
        );
    }

    const PORT = process.env.SANDBOX_PORT || 4000;
    
    const startServer = (port) => {
        const server = app.listen(port)
            .on('listening', () => {
                console.log(`Sandbox server running on http://localhost:${port}`);
            })
            .on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.log(`Port ${port} is busy, trying ${port + 1}...`);
                    startServer(port + 1);
                } else {
                    console.error('Sandbox server error:', err);
                }
            });
    };

    startServer(PORT);
};  
