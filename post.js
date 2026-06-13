const fs = require("fs");
const path = require("path");
const { parseMarkdown, transformImageMarkdown, getLineStatement, convertLatexToPlainText } = require("./utils"); // Adjust the import based on your utils file
const { getProblemBreadcrumbTitle, getProblemBreadcrumbParts, getPrevNextProblems, getSectionProblemsGrid, getRelatedProblems } = require("./parents");
const { format: formatDate } = require("date-fns");
const i18n = require('i18n');
const { Pool } = require("pg");
const { getPathsForProblem } = require("./paths");
const { getTopBrainstormMessages, getRelatedBrainstormLinks, getUserDisplayMode, formatBrainstormHtml } = require("./brainstorm");

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

async function renderPost(req, res) {
    const { lang, name } = req.params;
    const alternateLang = lang === 'en' ? 'ru' : 'en';
    const filePath = path.join(__dirname, `posts/${lang}`, `${name}.md`);
    const alternateFilePath = path.join(__dirname, `posts/${alternateLang}`, `${name}.md`);

    if (/^(1[0-4]|[1-9])$/.test(lang)) {
        return res.redirect(`/ru/${name}`);
    }

    // Check if the specified file exists
    if (fs.existsSync(filePath)) {
        const alternateFileExists = fs.existsSync(alternateFilePath);

        // Increment page views in the database
        const today = new Date().toISOString().split('T')[0]; // Get today's date in YYYY-MM-DD format

        // Check if the same IP has viewed this problem in the last minute
        const clientIp = req.headers["x-forwarded-for"] || req.ip;
        const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();

        const recentViewCheck = await pool.query(
            `SELECT COUNT(*) AS count FROM recent_views 
             WHERE ip_address = $1 AND problem_name = $2 AND language = $3 
             AND timestamp > $4`,
            [clientIp, name, lang, oneMinuteAgo]
        );

        // console.log(recentViewCheck.rows[0].count);

        if (parseInt(recentViewCheck.rows[0].count) === 0 && clientIp !== '::1') {
            // Increment page views in the database
            await pool.query(
                `INSERT INTO page_views (problem_name, language, date, views) 
                 VALUES ($1, $2, $3, 1) 
                 ON CONFLICT (problem_name, language, date) 
                 DO UPDATE SET views = page_views.views + 1`,
                [name, lang, today]
            );

            // Record the view in the recent_views table
            await pool.query(
                `INSERT INTO recent_views (ip_address, problem_name, language, timestamp) 
                 VALUES ($1, $2, $3, NOW())`,
                [clientIp, name, lang]
            );
        }

        // Fetch total views from the database
        const result = await pool.query(
            `SELECT COALESCE(SUM(views), 0) AS total_views 
             FROM (
                 SELECT views FROM page_views_old WHERE problem_name = $1
                 UNION ALL
                 SELECT views FROM page_views WHERE problem_name = $1
             ) AS combined_views`,
            [name]
        );

        const totalViews = result.rows[0].total_views || 0; // Default to 0 if no views found

        // Prepare the content for rendering
        let fileContents = fs.readFileSync(filePath, "utf8").replace(/\*/g, "\\*").replace(/~/g, "\\~");

        // Handle both inline and display math LaTeX
        fileContents = fileContents.replace(/\$\$([\s\S]+?)\$\$/g, (match, p1) => {
            return '$$' + p1.replace(/\\,\s*/g, '\\\\, ').replace(/\\;\s*/g, '\\\\; ') + '$$';
        });
        fileContents = fileContents.replace(/\$([^\$\n]+?)\$/g, (match, p1) => {
            return '$' + p1.replace(/\\,\s*/g, '\\\\, ').replace(/\\;\s*/g, '\\\\; ') + '$';
        });

        fileContents = transformImageMarkdown(fileContents);
        const titleContent = getLineStatement(fileContents);

        let html = parseMarkdown(fileContents);
        html = html.replace(/<em>/g, "_").replace(/<\/em>/g, "_");
        html = html.replace(/\\\*/g, "*");

        const pageRef = name.split(".").slice(0, 2).join(".");

        i18n.setLocale(res, lang);

        // Fetch creation date
        const creationDateResult = await getCreationDate(req, res);
        const creationDate = creationDateResult ? new Date(creationDateResult).toISOString() : null;

        const problemBreadcrumbTitle =
            getProblemBreadcrumbTitle(name, lang) || `$${name}.$`;
        const problemBreadcrumb = getProblemBreadcrumbParts(name, lang);

        // Fetch most recent contributor for structured data
        let contributorName = null;
        let lastModified = null;
        try {
            const contribResult = await pool.query(
                `SELECT u.username, c.edited_at FROM contributions c
                 LEFT JOIN users u ON u.id = c.user_id
                 WHERE c.problem_name = $1 AND c.invisible = false
                 ORDER BY c.edited_at DESC LIMIT 1`,
                [name]
            );
            if (contribResult.rows.length > 0) {
                contributorName = contribResult.rows[0].username || 'Anonymous';
                lastModified = new Date(contribResult.rows[0].edited_at).toISOString();
            }
        } catch (err) {
            console.error("Error fetching contributor for structured data:", err);
        }

        // Fallback lastModified to file mtime
        if (!lastModified) {
            try {
                const stat = fs.statSync(filePath);
                lastModified = stat.mtime.toISOString();
            } catch (_) {
                lastModified = new Date().toISOString();
            }
        }

        // Generate plain-text meta description from solution content
        const rawText = fs.readFileSync(filePath, "utf8");
        const plainDesc = convertLatexToPlainText(rawText).replace(/\s+/g, ' ').trim().substring(0, 155);

        // Build improved title using section name
        const seoTitle = problemBreadcrumb
            ? (lang === 'ru'
                ? `Задача ${name} Решение — ${problemBreadcrumb.sectionTitle} | Решения Савченко`
                : `Problem ${name} Solution — ${problemBreadcrumb.sectionTitle} | Savchenko Solutions`)
            : `${name} | ${i18n.__('title')}`;

        // Prev/next navigation
        const prevNext = getPrevNextProblems(name, lang);

        // Section problems grid for sidebar
        const sectionGrid = getSectionProblemsGrid(name, lang);

        // Contributor attribution
        let attribution = null;
        try {
            const attrResult = await pool.query(
                `SELECT DISTINCT c.user_id, u.username, MIN(c.edited_at) as first_edit
                 FROM contributions c
                 LEFT JOIN users u ON c.user_id = u.id
                 WHERE c.problem_name = $1 AND c.language = $2
                 AND c.content_changed = true AND c.invisible = false
                 GROUP BY c.user_id, u.username
                 ORDER BY first_edit ASC`,
                [name, lang]
            );

            const ghAttrResult = await pool.query(
                `SELECT DISTINCT gh.user_id, u.username, MIN(gh.edited_at) as first_edit
                 FROM github_contributions gh
                 LEFT JOIN users u ON gh.user_id = u.id
                 WHERE gh.problem_name = $1 AND gh.language = $2
                 GROUP BY gh.user_id, u.username
                 ORDER BY first_edit ASC`,
                [name, lang]
            );

            const allContributors = [];
            for (const row of ghAttrResult.rows) {
                allContributors.push({
                    username: row.username || null,
                    userId: row.user_id,
                    firstEdit: new Date(row.first_edit),
                });
            }
            for (const row of attrResult.rows) {
                const exists = allContributors.some(c =>
                    (c.userId && c.userId === row.user_id) ||
                    (c.username && c.username === row.username)
                );
                if (!exists) {
                    allContributors.push({
                        username: row.username || null,
                        userId: row.user_id,
                        firstEdit: new Date(row.first_edit),
                    });
                }
            }
            allContributors.sort((a, b) => a.firstEdit - b.firstEdit);

            if (allContributors.length > 0) {
                const originalAuthor = allContributors[0];
                const editors = allContributors.slice(1);
                const lastUpdatedFormatted = lastModified
                    ? formatDate(new Date(lastModified), "MMM d, yyyy")
                    : null;

                attribution = {
                    originalAuthor: {
                        username: originalAuthor.username || (lang === 'ru' ? 'Аноним' : 'Anonymous'),
                        userId: originalAuthor.userId,
                    },
                    editors: editors.slice(0, 5).map(e => ({
                        username: e.username || (lang === 'ru' ? 'Аноним' : 'Anonymous'),
                        userId: e.userId,
                    })),
                    extraEditors: Math.max(0, editors.length - 5),
                    lastUpdated: lastUpdatedFormatted,
                };
            }
        } catch (err) {
            console.error("Error fetching contributor attribution:", err);
        }

        // Problempedia — commented out for now
        // let bankRelated = [];
        // try {
        //     if (problemBreadcrumb && problemBreadcrumb.sectionTitle) {
        //         const topicKeyword = problemBreadcrumb.sectionTitle.toLowerCase().replace(/\s+/g, '-');
        //         const bankResult = await pool.query(
        //             `SELECT bp.id, bp.title, bp.difficulty, bs.name AS source_name
        //              FROM bank_problems bp
        //              JOIN bank_sources bs ON bs.id = bp.source_id
        //              WHERE bp.reviewed = true AND $1 = ANY(bp.topics)
        //              ORDER BY RANDOM()
        //              LIMIT 3`,
        //             [topicKeyword]
        //         );
        //         bankRelated = bankResult.rows;
        //     }
        // } catch (err) {
        //     // bank tables may not exist yet — silently ignore
        // }

        // Edit history (recent edits for inline display)
        let editHistory = [];
        try {
            const histResult = await pool.query(
                `SELECT id, user_id, edited_at, source, username, profile_picture FROM (
                    SELECT c.id, c.user_id, c.edited_at, 'direct' AS source, u.username, u.profile_picture
                    FROM contributions c
                    LEFT JOIN users u ON c.user_id = u.id
                    WHERE c.problem_name = $1 AND c.language = $2
                      AND c.content_changed = true AND c.invisible = false
                    UNION ALL
                    SELECT gh.id, gh.user_id, gh.edited_at, 'github' AS source, u.username, u.profile_picture
                    FROM github_contributions gh
                    LEFT JOIN users u ON gh.user_id = u.id
                    WHERE gh.problem_name = $1 AND gh.language = $2
                ) combined
                ORDER BY edited_at DESC
                LIMIT 10`,
                [name, lang]
            );
            editHistory = histResult.rows;
        } catch (err) {
            console.error("Error fetching edit history:", err);
        }

        // Related problems from the same chapter
        const relatedProblems = getRelatedProblems(name, lang);

        // Study paths containing this problem
        const problemPaths = await getPathsForProblem(name);

        // Brainstorm Room — rotating block (unified per problem, all languages).
        // Server-rendered on first paint (cached) so the hot page pays no extra
        // client round-trip. brainstormMode is the logged-in user's quiet-mode
        // preference; anonymous visitors reconcile via localStorage client-side.
        let brainstorm = [];
        let brainstormMode = 'rotate';
        // solution_post.ejs only renders when a solution file exists, so the problem
        // is solved (in this language). Solved problems get the Phase-4 "insights"
        // variant (Discussion & Insights + a descriptive related-problems strip);
        // the "brainstorm" open-question variant stays available for future
        // unsolved-problem pages.
        const brainstormVariant = 'insights';
        let brainstormRelated = [];
        try {
            brainstorm = await getTopBrainstormMessages(name, 5);
            brainstormRelated = await getRelatedBrainstormLinks(name, lang, 6);
            if (req.session.userId) {
                brainstormMode = await getUserDisplayMode(req.session.userId);
            }
        } catch (err) {
            console.error("Error loading brainstorm block:", err);
        }

        res.render("solution_post", {
            __: i18n.__,
            lang,
            pageRef,
            problemRef: name,
            name,
            problemBreadcrumbTitle,
            problemBreadcrumb,
            username: req.session.username || null,
            title: seoTitle,
            content: html,
            totalViews,
            creationDate,
            alternateFileExists,
            contributorName,
            lastModified,
            metaDescription: plainDesc,
            prevProblem: prevNext.prev,
            nextProblem: prevNext.next,
            sectionGrid,
            attribution,
            relatedProblems,
            problemPaths,
            editHistory,
            brainstorm,
            brainstormMode,
            brainstormVariant,
            brainstormRelated,
            formatBrainstormHtml,
        });
    } else {
        i18n.setLocale(res, lang);
        res.status(404).render("404", {
            __: i18n.__,
            pageUrl: req.originalUrl,
            lang
        });
    }
}

