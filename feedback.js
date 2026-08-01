// feedback.js: the suggestion box, the public board, and the one-question poll.
//
// Why this exists: the site had six feedback channels and none of them worked. The Google
// Form took 20 responses in 162 days. solution_reports has 63 rows, 62 of them still
// pending at a mean age of 245 days. The forum category literally named "Platform Feedback"
// contains five topics, all five written by the owner. Everything but the report prompt()
// required an account, and almost nobody who reads this site has one.
//
// Two design rules run through the whole file:
//
//   NO ACCOUNT, EVER. user_id is nullable everywhere and every write path works signed out.
//   That is not a nicety. 59% of visits never return, and a sign-in wall is precisely what
//   made every other channel here hear only from the same ten people.
//
//   CLOSURE IS THE FEATURE. Anyone can build intake. What was missing was a submitter being
//   able to see that their message arrived and what became of it. Hence public_id as an
//   instant receipt, a status that moves, and a board that shows the outcome. The failure
//   mode being fixed is a real one: a correct, formally written physics correction sat
//   unread for five months while its author, having had no acknowledgement, re-posted the
//   whole thing as a comment.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const i18n = require('i18n');
const { Pool } = require('pg');
const {
    CATEGORY_IDS,
    POLL_IDS,
    PUBLIC_STATUS_ORDER,
    getCategories,
    pickPollQuestion,
    statusLabel,
    getWidgetCopy,
    isLocked,
} = require('./feedbackQuestions');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const SECRET = (process.env.SESSION_SECRET || '').trim();

const MIN_BODY = 10;
const MAX_BODY = 4000;
const MAX_CONTACT = 200;
const MAX_FREE_TEXT = 500;
// A human who has read the prompt, chosen a category and typed a sentence cannot do it in
// under three seconds. Measured client-side as a delta on one clock, so timezone and clock
// skew are irrelevant. A determined bot can lie about it; combined with the honeypot this
// is a cheap filter, not a wall, and that is the right trade here.
const MIN_ELAPSED_MS = 3000;

// ── Validation ──────────────────────────────────────────────────────────────────────
//
// Pure, exported, and deliberately free of req/res or the pool so tests can cover it
// without a database, the same shape as brainstorm.js's link parser, and the only part of
// this module that is unit-testable at all.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TELEGRAM_RE = /^@?[A-Za-z0-9_]{4,32}$/;

function validateFeedback(input) {
    const inp = input || {};

    // The honeypot is a field positioned off-screen with no label. A person never fills it;
    // a form-filling bot fills everything it finds.
    if (typeof inp.hp === 'string' && inp.hp.trim() !== '') {
        return { ok: false, error: 'honeypot' };
    }

    if (!CATEGORY_IDS.includes(inp.category)) {
        return { ok: false, error: 'category' };
    }

    const body = typeof inp.body === 'string' ? inp.body.trim() : '';
    if (body.length < MIN_BODY) return { ok: false, error: 'too_short' };
    if (body.length > MAX_BODY) return { ok: false, error: 'too_long' };

    // Only enforced when the client reports a figure. An old browser, a blocked script or a
    // resubmitted form can all legitimately omit it, and rejecting those would turn a
    // spam heuristic into a way of silencing real people.
    if (inp.elapsedMs != null) {
        const ms = Number(inp.elapsedMs);
        if (Number.isFinite(ms) && ms >= 0 && ms < MIN_ELAPSED_MS) {
            return { ok: false, error: 'too_fast' };
        }
    }

    let contactKind = null;
    let contactValue = null;
    const rawContact = typeof inp.contactValue === 'string' ? inp.contactValue.trim() : '';
    if (rawContact) {
        if (rawContact.length > MAX_CONTACT) return { ok: false, error: 'contact' };
        if (inp.contactKind === 'email') {
            if (!EMAIL_RE.test(rawContact)) return { ok: false, error: 'contact_email' };
            contactKind = 'email';
            contactValue = rawContact;
        } else if (inp.contactKind === 'telegram') {
            if (!TELEGRAM_RE.test(rawContact)) return { ok: false, error: 'contact_telegram' };
            contactKind = 'telegram';
            // Stored with the @ so it is click-to-open in any client.
            contactValue = rawContact.startsWith('@') ? rawContact : `@${rawContact}`;
        } else {
            return { ok: false, error: 'contact_kind' };
        }
    }

    return {
        ok: true,
        value: {
            category: inp.category,
            body,
            contactKind,
            contactValue,
            // Asking to be told is meaningless with nowhere to tell, so it only sticks when
            // there is a contact or a signed-in account behind it.
            notifyOnShip: !!inp.notifyOnShip && (!!contactValue || !!inp.userId),
        },
    };
}

