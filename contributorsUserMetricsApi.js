const fs = require("fs");
const path = require("path");
const { flagEmojiForCountryName } = require("./lib/countries");

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();
const geoCache = new Map();

function getCached(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() - item.createdAt > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }
    return item.value;
}

async function withCache(key, loader) {
    const cached = getCached(key);
    if (cached) return cached;
    const value = await loader();
    cache.set(key, { createdAt: Date.now(), value });
    return value;
}

function parseCsvLineLoose(line) {
    const firstComma = line.indexOf(",");
    const lastComma = line.lastIndexOf(",");
    if (firstComma === -1) {
        return [line];
    }
    if (firstComma === lastComma) {
        return [line.slice(0, firstComma), line.slice(firstComma + 1)];
    }
    return [
        line.slice(0, firstComma),
        line.slice(firstComma + 1, lastComma),
        line.slice(lastComma + 1),
    ];
}

function loadBookStructure(baseDir) {
    const chaptersPath = path.join(baseDir, "src", "database", "chapters.csv");
    const sectionsPath = path.join(baseDir, "src", "database", "sections.csv");

    const chapters = fs
        .readFileSync(chaptersPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [numberRaw, title] = parseCsvLineLoose(line);
            return {
                number: parseInt(numberRaw, 10),
                name: String(title || "").trim() || `Chapter ${numberRaw}`,
            };
        });

    const sections = fs
        .readFileSync(sectionsPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [numberRaw, title, countRaw] = parseCsvLineLoose(line);
            const chapterNum = parseInt(String(numberRaw).split(".")[0], 10);
            return {
                number: String(numberRaw),
                chapter: chapterNum,
                name: String(title || "").trim(),
                totalProblems: parseInt(countRaw, 10) || 0,
            };
        });

    const totalsByChapter = sections.reduce((acc, section) => {
        acc[section.chapter] = (acc[section.chapter] || 0) + section.totalProblems;
        return acc;
    }, {});

    return { chapters, sections, totalsByChapter };
}

function chapterFromProblemName(problemName) {
    if (!problemName || typeof problemName !== "string") return null;
    const chapter = parseInt(problemName.split(".")[0], 10);
    return Number.isFinite(chapter) ? chapter : null;
}

function sectionFromProblemName(problemName) {
    if (!problemName || typeof problemName !== "string") return null;
    const parts = problemName.split(".");
    if (parts.length < 2) return null;
    return `${parts[0]}.${parts[1]}`;
}

function normalizeCountryName(name) {
    if (!name) return null;
    return String(name).trim();
}

async function resolveCountryFromIp(ipAddress) {
    if (!ipAddress) return null;
    const ip = String(ipAddress).trim();
    if (!ip) return null;
    if (geoCache.has(ip)) return geoCache.get(ip);
    if (typeof fetch !== "function") return null;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        const response = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            geoCache.set(ip, null);
            return null;
        }

        const payload = await response.json();
        const country = normalizeCountryName(payload.country_name);
        geoCache.set(ip, country || null);
        return country || null;
    } catch (_error) {
        geoCache.set(ip, null);
        return null;
    }
}

async function hydrateMissingCountries(pool) {
    const usersWithoutCountry = await pool.query(
        `
        WITH ranked_ips AS (
            SELECT
                c.user_id,
                c.ip_address,
                COUNT(*) AS cnt,
                ROW_NUMBER() OVER (
                    PARTITION BY c.user_id
                    ORDER BY COUNT(*) DESC, c.ip_address
                ) AS rn
            FROM contributions c
            JOIN users u ON u.id = c.user_id
            WHERE c.user_id IS NOT NULL
              AND c.ip_address IS NOT NULL
              AND TRIM(c.ip_address) <> ''
              AND (u.country_location IS NULL OR TRIM(u.country_location) = '')
            GROUP BY c.user_id, c.ip_address
        )
        SELECT user_id, ip_address
        FROM ranked_ips
        WHERE rn = 1
        LIMIT 90
    `
    );

    for (const row of usersWithoutCountry.rows) {
        const country = await resolveCountryFromIp(row.ip_address);
        if (!country) continue;
        await pool.query(
            `
            UPDATE users
            SET country_location = $1
            WHERE id = $2
              AND (country_location IS NULL OR TRIM(country_location) = '')
        `,
            [country, row.user_id]
        );
    }
}

