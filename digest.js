// digest.js: one email a week instead of one email per thing that happened.
//
// Until 2026-09-16 every notification worth an email sent one the moment it happened: three
// replies in a discussion were three emails nine minutes apart, and a follow/unfollow toggle
// was ten emails in twenty-seven seconds. Mail that arrives per event cannot be read as news;
// it can only be endured or turned off. So notifications no longer mail anything, and once a
// week this collects what happened and sends a single summary, in the shape Discourse uses.
// Immediate mail is now only what an account needs to work: reset, verify, email change.
//
// Who gets one: anyone with a verified address and email notifications on, who has personal
// news that week — a reply, a comment on a solution they wrote, a new follower, a like. Not
// having news means not getting mail; nobody is written to about an empty week. The dormant
// "we miss you" variant that Discourse also sends is deliberately off (SEND_TO_DORMANT):
// it would mean nine hundred emails a week to accounts that have never come back, which is a
// newsletter, and a decision for the owner rather than a side effect of this change.
//
// One run touches the database a handful of times, not once per person: the week's events are
// collected in four queries and grouped in memory, because almost every account has no news.
//
// Timing: Sundays at 06:00 UTC, which is 09:00 in Moscow and 11:00 in Almaty, where most
// readers are. DIGEST=off in the environment stops it without a deploy.

const fs = require('fs');
const path = require('path');
const { renderDigest } = require('./lib/digestRender');
const { sendEmail } = require('./email');
const { tokenFor } = require('./unsubscribe');
const { getMostWantedProblems } = require('./unsolved');

const ORIGIN = process.env.SITE_ORIGIN && /^https?:\/\/[^/\s?#]+$/.test(process.env.SITE_ORIGIN)
    ? process.env.SITE_ORIGIN
    : 'https://savchenkosolutions.com';

const SCHEDULE = Object.freeze({
    dayUtc: 0,        // Sunday
    hourUtc: 6,       // 06:00 UTC
    windowDays: 7,
    checkEveryMs: 15 * 60 * 1000,
    // A person gets at most one digest a week even if the process restarts inside the hour;
    // this is checked against the email_sends log, not against anything held in memory.
    minDaysBetween: 6,
});

// Off by default; see the header.
const SEND_TO_DORMANT = false;
const DORMANT_DAYS = 14;

// Gentle on SES and on the database: a short pause between sends.
const SEND_GAP_MS = 400;

const isOff = () => String(process.env.DIGEST || '').toLowerCase() === 'off';

// ── The week, for everyone ──────────────────────────────────────────────────────────────

async function collectSite(pool, { from, to }) {
    const [counters, discussions, updates] = await Promise.all([
        pool.query(
            `SELECT (SELECT count(DISTINCT problem_name) FROM contributions
                      WHERE edited_at >= $1 AND edited_at < $2 AND content_changed)::int AS solutions,
                    (SELECT count(*) FROM solution_comments
                      WHERE created_at >= $1 AND created_at < $2 AND is_deleted = false)::int AS comments,
                    (SELECT count(*) FROM users WHERE created_at >= $1 AND created_at < $2)::int AS members`,
            [from, to]
        ),
        pool.query(
            `SELECT sc.problem_name, sc.language, count(*)::int AS comments,
                    (array_agg(u.username ORDER BY sc.created_at DESC))[1] AS last_author,
                    (array_agg(sc.content ORDER BY sc.created_at DESC))[1] AS excerpt
               FROM solution_comments sc JOIN users u ON u.id = sc.user_id
              WHERE sc.created_at >= $1 AND sc.created_at < $2 AND sc.is_deleted = false
              GROUP BY 1, 2 ORDER BY comments DESC, max(sc.created_at) DESC LIMIT 4`,
            [from, to]
        ),
        // By problem, not by problem and language: a solution written in both on the same day
        // is one piece of work and reads as two lines otherwise.
        pool.query(
            `SELECT c.problem_name, array_agg(DISTINCT c.language) AS languages,
                    array_agg(DISTINCT u.username) AS authors, max(c.edited_at) AS at
               FROM contributions c JOIN users u ON u.id = c.user_id
              WHERE c.edited_at >= $1 AND c.edited_at < $2 AND c.content_changed
              GROUP BY 1 ORDER BY at DESC LIMIT 8`,
            [from, to]
        ),
    ]);

    return {
        counters: counters.rows[0],
        discussions: discussions.rows.map((r) => ({
            problem: r.problem_name,
            language: r.language,
            comments: r.comments,
            lastAuthor: r.last_author,
            excerpt: r.excerpt,
            url: `${ORIGIN}/${r.language}/${r.problem_name}`,
        })),
        updates: updates.rows.map((r) => ({
            problem: r.problem_name,
            languages: r.languages,
            authors: r.authors,
            url: `${ORIGIN}/${r.languages.includes('ru') ? 'ru' : r.languages[0]}/${r.problem_name}`,
        })),
        ...(await askForHelp(pool)),
    };
}

/** What each language has a solution for, from the files themselves. */
function writtenUp() {
    const byLang = { en: new Set(), ru: new Set() };
    for (const lang of ['en', 'ru']) {
        const dir = path.join(__dirname, 'posts', lang);
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
            if (file.endsWith('.md')) byLang[lang].add(file.replace(/\.md$/, ''));
        }
    }
    return byLang;
}

