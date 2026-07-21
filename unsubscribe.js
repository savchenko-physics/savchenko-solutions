// unsubscribe.js — one-click email unsubscribe for the Practicum 2026 broadcast
// (and any future announcement email). Stateless: the link carries an HMAC token
// derived from SESSION_SECRET, so there is no token table and no login. A valid
// hit sets user_preferences.email_notifications = false for that user.
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const router = express.Router();

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const SECRET = (process.env.SESSION_SECRET || '').trim();

// Deterministic per-user token. The send script computes the same value from the
// same SESSION_SECRET, so links verify without any stored state.
function tokenFor(userId) {
    return crypto.createHmac('sha256', SECRET).update('practicum-unsub:' + userId).digest('hex').slice(0, 24);
}

function validToken(userId, t) {
    if (!t || typeof t !== 'string') return false;
    const expected = tokenFor(userId);
    if (t.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(expected));
    } catch (_) {
        return false;
    }
}

async function setUnsubscribed(userId) {
    await pool.query(
        `INSERT INTO user_preferences (user_id, email_notifications) VALUES ($1, false)
         ON CONFLICT (user_id) DO UPDATE SET email_notifications = false, updated_at = NOW()`,
        [userId]
    );
}

// RFC 8058 one-click: Gmail/Apple Mail POST here from the native "Unsubscribe"
// button (List-Unsubscribe / List-Unsubscribe-Post headers).
router.post('/', async (req, res) => {
    const u = parseInt(req.query.u, 10);
    if (!u || !validToken(u, req.query.t)) return res.status(400).end();
    try {
        await setUnsubscribed(u);
        res.status(200).end();
    } catch (err) {
        console.error('unsubscribe POST error:', err);
        res.status(500).end();
    }
});

// Manual link in the email body.
router.get('/', async (req, res) => {
    const u = parseInt(req.query.u, 10);
    if (!u || !validToken(u, req.query.t)) {
        return res.status(400).render('unsubscribe', { status: 'invalid' });
    }
    try {
        await setUnsubscribed(u);
        res.render('unsubscribe', { status: 'ok' });
    } catch (err) {
        console.error('unsubscribe GET error:', err);
        res.status(500).render('unsubscribe', { status: 'error' });
    }
});

module.exports = { router, tokenFor };