function validatePollAnswer(input) {
    const inp = input || {};
    if (!POLL_IDS.includes(inp.questionId)) return { ok: false, error: 'question' };

    const choice = typeof inp.choice === 'string' ? inp.choice.trim().slice(0, 64) : '';
    const freeText = typeof inp.freeText === 'string' ? inp.freeText.trim().slice(0, MAX_FREE_TEXT) : '';
    if (!choice && !freeText) return { ok: false, error: 'empty' };

    return { ok: true, value: { questionId: inp.questionId, choice: choice || null, freeText: freeText || null } };
}

// ── Identity for vote de-duplication ────────────────────────────────────────────────
//
// Members are keyed by account. Everyone else is keyed by a random id kept in their
// session, which is stable for one browser and cheap to reset by anyone determined to.
// That is accepted on purpose. The alternative, requiring an account, is not a stricter
// version of this, it is zero votes. Every gated voting feature on this site has ~no rows
// (bank_difficulty_votes 0, votes 4, user_interests 4, three of those from one person).
// The board is advisory; it informs a decision, it does not make one.
//
// `create` is the whole subtlety, and getting it wrong is a bug that shipped once already.
// Sessions are saveUninitialized:false, so a visitor who has not caused a write has NO
// session cookie and `req.sessionID` is a fresh random value on every single request,
// which made every repeat vote look like a first vote and let one browser inflate a count
// without limit. Writing `fbv` marks the session dirty, which is what makes express-session
// persist it and send the cookie.
//
// But only ever on the vote itself. Doing it while rendering the board would create a
// session row for every crawler that looks at the page, which is exactly how the session
// table previously reached 1.46M rows (see the lang middleware in index.js). Reads pass
// create:false and simply get null: nothing matches, so nothing shows as already voted.
function voterKey(req, { create = false } = {}) {
    if (req.session && req.session.userId) return `u:${req.session.userId}`;
    let id = req.session && req.session.fbv;
    if (!id) {
        if (!create || !req.session) return null;
        id = crypto.randomBytes(12).toString('base64url');
        req.session.fbv = id;
    }
    return `a:${crypto.createHmac('sha256', SECRET).update(`feedback-vote:${id}`).digest('hex').slice(0, 40)}`;
}

// Reddit's toggle rule, pulled out so it can be tested without a database: pressing the
// direction you already hold clears the vote, anything else takes that direction.
function nextVote(was, dir) {
    if (dir !== 1 && dir !== -1) return was;
    return was === dir ? 0 : dir;
}

function newPublicId() {
    return crypto.randomBytes(12).toString('base64url'); // 16 url-safe chars
}

const clip = (s, n) => (typeof s === 'string' && s ? s.slice(0, n) : null);

// ── Rate limiting ───────────────────────────────────────────────────────────────────
//
// Keyed on req.ip, which is trustworthy here because trust proxy is 1 and Caddy appends the
// peer address. NOT keyed on a constant like editSaveLimiter's `?? 'anonymous'`, which puts
// every signed-out visitor on the planet in one bucket, and signed-out visitors are the
// entire point of this feature. The global apiLimiter is no help either: it is set to
// MAX_SAFE_INTEGER and does nothing.
//
// The ceilings are loose on purpose. One Novosibirsk school sits behind a single shared NAT
// gateway and is among the most engaged audiences on the site; a limit tight enough to stop
// a determined spammer would silence a whole classroom. Turning away one real person costs
// everything, and letting a duplicate through costs nothing.
//
// ipKeyGenerator, not a bare req.ip: a single IPv6 client is normally handed an entire /64
// and can pick a fresh address per request, so keying on the literal address is no limit at
// all for the roughly half of mobile traffic that arrives over IPv6. The helper collapses
// v6 to its /56 and leaves v4 alone.
const ipKey = (prefix) => (req) => `${prefix}:${ipKeyGenerator(req.ip)}`;

const submitLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyGenerator: ipKey('fb'),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
});

const lightLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 120,
    keyGenerator: ipKey('fbl'),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
});

// ── Notifying people that their thing shipped ───────────────────────────────────────
//
// This is the half of the loop that makes the other half worth building. Called from
// admin.js when an item reaches `done`. Everyone who submitted it or voted for it and asked
// to hear about it gets told once. notified_at is what makes it once.
async function notifyShipped(itemId, notifications, sendEmail) {
    const r = await pool.query(
        `SELECT id, public_id, lang, user_id, contact_kind, contact_value, notify_on_ship,
                COALESCE(public_title, left(body, 80)) AS title, notified_at
         FROM feedback_items WHERE id = $1`,
        [itemId]
    );
    if (r.rows.length === 0) return { notified: 0 };
    const item = r.rows[0];
    if (item.notified_at) return { notified: 0, alreadyNotified: true };
    if (!item.notify_on_ship) {
        await pool.query('UPDATE feedback_items SET notified_at = now() WHERE id = $1', [itemId]);
        return { notified: 0 };
    }

    const ru = item.lang === 'ru';
    const link = `/feedback/${item.public_id}`;
    const title = ru ? 'Ваше предложение реализовано' : 'Your suggestion has shipped';
    const message = ru
        ? `«${item.title}»: сделано. Спасибо, что написали.`
        : `"${item.title}" is done. Thank you for writing in.`;

    let notified = 0;
    if (item.user_id && notifications) {
        try {
            await notifications.createNotification(item.user_id, 'feedback_update', title, message, link, null);
            notified += 1;
        } catch (err) {
            console.error('feedback notifyShipped (bell):', err);
        }
    }
    // An anonymous submitter has no bell to ring, so the address they chose to leave is the
    // only way to close the loop with them, and they are the majority.
    if (!item.user_id && item.contact_kind === 'email' && item.contact_value && sendEmail) {
        try {
            const url = `https://savchenkosolutions.com${link}`;
            await sendEmail({
                to: item.contact_value,
                subject: title,
                text: `${message}\n\n${url}`,
                html: `<p>${message}</p><p><a href="${url}">${url}</a></p>`,
            });
            notified += 1;
        } catch (err) {
            console.error('feedback notifyShipped (email):', err);
        }
    }

    await pool.query('UPDATE feedback_items SET notified_at = now() WHERE id = $1', [itemId]);
    return { notified };
}

// ── Page routes (mounted at /feedback and /:lang/feedback) ──────────────────────────

const router = express.Router({ mergeParams: true });

const langOf = (req) => (req.params.lang === 'ru' || req.session?.lang === 'ru' ? 'ru' : 'en');

// The public board. Grouped by status rather than sorted flat, so "what is being worked on"
// reads at a glance, which is the thing that persuades the next person to write in.
router.get('/', async (req, res) => {
    const lang = langOf(req);
    // The shared header partial calls __() for the site title and menu, so the locale has
    // to be set even though this page's own copy comes from feedbackQuestions.js.
    i18n.setLocale(req, lang);
    // Top by default; New matters because a score-only order permanently buries whatever
    // arrived most recently, which is exactly the thing nobody has voted on yet.
    const sort = req.query.sort === 'new' ? 'new' : 'top';
    try {
        const { rows } = await pool.query(
            `SELECT f.public_id, f.category, f.status, f.votes, f.upvotes, f.downvotes, f.base_score,
                    f.created_at, f.resolved_at, f.lang, f.body,
                    COALESCE(f.public_title, left(f.body, 120)) AS title,
                    f.public_reply,
                    COALESCE(v.value, 0) AS my_vote
             FROM feedback_items f
             LEFT JOIN feedback_votes v ON v.item_id = f.id AND v.voter_key = $1
             WHERE f.is_public
             ORDER BY ${sort === 'new' ? 'f.created_at DESC' : 'f.votes DESC, f.created_at DESC'}`,
            [voterKey(req) || '']
        );
        const groups = PUBLIC_STATUS_ORDER
            .map((status) => ({
                status,
                label: statusLabel(status, lang),
                items: rows.filter((r) => r.status === status),
            }))
            .filter((g) => g.items.length > 0);

        res.render('feedback/board', {
            __: req.__,
            lang,
            pageLang: lang,
            groups,
            sort,
            total: rows.length,
            copy: getWidgetCopy(lang),
            categories: getCategories(lang),
        });
    } catch (err) {
        console.error('feedback board error:', err);
        res.status(500).render('feedback/board', {
            __: req.__, lang, pageLang: lang, groups: [], sort: 'top', total: 0,
            copy: getWidgetCopy(lang), categories: getCategories(lang),
        });
    }
});

