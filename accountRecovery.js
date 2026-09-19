// accountRecovery.js: "Forgot password?", the emailed reset link, and the recovery appeal.
//
// The decisions (who gets an email, the limits, the copy) live in lib/passwordReset.js;
// read its header first. This file does the I/O around them, and holds the one part the unit
// tests cannot reach without a database: the lock that makes the email limits exact.
//
// Why a lock. A limit is "count the emails of the last hour, send if under the ceiling". Run
// as plain queries, a hundred simultaneous requests all read the same count and all send. So
// every request that can lead to an email runs in one transaction holding a transaction-scoped
// advisory lock: it counts, decides and records its outcome row, and the next request, which
// cannot count until the lock is free, sees that row. SES is called after COMMIT and after
// the response has gone, so a slow SES holds no lock, and how long the page takes does not
// depend on whether an account matched.
//
// Requests also queue in this process before they take a pool client. Otherwise a flood would
// park every pooled connection on the advisory lock and stall the whole site; this way they
// wait here, and past MAX_WAITING they are told the site is busy.
//
// The token leaves the address bar on arrival. GET /reset-password?token=… moves it into a
// cookie scoped to /reset-password and redirects to a clean URL before anything renders:
// every page loads Google Analytics and Yandex Metrica, which record the address, and a link
// followed from the page would send it on as the Referer.
//
// Not covered by tests/password-reset.test.js, because the project has no test database:
// the SQL and the lock. On 2026-09-15 the app ran against a scratch PostgreSQL 16 cluster
// with the production schema and a stand-in SES endpoint: 60 simultaneous requests for one
// account sent one email (20 queued, 40 told busy); 80 for 80 accounts sent exactly the
// hourly ceiling; 15 at once with 15 already sent that hour sent exactly 5. The whole flow,
// from the form to signing in with the new password, was also driven in Firefox and Chrome.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const i18n = require('i18n');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { sendEmail } = require('./email');
const { normalizeLang } = require('./utils');
const policy = require('./lib/passwordReset');

const { LIMITS } = policy;
const HOUR_MS = 60 * 60 * 1000;
const MAX_WAITING = 20;
const COOKIE_PATH = '/reset-password';

// The emails the limits count. Must stay the predicate of the two partial indexes in migration
// 053, which tests/password-reset.test.js checks.
const EMAILED = `outcome IN (${policy.EMAIL_OUTCOMES.map((o) => `'${o}'`).join(', ')})`;

// ── One at a time ───────────────────────────────────────────────────────────────────────

let queueTail = Promise.resolve();
let waiting = 0;

function oneAtATime(task) {
    if (waiting >= MAX_WAITING) {
        const err = new Error('account recovery queue is full');
        err.code = 'RECOVERY_BUSY';
        return Promise.reject(err);
    }
    waiting += 1;
    const run = queueTail.then(task).finally(() => {
        waiting -= 1;
    });
    queueTail = run.catch(() => {});
    return run;
}

function inRecoveryLock(pool, work) {
    return oneAtATime(async () => {
        const client = await pool.connect();
        let broken = false;
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL statement_timeout = '5s'");
            await client.query("SELECT pg_advisory_xact_lock(hashtext('savchenko:account-recovery'))");
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_rollbackErr) {
                broken = true;
            }
            throw err;
        } finally {
            client.release(broken);
        }
    });
}

// ── Queries (run inside the lock) ───────────────────────────────────────────────────────

async function siteCounts(client) {
    const { rows } = await client.query(
        `SELECT count(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS "lastHour",
                count(*)::int AS "lastDay"
           FROM password_reset_requests
          WHERE ${EMAILED} AND created_at > NOW() - INTERVAL '24 hours'`
    );
    return rows[0];
}

async function accountCounts(client, userId) {
    const { rows } = await client.query(
        `SELECT count(*)::int AS "lastDay",
                EXTRACT(EPOCH FROM NOW() - max(created_at))::float8 AS "secondsSinceLast"
           FROM password_reset_requests
          WHERE user_id = $1 AND ${EMAILED} AND created_at > NOW() - INTERVAL '24 hours'`,
        [userId]
    );
    return rows[0];
}

// Case-insensitive on both columns; lib/passwordReset.js pickAccounts chooses among the rows.
async function findAccounts(client, identifier) {
    const { rows } = await client.query(
        `SELECT id, username, email,
                lower(btrim(email)) = lower($1) AS email_match,
                email = $1 AS email_exact,
                lower(username) = lower($1) AS username_match,
                username = $1 AS username_exact
           FROM users
          WHERE lower(btrim(email)) = lower($1) OR lower(username) = lower($1)
          LIMIT 10`,
        [identifier]
    );
    return policy.pickAccounts(rows);
}

