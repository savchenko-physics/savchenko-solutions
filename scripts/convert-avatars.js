// One-time avatar optimization: back up every existing raw profile picture, convert
// it to an optimized 320px WebP + 96px thumbnail, and point the DB at the new file.
//
//   node scripts/convert-avatars.js --dry-run   # report only, change nothing
//   node scripts/convert-avatars.js             # do it (originals go to the backup dir)
//
// Originals are copied to img/profile_images_backup/ before anything is deleted.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { processAvatar, AVATAR_DIR, RASTER_RE } = require('../avatar');

const DRY = process.argv.includes('--dry-run');
const BACKUP_DIR = path.join(__dirname, '..', 'img', 'profile_images_backup');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

(async () => {
    if (!DRY) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const { rows } = await pool.query(
        `SELECT id, profile_picture FROM users
         WHERE profile_picture LIKE '%profile_images%'
           AND profile_picture NOT LIKE '%.svg'
           AND profile_picture NOT LIKE '%.webp'
         ORDER BY id`
    );

    let done = 0, skipped = 0, failed = 0, before = 0, after = 0;
    for (const u of rows) {
        // Some legacy paths use Windows backslashes (\img\profile_images\..).
        const file = path.basename(u.profile_picture.replace(/\\/g, '/'));
        if (!RASTER_RE.test(file)) { skipped++; continue; }
        if (/^\d+\.webp$/.test(file)) { skipped++; continue; } // already optimized
        const src = path.join(AVATAR_DIR, file);
        if (!fs.existsSync(src)) { skipped++; console.log('skip (file missing):', file); continue; }

        const origSize = fs.statSync(src).size;
        if (DRY) {
            console.log(`[dry] user ${u.id}: ${file} (${(origSize / 1024).toFixed(0)}KB) -> ${u.id}.webp + _thumb`);
            before += origSize; done++;
            continue;
        }
        try {
            fs.copyFileSync(src, path.join(BACKUP_DIR, file));          // 1. backup original
            const newUrl = await processAvatar(src, u.id);             // 2. write .webp + _thumb.webp
            const mainOut = path.join(AVATAR_DIR, `${u.id}.webp`);
            const newSize = fs.statSync(mainOut).size;                 // (throws if not written)
            await pool.query('UPDATE users SET profile_picture = $1 WHERE id = $2', [newUrl, u.id]); // 3. DB
            if (path.resolve(src) !== path.resolve(mainOut)) fs.unlinkSync(src); // 4. remove original
            before += origSize; after += newSize; done++;
            console.log(`ok user ${u.id}: ${file} ${(origSize / 1024).toFixed(0)}KB -> ${(newSize / 1024).toFixed(0)}KB`);
        } catch (e) {
            failed++; console.error(`FAIL user ${u.id} (${file}):`, e.message);
        }
    }

    console.log(`\n${DRY ? '[dry-run] ' : ''}converted=${done} skipped=${skipped} failed=${failed}`);
    if (!DRY) console.log(`size: ${(before / 1024 / 1024).toFixed(2)}MB -> ${(after / 1024 / 1024).toFixed(2)}MB (saved ${((before - after) / 1024 / 1024).toFixed(2)}MB)`);
    await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
