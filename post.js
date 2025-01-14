const fs = require("fs");
const path = require("path");
const { parseMarkdown, transformImageMarkdown, getLineStatement } = require("./utils"); // Adjust the import based on your utils file
const i18n = require('i18n');
const { Pool } = require("pg");

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

        console.log(recentViewCheck.rows[0].count);

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

        res.render("post", {
            __: i18n.__,
            lang,
            pageRef,
            problemRef: name,
            title: name + ". " + titleContent,
            content: html,
            totalViews, // Pass total views to the template
            creationDate, // Pass creation date to the template
            alternateFileExists // Pass the existence flag to the template
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
        `SELECT date, COALESCE(SUM(views), 0) AS views 
         FROM (
             SELECT date, views FROM page_views_old WHERE problem_name = $1 AND date > NOW() - INTERVAL '30 days'
             UNION ALL
             SELECT date, views FROM page_views WHERE problem_name = $1 AND date > NOW() - INTERVAL '30 days'
         ) AS combined_views
         GROUP BY date
         ORDER BY date`,
        [name]
    );
    console.log(result.rows);
    res.json(result.rows);
}

async function getCreationDate(req, res) {
    const { name, lang } = req.params;
    console.log(name, lang);

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