// One item. Doubles as the submitter's receipt: the token is unguessable, so holding the
// URL is what grants the view even before the owner has published anything.
router.get('/:publicId([A-Za-z0-9_-]{10,24})', async (req, res) => {
    const lang = langOf(req);
    i18n.setLocale(req, lang);
    try {
        const { rows } = await pool.query(
            `SELECT f.id, f.public_id, f.category, f.status, f.votes, f.upvotes, f.downvotes,
                    f.base_score, f.created_at, f.resolved_at, f.body,
                    f.is_public, f.public_title, f.public_reply, f.problem_name, f.problem_lang,
                    COALESCE(v.value, 0) AS my_vote
             FROM feedback_items f
             LEFT JOIN feedback_votes v ON v.item_id = f.id AND v.voter_key = $1
             WHERE f.public_id = $2`,
            [voterKey(req) || '', req.params.publicId]
        );
        if (rows.length === 0) {
            return res.status(404).render('404', { __: req.__, pageUrl: req.originalUrl, lang });
        }
        const item = rows[0];
        res.render('feedback/item', {
            __: req.__,
            lang,
            pageLang: lang,
            item,
            statusLabel: statusLabel(item.status, lang),
            copy: getWidgetCopy(lang),
        });
    } catch (err) {
        console.error('feedback item error:', err);
        res.status(500).render('404', { __: req.__, pageUrl: req.originalUrl, lang });
    }
});

// ── API routes (mounted at /api/feedback) ───────────────────────────────────────────

const api = express.Router();

api.post('/', submitLimiter, async (req, res) => {
    const b = req.body || {};
    const userId = req.session?.userId || null;
    const check = validateFeedback({ ...b, userId });
    if (!check.ok) {
        // A caught honeypot gets a 200 with a fake receipt. Telling a bot it was spotted
        // just teaches whoever wrote it which field to skip next time.
        if (check.error === 'honeypot') return res.json({ ok: true, publicId: newPublicId() });
        return res.status(400).json({ error: check.error });
    }
    const v = check.value;
    const lang = b.lang === 'ru' ? 'ru' : 'en';

    try {
        const publicId = newPublicId();
        const { rows } = await pool.query(
            `INSERT INTO feedback_items
                (public_id, category, body, lang, user_id, contact_kind, contact_value, notify_on_ship,
                 page_url, problem_name, problem_lang, viewport_w, user_agent, referrer, ip_address)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING public_id`,
            [
                publicId, v.category, v.body, lang, userId, v.contactKind, v.contactValue, v.notifyOnShip,
                clip(b.pageUrl, 2000),
                // Validated to the site's own problem-numbering shape so a hostile client
                // cannot write arbitrary strings into a column the admin view links from.
                /^\d{1,2}\.\d{1,2}\.\d{1,3}$/.test(b.problemName || '') ? b.problemName : null,
                b.problemLang === 'ru' || b.problemLang === 'en' ? b.problemLang : null,
                Number.isFinite(Number(b.viewportW)) ? Math.min(9999, Math.max(0, Math.trunc(Number(b.viewportW)))) : null,
                clip(req.get('user-agent'), 500),
                clip(b.referrer || req.get('referer'), 500),
                req.ip,
            ]
        );
        res.json({ ok: true, publicId: rows[0].public_id });
    } catch (err) {
        console.error('feedback submit error:', err);
        res.status(500).json({ error: 'server' });
    }
});

