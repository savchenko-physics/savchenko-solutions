const { Pool } = require("pg");
const i18n = require('i18n');
const { getOnlineUsernames } = require('./lib/presence');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === "true" },
});

// Human-readable duration between two edits. Mirrors the client-side fmtGap on
// the user profile: shows the two most significant units (e.g. "2 days 5 hours"),
// with minUnitSec capping the smallest unit (60 = stop at minutes).
function fmtGap(ms, lang, minUnitSec = 1) {
    const isRu = lang === 'ru';
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const pick = (n, en, ru) => {
        if (isRu) {
            const n10 = n % 10, n100 = n % 100;
            let form;
            if (n10 === 1 && n100 !== 11) form = ru[0];
            else if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) form = ru[1];
            else form = ru[2];
            return `${n} ${form}`;
        }
        return `${n} ${n === 1 ? en[0] : en[1]}`;
    };
    const units = [
        { sec: 31536000, en: ['year', 'years'], ru: ['год', 'года', 'лет'] },
        { sec: 2592000, en: ['month', 'months'], ru: ['месяц', 'месяца', 'месяцев'] },
        { sec: 86400, en: ['day', 'days'], ru: ['день', 'дня', 'дней'] },
        { sec: 3600, en: ['hour', 'hours'], ru: ['час', 'часа', 'часов'] },
        { sec: 60, en: ['minute', 'minutes'], ru: ['минута', 'минуты', 'минут'] },
        { sec: 1, en: ['second', 'seconds'], ru: ['секунда', 'секунды', 'секунд'] },
    ].filter((u) => u.sec >= minUnitSec);
    const smallest = units[units.length - 1];
    if (totalSec < smallest.sec) {
        return isRu ? `менее ${smallest.ru[1]}` : `less than a ${smallest.en[0]}`;
    }
    let i = units.findIndex((u) => totalSec >= u.sec);
    if (i === -1) i = units.length - 1;
    const primary = Math.floor(totalSec / units[i].sec);
    const parts = [pick(primary, units[i].en, units[i].ru)];
    if (i + 1 < units.length) {
        const secondary = Math.floor((totalSec - primary * units[i].sec) / units[i + 1].sec);
        if (secondary > 0) parts.push(pick(secondary, units[i + 1].en, units[i + 1].ru));
    }
    return parts.join(' ');
}

// Group a newest-first list of contributions into windows of consecutive edits
// to the same problem, mirroring the user-profile "Recent Contributions" view.
// Each group carries the time it took (first→last edit) and the gap to the
// group above it (end of the older problem → start of the newer one).
function buildProblemGroups(contributions, lang) {
    const isRu = lang === 'ru';
    const groups = [];
    let cur = null;
    for (const c of contributions) {
        const t = new Date(c.edited_at).getTime();
        if (!cur || cur.problemName !== c.problem_name) {
            cur = {
                problemName: c.problem_name,
                language: c.language,
                rows: [],
                earliestMs: t,
                latestMs: t,
            };
            groups.push(cur);
        }
        cur.rows.push(c);
        cur.earliestMs = Math.min(cur.earliestMs, t);
        cur.latestMs = Math.max(cur.latestMs, t);
    }
    groups.forEach((g, i) => {
        const spanMs = g.latestMs - g.earliestMs;
        g.solvedPrefix = isRu ? 'решено·' : 'solved·';
        g.solvedInWord = isRu ? 'за' : 'in';
        g.spanDur = spanMs > 0 ? fmtGap(spanMs, lang) : null;
        if (i > 0) {
            const gapMs = groups[i - 1].earliestMs - g.latestMs;
            const human = fmtGap(gapMs, lang, 60);
            g.sepLabel = isRu ? `${human} между задачами` : `${human} between problems`;
        }
    });
    return groups;
}

