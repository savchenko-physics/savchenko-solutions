const fs = require("fs");
const { recommendationsForChapter } = require('./lib/recommendationsForChapter');
const path = require("path");
const { parseMarkdown, transformImageMarkdown, getLineStatement, convertLatexToPlainText, buildMetaDescription } = require("./utils"); // Adjust the import based on your utils file
const { getProblemBreadcrumbTitle, getProblemBreadcrumbParts, getPrevNextProblems, getSectionProblemsGrid, getRelatedProblems } = require("./parents");
const { format: formatDate } = require("date-fns");
const i18n = require('i18n');
const { Pool } = require("pg");
const { getPathsForProblem } = require("./paths");
const { getRelatedBrainstormLinks, getUserDisplayMode, canCurate, ALLOWED_REACTIONS } = require("./brainstorm");
const { getOnlineUsernames } = require("./lib/presence");

const DEFAULT_PROFILE_AVATAR = "/img/profile_images/Default_placeholder.svg";
const { getSolutionJudgingWidget, isContestOrganizer } = require("./contestJudge");
const { renderMathInHtml } = require("./mathRender");
const { isCountable } = require("./botgate");
const { label: axisLabel, explain: axisExplain, bucketWord, WIDGET_COST_KEYS, WIDGET_REWARD_KEYS } = require("./lib/difficultyAxes");
const { toRating } = require("./lib/difficultyRating");
const { ruVotes } = require("./lib/ruPlural");

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

        // req.ip, not the raw X-Forwarded-For header. Caddy APPENDS the peer address, so
        // with `trust proxy: 1` req.ip is the real client while the raw header (and
        // especially its first element) is whatever the caller chose to send. Reading the
        // header let anyone defeat this dedupe — and the blocklist — with one line of curl.
        const clientIp = req.ip;
        const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();

        // Machines are served the page in full but never counted. Skipping the lookup as
        // well as the writes also takes the app's hottest query off the bot path: this
        // SELECT runs on every solution render against 1.8M rows.
        if (isCountable(req) && clientIp !== '::1' && clientIp !== '127.0.0.1') {
            const recentViewCheck = await pool.query(
                `SELECT COUNT(*) AS count FROM recent_views
                 WHERE ip_address = $1 AND problem_name = $2 AND language = $3
                 AND timestamp > $4`,
                [clientIp, name, lang, oneMinuteAgo]
            );

            if (parseInt(recentViewCheck.rows[0].count) === 0) {
                // Increment page views in the database
                await pool.query(
                    `INSERT INTO page_views (problem_name, language, date, views)
                     VALUES ($1, $2, $3, 1)
                     ON CONFLICT (problem_name, language, date)
                     DO UPDATE SET views = page_views.views + 1`,
                    [name, lang, today]
                );

                // Record the view. user_agent is new (migration 037): without it, a future
                // wave cannot be reclassified after the fact — which is exactly why the
                // historical rows in this table are uncleanable.
                await pool.query(
                    `INSERT INTO recent_views (ip_address, problem_name, language, timestamp, user_agent)
                     VALUES ($1, $2, $3, NOW(), $4)`,
                    [clientIp, name, lang, String(req.headers['user-agent'] || '').slice(0, 300)]
                );
            }
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

        // The TeX spacing macros used to be protected here, per `$…$` span, which missed
        // inline math spanning a line break, `\[…\]` and bare `\begin{equation}` blocks —
        // every `\,` in those rendered as a comma. parseMarkdown now does it for the whole
        // document, alongside the identical protection the math delimiters already had.
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

        // Generate a clean, keyword-rich meta description that leads with the
        // problem statement (matches "problem-text" search queries). Strips all
        // markdown + LaTeX; falls back to a templated description for image-only.
        const rawText = fs.readFileSync(filePath, "utf8");
        const plainDesc = buildMetaDescription(
            rawText,
            name,
            problemBreadcrumb ? problemBreadcrumb.sectionTitle : '',
            lang
        );

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

        // Difficulty for the same section, so the sidebar grid can recolour by it. One
        // query for the whole section rather than one per dot; a missing table or an
        // unscored problem simply leaves the grid as it was.
        if (sectionGrid && sectionGrid.problems.length) {
            try {
                const { rows: diffRows } = await pool.query(
                    `SELECT problem_name, calibrated, starred FROM problem_difficulty
                      WHERE problem_name = ANY($1) AND calibrated IS NOT NULL`,
                    [sectionGrid.problems.map((p) => p.name)]
                );
                const byName = new Map(diffRows.map((r) => [r.problem_name, r]));
                let scored = 0;
                for (const p of sectionGrid.problems) {
                    const d = byName.get(p.name);
                    if (!d) continue;
                    p.heat = Math.min(9, Math.max(1, Math.ceil((d.calibrated / 100) * 9) || 1));
                    p.heatStarred = d.starred;
                    p.calibrated = d.calibrated;
                    scored++;
                }
                sectionGrid.hasDifficulty = scored > 0;
            } catch (err) {
                if (err.code !== '42P01') console.error('section difficulty:', err.message);
            }
        }

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

        // Contest quality-judging widget — only for the two organizers, and
        // only when this (problem, language) is a credited contest submission.
        // Fully blind: never carries the other judge's individual scores.
        let judging = null;
        try {
            if (isContestOrganizer(req)) {
                judging = await getSolutionJudgingWidget(req.session.userId, name, lang);
            }
        } catch (err) {
            console.error("Error loading contest judging widget:", err);
        }

        // Related problems from the same chapter
        const relatedProblems = getRelatedProblems(name, lang);

        // Study paths containing this problem
        const problemPaths = await getPathsForProblem(name);

        // Difficulty rating, if this problem has been scored. Null keeps the panel out of
        // the page entirely rather than rendering an empty card.
        let difficulty = null;
        try {
            const { rows } = await pool.query(
                `SELECT scores, calibrated, starred, key_idea, prerequisites, est_minutes
                   FROM problem_difficulty WHERE problem_name = $1`,
                [name]
            );
            if (rows.length) difficulty = rows[0];
        } catch (err) {
            if (err.code !== '42P01') console.error('difficulty lookup:', err.message);
        }

        // Reader difficulty votes (1-10) — a completely separate table from
        // problem_difficulty, never blended into the AI's scores/calibrated. Only
        // aggregated here, at display time.
        const difficultyVotes = { avg: null, count: 0, mine: null };
        try {
            const { rows } = await pool.query(
                `SELECT AVG(vote)::numeric(3,1) AS avg_vote, COUNT(*)::int AS vote_count
                   FROM problem_difficulty_votes WHERE problem_name = $1`,
                [name]
            );
            difficultyVotes.avg = rows[0]?.avg_vote || null;
            difficultyVotes.count = rows[0]?.vote_count || 0;
            if (req.session.userId) {
                const mine = await pool.query(
                    `SELECT vote FROM problem_difficulty_votes WHERE problem_name = $1 AND user_id = $2`,
                    [name, req.session.userId]
                );
                difficultyVotes.mine = mine.rows[0]?.vote || null;
            }
        } catch (err) {
            if (err.code !== '42P01') console.error('difficulty votes lookup:', err.message);
        }

        // The widget's two axis groups (see lib/difficultyAxes.js — same labels and
        // explanations are reused by the methodology page and the problem finder, so
        // they are computed once here rather than inline in the template).
        const difficultyCostAxes = WIDGET_COST_KEYS.map((key) => ({
            key, label: axisLabel(key, lang), explain: axisExplain(key, lang),
        }));
        const difficultyRewardAxes = WIDGET_REWARD_KEYS.map((key) => ({
            key, label: axisLabel(key, lang), explain: axisExplain(key, lang),
        }));

        // Brainstorm Room — rotating block (unified per problem, all languages).
        // Server-rendered on first paint (cached) so the hot page pays no extra
        // client round-trip. brainstormMode is the logged-in user's quiet-mode
        // preference; anonymous visitors reconcile via localStorage client-side.
        // The live Brainstorm Room conversation sits in the right rail (YouTube-style
        // live chat). Messages are lazy-loaded client-side on first visibility, so
        // the hot page only needs: the reader's quiet-mode preference, the curator
        // capability, and the descriptive related-problems strip. Anonymous views add
        // no per-user queries (canCurate / getUserDisplayMode are skipped).
        let brainstormMode = 'rotate';
        let brainstormIsCurator = false;
        let brainstormRelated = [];
        try {
            brainstormRelated = await getRelatedBrainstormLinks(name, lang, 6);
            if (req.session.userId) {
                brainstormMode = await getUserDisplayMode(req.session.userId);
                brainstormIsCurator = await canCurate(req);
            }
        } catch (err) {
            console.error("Error loading brainstorm data:", err);
        }

        // Structured data (JSON-LD). Build as objects and serialize script-safely
        // (JSON-escaped, not HTML-escaped — EJS <%= %> would corrupt the JSON and
        // garble entities like O'Brien / A&B). Description reuses the clean plainDesc.
        const SITE = 'https://savchenkosolutions.com';
        const ogImage = `${SITE}/img/logo.png`;
        const canonicalUrl = `${SITE}/${lang}/${name}`;
        const jsonLdSafe = (o) => JSON.stringify(o)
            .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
        // ScholarlyArticle, not Article. Answer engines surface what looks like a source,
        // and a worked physics solution with a named author, a review date and an explicit
        // licence is a citable object; a wiki page with a coloured dot is not. The licence
        // and author are also stated visibly on the page — structured data alone is a
        // claim nobody can see.
        const articleJsonLd = {
            "@context": "https://schema.org",
            "@type": ["ScholarlyArticle", "Article"],
            "headline": seoTitle,
            "license": "https://creativecommons.org/licenses/by-sa/4.0/",
            "isAccessibleForFree": true,
            "creativeWorkStatus": "Published",
            "description": plainDesc,
            "image": ogImage,
            "inLanguage": lang,
            "educationalLevel": "University",
            "learningResourceType": "Problem Solution",
            "dateModified": lastModified,
            "isPartOf": { "@type": "Book", "name": "Problems in Physics by O.Y. Savchenko" },
            "publisher": {
                "@type": "Organization",
                "name": "Savchenko Solutions",
                "url": SITE,
                "logo": { "@type": "ImageObject", "url": ogImage },
            },
            "mainEntityOfPage": { "@type": "WebPage", "@id": canonicalUrl },
        };
        if (contributorName) {
            articleJsonLd.author = {
                "@type": "Person",
                "name": contributorName,
                "url": `${SITE}/user/${encodeURIComponent(contributorName)}`,
            };
        }
        if (creationDate) articleJsonLd.datePublished = creationDate;
        // dateModified doubles as the last-reviewed date: every edit passes through
        // peer review, so the most recent change is the most recent review.
        if (lastModified) articleJsonLd.dateModified = lastModified;

        let breadcrumbJsonLdStr = null;
        if (problemBreadcrumb) {
            breadcrumbJsonLdStr = jsonLdSafe({
                "@context": "https://schema.org",
                "@type": "BreadcrumbList",
                "itemListElement": [
                    { "@type": "ListItem", "position": 1, "name": lang === 'ru' ? 'Главная' : 'Home', "item": `${SITE}/${lang}/` },
                    { "@type": "ListItem", "position": 2, "name": `${lang === 'ru' ? 'Глава' : 'Chapter'} ${problemBreadcrumb.chapterNum}: ${problemBreadcrumb.chapterTitle}`, "item": `${SITE}/${lang}/#${problemBreadcrumb.chapterNum}` },
                    { "@type": "ListItem", "position": 3, "name": `${problemBreadcrumb.sectionRef}: ${problemBreadcrumb.sectionTitle}`, "item": `${SITE}/${lang}/#${problemBreadcrumb.sectionRef}` },
                    { "@type": "ListItem", "position": 4, "name": problemBreadcrumb.problemLabel },
                ],
            });
        }
        const articleJsonLdStr = jsonLdSafe(articleJsonLd);

        let chapterRecommendations = [];
        try {
            const rec = require('./recommendations');
            chapterRecommendations = recommendationsForChapter(rec.getCatalog(), name, lang, 3);
        } catch (_e) { /* catalog optional — the block simply does not render */ }

        // The discussion and the like/star counts used to be two fetches the browser
        // made after the page arrived — ~700 ms of round trip for data the server can
        // read in single-digit milliseconds while it is already rendering. Gathered
        // here and inlined into the page; the client still fetches if this is missing.
        // Bounded for the same reason as the profile: these read in single-digit
        // milliseconds, so if they ever do not, the solution itself must not wait.
        let solutionBundle = null;
        try {
            const bundle = loadSolutionBundle(name, lang, req.session.userId || null);
            bundle.catch(() => {});
            solutionBundle = await Promise.race([
                bundle,
                new Promise((resolve) => setTimeout(() => resolve(null), 250)),
            ]);
        } catch (bundleError) {
            console.error("Solution bundle failed, falling back to client fetches:", bundleError);
        }

        res.render("solution_post", {
            chapterRecommendations,
            solutionBundle,
            __: i18n.__,
            lang,
            pageRef,
            articleJsonLdStr,
            breadcrumbJsonLdStr,
            problemRef: name,
            name,
            problemBreadcrumbTitle,
            problemBreadcrumb,
            username: req.session.username || null,
            userId: req.session.userId || null,
            title: seoTitle,
            content: html,
            totalViews,
            creationDate,
            alternateFileExists,
            contributorName,
            lastModified,
            metaDescription: plainDesc,
            ogUrl: `https://savchenkosolutions.com/${lang}/${name}`,
            prevProblem: prevNext.prev,
            nextProblem: prevNext.next,
            sectionGrid,
            attribution,
            relatedProblems,
            problemPaths,
            difficulty,
            difficultyVotes,
            ruVotes,
            difficultyRating: difficulty ? toRating(difficulty.calibrated) : null,
            difficultyCostAxes,
            difficultyRewardAxes,
            bucketWord,
            editHistory,
            brainstormMode,
            brainstormRelated,
            brainstormIsCurator,
            brainstormReactions: ALLOWED_REACTIONS,
            judging,
        }, (renderErr, pageHtml) => {
            if (renderErr) {
                console.error("solution_post render error:", renderErr);
                return res.status(500).render("500", { lang });
            }
            // Server-render every LaTeX span on the whole page to inline SVG, so
            // formulas everywhere (body, breadcrumb, nav, grid) arrive final without
            // needing the client MathJax download.
            res.send(renderMathInHtml(pageHtml));
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

// The like/star counts and the discussion, read in one pass so the solution page can
// ship them inside its own HTML. Mirrors the shapes returned by
// /api/solutions/:problemName/:language/stats and .../comments exactly, so the page's
// existing renderers consume either source without knowing which it got.
async function loadSolutionBundle(problemName, language, userId) {
    const [likes, stars, commentRows] = await Promise.all([
        pool.query(
            `SELECT
                COUNT(CASE WHEN is_like = true THEN 1 END) as likes,
                COUNT(CASE WHEN is_like = false THEN 1 END) as dislikes
             FROM solution_likes WHERE problem_name = $1 AND language = $2`,
            [problemName, language]
        ),
        pool.query(
            "SELECT COUNT(*) as stars FROM starred_solutions WHERE problem_name = $1 AND language = $2",
            [problemName, language]
        ),
        pool.query(
            `SELECT
                c.id, c.user_id, c.content, c.parent_id, c.created_at, c.updated_at, c.is_brainstorm,
                u.username, u.full_name, u.profile_picture
             FROM solution_comments c
             JOIN users u ON c.user_id = u.id
             WHERE c.problem_name = $1 AND c.language = $2 AND c.is_deleted = false
             ORDER BY c.created_at ASC`,
            [problemName, language]
        ),
    ]);

    // What this particular viewer has done to this solution.
    const userInteraction = { liked: null, starred: false };
    if (userId) {
        const [likeRow, starRow] = await Promise.all([
            pool.query(
                "SELECT is_like FROM solution_likes WHERE user_id = $1 AND problem_name = $2 AND language = $3",
                [userId, problemName, language]
            ),
            pool.query(
                "SELECT id FROM starred_solutions WHERE user_id = $1 AND problem_name = $2 AND language = $3",
                [userId, problemName, language]
            ),
        ]);
        if (likeRow.rows.length > 0) userInteraction.liked = likeRow.rows[0].is_like;
        userInteraction.starred = starRow.rows.length > 0;
    }

    const online = await getOnlineUsernames(pool, commentRows.rows.map((r) => r.username));

    // Reactions for the whole thread in one query, so the inlined comments carry them
    // exactly as the API version does.
    const reactionsByComment = new Map();
    if (commentRows.rows.length > 0) {
        const reactionRows = await pool.query(
            `SELECT comment_id, emoji, COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS me
             FROM solution_comment_reactions
             WHERE comment_id = ANY($1::int[])
             GROUP BY comment_id, emoji
             ORDER BY MIN(created_at)`,
            [commentRows.rows.map((r) => r.id), userId]
        ).catch(() => ({ rows: [] }));   // pre-migration 048: simply no reactions
        for (const r of reactionRows.rows) {
            if (!reactionsByComment.has(r.comment_id)) reactionsByComment.set(r.comment_id, []);
            reactionsByComment.get(r.comment_id).push({ emoji: r.emoji, count: r.count, me: !!r.me });
        }
    }

    const now = new Date();
    const comments = commentRows.rows.map((row) => {
        const isOwnComment = !!userId && row.user_id === userId;
        const hoursSinceCreation = (now - new Date(row.created_at)) / (1000 * 60 * 60);
        return {
            id: row.id,
            content: row.content,
            parentId: row.parent_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            isBrainstorm: row.is_brainstorm,
            isOwnComment,
            isEditable: isOwnComment && hoursSinceCreation <= 24,
            reactions: reactionsByComment.get(row.id) || [],
            author: {
                username: row.username,
                fullName: row.full_name,
                profilePicture: row.profile_picture || DEFAULT_PROFILE_AVATAR,
                isOnline: online.has(row.username),
            },
        };
    });

    return {
        stats: {
            likes: parseInt(likes.rows[0].likes, 10),
            dislikes: parseInt(likes.rows[0].dislikes, 10),
            stars: parseInt(stars.rows[0].stars, 10),
            comments: comments.length,
            userInteraction,
        },
        comments: { comments },
    };
}

module.exports = { renderPost, getPageViewsData }; 