// The one connection pool of the app. Every module used to open its own (53 of them), each
// letting a connection go after 10 s idle, pg's default; opening one again costs ~95 ms of TCP
// and TLS to RDS, against 1–2 ms for a query on a connection already open (measured on the box,
// 2026-09-19). On a site with a request every few seconds that was most of a page: a solution
// page touched five modules' pools after a quiet spell and answered in 350–530 ms, 1–40 ms of
// which was its own work. One pool, its connections kept for half an hour and two of them for
// good, and the handshake is paid a few times a day instead of a few times a page.
//
// Scripts keep their own pools: they run once and end them.
'use strict';

const { Pool } = require('pg');

const clean = (v) => String(v ?? '').trim(); // .env on the server has CRLF line endings

const pool = new Pool({
    user: clean(process.env.PG_USER),
    host: clean(process.env.PG_HOST),
    database: clean(process.env.PG_DATABASE),
    password: clean(process.env.PG_PASSWORD),
    port: Number(clean(process.env.PG_PORT)) || 5432,
    ssl: { rejectUnauthorized: clean(process.env.PG_SSL_REJECT_UNAUTHORIZED) === 'true' },
    max: 10,
    min: 2,
    idleTimeoutMillis: 30 * 60 * 1000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10 * 1000,
    application_name: 'savchenko-solutions',
});

// An idle connection the server drops (a failover, a restart of the database) surfaces here;
// without a listener the event is uncaught and takes the process down. The pool has already
// discarded that client; the next query opens a new one.
pool.on('error', (err) => {
    console.error('pg pool: idle connection lost:', err.message);
});

module.exports = pool;