function toMonthLabel(monthString, locale = "en-US") {
    const [year, month] = monthString.split("-").map((x) => parseInt(x, 10));
    const date = new Date(Date.UTC(year, month - 1, 1));
    return date.toLocaleDateString(locale, { month: "short", year: "numeric", timeZone: "UTC" });
}

function buildLast12MonthKeys() {
    const keys = [];
    const now = new Date();
    for (let i = 11; i >= 0; i -= 1) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    }
    return keys;
}

function sortSafeContributors(rows, sortBy, sortOrder) {
    const order = sortOrder === "asc" ? 1 : -1;
    const compareText = (a, b) => String(a || "").localeCompare(String(b || ""));
    const compareNum = (a, b) => (Number(a || 0) - Number(b || 0));
    const map = {
        rank: (a, b) => compareNum(a.rank_position, b.rank_position),
        contributor: (a, b) => compareText(a.full_name || a.username, b.full_name || b.username),
        country: (a, b) => compareText(a.country_location || "", b.country_location || ""),
        solutions: (a, b) => compareNum(a.unique_solutions, b.unique_solutions),
        score: (a, b) => compareNum(a.score, b.score),
        joined: (a, b) => compareText(a.joined_at || "", b.joined_at || ""),
        lastActive: (a, b) => compareText(a.last_active_at || "", b.last_active_at || ""),
    };
    const cmp = map[sortBy] || map.score;
    return [...rows].sort((a, b) => cmp(a, b) * order);
}