// The account's current token when it was issued within the reuse window, else a new one.
async function tokenFor(client, userId) {
    const { rows } = await client.query(
        `SELECT reset_token,
                reset_token_expires > NOW() + make_interval(hours => $2) - make_interval(mins => $3) AS reusable
           FROM users WHERE id = $1`,
        [userId, LIMITS.tokenHours, LIMITS.tokenReuseMinutes]
    );
    if (rows[0] && rows[0].reusable && policy.isResetToken(rows[0].reset_token)) return rows[0].reset_token;
    const token = crypto.randomBytes(32).toString('hex');
    await client.query(
        'UPDATE users SET reset_token = $2, reset_token_expires = NOW() + make_interval(hours => $3) WHERE id = $1',
        [userId, token, LIMITS.tokenHours]
    );
    return token;
}

async function logRequest(client, { identifier, userId, token, ip, type, note, outcome }) {
    const { rows } = await client.query(
        `INSERT INTO password_reset_requests (email, user_id, reset_token, ip_address, request_type, note, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [identifier.slice(0, 255), userId, token, String(ip || '').slice(0, 45), type, note, outcome]
    );
    return rows[0].id;
}

async function requestReset(client, { identifier, ip }) {
    const site = await siteCounts(client);
    // Checked before the lookup, so a paused site answers the same whatever was typed. No
    // row is written: during a flood the table would otherwise grow by the flood.
    if (policy.siteLimitReached(site)) return { paused: true, emails: [] };

    const accounts = await findAccounts(client, identifier);
    if (accounts.length === 0) {
        await logRequest(client, { identifier, userId: null, token: null, ip, type: 'reset', note: null, outcome: 'no_account' });
        return { paused: false, emails: [] };
    }

    const emails = [];
    for (const account of accounts) {
        const decision = policy.decideSend({ site, account: await accountCounts(client, account.id) });
        const token = decision === 'send' ? await tokenFor(client, account.id) : null;
        const outcome = decision === 'send' ? 'sent' : decision;
        const logId = await logRequest(client, { identifier, userId: account.id, token, ip, type: 'reset', note: null, outcome });
        if (decision === 'send') {
            site.lastHour += 1;
            site.lastDay += 1;
            emails.push({ logId, to: account.email, username: account.username, token, userId: account.id });
        }
    }
    return { paused: false, emails };
}

// An appeal is always recorded, since a person reads it; only the acknowledgement is limited,
// and it goes to the account's own address or nowhere.
async function fileAppeal(client, { identifier, ip, note }) {
    const site = await siteCounts(client);
    const [account] = await findAccounts(client, identifier);
    const decision = account
        ? policy.decideSend({ site, account: await accountCounts(client, account.id) })
        : 'no_account';
    const outcome = decision === 'send' ? 'sent' : decision;
    const logId = await logRequest(client, {
        identifier, userId: account ? account.id : null, token: null, ip, type: 'recovery_appeal', note: note || null, outcome,
    });
    return { emails: decision === 'send' ? [{ logId, to: account.email, username: account.username, userId: account.id }] : [] };
}

// ── After the response ──────────────────────────────────────────────────────────────────

function dispatch(pool, emails, build, kind) {
    for (const email of emails) {
        sendEmail({ to: email.to, kind, userId: email.userId, ...build(email) }).catch(async (err) => {
            console.error(`account recovery: email for request ${email.logId} failed:`, err && err.message ? err.message : err);
            try {
                await pool.query("UPDATE password_reset_requests SET outcome = 'failed' WHERE id = $1", [email.logId]);
            } catch (_err) {
                // The row keeps 'sent', which counts toward the limits exactly as 'failed' does.
            }
        });
    }
}

let lastPausedWarning = 0;
function warnPaused() {
    if (Date.now() - lastPausedWarning < 10 * 60 * 1000) return;
    lastPausedWarning = Date.now();
    console.error(`account recovery: site-wide ceiling reached (${LIMITS.emailsPerSitePerHour} an hour, ${LIMITS.emailsPerSitePerDay} a day); reset emails are paused`);
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────

function createAccountRecovery({ pool }) {
    const router = express.Router();

    const crossSite = (req) => policy.isCrossSite({
        fetchSite: req.get('sec-fetch-site'),
        origin: req.get('origin'),
        host: req.get('host'),
    });
    const origin = () => policy.linkOrigin(process.env.SITE_ORIGIN);
    const bodyLang = (req) => normalizeLang(req.body && req.body.lang);

    // The view names stay literal in the render calls: tests/site-styles.test.js finds the
    // pages to check by reading them.
    // `page` is the address the header's RU / EN link should keep: these pages say their
    // language in ?lang= and have no /en/… twin, so the site-wide rule (lib/langSwitch.js)
    // would send the switch to a /ru/forgot-password that does not exist.
    function pageLocals(res, lang, status, page, locals) {
        i18n.setLocale(res, lang);
        res.status(status).set('Cache-Control', 'no-store');
        const t = policy.copyFor(lang);
        return {
            __: i18n.__, lang, t, limits: LIMITS,
            langSwitchEnUrl: `${page}?lang=en`, langSwitchRuUrl: `${page}?lang=ru`,
            ...locals, error: locals.error ? t.errors[locals.error] : '',
        };
    }

    const renderForgot = (res, lang, { status = 200, state = 'form', error = null, identifier = '' } = {}) =>
        res.render('forgot_password', pageLocals(res, lang, status, '/forgot-password', { state, error, identifier }));
    // accountName, not username: the site header reads a local called username as the
    // signed-in person, and would show this account's avatar and bell to a signed-out visitor.
    const renderReset = (res, lang, { status = 200, state, accountName = '', error = null }) =>
        res.render('reset_password', pageLocals(res, lang, status, COOKIE_PATH, { state, accountName, error }));
    const renderRecover = (res, lang, { status = 200, state = 'form', error = null, email = '', message = '' } = {}) =>
        res.render('recover_account', pageLocals(res, lang, status, '/recover-account', { state, error, email, message }));

    // Keyed like feedback.js: ipKeyGenerator puts a whole IPv6 /56 in one bucket, since one
    // client can pick a fresh address in its /64 for every request.
    const limiter = (prefix, max, onLimit) => rateLimit({
        windowMs: HOUR_MS,
        max,
        keyGenerator: (req) => `${prefix}:${ipKeyGenerator(req.ip)}`,
        standardHeaders: true,
        legacyHeaders: false,
        handler: onLimit,
    });
    const forgotLimiter = limiter('pwreset', LIMITS.requestsPerIpPerHour,
        (req, res) => renderForgot(res, bodyLang(req), { status: 429, error: 'rate_limited' }));
    const appealLimiter = limiter('appeal', LIMITS.appealsPerIpPerHour,
        (req, res) => renderRecover(res, bodyLang(req), { status: 429, error: 'rate_limited' }));

    router.get('/forgot-password', (req, res) => renderForgot(res, normalizeLang(req.query.lang)));

    router.post('/forgot-password', forgotLimiter, async (req, res) => {
        const lang = bodyLang(req);
        // `email` is what the form posted before 2026-09-15; a page left open across the deploy still sends it.
        const typed = typeof req.body.identifier === 'string' ? req.body.identifier : req.body.email;
        const echo = typeof typed === 'string' ? typed.slice(0, LIMITS.identifierMaxLength) : '';
        if (crossSite(req)) return renderForgot(res, lang, { status: 403, error: 'cross_site', identifier: echo });
        const parsed = policy.parseIdentifier(typed);
        if (!parsed.ok) return renderForgot(res, lang, { status: 400, error: parsed.error, identifier: echo });

        let result;
        try {
            result = await inRecoveryLock(pool, (client) => requestReset(client, { identifier: parsed.value, ip: req.ip }));
        } catch (err) {
            if (err.code === 'RECOVERY_BUSY') return renderForgot(res, lang, { status: 503, error: 'busy', identifier: echo });
            console.error('forgot-password:', err);
            return renderForgot(res, lang, { status: 500, error: 'server', identifier: echo });
        }
        if (result.paused) {
            warnPaused();
            return renderForgot(res, lang, { status: 429, error: 'paused', identifier: echo });
        }

        renderForgot(res, lang, { state: 'sent' });
        dispatch(pool, result.emails, (email) => policy.buildResetEmail({
            lang,
            username: email.username,
            url: `${origin()}/reset-password?token=${email.token}&lang=${lang}`,
        }), 'password_reset');
    });

    const cookieOptions = (req) => ({
        path: COOKIE_PATH,
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        maxAge: LIMITS.tokenHours * HOUR_MS,
    });

    async function accountForToken(token) {
        if (!token) return null;
        const { rows } = await pool.query(
            'SELECT id, username FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
            [token]
        );
        return rows[0] || null;
    }

    router.get('/reset-password', async (req, res) => {
        const lang = normalizeLang(req.query.lang);
        if (req.query.token !== undefined) {
            if (policy.isResetToken(req.query.token)) res.cookie(policy.RESET_COOKIE, req.query.token, cookieOptions(req));
            else res.clearCookie(policy.RESET_COOKIE, { path: COOKIE_PATH });
            res.set('Cache-Control', 'no-store');
            return res.redirect(303, `${COOKIE_PATH}?lang=${lang}`);
        }
        try {
            const account = await accountForToken(policy.readResetCookie(req.get('cookie')));
            if (!account) return renderReset(res, lang, { state: 'invalid' });
            return renderReset(res, lang, { state: 'form', accountName: account.username });
        } catch (err) {
            console.error('reset-password:', err);
            return renderReset(res, lang, { status: 500, state: 'invalid', error: 'server' });
        }
    });

    // No origin check here: the token is a SameSite=Lax cookie, which a form on another site
    // does not carry, and without the token nothing below changes anything.
    router.post('/reset-password', async (req, res) => {
        const lang = bodyLang(req);
        try {
            const token = policy.readResetCookie(req.get('cookie'));
            const account = await accountForToken(token);
            if (!account) return renderReset(res, lang, { status: 400, state: 'invalid' });

            const problem = policy.validateNewPassword(req.body.password, req.body.confirmPassword);
            if (problem) return renderReset(res, lang, { status: 400, state: 'form', accountName: account.username, error: problem });

            const hash = await bcrypt.hash(req.body.password, 10);
            // The token is checked and consumed by one statement, so a link submitted twice at
            // once changes the password once. Opening the emailed link proved the address.
            const { rows } = await pool.query(
                `UPDATE users
                    SET password = $1, reset_token = NULL, reset_token_expires = NULL, email_verified = TRUE
                  WHERE id = $2 AND reset_token = $3 AND reset_token_expires > NOW()
                  RETURNING id, username`,
                [hash, account.id, token]
            );
            if (rows.length === 0) return renderReset(res, lang, { status: 400, state: 'invalid' });
            const user = rows[0];

            // What the admin queue shows as pending is what still needs someone.
            try {
                await pool.query(
                    `UPDATE password_reset_requests SET status = 'handled', handled_at = NOW()
                      WHERE user_id = $1 AND request_type = 'reset' AND status = 'pending'`,
                    [user.id]
                );
            } catch (err) {
                console.error('reset-password: closing the requests failed:', err);
            }

            res.clearCookie(policy.RESET_COOKIE, { path: COOKIE_PATH });
            // Signed in the way POST /login signs in, with its year-long cookie.
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.lang = lang;
            req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 365;
            return res.redirect(`/${lang}/profile`);
        } catch (err) {
            console.error('reset-password:', err);
            return renderReset(res, lang, { status: 500, state: 'invalid', error: 'server' });
        }
    });

    router.get('/recover-account', (req, res) => renderRecover(res, normalizeLang(req.query.lang)));

    router.post('/recover-account', appealLimiter, async (req, res) => {
        const lang = bodyLang(req);
        const typed = req.body.email;
        const email = typeof typed === 'string' ? typed.slice(0, LIMITS.identifierMaxLength) : '';
        const message = typeof req.body.message === 'string' ? req.body.message.trim().slice(0, 2000) : '';
        if (crossSite(req)) return renderRecover(res, lang, { status: 403, error: 'cross_site', email, message });
        const parsed = policy.parseIdentifier(typed);
        if (!parsed.ok) {
            return renderRecover(res, lang, { status: 400, error: parsed.error === 'empty' ? 'empty_email' : parsed.error, email, message });
        }

        let result;
        try {
            result = await inRecoveryLock(pool, (client) => fileAppeal(client, { identifier: parsed.value, ip: req.ip, note: message }));
        } catch (err) {
            if (err.code === 'RECOVERY_BUSY') return renderRecover(res, lang, { status: 503, error: 'busy', email, message });
            console.error('recover-account:', err);
            return renderRecover(res, lang, { status: 500, error: 'server', email, message });
        }

        renderRecover(res, lang, { state: 'received' });
        dispatch(pool, result.emails, (appeal) => policy.buildAppealEmail({
            lang,
            username: appeal.username,
            forgotUrl: `${origin()}/forgot-password?lang=${lang}`,
        }), 'appeal_ack');
    });

    return router;
}

module.exports = { createAccountRecovery };