/**
 * The block that asks for something back. First choice is a problem nobody has written up,
 * ordered by how often people looked for it. There are 26 of those left out of 2,023 and none
 * of them has ever been opened, so the usual answer is the second choice: a solution that
 * exists in one language and not the other, which is the work actually waiting on this site.
 * Never fails a run.
 */
async function askForHelp(pool) {
    try {
        const written = writtenUp();
        const solved = new Set([...written.en, ...written.ru]);
        const unsolved = await getMostWantedProblems(solved, 3);
        if (unsolved.length > 0) {
            return {
                wantedKind: 'unsolved',
                wanted: unsolved.map((r) => ({ problem: r.problem_name, views: r.total_views, url: `${ORIGIN}/ru/${r.problem_name}` })),
            };
        }
        const oneLanguage = [...written.ru].filter((p) => !written.en.has(p)).map((p) => ({ problem: p, has: 'ru' }))
            .concat([...written.en].filter((p) => !written.ru.has(p)).map((p) => ({ problem: p, has: 'en' })));
        if (oneLanguage.length === 0) return { wantedKind: 'unsolved', wanted: [] };
        const views = await pool.query(
            `SELECT problem_name, SUM(views)::int AS views FROM page_views WHERE problem_name = ANY($1) GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
            [oneLanguage.map((p) => p.problem)]
        );
        const has = new Map(oneLanguage.map((p) => [p.problem, p.has]));
        return {
            wantedKind: 'translate',
            wanted: views.rows.map((r) => ({
                problem: r.problem_name,
                views: r.views,
                url: `${ORIGIN}/${has.get(r.problem_name)}/${r.problem_name}`,
            })),
        };
    } catch (err) {
        console.error('digest: the help block is unavailable:', err.message);
        return { wantedKind: 'unsolved', wanted: [] };
    }
}

// ── The week, per person ────────────────────────────────────────────────────────────────

/** Everyone's personal news for the window, in four queries, grouped by user id. */
async function collectPersonal(pool, { from, to }) {
    const byUser = new Map();
    const bucket = (id) => {
        if (!byUser.has(id)) byUser.set(id, { replies: [], onYourSolutions: [], followers: [], likes: 0 });
        return byUser.get(id);
    };

    const [replies, onSolutions, followers, likes] = await Promise.all([
        pool.query(
            `SELECT p.user_id AS owner, u.username AS author, c.problem_name, c.language, c.content, c.created_at
               FROM solution_comments c
               JOIN solution_comments p ON p.id = c.parent_id
               JOIN users u ON u.id = c.user_id
              WHERE c.created_at >= $1 AND c.created_at < $2 AND c.is_deleted = false
                AND p.user_id IS NOT NULL AND p.user_id <> c.user_id
              ORDER BY c.created_at DESC`,
            [from, to]
        ),
        // "Your solution" is the same rule the bell uses: anyone who has written on that
        // problem, from either contribution table, minus the commenter.
        pool.query(
            `SELECT DISTINCT ON (owner, c.problem_name, c.language) owners.user_id AS owner,
                    u.username AS author, c.problem_name, c.language, c.content, c.created_at
               FROM solution_comments c
               JOIN users u ON u.id = c.user_id
               JOIN (SELECT DISTINCT problem_name, user_id FROM contributions WHERE user_id IS NOT NULL
                     UNION SELECT DISTINCT problem_name, user_id FROM github_contributions WHERE user_id IS NOT NULL) owners
                 ON owners.problem_name = c.problem_name AND owners.user_id <> c.user_id
              WHERE c.created_at >= $1 AND c.created_at < $2 AND c.is_deleted = false AND c.parent_id IS NULL
              ORDER BY owner, c.problem_name, c.language, c.created_at DESC`,
            [from, to]
        ),
        pool.query(
            // DISTINCT, because following is a toggle: the same person can appear many times.
            `SELECT DISTINCT f.following_id AS owner, u.username FROM user_follows f JOIN users u ON u.id = f.follower_id
              WHERE f.created_at >= $1 AND f.created_at < $2`,
            [from, to]
        ),
        pool.query(
            `SELECT owners.user_id AS owner, count(*)::int AS likes
               FROM solution_likes l
               JOIN (SELECT DISTINCT problem_name, user_id FROM contributions WHERE user_id IS NOT NULL
                     UNION SELECT DISTINCT problem_name, user_id FROM github_contributions WHERE user_id IS NOT NULL) owners
                 ON owners.problem_name = l.problem_name AND owners.user_id <> l.user_id
              WHERE l.created_at >= $1 AND l.created_at < $2 AND l.is_like
              GROUP BY 1`,
            [from, to]
        ),
    ]);

    for (const r of replies.rows) {
        bucket(r.owner).replies.push({
            kind: 'reply', author: r.author, problem: r.problem_name, language: r.language,
            excerpt: r.content, url: `${ORIGIN}/${r.language}/${r.problem_name}`,
        });
    }
    for (const r of onSolutions.rows) {
        bucket(r.owner).onYourSolutions.push({
            kind: 'comment', author: r.author, problem: r.problem_name, language: r.language,
            excerpt: r.content, url: `${ORIGIN}/${r.language}/${r.problem_name}`,
        });
    }
    for (const r of followers.rows) {
        bucket(r.owner).followers.push({ username: r.username, url: `${ORIGIN}/user/${r.username}` });
    }
    for (const r of likes.rows) bucket(r.owner).likes = r.likes;

    return byUser;
}

/**
 * Who may be written to at all: a verified address, email notifications on, and no digest in
 * the last few days. The language is the community chat they kept unmuted at signup, which is
 * the only language signal every account has (user_preferences has 19 rows for a thousand
 * accounts, and every one of them says "en").
 */
async function candidates(pool) {
    const { rows } = await pool.query(
        `SELECT u.id, u.username, u.email, u.last_seen_at,
                CASE WHEN ru.muted IS FALSE THEN 'ru' WHEN en.muted IS FALSE THEN 'en' ELSE 'ru' END AS lang
           FROM users u
           LEFT JOIN user_preferences up ON up.user_id = u.id
           LEFT JOIN conversation_members ru ON ru.user_id = u.id
                AND ru.conversation_id = (SELECT id FROM conversations WHERE community_lang = 'ru' LIMIT 1)
           LEFT JOIN conversation_members en ON en.user_id = u.id
                AND en.conversation_id = (SELECT id FROM conversations WHERE community_lang = 'en' LIMIT 1)
          WHERE u.email IS NOT NULL AND u.email <> '' AND u.email_verified
            AND COALESCE(up.email_notifications, true)
            AND NOT EXISTS (
                SELECT 1 FROM email_sends e
                 WHERE e.user_id = u.id AND e.kind = 'digest' AND e.status IN ('sent', 'failed')
                   AND e.created_at > NOW() - make_interval(days => $1))`,
        [SCHEDULE.minDaysBetween]
    );
    return rows;
}

/** Nothing personal and no reason to write: skip. Pure, so tests/digest.test.js can check it. */
function shouldSend({ hasPersonalNews, siteHasNews, daysSinceSeen }) {
    if (hasPersonalNews) return true;
    if (!SEND_TO_DORMANT) return false;
    return siteHasNews && (daysSinceSeen == null || daysSinceSeen >= DORMANT_DAYS);
}

function digestData(user, site, personal, { from, to }) {
    return {
        lang: user.lang,
        origin: ORIGIN,
        siteUrl: `${ORIGIN}/${user.lang}`,
        settingsUrl: `${ORIGIN}/${user.lang}/settings`,
        unsubscribeUrl: `${ORIGIN}/unsubscribe?u=${user.id}&t=${tokenFor(user.id)}`,
        username: user.username,
        period: { fromISO: from.toISOString(), toISO: to.toISOString() },
        counters: site.counters,
        discussions: site.discussions,
        updates: site.updates,
        wanted: site.wanted,
        wantedKind: site.wantedKind,
        replies: personal.replies,
        onYourSolutions: personal.onYourSolutions,
        followers: personal.followers,
        likes: personal.likes,
    };
}

const EMPTY = { replies: [], onYourSolutions: [], followers: [], likes: 0 };

/**
 * Build (and, unless dryRun, send) this week's digests.
 * @returns {Promise<{window: {from: Date, to: Date}, site: object, digests: Array}>}
 */
async function runDigest(pool, { dryRun = true, onlyUser = null, now = new Date() } = {}) {
    const to = now;
    const from = new Date(to.getTime() - SCHEDULE.windowDays * 24 * 3600 * 1000);
    const [site, personalByUser, people] = await Promise.all([
        collectSite(pool, { from, to }),
        collectPersonal(pool, { from, to }),
        candidates(pool),
    ]);
    const siteHasNews = site.counters.solutions + site.counters.comments > 0;

    const digests = [];
    for (const user of people) {
        if (onlyUser && user.username !== onlyUser) continue;
        const personal = personalByUser.get(user.id) || EMPTY;
        const hasPersonalNews = personal.replies.length + personal.onYourSolutions.length
            + personal.followers.length + (personal.likes > 0 ? 1 : 0) > 0;
        const daysSinceSeen = user.last_seen_at ? (to - new Date(user.last_seen_at)) / 86400e3 : null;
        if (!onlyUser && !shouldSend({ hasPersonalNews, siteHasNews, daysSinceSeen })) continue;

        const data = digestData(user, site, personal, { from, to });
        const mail = renderDigest(data);
        digests.push({ user, data, mail, hasPersonalNews });
    }

    if (!dryRun) {
        for (const d of digests) {
            try {
                await sendEmail({
                    to: d.user.email,
                    kind: 'digest',
                    userId: d.user.id,
                    subject: d.mail.subject,
                    html: d.mail.html,
                    text: d.mail.text,
                    headers: [
                        { Name: 'List-Unsubscribe', Value: `<${d.data.unsubscribeUrl}>` },
                        { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
                    ],
                });
            } catch (err) {
                console.error(`digest: sending to ${d.user.username} failed:`, err.message);
            }
            await new Promise((r) => setTimeout(r, SEND_GAP_MS));
        }
        console.log(`digest: ${digests.length} sent for the week to ${to.toISOString().slice(0, 10)}`);
    }

    return { window: { from, to }, site, digests };
}

// ── The weekly clock ────────────────────────────────────────────────────────────────────

let timer = null;
let lastRunKey = null;

function startScheduler(pool) {
    if (isOff() || timer) return null;
    const tick = async () => {
        const now = new Date();
        if (now.getUTCDay() !== SCHEDULE.dayUtc || now.getUTCHours() !== SCHEDULE.hourUtc) return;
        const key = now.toISOString().slice(0, 10);
        if (lastRunKey === key) return;
        lastRunKey = key;
        try {
            await runDigest(pool, { dryRun: false, now });
        } catch (err) {
            console.error('digest: weekly run failed:', err);
        }
    };
    timer = setInterval(tick, SCHEDULE.checkEveryMs);
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = { runDigest, startScheduler, shouldSend, collectSite, collectPersonal, candidates, SCHEDULE, SEND_TO_DORMANT, DORMANT_DAYS, ORIGIN };
