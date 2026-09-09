// Give the avatar URLs already in the users table the ?v=<content hash> token that
// processAvatar appends to every new upload (see the cache-busting note in avatar.js).
//
//   node scripts/version-avatar-urls.js --dry-run   # report only, change nothing
//   node scripts/version-avatar-urls.js             # do it
//
// A row that still holds a bare /img/profile_images/<id>.webp is served with `no-cache`,
// so it is correct — the browser re-asks and gets the current picture — but it costs a
// conditional request per avatar per page load. With the token those files are cached for
// a year instead, and a new upload still appears instantly, because it writes a new URL.
//
// Idempotent, and the repair for drift: the token is always recomputed from the bytes on
// disk, so a file replaced by hand is fixed by running this again.

require('dotenv').config();
const { Pool } = require('pg');
const { versionedAvatarUrl } = require('../avatar');

const DRY = process.argv.includes('--dry-run');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

(async () => {
    const { rows } = await pool.query(
        // The placeholder is a constant asset shared by everyone; it needs no token.
        `SELECT id, profile_picture FROM users
         WHERE profile_picture LIKE '/img/profile_images/%'
           AND profile_picture NOT LIKE '%Default_placeholder%'
         ORDER BY id`
    );

    let updated = 0, unchanged = 0, missing = 0;
    for (const u of rows) {
        const file = u.profile_picture.split('?')[0].replace(/^.*\//, '');
        const url = versionedAvatarUrl(file);
        if (!url.includes('?v=')) {
            // The row points at a file that is not on disk. Leave it alone: `no-cache`
            // already makes it behave, and rewriting it would only hide the mismatch.
            missing++; console.log(`skip (file missing): user ${u.id} -> ${file}`);
            continue;
        }
        if (url === u.profile_picture) { unchanged++; continue; }
        if (!DRY) await pool.query('UPDATE users SET profile_picture = $1 WHERE id = $2', [url, u.id]);
        updated++;
        console.log(`${DRY ? '[dry] ' : ''}user ${u.id}: ${u.profile_picture} -> ${url}`);
    }

    console.log(`\n${DRY ? '[dry-run] ' : ''}updated=${updated} unchanged=${unchanged} missing=${missing} of ${rows.length}`);
    await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