async function getPageViewsData(req, res) {
    const { name } = req.params;
    const result = await pool.query(
        `SELECT TO_CHAR(date, 'YYYY-MM-DD') AS date, COALESCE(SUM(views), 0) AS views
         FROM (
             SELECT date, views FROM page_views_old WHERE problem_name = $1 AND date > NOW() - INTERVAL '30 days'
             UNION ALL
             SELECT date, views FROM page_views WHERE problem_name = $1 AND date > NOW() - INTERVAL '30 days'
         ) AS combined_views
         GROUP BY date
         ORDER BY date`,
        [name]
    );
    // console.log(result.rows);
    res.json(result.rows);
}

async function getCreationDate(req, res) {
    const { name, lang } = req.params;
    // console.log(name, lang);

    const result = await pool.query(
        `SELECT MIN(date) AS creation_date 
         FROM (
             SELECT date FROM page_views WHERE problem_name = $1 AND language = $2 AND views > 1
             UNION ALL
             SELECT date FROM page_views_old WHERE problem_name = $1 AND language = $2 AND views > 1
         ) AS combined_views`,
        [name, lang]
    );

    return result.rows[0].creation_date;


    // if (result.rows.length > 0 && result.rows[0].creation_date) {
    //     res.json({ creationDate: result.rows[0].creation_date });
    // } else {
    //     res.status(404).json({ error: "Problem not found" });
    // }
}

module.exports = { renderPost, getPageViewsData }; 