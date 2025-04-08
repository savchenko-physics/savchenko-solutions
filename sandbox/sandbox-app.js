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

    // Update authentication middleware to check shared session
    function checkAuthenticated(req, res, next) {
        // console.log(req.session.userId);
        // console.log(req.session.username);
        if (req.session.userId) {
            return next();
        }
        const lang = req.params.lang || 'en';
        res.redirect(`/${lang}/login?error=${i18n.__('Please log in to access this page')}`);
    }

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
          user: req.user,
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
    app.get('/sandbox/:id', async (req, res) => {
      try {
        const solutionId = req.params.id;
        const solutionResult = await pool.query(
          `SELECT * FROM solutions WHERE id = $1`,
          [solutionId]
        );
        
        const commentsResult = await pool.query(
          `SELECT * FROM comments WHERE solution_id = $1 ORDER BY created_at ASC`,
          [solutionId]
        );
        
        // You might also fetch total votes or upvote/downvote data
        // from the votes table here.

        if (solutionResult.rows.length === 0) {
          return res.send('Solution not found');
        }

        res.render('sandbox/sandbox-show', {
          pageTitle: `Viewing: ${solutionResult.rows[0].title}`,
          solution: solutionResult.rows[0],
          comments: commentsResult.rows,
        });
      } catch (err) {
        console.error(err);
        res.send('Error retrieving solution or comments.');
      }
    });

    // 6) Post a comment on a solution
    app.post('/sandbox/:id/comment', checkAuthenticated, async (req, res) => {
      try {
        const solutionId = req.params.id;
        const { comment_text } = req.body;
        
        await pool.query(
          `INSERT INTO comments (solution_id, comment_text, author) 
           VALUES ($1, $2, $3)`,
          [solutionId, comment_text, req.session.username]
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
        
        await pool.query(
          `INSERT INTO votes (solution_id, vote_value, user_id) 
           VALUES ($1, $2, $3)`,
          [solutionId, vote_value, req.session.userId]
        );
        
        res.redirect(`/sandbox/${solutionId}`);
      } catch (err) {
        console.error(err);
        res.send('Error registering vote.');
      }
    });

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