module.exports = function registerContributorAndUserMetricsApi({ app, pool, baseDir }) {
    const structure = loadBookStructure(baseDir);

    app.get("/api/contributors/stats", async (_req, res) => {
        try {
            const payload = await withCache("contributors:stats", async () => {
                await hydrateMissingCountries(pool);

                const contributorsCount = await pool.query(
                    `
                    SELECT COUNT(DISTINCT user_id)::int AS value
                    FROM contributions
                    WHERE content_changed = true
                      AND invisible = false
                      AND user_id IS NOT NULL
                `
                );

                const solutionsCount = await pool.query(
                    `
                    SELECT COUNT(DISTINCT problem_name)::int AS value
                    FROM (
                        SELECT problem_name
                        FROM contributions
                        WHERE content_changed = true
                          AND invisible = false
                          AND problem_name IS NOT NULL
                        UNION
                        SELECT problem_name
                        FROM github_contributions
                        WHERE problem_name IS NOT NULL
                    ) src
                `
                );

                const countriesCount = await pool.query(
                    `
                    WITH contributor_users AS (
                        SELECT DISTINCT user_id
                        FROM contributions
                        WHERE content_changed = true
                          AND invisible = false
                          AND user_id IS NOT NULL
                        UNION
                        SELECT DISTINCT user_id
                        FROM github_contributions
                        WHERE user_id IS NOT NULL
                    )
                    SELECT COUNT(DISTINCT TRIM(u.country_location))::int AS value
                    FROM contributor_users cu
                    JOIN users u ON u.id = cu.user_id
                    WHERE u.country_location IS NOT NULL
                      AND TRIM(u.country_location) <> ''
                `
                );

                const totalEditsCount = await pool.query(
                    `
                    SELECT (
                        (SELECT COUNT(*)::int FROM contributions
                         WHERE content_changed = true AND invisible = false)
                        +
                        (SELECT COUNT(*)::int FROM github_contributions)
                    ) AS value
                `
                );

                return {
                    contributors: contributorsCount.rows[0]?.value || 0,
                    solutions: solutionsCount.rows[0]?.value || 0,
                    countries: countriesCount.rows[0]?.value || 0,
                    totalEdits: totalEditsCount.rows[0]?.value || 0,
                };
            });

            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load contributor stats:", error);
            res.status(500).json({ error: "Failed to load contributor stats" });
        }
    });

    app.get("/api/contributors/map", async (_req, res) => {
        try {
            const payload = await withCache("contributors:map:v3", async () => {
                await hydrateMissingCountries(pool);

                const result = await pool.query(
                    `
                    WITH combined AS (
                        SELECT user_id
                        FROM contributions
                        WHERE content_changed = true
                          AND invisible = false
                          AND user_id IS NOT NULL
                        UNION ALL
                        SELECT user_id
                        FROM github_contributions
                        WHERE user_id IS NOT NULL
                    )
                    SELECT
                        CASE
                            WHEN c.user_id = 28 THEN 'United States'
                            ELSE TRIM(u.country_location)
                        END AS country,
                        COUNT(DISTINCT c.user_id)::int AS contributors,
                        COUNT(*)::int AS contributions,
                        COUNT(*)::int AS total_contributions
                    FROM combined c
                    JOIN users u ON u.id = c.user_id
                    WHERE u.country_location IS NOT NULL
                      AND TRIM(u.country_location) <> ''
                    GROUP BY
                        CASE
                            WHEN c.user_id = 28 THEN 'United States'
                            ELSE TRIM(u.country_location)
                        END
                    ORDER BY contributions DESC, contributors DESC, country ASC
                `
                );
                return result.rows;
            });
            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load contributor map:", error);
            res.status(500).json({ error: "Failed to load contributor map" });
        }
    });

    app.get("/api/contributors/heatmap", async (req, res) => {
        try {
            const rawYear = req.query.year;
            const parsedYear = rawYear !== undefined && rawYear !== "" ? parseInt(String(rawYear), 10) : NaN;
            const yearFilter =
                Number.isFinite(parsedYear) && parsedYear >= 1970 && parsedYear <= 2100 ? parsedYear : null;
            const cacheKey = `contributors:heatmap:${yearFilter ?? "rolling"}`;

            const payload = await withCache(cacheKey, async () => {
                const yearsResult = await pool.query(
                    `
                    WITH bounds AS (
                        SELECT
                            MIN(EXTRACT(YEAR FROM edited_at)::int) AS min_y,
                            MAX(EXTRACT(YEAR FROM edited_at)::int) AS max_y
                        FROM (
                            SELECT edited_at
                            FROM contributions
                            WHERE content_changed = true
                              AND invisible = false
                            UNION ALL
                            SELECT edited_at
                            FROM github_contributions
                        ) s
                        WHERE edited_at IS NOT NULL
                    )
                    SELECT generate_series(bounds.min_y, bounds.max_y)::int AS y
                    FROM bounds
                    WHERE bounds.min_y IS NOT NULL
                      AND bounds.max_y IS NOT NULL
                    ORDER BY y DESC
                `
                );
                const years = yearsResult.rows.map((r) => r.y).filter((y) => y != null);

                let result;
                if (yearFilter != null) {
                    result = await pool.query(
                        `
                        SELECT day::date, COUNT(*)::int AS count
                        FROM (
                            SELECT DATE(edited_at) AS day
                            FROM contributions
                            WHERE content_changed = true
                              AND invisible = false
                              AND edited_at >= make_date($1, 1, 1)
                              AND edited_at < make_date($1 + 1, 1, 1)
                            UNION ALL
                            SELECT DATE(edited_at) AS day
                            FROM github_contributions
                            WHERE edited_at >= make_date($1, 1, 1)
                              AND edited_at < make_date($1 + 1, 1, 1)
                        ) src
                        GROUP BY day
                        ORDER BY day ASC
                    `,
                        [yearFilter]
                    );
                } else {
                    result = await pool.query(
                        `
                        SELECT day::date, COUNT(*)::int AS count
                        FROM (
                            SELECT DATE(edited_at) AS day
                            FROM contributions
                            WHERE content_changed = true
                              AND invisible = false
                              AND edited_at > NOW() - INTERVAL '12 months'
                            UNION ALL
                            SELECT DATE(edited_at) AS day
                            FROM github_contributions
                            WHERE edited_at > NOW() - INTERVAL '12 months'
                        ) src
                        GROUP BY day
                        ORDER BY day ASC
                    `
                    );
                }

                const view =
                    yearFilter != null ? { kind: "year", year: yearFilter } : { kind: "rolling" };

                return {
                    years,
                    view,
                    days: result.rows,
                };
            });
            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load contributor heatmap:", error);
            res.status(500).json({ error: "Failed to load contributor heatmap" });
        }
    });

    app.get("/api/contributors/leaderboard", async (req, res) => {
        try {
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
            const sortBy = String(req.query.sortBy || "score");
            const sortOrder = String(req.query.sortOrder || "desc").toLowerCase() === "asc" ? "asc" : "desc";

            const payload = await withCache(`contributors:leaderboard`, async () => {
                const result = await pool.query(
                    `
                    WITH combined AS (
                        SELECT user_id, problem_name, language, edited_at
                        FROM contributions
                        WHERE user_id IS NOT NULL
                          AND content_changed = true
                          AND invisible = false
                        UNION ALL
                        SELECT user_id, problem_name, language, edited_at
                        FROM github_contributions
                        WHERE user_id IS NOT NULL
                    ),
                    user_stats AS (
                        SELECT
                            u.id AS user_id,
                            u.username,
                            u.full_name,
                            u.profile_picture,
                            u.country_location,
                            u.created_at,
                            u.is_verified_user,
                            COUNT(*)::int AS edits_total,
                            COUNT(DISTINCT c.problem_name)::int AS unique_solutions,
                            MIN(c.edited_at) AS first_contribution_at,
                            MAX(c.edited_at) AS last_active_at,
                            ROUND((19 * LN(COUNT(DISTINCT c.problem_name) * SQRT(COUNT(*))))::numeric, 0)::int AS score
                        FROM combined c
                        JOIN users u ON u.id = c.user_id
                        GROUP BY u.id, u.username, u.full_name, u.profile_picture, u.country_location, u.created_at, u.is_verified_user
                    ),
                    ranked AS (
                        SELECT
                            *,
                            ROW_NUMBER() OVER (ORDER BY score DESC, unique_solutions DESC, username ASC) AS rank_position
                        FROM user_stats
                    )
                    SELECT *
                    FROM ranked
                `
                );
                return result.rows;
            });

            const sorted = sortSafeContributors(payload, sortBy, sortOrder);
            const total = sorted.length;
            const start = (page - 1) * limit;
            const rows = sorted.slice(start, start + limit).map((row, idx) => ({
                rank: start + idx + 1,
                rankPosition: row.rank_position,
                username: row.username,
                fullName: row.full_name || row.username,
                profilePicture: row.profile_picture || "/img/profile_images/Default_placeholder.svg",
                countryLocation: row.country_location || null,
                countryFlag: row.country_location ? flagEmojiForCountryName(row.country_location) : "",
                solutions: row.unique_solutions,
                score: row.score,
                joinedAt: row.created_at || row.first_contribution_at,
                lastActiveAt: row.last_active_at,
                isVerifiedUser: row.is_verified_user,
            }));

            res.set("Cache-Control", "public, max-age=3600");
            res.json({
                page,
                limit,
                total,
                hasPrev: page > 1,
                hasNext: start + limit < total,
                sortBy,
                sortOrder,
                rows,
            });
        } catch (error) {
            console.error("Failed to load contributors leaderboard:", error);
            res.status(500).json({ error: "Failed to load contributors leaderboard" });
        }
    });

    app.get("/api/user/:username/stats", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            // v2: align headline stats with legacy profile (pair UNION; edits = row counts)
            const cacheKey = `user:${username}:stats:v3:${req.session.userId || 0}`;
            const payload = await withCache(cacheKey, async () => {
                const userResult = await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE username = $1
                `,
                    [username]
                );
                if (userResult.rows.length === 0) return null;
                const user = userResult.rows[0];
                const isOwnProfile = req.session.userId === user.id;

                const statsResult = await pool.query(
                    `
                    WITH pair_union AS (
                        SELECT problem_name, language
                        FROM contributions
                        WHERE user_id = $1
                          AND content_changed = true
                        UNION
                        SELECT problem_name, language
                        FROM github_contributions
                        WHERE user_id = $1
                    ),
                    contribution_times AS (
                        SELECT edited_at
                        FROM contributions
                        WHERE user_id = $1
                          AND content_changed = true
                        UNION ALL
                        SELECT edited_at
                        FROM github_contributions
                        WHERE user_id = $1
                    ),
                    user_problem_names AS (
                        SELECT DISTINCT problem_name
                        FROM pair_union
                        WHERE problem_name IS NOT NULL
                    ),
                    liked AS (
                        SELECT COUNT(*)::int AS likes_received
                        FROM solution_likes sl
                        WHERE sl.is_like = true
                          AND sl.problem_name IN (SELECT problem_name FROM user_problem_names)
                    ),
                    edits_count AS (
                        SELECT COUNT(*)::int AS n
                        FROM (
                            SELECT problem_name
                            FROM contributions
                            WHERE user_id = $1
                              AND content_changed = true
                            UNION ALL
                            SELECT problem_name
                            FROM github_contributions
                            WHERE user_id = $1
                        ) t
                    )
                    SELECT
                        (SELECT COUNT(DISTINCT problem_name)::int FROM pair_union WHERE problem_name IS NOT NULL) AS solutions,
                        (SELECT n FROM edits_count) AS edits,
                        (SELECT COUNT(DISTINCT CASE WHEN language = 'en' THEN problem_name END)::int FROM pair_union) AS translations,
                        (SELECT likes_received FROM liked) AS likes_received,
                        (SELECT MIN(edited_at) FROM contribution_times) AS first_contribution_at,
                        (SELECT MAX(edited_at) FROM contribution_times) AS last_active_at
                `,
                    [user.id]
                );

                const stats = statsResult.rows[0];

                const collaborators = await pool.query(
                    `
                    WITH user_problems AS (
                        SELECT DISTINCT problem_name
                        FROM contributions
                        WHERE user_id = $1
                        UNION
                        SELECT DISTINCT problem_name
                        FROM github_contributions
                        WHERE user_id = $1
                    ),
                    collaborator_counts AS (
                        SELECT
                            c.user_id AS collaborator_id,
                            COUNT(DISTINCT c.problem_name)::int AS collaboration_count
                        FROM contributions c
                        INNER JOIN user_problems up ON c.problem_name = up.problem_name
                        WHERE c.user_id IS NOT NULL
                          AND c.user_id <> $1
                        GROUP BY c.user_id
                        UNION ALL
                        SELECT
                            gc.user_id AS collaborator_id,
                            COUNT(DISTINCT gc.problem_name)::int AS collaboration_count
                        FROM github_contributions gc
                        INNER JOIN user_problems up ON gc.problem_name = up.problem_name
                        WHERE gc.user_id IS NOT NULL
                          AND gc.user_id <> $1
                        GROUP BY gc.user_id
                    ),
                    aggregated AS (
                        SELECT
                            collaborator_id,
                            SUM(collaboration_count)::int AS shared_problems
                        FROM collaborator_counts
                        GROUP BY collaborator_id
                    )
                    SELECT
                        u.username,
                        u.full_name,
                        u.profile_picture,
                        a.shared_problems
                    FROM aggregated a
                    JOIN users u ON u.id = a.collaborator_id
                    ORDER BY a.shared_problems DESC, u.username ASC
                    LIMIT 12
                `,
                    [user.id]
                );

                let platformOverview = null;
                if (username === "astrosander" && isOwnProfile) {
                    const overview = await pool.query(
                        `
                        SELECT
                            (SELECT COUNT(DISTINCT problem_name)::int
                             FROM (
                                SELECT problem_name FROM contributions WHERE content_changed = true AND invisible = false
                                UNION
                                SELECT problem_name FROM github_contributions
                             ) s) AS total_platform_solutions,
                            (SELECT COUNT(*)::int FROM users) AS total_registered_users,
                            (SELECT COALESCE(SUM(views), 0)::bigint FROM page_views) + (SELECT COALESCE(SUM(views), 0)::bigint FROM page_views_old) AS total_page_views,
                            (SELECT COUNT(DISTINCT ip_address)::int FROM recent_views WHERE ip_address IS NOT NULL) AS unique_visitors,
                            (SELECT COUNT(DISTINCT problem_name)::int FROM github_contributions WHERE user_id = $1) AS solutions_personally_authored,
                            (
                                SELECT COUNT(DISTINCT problem_name)::int
                                FROM (
                                    SELECT problem_name, language FROM contributions WHERE user_id = $1 AND content_changed = true
                                    UNION
                                    SELECT problem_name, language FROM github_contributions WHERE user_id = $1
                                ) t
                                WHERE language = 'en'
                            ) AS solutions_translated
                    `,
                        [user.id]
                    );
                    platformOverview = overview.rows[0];
                }

                return {
                    user: {
                        id: user.id,
                        username: user.username,
                        fullName: user.full_name || user.username,
                        profilePicture: user.profile_picture || "/img/profile_images/Default_placeholder.svg",
                        countryLocation: user.country_location || null,
                        countryFlag: user.country_location ? flagEmojiForCountryName(user.country_location) : "",
                        institution: user.institution || null,
                        bio: user.bio || "",
                        isVerifiedUser: !!user.is_verified_user,
                        github: user.github || null,
                        linkedin: user.linkedin || null,
                        website: user.personal_website || null,
                        createdAt: user.created_at || null,
                    },
                    stats: {
                        solutions: Number(stats.solutions || 0),
                        edits: Number(stats.edits || 0),
                        translations: Number(stats.translations || 0),
                        likesReceived: Number(stats.likes_received || 0),
                    },
                    footer: {
                        memberSince: user.created_at || stats.first_contribution_at || null,
                        lastActiveAt: stats.last_active_at || null,
                    },
                    collaborators: collaborators.rows.map((row) => ({
                        username: row.username,
                        fullName: row.full_name || row.username,
                        profilePicture: row.profile_picture || "/img/profile_images/Default_placeholder.svg",
                        sharedProblems: row.shared_problems,
                    })),
                    isOwnProfile,
                    canShowSankey: Number(stats.edits || 0) >= 50 || username === "astrosander",
                    platformOverview,
                };
            });

            if (!payload) {
                return res.status(404).json({ error: "User not found" });
            }

            // Follow status checked outside cache (changes frequently)
            const result = { ...payload };
            result.isFollowing = false;
            if (req.session.userId && req.session.userId !== payload.user.id) {
                const followCheck = await pool.query(
                    "SELECT id FROM user_follows WHERE follower_id = $1 AND following_id = $2",
                    [req.session.userId, payload.user.id]
                );
                result.isFollowing = followCheck.rows.length > 0;
            }

            if (req.session.userId) {
                res.set("Cache-Control", "private, no-cache");
            } else {
                res.set("Cache-Control", "public, max-age=3600");
            }
            res.json(result);
        } catch (error) {
            console.error("Failed to load user stats:", error);
            res.status(500).json({ error: "Failed to load user stats" });
        }
    });

    app.get("/api/user/:username/heatmap", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            const rawYear = req.query.year;
            const parsedYear = rawYear !== undefined && rawYear !== "" ? parseInt(String(rawYear), 10) : NaN;
            const yearFilter =
                Number.isFinite(parsedYear) && parsedYear >= 1970 && parsedYear <= 2100 ? parsedYear : null;

            const cacheKey = `user:${username}:heatmap:${yearFilter ?? "rolling"}`;
            const payload = await withCache(cacheKey, async () => {
                const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
                if (user.rows.length === 0) return null;
                const userId = user.rows[0].id;

                const yearsResult = await pool.query(
                    `
                    SELECT DISTINCT EXTRACT(YEAR FROM edited_at)::int AS y
                    FROM (
                        SELECT edited_at FROM contributions
                        WHERE user_id = $1 AND content_changed = true AND invisible = false
                        UNION ALL
                        SELECT edited_at FROM github_contributions
                        WHERE user_id = $1
                    ) s
                    WHERE edited_at IS NOT NULL
                    ORDER BY y DESC
                `,
                    [userId]
                );
                const years = yearsResult.rows.map((r) => r.y).filter((y) => y != null);

                let result;
                if (yearFilter != null) {
                    result = await pool.query(
                        `
                        SELECT day::date, COUNT(*)::int AS count
                        FROM (
                            SELECT DATE(edited_at) AS day
                            FROM contributions
                            WHERE user_id = $1
                              AND content_changed = true
                              AND invisible = false
                              AND edited_at >= make_date($2, 1, 1)
                              AND edited_at < make_date($2 + 1, 1, 1)
                            UNION ALL
                            SELECT DATE(edited_at) AS day
                            FROM github_contributions
                            WHERE user_id = $1
                              AND edited_at >= make_date($2, 1, 1)
                              AND edited_at < make_date($2 + 1, 1, 1)
                        ) src
                        GROUP BY day
                        ORDER BY day ASC
                    `,
                        [userId, yearFilter]
                    );
                } else {
                    result = await pool.query(
                        `
                        SELECT day::date, COUNT(*)::int AS count
                        FROM (
                            SELECT DATE(edited_at) AS day
                            FROM contributions
                            WHERE user_id = $1
                              AND content_changed = true
                              AND invisible = false
                              AND edited_at > NOW() - INTERVAL '12 months'
                            UNION ALL
                            SELECT DATE(edited_at) AS day
                            FROM github_contributions
                            WHERE user_id = $1
                              AND edited_at > NOW() - INTERVAL '12 months'
                        ) src
                        GROUP BY day
                        ORDER BY day ASC
                    `,
                        [userId]
                    );
                }

                const view =
                    yearFilter != null ? { kind: "year", year: yearFilter } : { kind: "rolling" };

                return {
                    years,
                    view,
                    days: result.rows,
                };
            });
            if (!payload) {
                return res.status(404).json({ error: "User not found" });
            }
            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load user heatmap:", error);
            res.status(500).json({ error: "Failed to load user heatmap" });
        }
    });

    app.get("/api/user/:username/radar", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            const payload = await withCache(`user:${username}:radar`, async () => {
                const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
                if (user.rows.length === 0) return null;
                const userId = user.rows[0].id;

                const solved = await pool.query(
                    `
                    SELECT DISTINCT problem_name
                    FROM (
                        SELECT problem_name
                        FROM contributions
                        WHERE user_id = $1
                          AND content_changed = true
                          AND invisible = false
                        UNION
                        SELECT problem_name
                        FROM github_contributions
                        WHERE user_id = $1
                    ) src
                    WHERE problem_name IS NOT NULL
                `,
                    [userId]
                );

                const solvedByChapter = {};
                const solvedBySection = {};
                for (const row of solved.rows) {
                    const chapter = chapterFromProblemName(row.problem_name);
                    const section = sectionFromProblemName(row.problem_name);
                    if (chapter) solvedByChapter[chapter] = (solvedByChapter[chapter] || 0) + 1;
                    if (section) solvedBySection[section] = (solvedBySection[section] || 0) + 1;
                }

                const breakdown = structure.chapters.map((chapter) => {
                    const solvedCount = solvedByChapter[chapter.number] || 0;
                    const totalProblems = structure.totalsByChapter[chapter.number] || 0;
                    const percentage = totalProblems > 0 ? (solvedCount / totalProblems) * 100 : 0;
                    return {
                        chapterNumber: chapter.number,
                        chapterName: chapter.name,
                        solved: solvedCount,
                        total: totalProblems,
                        percentage: Number(percentage.toFixed(2)),
                    };
                }).sort((a, b) => b.percentage - a.percentage || b.solved - a.solved);

                const top = [...breakdown]
                    .sort((a, b) => b.solved - a.solved)
                    .filter((x) => x.solved > 0);
                const radarBase = top.slice(0, 7);
                const other = top.slice(7).reduce((acc, x) => acc + x.solved, 0);
                const radarAxes = radarBase.map((x) => ({ label: x.chapterName, value: x.solved }));
                if (other > 0) {
                    radarAxes.push({ label: "Other", value: other });
                }

                return { radarAxes, breakdown, solvedBySection };
            });
            if (!payload) {
                return res.status(404).json({ error: "User not found" });
            }
            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load user radar:", error);
            res.status(500).json({ error: "Failed to load user radar" });
        }
    });

    app.get("/api/user/:username/timeline", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            const payload = await withCache(`user:${username}:timeline`, async () => {
                const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
                if (user.rows.length === 0) return null;
                const userId = user.rows[0].id;

                const result = await pool.query(
                    `
                    SELECT
                        TO_CHAR(date_trunc('month', edited_at), 'YYYY-MM') AS month_key,
                        COUNT(*)::int AS count
                    FROM (
                        SELECT edited_at
                        FROM contributions
                        WHERE user_id = $1
                          AND content_changed = true
                          AND invisible = false
                          AND edited_at > NOW() - INTERVAL '12 months'
                        UNION ALL
                        SELECT edited_at
                        FROM github_contributions
                        WHERE user_id = $1
                          AND edited_at > NOW() - INTERVAL '12 months'
                    ) src
                    GROUP BY month_key
                `,
                    [userId]
                );

                const byMonth = Object.fromEntries(result.rows.map((r) => [r.month_key, Number(r.count)]));
                const keys = buildLast12MonthKeys();
                const months = keys.map((key) => ({
                    key,
                    label: toMonthLabel(key),
                    count: byMonth[key] || 0,
                }));
                const mostActive = [...months].sort((a, b) => b.count - a.count)[0] || null;
                return { months, mostActive };
            });
            if (!payload) {
                return res.status(404).json({ error: "User not found" });
            }
            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load user timeline:", error);
            res.status(500).json({ error: "Failed to load user timeline" });
        }
    });

    app.get("/api/user/:username/contributions", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
            const offset = (page - 1) * limit;

            const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
            if (user.rows.length === 0) {
                return res.status(404).json({ error: "User not found" });
            }
            const userId = user.rows[0].id;

            const rows = await pool.query(
                `
                SELECT *
                FROM (
                    SELECT
                        id,
                        problem_name,
                        language,
                        edited_at,
                        'contribution' AS source
                    FROM contributions
                    WHERE user_id = $1
                      AND content_changed = true
                      AND invisible = false
                    UNION ALL
                    SELECT
                        id,
                        problem_name,
                        language,
                        edited_at,
                        'github' AS source
                    FROM github_contributions
                    WHERE user_id = $1
                ) src
                ORDER BY edited_at DESC
                LIMIT $2 OFFSET $3
            `,
                [userId, limit + 1, offset]
            );

            const hasNext = rows.rows.length > limit;
            const dataRows = hasNext ? rows.rows.slice(0, limit) : rows.rows;

            res.set("Cache-Control", "public, max-age=3600");
            res.json({
                page,
                limit,
                hasNext,
                rows: dataRows,
            });
        } catch (error) {
            console.error("Failed to load user contributions:", error);
            res.status(500).json({ error: "Failed to load user contributions" });
        }
    });

    app.get("/api/user/:username/sankey", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            const chapterParam = parseInt(req.query.chapter, 10) || null;
            const cacheKey = `user:${username}:sankey:${chapterParam || 0}`;
            const payload = await withCache(cacheKey, async () => {
                const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
                if (user.rows.length === 0) return null;
                const userId = user.rows[0].id;

                const editsCount = await pool.query(
                    `
                    SELECT (
                        (SELECT COUNT(*) FROM contributions WHERE user_id = $1)
                        + (SELECT COUNT(*) FROM github_contributions WHERE user_id = $1)
                    )::int AS edits
                `,
                    [userId]
                );
                const edits = Number(editsCount.rows[0]?.edits || 0);
                if (!(edits >= 50 || username === "astrosander")) {
                    return { forbidden: true };
                }

                const solvedRows = await pool.query(
                    `
                    SELECT DISTINCT problem_name
                    FROM (
                        SELECT problem_name
                        FROM contributions
                        WHERE user_id = $1
                          AND content_changed = true
                          AND invisible = false
                        UNION
                        SELECT problem_name
                        FROM github_contributions
                        WHERE user_id = $1
                    ) src
                    WHERE problem_name IS NOT NULL
                `,
                    [userId]
                );

                const solvedSet = new Set(solvedRows.rows.map((r) => r.problem_name));
                const chapterNumbers = [...new Set(structure.sections.map((s) => s.chapter))].sort((a, b) => a - b);
                const selectedChapter = chapterParam && chapterNumbers.includes(chapterParam)
                    ? chapterParam
                    : chapterNumbers[0];

                const sectionNodes = structure.sections.filter((s) => s.chapter === selectedChapter);
                const chapterName = structure.chapters.find((c) => c.number === selectedChapter)?.name || `Chapter ${selectedChapter}`;

                const solvedBySection = {};
                for (const problemName of solvedSet) {
                    const section = sectionFromProblemName(problemName);
                    if (!section) continue;
                    solvedBySection[section] = (solvedBySection[section] || 0) + 1;
                }

                const nodes = [
                    { name: chapterName, kind: "chapter" },
                    ...sectionNodes.map((s) => ({ name: s.name, kind: "section" })),
                    { name: "Solved", kind: "status" },
                    { name: "Unsolved", kind: "status" },
                ];

                const nodeIndex = Object.fromEntries(nodes.map((n, i) => [n.name, i]));
                const links = [];
                for (const section of sectionNodes) {
                    const solved = solvedBySection[section.number] || 0;
                    const unsolved = Math.max(0, section.totalProblems - solved);
                    links.push({ source: nodeIndex[chapterName], target: nodeIndex[section.name], value: section.totalProblems });
                    if (solved > 0) {
                        links.push({ source: nodeIndex[section.name], target: nodeIndex.Solved, value: solved });
                    }
                    if (unsolved > 0) {
                        links.push({ source: nodeIndex[section.name], target: nodeIndex.Unsolved, value: unsolved });
                    }
                }

                return {
                    selectedChapter,
                    chapters: structure.chapters.map((c) => ({ number: c.number, name: c.name })),
                    nodes,
                    links,
                };
            });

            if (!payload) {
                return res.status(404).json({ error: "User not found" });
            }
            if (payload.forbidden) {
                return res.status(403).json({ error: "Sankey not available for this user" });
            }
            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load user sankey:", error);
            res.status(500).json({ error: "Failed to load user sankey" });
        }
    });
};
