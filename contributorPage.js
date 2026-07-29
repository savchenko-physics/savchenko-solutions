// contributorPage.js — a public, English, CV-linkable page per contributor.
//
// The leaderboard stops at the edge of the site: it gives a number to people whose work
// nobody outside can see. This gives each contributor one stable URL with their real
// name on it, which they can put in a university application or send to a teacher.
//
// ON "HARDEST PROBLEMS". The book asks for hardest-problems-solved, and there is no
// difficulty rating anywhere in this schema — bank_difficulty_votes was never populated
// and has since been dropped. Rather than invent a score and dress it up as measurement,
// this page reports two things that are genuinely defensible:
//
//   * FIRST SOLUTIONS — problems where this person was the earliest contributor, i.e.
//     the page did not exist until they wrote it. That is the real contribution signal.
//   * CHAPTER REACH — how far through the collection they range. Savchenko's chapters do
//     get harder (14 is special relativity), so breadth across late chapters is a weak
//     but honest proxy, and it is labelled as reach rather than difficulty.
//
// If a difficulty rating is ever added, "hardest solved" belongs here and should replace
// the reach figure.
const { Pool } = require('pg');
const i18n = require('i18n');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const CHAPTER_NAMES = [
    'Kinematics', 'Dynamics', 'Oscillations and Waves', 'Fluid Mechanics',
    'Molecular Physics', 'Electrostatics', 'Charged particles in an electric field',
    'Electric current', 'Constant magnetic field', 'Charged particles in complex fields',
    'Electromagnetic induction', 'Electromagnetic waves',
    'Geometrical optics, photometry, quantum light', 'Special relativity',
];

async function renderContributorPage(req, res) {
    const { username } = req.params;
    const lang = 'en'; // Deliberately English: the point is that it travels.
    i18n.setLocale(res, lang);

    try {
        const userRes = await pool.query(
            'SELECT id, username, full_name, profile_picture, bio, country_location FROM users WHERE username = $1',
            [username]
        );
        if (userRes.rows.length === 0) {
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }
        const user = userRes.rows[0];

        const [summaryRes, firstsRes, chaptersRes, problemsRes, rankRes] = await Promise.all([
            pool.query(
                `SELECT count(DISTINCT problem_name)::int AS problems,
                        count(*)::int                      AS edits,
                        min(edited_at)::date               AS first_edit,
                        max(edited_at)::date               AS last_edit,
                        count(DISTINCT date_trunc('month', edited_at))::int AS active_months
                   FROM contributions WHERE user_id = $1`,
                [user.id]
            ),
            // Problems whose earliest contribution anywhere is this person's — the page
            // did not exist before they wrote it.
            pool.query(
                `WITH firsts AS (
                     SELECT DISTINCT ON (problem_name) problem_name, user_id
                       FROM contributions
                      WHERE user_id IS NOT NULL
                      ORDER BY problem_name, edited_at ASC
                 )
                 SELECT count(*)::int AS n FROM firsts WHERE user_id = $1`,
                [user.id]
            ),
            pool.query(
                `SELECT split_part(problem_name, '.', 1)::int AS chapter,
                        count(DISTINCT problem_name)::int      AS problems
                   FROM contributions
                  WHERE user_id = $1 AND problem_name ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'
                  GROUP BY 1 ORDER BY 1`,
                [user.id]
            ),
            pool.query(
                `SELECT DISTINCT problem_name
                   FROM contributions
                  WHERE user_id = $1 AND problem_name ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'`,
                [user.id]
            ),
            // Rank among everyone who has ever contributed, by distinct problems.
            pool.query(
                `WITH totals AS (
                     SELECT user_id, count(DISTINCT problem_name) AS problems
                       FROM contributions WHERE user_id IS NOT NULL GROUP BY user_id
                 )
                 SELECT (SELECT count(*) + 1 FROM totals t2
                          WHERE t2.problems > (SELECT problems FROM totals WHERE user_id = $1))::int AS rank,
                        (SELECT count(*) FROM totals)::int AS out_of`,
                [user.id]
            ),
        ]);

        const summary = summaryRes.rows[0] || {};
        if (!summary.problems) {
            // No contributions — there is nothing to certify, so don't pretend otherwise.
            return res.status(404).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
        }

        const problems = problemsRes.rows
            .map((r) => r.problem_name)
            .sort((a, b) => {
                const pa = a.split('.').map(Number);
                const pb = b.split('.').map(Number);
                return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
            });

        const chapters = chaptersRes.rows.map((r) => ({
            number: r.chapter,
            name: CHAPTER_NAMES[r.chapter - 1] || `Chapter ${r.chapter}`,
            problems: r.problems,
        }));

        res.render('contributor_page', {
            __: i18n.__,
            lang,
            user,
            displayName: (user.full_name || '').trim() || user.username,
            summary,
            firstSolutions: firstsRes.rows[0] ? firstsRes.rows[0].n : 0,
            chapters,
            problems,
            rank: rankRes.rows[0] || { rank: null, out_of: null },
            canonicalUrl: `https://savchenkosolutions.com/contributor/${encodeURIComponent(user.username)}`,
        });
    } catch (err) {
        console.error('contributor page error:', err);
        res.status(500).render('404', { __: i18n.__, pageUrl: req.originalUrl, lang });
    }
}

module.exports = renderContributorPage;
