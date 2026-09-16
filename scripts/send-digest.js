#!/usr/bin/env node
// The weekly digest, by hand: preview it, or send this week's run now.
//
//   node scripts/send-digest.js                      # dry run: builds every digest, sends nothing
//   node scripts/send-digest.js --out /tmp/digest    # ... and writes each one as an HTML file
//   node scripts/send-digest.js --user Valter --out /tmp/digest
//   node scripts/send-digest.js --send               # really send (the scheduler does this on Sundays)
//   node scripts/send-digest.js --user astrosander --send --force   # again, ignoring "one a week"
//   node scripts/send-digest.js --send --if-due                      # the cron backstop: does
//                                                                    # nothing unless it is the
//                                                                    # scheduled minute or later
//                                                                    # on the scheduled day
//
// A dry run touches nothing: it reads the week and renders, which is also how the design is
// reviewed in a browser. --send goes through email.js, so it is logged in email_sends and a
// person who already had a digest in the last few days is skipped by digest.js itself.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { runDigest, isDue, isOff, scheduleLabel } = require('../digest');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };

// The cron runs this every hour; almost every run should cost nothing but a node start, so the
// clock and the kill switch are checked before the database is touched.
if (flag('if-due')) {
    if (isOff()) {
        console.log('digest: DIGEST=off, nothing to do');
        process.exit(0);
    }
    if (!isDue(new Date())) process.exit(0);
    console.log(`digest: due (${scheduleLabel()}), checking what is still unsent`);
}

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

(async () => {
    const send = flag('send');
    if (send && isOff()) {
        console.error('digest: DIGEST=off, refusing to send. Unset it in .env to allow sending.');
        await pool.end();
        process.exit(1);
    }
    const outDir = value('out');
    const onlyUser = value('user');
    const { window: w, site, digests, testOnly } = await runDigest(pool, { dryRun: !send, onlyUser, force: flag('force') });

    console.log(`week ${w.from.toISOString().slice(0, 10)} → ${w.to.toISOString().slice(0, 10)}`);
    console.log(`site: ${site.counters.solutions} solutions updated, ${site.counters.comments} comments, ` +
        `${site.counters.members} new members, ${site.discussions.length} discussions, ${site.wanted.length} most wanted`);
    console.table(digests.map((d) => ({
        user: d.user.username,
        lang: d.user.lang,
        replies: d.data.replies.length,
        on_your_solutions: d.data.onYourSolutions.length,
        followers: d.data.followers.length,
        likes: d.data.likes,
        subject: d.mail.subject,
    })));

    if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        for (const d of digests) {
            const file = path.join(outDir, `${d.user.username.replace(/[^\w.-]/g, '_')}.html`);
            fs.writeFileSync(file, d.mail.html);
            fs.writeFileSync(file.replace(/\.html$/, '.txt'), d.mail.text);
        }
        console.log(`wrote ${digests.length} preview(s) to ${outDir}`);
    }
    if (testOnly.length > 0) console.log(`DIGEST_TEST_ONLY: only ${testOnly.join(', ')} can receive one`);
    if (!send) console.log('dry run: nothing was sent (add --send to send)');

    await pool.end();
})().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