// Reddit's exact semantics, because they are what people already have in their fingers:
// pressing the direction you already chose clears the vote, pressing the opposite one swings
// it by two. Never an error, never a "you have already voted". A mis-click has to be
// undoable with the same button that caused it.
//
// The whole thing is one transaction against a locked row: two people voting on the same
// item at the same moment would otherwise interleave read-modify-write and lose a vote.
api.post('/:publicId([A-Za-z0-9_-]{10,24})/vote', lightLimiter, async (req, res) => {
    const dir = Number(req.body && req.body.dir);
    if (dir !== 1 && dir !== -1) return res.status(400).json({ error: 'direction' });

    const key = voterKey(req, { create: true });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const found = await client.query(
            'SELECT id, status FROM feedback_items WHERE public_id = $1 AND is_public FOR UPDATE',
            [req.params.publicId]
        );
        if (found.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'not_found' });
        }
        // Enforced here and not only hidden in the template. The buttons are gone from a
        // resolved thread, but the endpoint is open to anyone with curl.
        if (isLocked(found.rows[0].status)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'locked' });
        }
        const id = found.rows[0].id;

        const prev = await client.query(
            'SELECT value FROM feedback_votes WHERE item_id = $1 AND voter_key = $2',
            [id, key]
        );
        const was = prev.rows.length ? prev.rows[0].value : 0;
        const now = nextVote(was, dir);

        if (now === 0) {
            await client.query('DELETE FROM feedback_votes WHERE item_id = $1 AND voter_key = $2', [id, key]);
        } else if (was === 0) {
            await client.query('INSERT INTO feedback_votes (item_id, voter_key, value) VALUES ($1, $2, $3)', [id, key, now]);
        } else {
            await client.query('UPDATE feedback_votes SET value = $3 WHERE item_id = $1 AND voter_key = $2', [id, key, now]);
        }

        // Recomputed from the vote rows rather than nudged by a delta. The counters are a
        // cache, and a cache that drifts on one lost request stays wrong forever.
        //
        // base_score is added back, not overwritten. It holds the people recorded asking for
        // an item before this board existed, which have no rows here. An earlier version
        // recomputed straight over it and the first click on a seeded item deleted its whole
        // history.
        const upd = await client.query(
            `UPDATE feedback_items f SET
                 upvotes   = COALESCE(t.up, 0),
                 downvotes = COALESCE(t.down, 0),
                 votes     = f.base_score + COALESCE(t.up, 0) - COALESCE(t.down, 0)
             FROM (SELECT
                     count(*) FILTER (WHERE value = 1)  AS up,
                     count(*) FILTER (WHERE value = -1) AS down
                   FROM feedback_votes WHERE item_id = $1) t
             WHERE f.id = $1
             RETURNING f.votes, f.upvotes, f.downvotes`,
            [id]
        );
        await client.query('COMMIT');
        const r = upd.rows[0];
        res.json({ ok: true, myVote: now, votes: r.votes, upvotes: r.upvotes, downvotes: r.downvotes });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('feedback vote error:', err);
        res.status(500).json({ error: 'server' });
    } finally {
        client.release();
    }
});

// Which single question this visitor gets. The browser sends back the ids it has already
// dealt with; there is no server-side state, because the people this poll most needs to
// hear from have no account to hang state on.
api.get('/poll', lightLimiter, (req, res) => {
    const lang = req.query.lang === 'ru' ? 'ru' : 'en';
    const answered = String(req.query.answered || '').split(',').map((s) => s.trim()).filter(Boolean);
    // Round-robin on the session id rather than at random, so the queue tail is not starved
    // by luck and every question ends up with a comparable sample.
    const seed = crypto.createHash('sha256').update(req.sessionID || req.ip || 'x').digest()[0];
    res.json({ question: pickPollQuestion(lang, answered, seed) });
});

api.post('/poll', lightLimiter, async (req, res) => {
    const b = req.body || {};
    if (typeof b.hp === 'string' && b.hp.trim() !== '') return res.json({ ok: true });
    const check = validatePollAnswer(b);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const v = check.value;
    try {
        await pool.query(
            `INSERT INTO poll_answers (question_id, choice, free_text, lang, user_id, viewport_w, page_url, ip_address)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
                v.questionId, v.choice, v.freeText,
                b.lang === 'ru' ? 'ru' : 'en',
                req.session?.userId || null,
                Number.isFinite(Number(b.viewportW)) ? Math.min(9999, Math.max(0, Math.trunc(Number(b.viewportW)))) : null,
                clip(b.pageUrl, 2000),
                req.ip,
            ]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('feedback poll error:', err);
        res.status(500).json({ error: 'server' });
    }
});

module.exports = {
    router,
    api,
    pool,
    notifyShipped,
    // exported for tests
    validateFeedback,
    validatePollAnswer,
    voterKey,
    nextVote,
    MIN_BODY,
    MAX_BODY,
    MIN_ELAPSED_MS,
};