async function getContributionsList(req, res) {
    const { lang, problemName } = req.params;
    i18n.setLocale(res, lang);

    try {
        const rawLimit = parseInt(req.query.limit, 10);
        const rawOffset = parseInt(req.query.offset, 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(50, rawLimit)) : 250;
        const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

        let result;
        let stats;
        let totalRows = 0;
        if (problemName === 'all') {
            const [rowsResult, statsResult] = await Promise.all([
                pool.query(
                `SELECT
                    c.id, c.user_id, c.edited_at, c.problem_name, c.language, c.content_changed, c.source,
                    u.username,
                    u.full_name,
                    u.profile_picture,
                    CASE
                        WHEN ROW_NUMBER() OVER (PARTITION BY c.problem_name ORDER BY c.edited_at ASC, c.id ASC) = 1
                        THEN 1 ELSE 0
                    END AS is_new
                FROM (
                    SELECT
                        id, user_id, edited_at, problem_name, language, false AS content_changed, 'github' AS source
                    FROM github_contributions
                    UNION ALL
                    SELECT
                        id, user_id, edited_at, problem_name, language, content_changed, 'direct' AS source
                    FROM contributions
                ) c
                LEFT JOIN users u ON c.user_id = u.id
                ORDER BY c.edited_at DESC
                LIMIT $1 OFFSET $2
                `,
                [limit, offset]
            ),
                pool.query(
                    `SELECT
                        COUNT(*)::int AS total,
                        COUNT(DISTINCT problem_name)::int AS unique_problems,
                        COUNT(DISTINCT user_id)::int AS unique_contributors
                    FROM (
                        SELECT user_id, problem_name, language
                        FROM github_contributions
                        UNION ALL
                        SELECT user_id, problem_name, language
                        FROM contributions
                    ) c`
                ),
            ]);
            result = rowsResult;
            stats = {
                total: statsResult.rows[0]?.total || 0,
                uniqueProblems: statsResult.rows[0]?.unique_problems || 0,
                uniqueContributors: statsResult.rows[0]?.unique_contributors || 0,
            };
            totalRows = Number(stats.total || 0);
        } else {
            const [rowsResult, statsResult] = await Promise.all([
                pool.query(
                `SELECT
                    c.id, c.user_id, c.edited_at, c.problem_name, c.language, c.content_changed, c.source,
                    u.username,
                    u.full_name,
                    u.profile_picture,
                    CASE
                        WHEN ROW_NUMBER() OVER (PARTITION BY c.problem_name ORDER BY c.edited_at ASC, c.id ASC) = 1
                        THEN 1 ELSE 0
                    END AS is_new
                FROM (
                    SELECT
                        id, user_id, edited_at, problem_name, language, false AS content_changed, 'github' AS source
                    FROM github_contributions
                    UNION ALL
                    SELECT
                        id, user_id, edited_at, problem_name, language, content_changed, 'direct' AS source
                    FROM contributions
                ) c
                LEFT JOIN users u ON c.user_id = u.id
                WHERE c.problem_name = $1 AND c.language = $2
                ORDER BY c.edited_at DESC
                LIMIT $3 OFFSET $4`,
                [problemName, lang, limit, offset]
            ),
                pool.query(
                    `SELECT
                        COUNT(*)::int AS total,
                        COUNT(DISTINCT problem_name)::int AS unique_problems,
                        COUNT(DISTINCT user_id)::int AS unique_contributors
                    FROM (
                        SELECT user_id, problem_name, language
                        FROM github_contributions
                        UNION ALL
                        SELECT user_id, problem_name, language
                        FROM contributions
                    ) c
                    WHERE c.problem_name = $1 AND c.language = $2`,
                    [problemName, lang]
                ),
            ]);
            result = rowsResult;
            stats = {
                total: statsResult.rows[0]?.total || 0,
                uniqueProblems: statsResult.rows[0]?.unique_problems || 0,
                uniqueContributors: statsResult.rows[0]?.unique_contributors || 0,
            };
            totalRows = Number(stats.total || 0);
        }

        // Mark which contributors are currently online (fresh, privacy-aware).
        const onlineUsernames = await getOnlineUsernames(pool, result.rows.map(r => r.username));
        const contributions = result.rows.map(row => ({
            ...row,
            isNew: Number(row.is_new) === 1,
            isOnline: onlineUsernames.has(row.username),
        }));

        // Group consecutive edits to the same problem into windows, matching the
        // "Recent Contributions" separation on the user profile.
        const groups = buildProblemGroups(contributions, lang);

        res.render("contributions_list", {
            __: i18n.__,
            lang,
            problemName,
            contributions,
            groups,
            stats,
            pagination: {
                limit,
                offset,
                shown: contributions.length,
                hasMore: offset + contributions.length < totalRows,
                nextOffset: offset + contributions.length,
            },
            formatDate: (date) => {
                return new Date(date).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            },
            formatTime: (date) => {
                return new Date(date).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
                    hour: '2-digit',
                    minute: '2-digit'
                });
            },
            usernameCurrent: req.session.username || null,
            userIdCurrent: req.session.userId || null,
            username: req.session.username || null,
        });

    } catch (error) {
        console.error("Error fetching contributions:", error);
        res.status(500).send("Error fetching contributions");
    }
}

module.exports = getContributionsList; 