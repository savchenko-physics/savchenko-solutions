// tracking.js — self-hosted email open/click tracking (no SES config-set needed).
//
// Open  : the email embeds <img src="/e/o?c=<campaign>&u=<id>"> → logged on load.
// Click : program links are rewritten to /e/c?c=&u=&d=<base64url dest>&s=<hmac>
//         → logged, then 302 to the destination. The HMAC signature makes this a
//         closed redirect (only URLs the sender signed can be followed — no open
//         redirect). Events land in the `email_events` table for analysis.
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
// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// Idempotent table bootstrap (also mirrored in sql/migrations/036_email_events.sql).
(async () => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS email_events (
            id         SERIAL PRIMARY KEY,
            campaign   VARCHAR(64),
            user_id    INTEGER,
            event      VARCHAR(16) NOT NULL,
            url        TEXT,
            ip         VARCHAR(64),
            ua         VARCHAR(300),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_events_campaign ON email_events (campaign, event)`);
    } catch (err) {
        console.error('email_events init error:', err.message);
    }
})();

// Signature over a destination URL — the send script computes the identical value.
function sig(dest) {
    return crypto.createHmac('sha256', SECRET).update('track:' + dest).digest('hex').slice(0, 20);
}

async function logEvent(campaign, userId, event, url, req) {
    try {
        const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);
        const ua = String(req.headers['user-agent'] || '').slice(0, 300);
        await pool.query(
            'INSERT INTO email_events (campaign, user_id, event, url, ip, ua) VALUES ($1,$2,$3,$4,$5,$6)',
            [String(campaign || '').slice(0, 64), Number.isInteger(userId) ? userId : null, event, url ? String(url).slice(0, 2000) : null, ip, ua]
        );
    } catch (_) { /* analytics must never break the response */ }
}

// Open pixel.
router.get('/o', async (req, res) => {
    await logEvent(req.query.c, parseInt(req.query.u, 10), 'open', null, req);
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.send(PIXEL);
});

// Click redirect (signed).
router.get('/c', async (req, res) => {
    let dest = '';
    try { dest = Buffer.from(String(req.query.d || ''), 'base64url').toString('utf8'); } catch (_) { dest = ''; }
    if (!dest || !/^https?:\/\//i.test(dest) || req.query.s !== sig(dest)) {
        return res.status(400).type('text/plain').send('Invalid or expired link.');
    }
    await logEvent(req.query.c, parseInt(req.query.u, 10), 'click', dest, req);
    res.redirect(302, dest);
});

module.exports = { router, sig };
