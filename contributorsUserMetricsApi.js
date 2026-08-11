const fs = require("fs");
const path = require("path");
const { flagEmojiForCountryName, countryCodeForName } = require("./lib/countries");
const { getOnlineUsernames } = require("./lib/presence");

const CACHE_TTL_MS = 60 * 60 * 1000;
// A user counts as "online" while their last_seen_at is within this window.
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
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

// The Russian CSVs use the same chapter/section numbering as the English ones —
// only the titles differ — so a chapter keeps its identity across languages and
// the two structures are interchangeable everywhere but in display text.
const BOOK_STRUCTURE_DIRS = {
    en: ["src", "database"],
    ru: ["src", "ru", "database"],
};

// Both Russian CSVs start with a UTF-8 BOM, which would otherwise leave the first
// chapter numbered NaN.
function readCsv(filePath) {
    return fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
}

function loadBookStructure(baseDir, lang = "en") {
    const dir = BOOK_STRUCTURE_DIRS[lang] || BOOK_STRUCTURE_DIRS.en;
    const chaptersPath = path.join(baseDir, ...dir, "chapters.csv");
    const sectionsPath = path.join(baseDir, ...dir, "sections.csv");

    const chapters = readCsv(chaptersPath)
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

    const sections = readCsv(sectionsPath)
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

// The site owner: listed in score order but deliberately without a place number.
const OWNER_USER_ID = 28;

// A contributor's country as the leaderboard is allowed to show it. Users who
// switched "show my country" off in their settings are excluded from the flag
// column and from the country filter alike — otherwise the filter would leak
// exactly the fact the setting is meant to hide.
function countryOnLeaderboard(row) {
    if (row.show_country === false) return null;
    const name = String(row.country_location || "").trim();
    return name || null;
}

// Turns the sorted contributor rows into what one leaderboard request needs:
// every row with its place number, the subset matching the requested country, and
// the facet counts behind the dropdown. Pure, so it is tested directly — there is
// no test database for the route itself.
function selectLeaderboardRows(sorted, countryFilter) {
    // astrosander (user 28, the site owner) keeps their score-sorted position in the
    // table but is NOT given a place number ("место"). Everyone else is numbered from
    // 1 in the current sort order, so the top non-owner contributor shows as #1.
    // Places are assigned over the full sorted list — before both filtering and
    // pagination — so a filtered view shows real site-wide places (3, 11, 24…)
    // rather than renumbering from 1.
    let place = 0;
    const placed = sorted.map((row) => {
        if (Number(row.user_id) === OWNER_USER_ID) return { row, rank: null };
        place += 1;
        return { row, rank: place };
    });

    // The facet list is built from every contributor, not from the current page, so
    // the dropdown reads the same whatever you happen to be looking at.
    const facets = new Map();
    for (const { row } of placed) {
        const country = countryOnLeaderboard(row);
        if (!country) continue;
        facets.set(country, (facets.get(country) || 0) + 1);
    }
    const countries = [...facets.entries()]
        .map(([name, count]) => ({
            name,
            code: countryCodeForName(name),
            flag: flagEmojiForCountryName(name),
            count,
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const wanted = String(countryFilter || "").trim().toLowerCase();
    const matching = wanted
        ? placed.filter(({ row }) => (countryOnLeaderboard(row) || "").toLowerCase() === wanted)
        : placed;

    return { placed, matching, countries };
}

function sortSafeContributors(rows, sortBy, sortOrder) {
    const order = sortOrder === "asc" ? 1 : -1;
    const compareText = (a, b) => String(a || "").localeCompare(String(b || ""));
    const compareNum = (a, b) => (Number(a || 0) - Number(b || 0));
    const map = {
        rank: (a, b) => compareNum(a.rank_position, b.rank_position),
        contributor: (a, b) => compareText(a.full_name || a.username, b.full_name || b.username),
        country: (a, b) => compareText(countryOnLeaderboard(a) || "", countryOnLeaderboard(b) || ""),
        solutions: (a, b) => compareNum(a.unique_solutions, b.unique_solutions),
        score: (a, b) => compareNum(a.score, b.score),
        joined: (a, b) => compareText(a.joined_at || "", b.joined_at || ""),
        lastActive: (a, b) => compareText(a.last_active_at || "", b.last_active_at || ""),
    };
    const cmp = map[sortBy] || map.score;
    return [...rows].sort((a, b) => cmp(a, b) * order);
}

// Wording for the few labels the API generates itself rather than reading out of
// the book CSVs (Sankey status nodes, the radar's catch-all axis).
const CHART_LABELS = {
    en: { solved: "Solved", unsolved: "Unsolved", other: "Other", chapter: (n) => `Chapter ${n}` },
    ru: { solved: "Решено", unsolved: "Не решено", other: "Другое", chapter: (n) => `Глава ${n}` },
};

function normalizeLang(value) {
    return String(value || "").toLowerCase() === "ru" ? "ru" : "en";
}

module.exports = function registerContributorAndUserMetricsApi({ app, pool, baseDir }) {
    const structures = { en: loadBookStructure(baseDir, "en") };
    try {
        structures.ru = loadBookStructure(baseDir, "ru");
    } catch (error) {
        // Better an English chapter list than a 500 on the Russian profile page.
        console.error("Russian book structure unavailable, falling back to English:", error.message);
        structures.ru = structures.en;
    }
    const structureFor = (lang) => structures[normalizeLang(lang)];

    // Each /api/user/:username/* handler is registered through here so a reference
    // survives. The profile page then runs all of them in-process and ships the
    // results inside its own HTML — seven network round trips, each costing a full
    // RTT for one or two kilobytes, collapse to none. The handlers themselves are
    // untouched, so the endpoints keep working for anything else that calls them.
    const userEndpoints = {};
    function defineUserEndpoint(name, handler) {
        userEndpoints[name] = handler;
        app.get(`/api/user/:username/${name}`, handler);
    }

    // Runs a handler with a stub response and hands back whatever it would have sent.
    // Anything that errors or 404s resolves to null rather than taking the page down.
    function runUserEndpoint(name, req) {
        const handler = userEndpoints[name];
        if (!handler) return Promise.resolve(null);
        return new Promise((resolve) => {
            let settled = false;
            const done = (value) => { if (!settled) { settled = true; resolve(value); } };
            const res = {
                statusCode: 200,
                set() { return this; },
                setHeader() { return this; },
                status(code) { this.statusCode = code; return this; },
                json(body) { done(this.statusCode >= 400 ? null : body); return this; },
                send(body) { done(this.statusCode >= 400 ? null : body); return this; },
            };
            Promise.resolve()
                .then(() => handler(req, res))
                .then(() => done(null))
                .catch(() => done(null));
        });
    }

    // Everything the profile page renders, gathered in one pass. Measured at 63 ms
    // for all seven on a warm cache, against ~400 ms of latency per round trip.
    app.locals.loadUserProfileBundle = async function loadUserProfileBundle(req, username, lang) {
        const base = {
            params: { username },
            query: { lang },
            session: req.session || {},
            headers: req.headers || {},
        };
        const wanted = ['stats', 'heatmap', 'rating', 'timeline', 'radar', 'social', 'impact'];
        const results = await Promise.all([
            ...wanted.map((name) => runUserEndpoint(name, { ...base, query: { lang } })),
            runUserEndpoint('contributions', { ...base, query: { page: '1', limit: '20' } }),
        ]);
        const bundle = {};
        wanted.forEach((name, i) => { bundle[name] = results[i]; });
        bundle.contributions = results[wanted.length];
        return bundle;
    };

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
            const countryFilter = String(req.query.country || "").trim();

            // v2: the row set now carries the show_country_on_leaderboard preference.
            const payload = await withCache(`contributors:leaderboard:v2`, async () => {
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
                            COALESCE(pr.show_country_on_leaderboard, true) AS show_country,
                            u.created_at,
                            u.is_verified_user,
                            COUNT(*)::int AS edits_total,
                            COUNT(DISTINCT c.problem_name)::int AS unique_solutions,
                            MIN(c.edited_at) AS first_contribution_at,
                            MAX(c.edited_at) AS last_active_at,
                            ROUND((19 * LN(COUNT(DISTINCT c.problem_name) * SQRT(COUNT(*))))::numeric, 0)::int AS score
                        FROM combined c
                        JOIN users u ON u.id = c.user_id
                        LEFT JOIN user_preferences pr ON pr.user_id = u.id
                        GROUP BY u.id, u.username, u.full_name, u.profile_picture, u.country_location,
                                 pr.show_country_on_leaderboard, u.created_at, u.is_verified_user
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
            const { placed, matching, countries } = selectLeaderboardRows(sorted, countryFilter);

            const total = matching.length;
            const start = (page - 1) * limit;

            const pageRows = matching.slice(start, start + limit).map(({ row, rank }) => {
                const country = countryOnLeaderboard(row);
                return {
                    rank,
                    rankPosition: row.rank_position,
                    username: row.username,
                    fullName: row.full_name || row.username,
                    profilePicture: row.profile_picture || "/img/profile_images/Default_placeholder.svg",
                    countryLocation: country,
                    countryCode: country ? countryCodeForName(country) : "",
                    countryFlag: country ? flagEmojiForCountryName(country) : "",
                    solutions: row.unique_solutions,
                    score: row.score,
                    joinedAt: row.created_at || row.first_contribution_at,
                    lastActiveAt: row.last_active_at,
                    isVerifiedUser: row.is_verified_user,
                };
            });

            // Online presence is time-sensitive, so it is resolved fresh per
            // request (outside the 1h leaderboard cache) for the current page.
            const onlineUsernames = await getOnlineUsernames(pool, pageRows.map((r) => r.username));
            const rows = pageRows.map((r) => ({ ...r, isOnline: onlineUsernames.has(r.username) }));

            // Short max-age: the row data is cached server-side for 1h, but the
            // isOnline flags must not be frozen in the client cache for long.
            res.set("Cache-Control", "public, max-age=60");
            res.json({
                page,
                limit,
                total,
                totalAll: placed.length,
                hasPrev: page > 1,
                hasNext: start + limit < total,
                sortBy,
                sortOrder,
                country: countryFilter || null,
                countries,
                rows,
            });
        } catch (error) {
            console.error("Failed to load contributors leaderboard:", error);
            res.status(500).json({ error: "Failed to load contributors leaderboard" });
        }
    });

    // Codeforces-style rating trajectory for one user. The final point and the
    // `current.score` use the SAME "combined" set + formula as the leaderboard
    // (/api/contributors/leaderboard), so the end of the line coincides exactly
    // with the value shown on /:lang/contributors.
    defineUserEndpoint("rating", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            const userRow = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
            if (userRow.rows.length === 0) {
                return res.status(404).json({ error: "User not found" });
            }
            const userId = userRow.rows[0].id;

            // v3: the series is anchored at zero before the first contribution.
            const payload = await withCache(`user:${username}:rating:v3`, async () => {
                const events = await pool.query(
                    `
                    SELECT problem_name, edited_at
                    FROM (
                        SELECT problem_name, edited_at
                        FROM contributions
                        WHERE user_id = $1
                          AND content_changed = true
                          AND invisible = false
                        UNION ALL
                        SELECT problem_name, edited_at
                        FROM github_contributions
                        WHERE user_id = $1
                    ) c
                    WHERE edited_at IS NOT NULL
                    ORDER BY edited_at ASC
                    `,
                    [userId]
                );

                // Cumulative score is monotonic in the cumulative counts; collapse
                // to one point per day (keeping that day's final value).
                const scoreOf = (uniq, tot) => {
                    if (uniq <= 0 || tot <= 0) return 0;
                    const s = Math.round(19 * Math.log(uniq * Math.sqrt(tot)));
                    return s < 0 ? 0 : s;
                };
                const seen = new Set();
                let edits = 0;
                const byDay = new Map();
                for (const row of events.rows) {
                    edits += 1;
                    if (row.problem_name) seen.add(row.problem_name);
                    const day = new Date(row.edited_at).toISOString().slice(0, 10);
                    byDay.set(day, {
                        date: day,
                        score: scoreOf(seen.size, edits),
                        solutions: seen.size,
                        edits,
                    });
                }
                const points = Array.from(byDay.values());

                // Each day carries that day's *finished* score, so the very first
                // point is already high — someone who made twenty edits on their
                // first day starts the line at 20, hanging in mid-air. Anchor the
                // series at zero on the day before, so it rises from the origin.
                if (points.length > 0) {
                    const anchor = new Date(`${points[0].date}T00:00:00Z`);
                    anchor.setUTCDate(anchor.getUTCDate() - 1);
                    points.unshift({
                        date: anchor.toISOString().slice(0, 10),
                        score: 0,
                        solutions: 0,
                        edits: 0,
                    });
                }

                // Rank consistent with the leaderboard ordering (score DESC).
                const rankResult = await pool.query(
                    `
                    WITH combined AS (
                        SELECT user_id, problem_name
                        FROM contributions
                        WHERE user_id IS NOT NULL
                          AND content_changed = true
                          AND invisible = false
                        UNION ALL
                        SELECT user_id, problem_name
                        FROM github_contributions
                        WHERE user_id IS NOT NULL
                    ),
                    scores AS (
                        SELECT user_id,
                               ROUND((19 * LN(COUNT(DISTINCT problem_name) * SQRT(COUNT(*))))::numeric, 0)::int AS score
                        FROM combined
                        GROUP BY user_id
                    )
                    SELECT
                        (SELECT score FROM scores WHERE user_id = $1) AS score,
                        -- astrosander (user 28) is skipped from rank numbering on the
                        -- leaderboard, so exclude them here too to keep the profile
                        -- rank/total consistent with /:lang/contributors.
                        (SELECT COUNT(*)::int FROM scores WHERE user_id <> 28) AS total,
                        (SELECT COUNT(*)::int FROM scores WHERE score > (SELECT score FROM scores WHERE user_id = $1) AND user_id <> 28) + 1 AS rank
                    `,
                    [userId]
                );
                const rankRow = rankResult.rows[0] || {};
                const last = points.length ? points[points.length - 1] : { score: 0, solutions: 0, edits: 0 };

                return {
                    points,
                    current: {
                        score: rankRow.score != null ? rankRow.score : last.score,
                        solutions: last.solutions,
                        edits: last.edits,
                        rank: rankRow.score != null ? rankRow.rank : null,
                        total: rankRow.total != null ? rankRow.total : null,
                    },
                };
            });

            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load user rating history:", error);
            res.status(500).json({ error: "Failed to load user rating history" });
        }
    });

    defineUserEndpoint("stats", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            // v4: the cache key no longer carries the viewer's session id. It used to,
            // purely so isOwnProfile and the owner-only platformOverview could live
            // inside the cached object — which meant every signed-in visitor missed the
            // cache on every profile and paid for the full query set. Both are now
            // resolved after the cache, so all viewers share one warm payload.
            const cacheKey = `user:${username}:stats:v4`;
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
                // Deliberately not read from the session: this block is shared cache.

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
                    -- Eleven, not twelve: the twelfth wrapped onto a line of its own,
                    -- which read as a layout bug rather than as a longer list.
                    LIMIT 11
                `,
                    [user.id]
                );

                let platformOverview = null;
                if (username === "astrosander") {
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
                        cvUrl: user.cv_url || null,
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
                    canShowSankey: Number(stats.edits || 0) >= 50 || username === "astrosander",
                    platformOverview,
                };
            });

            if (!payload) {
                return res.status(404).json({ error: "User not found" });
            }

            // Everything from here down depends on who is looking, so it is resolved
            // per request against the one shared cached payload above.
            const result = { ...payload };
            result.isOwnProfile = req.session.userId === payload.user.id;
            // The platform-wide numbers are the owner's own dashboard; the cache holds
            // them for astrosander's profile, but only astrosander gets to see them.
            if (result.platformOverview && !result.isOwnProfile) {
                result.platformOverview = null;
            }

            // Follow status checked outside cache (changes frequently)
            result.isFollowing = false;
            if (req.session.userId && req.session.userId !== payload.user.id) {
                const followCheck = await pool.query(
                    "SELECT id FROM user_follows WHERE follower_id = $1 AND following_id = $2",
                    [req.session.userId, payload.user.id]
                );
                result.isFollowing = followCheck.rows.length > 0;
            }

            // Presence (fresh, not cached) — respects the show_online_status
            // preference. Owners always see their own presence.
            result.presence = { lastSeenAt: null, isOnline: false, hidden: false };
            try {
                const presenceRow = await pool.query(
                    `SELECT u.last_seen_at, COALESCE(pr.show_online_status, true) AS show_online
                     FROM users u
                     LEFT JOIN user_preferences pr ON pr.user_id = u.id
                     WHERE u.id = $1`,
                    [payload.user.id]
                );
                const pRow = presenceRow.rows[0];
                if (pRow) {
                    const viewingSelf = req.session.userId === payload.user.id;
                    if (pRow.show_online || viewingSelf) {
                        result.presence.lastSeenAt = pRow.last_seen_at || null;
                        result.presence.isOnline = pRow.last_seen_at
                            ? (Date.now() - new Date(pRow.last_seen_at).getTime() <= ONLINE_WINDOW_MS)
                            : false;
                    } else {
                        result.presence.hidden = true;
                    }
                }
            } catch (_presenceErr) {
                // last_seen_at column may not exist yet (pre-migration); ignore.
            }

            // Fresh online flags for collaborator avatars. Remap to new objects so
            // we never mutate the cached payload's collaborator rows.
            if (Array.isArray(result.collaborators) && result.collaborators.length) {
                const collabOnline = await getOnlineUsernames(pool, result.collaborators.map((c) => c.username));
                result.collaborators = result.collaborators.map((c) => ({ ...c, isOnline: collabOnline.has(c.username) }));
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

    defineUserEndpoint("heatmap", async (req, res) => {
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

    defineUserEndpoint("radar", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            const lang = normalizeLang(req.query.lang);
            const structure = structureFor(lang);
            const labels = CHART_LABELS[lang];
            const payload = await withCache(`user:${username}:radar:${lang}`, async () => {
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
                    radarAxes.push({ label: labels.other, value: other });
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

    defineUserEndpoint("timeline", async (req, res) => {
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

    defineUserEndpoint("contributions", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
            const offset = (page - 1) * limit;

            // This was the one profile endpoint that hit the database on every
            // request; page 1 is what every visitor loads, so it is worth caching
            // on the same 1h clock as its neighbours.
            const payload = await withCache(`user:${username}:contributions:${page}:${limit}`, async () => {
                const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
                if (user.rows.length === 0) return null;
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
                return {
                    page,
                    limit,
                    hasNext,
                    rows: hasNext ? rows.rows.slice(0, limit) : rows.rows,
                };
            });

            if (!payload) {
                return res.status(404).json({ error: "User not found" });
            }
            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load user contributions:", error);
            res.status(500).json({ error: "Failed to load user contributions" });
        }
    });

    // Who this contributor talks to and reads, in both directions.
    //
    // "Their solutions" means every problem they have edited — solutions here are
    // collaborative, so there is no single author to attribute a like to. For a
    // prolific editor that makes the incoming lists broad by construction; the
    // counts still say who engages with their work most, which is the question.
    defineUserEndpoint("social", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();

            const payload = await withCache(`user:${username}:social`, async () => {
                const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
                if (user.rows.length === 0) return null;
                const userId = user.rows[0].id;

                // Problems this user has touched, and who else has touched each
                // problem — the two building blocks every query below reuses.
                const MINE = `
                    SELECT DISTINCT problem_name
                    FROM contributions
                    WHERE user_id = $1 AND content_changed = true AND problem_name IS NOT NULL
                    UNION
                    SELECT DISTINCT problem_name
                    FROM github_contributions
                    WHERE user_id = $1 AND problem_name IS NOT NULL
                `;
                const AUTHORS = `
                    SELECT DISTINCT problem_name, user_id
                    FROM contributions
                    WHERE user_id IS NOT NULL AND content_changed = true AND problem_name IS NOT NULL
                    UNION
                    SELECT DISTINCT problem_name, user_id
                    FROM github_contributions
                    WHERE user_id IS NOT NULL AND problem_name IS NOT NULL
                `;
                const PERSON = "u.username, u.full_name, u.profile_picture";

                const [
                    recentComments,
                    likedSolutions,
                    likedBy,
                    commentedBy,
                    likesGiven,
                    commentsGiven,
                    totals,
                ] = await Promise.all([
                    pool.query(
                        `SELECT id, problem_name, language, content, created_at
                         FROM solution_comments
                         WHERE user_id = $1 AND is_deleted = false
                         ORDER BY created_at DESC
                         LIMIT 10`,
                        [userId]
                    ),
                    pool.query(
                        `SELECT problem_name, language, created_at
                         FROM solution_likes
                         WHERE user_id = $1 AND is_like = true
                         ORDER BY created_at DESC NULLS LAST
                         LIMIT 12`,
                        [userId]
                    ),
                    pool.query(
                        `WITH mine AS (${MINE})
                         SELECT ${PERSON}, COUNT(*)::int AS count
                         FROM solution_likes sl
                         JOIN mine m ON m.problem_name = sl.problem_name
                         JOIN users u ON u.id = sl.user_id
                         WHERE sl.is_like = true AND sl.user_id <> $1
                         GROUP BY ${PERSON}
                         ORDER BY count DESC, u.username ASC
                         LIMIT 8`,
                        [userId]
                    ),
                    pool.query(
                        `WITH mine AS (${MINE})
                         SELECT ${PERSON}, COUNT(*)::int AS count
                         FROM solution_comments sc
                         JOIN mine m ON m.problem_name = sc.problem_name
                         JOIN users u ON u.id = sc.user_id
                         WHERE sc.is_deleted = false AND sc.user_id <> $1
                         GROUP BY ${PERSON}
                         ORDER BY count DESC, u.username ASC
                         LIMIT 8`,
                        [userId]
                    ),
                    pool.query(
                        `WITH liked AS (
                            SELECT DISTINCT problem_name
                            FROM solution_likes
                            WHERE user_id = $1 AND is_like = true AND problem_name IS NOT NULL
                         ), authors AS (${AUTHORS})
                         SELECT ${PERSON}, COUNT(DISTINCT a.problem_name)::int AS count
                         FROM liked l
                         JOIN authors a ON a.problem_name = l.problem_name
                         JOIN users u ON u.id = a.user_id
                         WHERE a.user_id <> $1
                         GROUP BY ${PERSON}
                         ORDER BY count DESC, u.username ASC
                         LIMIT 8`,
                        [userId]
                    ),
                    pool.query(
                        `WITH commented AS (
                            SELECT problem_name, COUNT(*)::int AS n
                            FROM solution_comments
                            WHERE user_id = $1 AND is_deleted = false AND problem_name IS NOT NULL
                            GROUP BY problem_name
                         ), authors AS (${AUTHORS})
                         SELECT ${PERSON}, SUM(c.n)::int AS count
                         FROM commented c
                         JOIN authors a ON a.problem_name = c.problem_name
                         JOIN users u ON u.id = a.user_id
                         WHERE a.user_id <> $1
                         GROUP BY ${PERSON}
                         ORDER BY count DESC, u.username ASC
                         LIMIT 8`,
                        [userId]
                    ),
                    pool.query(
                        `WITH mine AS (${MINE})
                         SELECT
                            (SELECT COUNT(*)::int FROM solution_comments
                             WHERE user_id = $1 AND is_deleted = false) AS comments_written,
                            (SELECT COUNT(*)::int FROM solution_likes
                             WHERE user_id = $1 AND is_like = true) AS likes_given,
                            (SELECT COUNT(*)::int FROM solution_comments sc
                             JOIN mine m ON m.problem_name = sc.problem_name
                             WHERE sc.is_deleted = false AND sc.user_id <> $1) AS comments_received`,
                        [userId]
                    ),
                ]);

                const person = (row) => ({
                    username: row.username,
                    fullName: row.full_name || row.username,
                    profilePicture: row.profile_picture || "/img/profile_images/Default_placeholder.svg",
                    count: Number(row.count || 0),
                });

                return {
                    recentComments: recentComments.rows.map((row) => ({
                        id: row.id,
                        problemName: row.problem_name,
                        language: row.language,
                        // The raw body can be long and carries Markdown/LaTeX; the
                        // page shows a plain-text teaser and links to the thread.
                        excerpt: String(row.content || "").replace(/\s+/g, " ").trim().slice(0, 220),
                        createdAt: row.created_at,
                    })),
                    likedSolutions: likedSolutions.rows.map((row) => ({
                        problemName: row.problem_name,
                        language: row.language,
                        createdAt: row.created_at,
                    })),
                    likedBy: likedBy.rows.map(person),
                    commentedBy: commentedBy.rows.map(person),
                    likesGiven: likesGiven.rows.map(person),
                    commentsGiven: commentsGiven.rows.map(person),
                    totals: {
                        commentsWritten: Number(totals.rows[0]?.comments_written || 0),
                        likesGiven: Number(totals.rows[0]?.likes_given || 0),
                        commentsReceived: Number(totals.rows[0]?.comments_received || 0),
                    },
                };
            });

            if (!payload) {
                return res.status(404).json({ error: "User not found" });
            }
            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load user social activity:", error);
            res.status(500).json({ error: "Failed to load user social activity" });
        }
    });

    // What a contributor's work actually amounts to, as opposed to how much of it there
    // is. Every figure here comes from data the site already accrues — page views,
    // Savchenko's own difficulty marks, edit timestamps — so nobody has to do anything
    // for their profile to say something true.
    defineUserEndpoint("impact", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            const lang = normalizeLang(req.query.lang);
            const structure = structureFor(lang);

            const payload = await withCache(`user:${username}:impact:${lang}`, async () => {
                const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
                if (user.rows.length === 0) return null;
                const userId = user.rows[0].id;

                // The problem set this person has worked on, reused by nearly every
                // query below.
                const MINE = `
                    SELECT DISTINCT problem_name
                    FROM contributions
                    WHERE user_id = $1 AND content_changed = true AND problem_name IS NOT NULL
                    UNION
                    SELECT DISTINCT problem_name
                    FROM github_contributions
                    WHERE user_id = $1 AND problem_name IS NOT NULL
                `;

                const [readership, mostRead, difficulty, bookStarred, firstSolved, solvedRows, editDays, soloLang, activity, composeTime, drafts] =
                    await Promise.all([
                        pool.query(
                            `WITH mine AS (${MINE})
                             SELECT COALESCE(SUM(pv.views), 0)::bigint AS views,
                                    COUNT(DISTINCT pv.problem_name)::int AS problems
                             FROM page_views pv JOIN mine m ON m.problem_name = pv.problem_name`,
                            [userId]
                        ),
                        pool.query(
                            `WITH mine AS (${MINE})
                             SELECT pv.problem_name, SUM(pv.views)::int AS views
                             FROM page_views pv JOIN mine m ON m.problem_name = pv.problem_name
                             GROUP BY pv.problem_name ORDER BY views DESC LIMIT 5`,
                            [userId]
                        ),
                        pool.query(
                            `WITH mine AS (${MINE})
                             SELECT COUNT(*)::int AS scored,
                                    COUNT(*) FILTER (WHERE pd.starred)::int AS starred,
                                    ROUND(AVG((pd.scores->>'local_z')::numeric), 3) AS avg_z
                             FROM problem_difficulty pd JOIN mine m ON m.problem_name = pd.problem_name`,
                            [userId]
                        ).catch(() => ({ rows: [{}] })),
                        pool.query(
                            `SELECT COUNT(*) FILTER (WHERE starred)::int AS starred FROM problem_difficulty`
                        ).catch(() => ({ rows: [{ starred: 0 }] })),
                        // Who wrote the first version of each problem. On a wiki this is
                        // the closest thing to authorship there is.
                        pool.query(
                            `WITH events AS (
                                SELECT problem_name, user_id, edited_at, id FROM contributions
                                 WHERE content_changed = true AND user_id IS NOT NULL AND problem_name IS NOT NULL
                                UNION ALL
                                SELECT problem_name, user_id, edited_at, id FROM github_contributions
                                 WHERE user_id IS NOT NULL AND problem_name IS NOT NULL
                             ), firsts AS (
                                SELECT problem_name,
                                       (ARRAY_AGG(user_id ORDER BY edited_at ASC, id ASC))[1] AS first_user
                                FROM events GROUP BY problem_name
                             )
                             SELECT COUNT(*)::int AS n FROM firsts WHERE first_user = $1`,
                            [userId]
                        ),
                        pool.query(
                            `WITH mine AS (${MINE}) SELECT problem_name FROM mine`,
                            [userId]
                        ),
                        // Distinct days with an edit, for the streak run.
                        pool.query(
                            `SELECT DISTINCT DATE(edited_at) AS d FROM (
                                SELECT edited_at FROM contributions
                                 WHERE user_id = $1 AND content_changed = true AND invisible = false
                                UNION ALL
                                SELECT edited_at FROM github_contributions WHERE user_id = $1
                             ) t WHERE edited_at IS NOT NULL ORDER BY d`,
                            [userId]
                        ),
                        // Problems they worked on that exist in one language only —
                        // an invitation rather than a statistic.
                        pool.query(
                            `WITH mine AS (${MINE}), langs AS (
                                SELECT problem_name, language FROM contributions
                                 WHERE content_changed = true AND problem_name IS NOT NULL
                                UNION
                                SELECT problem_name, language FROM github_contributions
                                 WHERE problem_name IS NOT NULL
                             )
                             SELECT l.problem_name, MIN(l.language) AS language
                             FROM langs l JOIN mine m ON m.problem_name = l.problem_name
                             GROUP BY l.problem_name HAVING COUNT(DISTINCT l.language) = 1
                             ORDER BY l.problem_name LIMIT 24`,
                            [userId]
                        ),
                        pool.query(
                            `SELECT activity_type, target_problem, target_language, created_at
                             FROM user_activities WHERE user_id = $1
                             ORDER BY created_at DESC LIMIT 12`,
                            [userId]
                        ).catch(() => ({ rows: [] })),
                        // Measured writing time, and drafts still open. Both are new
                        // (migration 050), so every pre-existing edit contributes
                        // nothing here and the totals start honest rather than guessed.
                        pool.query(
                            `SELECT COALESCE(SUM(compose_seconds), 0)::bigint AS seconds,
                                    COUNT(*) FILTER (WHERE compose_seconds IS NOT NULL)::int AS measured
                             FROM contributions WHERE user_id = $1`,
                            [userId]
                        ).catch(() => ({ rows: [{ seconds: 0, measured: 0 }] })),
                        pool.query(
                            `SELECT problem_name, language, updated_at
                             FROM solution_drafts
                             WHERE user_id = $1 AND completed_at IS NULL
                             ORDER BY updated_at DESC LIMIT 12`,
                            [userId]
                        ).catch(() => ({ rows: [] })),
                    ]);

                // Streaks: longest run of consecutive days, and whether it is still live.
                const days = editDays.rows.map((r) => new Date(r.d).toISOString().slice(0, 10));
                let longest = 0, run = 0, prev = null;
                for (const d of days) {
                    const t = Date.parse(d + "T00:00:00Z");
                    run = (prev !== null && t - prev === 86400000) ? run + 1 : 1;
                    if (run > longest) longest = run;
                    prev = t;
                }
                let current = 0;
                if (days.length) {
                    const today = Date.now();
                    const last = Date.parse(days[days.length - 1] + "T00:00:00Z");
                    const daysSince = Math.floor((today - last) / 86400000);
                    if (daysSince <= 1) {
                        current = 1;
                        for (let i = days.length - 1; i > 0; i -= 1) {
                            const a = Date.parse(days[i] + "T00:00:00Z");
                            const b = Date.parse(days[i - 1] + "T00:00:00Z");
                            if (a - b === 86400000) current += 1; else break;
                        }
                    }
                }

                // Sections this person is within touching distance of finishing. The
                // most actionable thing the profile can say, and it needs no new data.
                const solvedBySection = {};
                for (const row of solvedRows.rows) {
                    const section = sectionFromProblemName(row.problem_name);
                    if (section) solvedBySection[section] = (solvedBySection[section] || 0) + 1;
                }
                const workQueue = structure.sections
                    .map((sec) => {
                        const solved = solvedBySection[sec.number] || 0;
                        return { number: sec.number, name: sec.name, solved, total: sec.totalProblems,
                                 remaining: sec.totalProblems - solved };
                    })
                    .filter((s) => s.solved > 0 && s.remaining > 0 && s.remaining <= 3)
                    .sort((a, b) => a.remaining - b.remaining || b.solved - a.solved)
                    .slice(0, 6);

                const d = difficulty.rows[0] || {};
                return {
                    readership: {
                        views: Number(readership.rows[0]?.views || 0),
                        problems: Number(readership.rows[0]?.problems || 0),
                        top: mostRead.rows.map((r) => ({ problemName: r.problem_name, views: Number(r.views) })),
                    },
                    difficulty: {
                        scored: Number(d.scored || 0),
                        starred: Number(d.starred || 0),
                        starredInBook: Number(bookStarred.rows[0]?.starred || 0),
                        averageZ: d.avg_z != null ? Number(d.avg_z) : null,
                    },
                    firstSolved: Number(firstSolved.rows[0]?.n || 0),
                    streak: { longest, current },
                    workQueue,
                    untranslated: soloLang.rows.map((r) => ({ problemName: r.problem_name, language: r.language })),
                    composeTime: {
                        seconds: Number(composeTime.rows[0]?.seconds || 0),
                        measuredEdits: Number(composeTime.rows[0]?.measured || 0),
                    },
                    drafts: drafts.rows.map((r) => ({
                        problemName: r.problem_name,
                        language: r.language,
                        updatedAt: r.updated_at,
                    })),
                    activity: activity.rows.map((r) => ({
                        type: r.activity_type,
                        problemName: r.target_problem,
                        language: r.target_language,
                        createdAt: r.created_at,
                    })),
                };
            });

            if (!payload) return res.status(404).json({ error: "User not found" });
            res.set("Cache-Control", "public, max-age=3600");
            res.json(payload);
        } catch (error) {
            console.error("Failed to load user impact:", error);
            res.status(500).json({ error: "Failed to load user impact" });
        }
    });

    defineUserEndpoint("sankey", async (req, res) => {
        try {
            const username = String(req.params.username || "").trim();
            const chapterParam = parseInt(req.query.chapter, 10) || null;
            const lang = normalizeLang(req.query.lang);
            const structure = structureFor(lang);
            const labels = CHART_LABELS[lang];
            const cacheKey = `user:${username}:sankey:${lang}:${chapterParam || 0}`;
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

                // Chapters the user has actually solved at least one problem in.
                const sectionToChapter = {};
                for (const s of structure.sections) sectionToChapter[s.number] = s.chapter;
                const solvedChapterSet = new Set();
                for (const problemName of solvedSet) {
                    const section = sectionFromProblemName(problemName);
                    if (section == null) continue;
                    const ch = sectionToChapter[section];
                    if (ch != null) solvedChapterSet.add(ch);
                }
                const solvedChapterNumbers = chapterNumbers.filter((n) => solvedChapterSet.has(n));

                const selectedChapter = chapterParam && chapterNumbers.includes(chapterParam)
                    ? chapterParam
                    : (solvedChapterNumbers[0] || chapterNumbers[0]);

                const sectionNodes = structure.sections.filter((s) => s.chapter === selectedChapter);
                const chapterName = structure.chapters.find((c) => c.number === selectedChapter)?.name
                    || labels.chapter(selectedChapter);

                const solvedBySection = {};
                for (const problemName of solvedSet) {
                    const section = sectionFromProblemName(problemName);
                    if (!section) continue;
                    solvedBySection[section] = (solvedBySection[section] || 0) + 1;
                }

                // Nodes are addressed by position, not by name: the titles are
                // translated, and a section can legitimately share its wording with
                // the chapter it belongs to.
                const chapterIdx = 0;
                const solvedIdx = 1 + sectionNodes.length;
                const unsolvedIdx = solvedIdx + 1;
                const nodes = [
                    { name: chapterName, kind: "chapter" },
                    ...sectionNodes.map((s) => ({ name: s.name, kind: "section" })),
                    { name: labels.solved, kind: "status", status: "solved" },
                    { name: labels.unsolved, kind: "status", status: "unsolved" },
                ];

                const links = [];
                sectionNodes.forEach((section, i) => {
                    const sectionIdx = 1 + i;
                    const solved = solvedBySection[section.number] || 0;
                    const unsolved = Math.max(0, section.totalProblems - solved);
                    links.push({ source: chapterIdx, target: sectionIdx, value: section.totalProblems });
                    if (solved > 0) {
                        links.push({ source: sectionIdx, target: solvedIdx, value: solved });
                    }
                    if (unsolved > 0) {
                        links.push({ source: sectionIdx, target: unsolvedIdx, value: unsolved });
                    }
                });

                return {
                    selectedChapter,
                    chapters: structure.chapters
                        .filter((c) => solvedChapterSet.has(c.number))
                        .map((c) => ({ number: c.number, name: c.name })),
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

// Exported for tests only — the leaderboard route itself has no test database.
module.exports.selectLeaderboardRows = selectLeaderboardRows;
module.exports.countryOnLeaderboard = countryOnLeaderboard;
