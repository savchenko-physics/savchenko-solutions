#!/usr/bin/env node
// When should the weekly digest be sent, to bring the most people to the site?
//
//   node scripts/digest-best-time.js                # measure and report, change nothing
//   node scripts/digest-best-time.js --apply        # ... and write the winner to data/digest-schedule.json
//   node scripts/digest-best-time.js --days 180 --top 15
//
// The question is not "when do people open email" but "when does an email turn into a visit".
// An email opened while somebody is on a bus is a visit that never happens; an email that is at
// the top of the inbox when they sit down with physics is one that does. So the score of a send
// time t is how much of the audience is on the site over the hours after t, weighted by how
// quickly this audience actually opens what we send:
//
//     score(t) = Σ over lag L of  respond(L) · online(t + L)
//
//   online(m)   how many people are on the site at minute m of the week, from recent_views with
//               the bot user agents filtered out, and from members' own timestamps (comments,
//               edits, chat, activity). Both are normalised and averaged, because the recipients
//               are members but there are only a few dozen of them active a day, which is too
//               thin to read a minute off on its own.
//   respond(L)  how long after a send this audience opens it, from the one campaign the site has
//               sent (email_events, 308 opens): 23% inside the first hour, then a long tail.
//               Divided by online() at those same moments, so it measures responsiveness rather
//               than re-measuring the daily rhythm, and renormalised.
//
// Minutes 0 and 30 are skipped: every bulk sender in the world releases on the hour and the half
// hour, and a queue is a worse place to be than a quiet minute.
//
// The numbers move as the audience does. Re-run it every few months; --apply writes the slot and
// digest.js reads it at startup, so a new answer needs no code change.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const num = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };

const DAYS = num('days', 120);            // how far back to read the traffic
const MEMBER_DAYS = num('member-days', 180);
const TOP = num('top', 10);
const LAG_HOURS = num('lag-hours', 12);   // how long after a send an email can still pull a visit
const SMOOTH_READERS = num('smooth', 30); // ± minutes
const SMOOTH_MEMBERS = num('smooth-members', 60);
const MINUTES = 7 * 24 * 60;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Where the readers are, for the human-readable line under the winner.
const ELSEWHERE = [['Moscow', 3], ['Tbilisi', 4], ['Tashkent', 5], ['Berlin', 2]];

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const NOT_A_BOT = "user_agent IS NOT NULL AND user_agent !~* '(bot|crawler|spider|scraper|python|curl|wget|headless|monitoring|preview)'";

/** Circular moving average over the week, so Saturday night and Sunday morning are neighbours. */
function smooth(series, radius) {
    const out = new Array(series.length).fill(0);
    let sum = 0;
    for (let i = -radius; i <= radius; i += 1) sum += series[(i + series.length) % series.length];
    for (let m = 0; m < series.length; m += 1) {
        out[m] = sum / (2 * radius + 1);
        sum -= series[(m - radius + series.length) % series.length];
        sum += series[(m + radius + 1) % series.length];
    }
    return out;
}

const normalise = (a) => { const total = a.reduce((x, y) => x + y, 0) || 1; return a.map((v) => v / total); };

async function onlineProfile() {
    const readers = new Array(MINUTES).fill(0);
    const members = new Array(MINUTES).fill(0);
    const r = await pool.query(
        `SELECT (EXTRACT(DOW FROM timestamp) * 1440 + EXTRACT(HOUR FROM timestamp) * 60 + EXTRACT(MINUTE FROM timestamp))::int AS m,
                count(*)::int AS n
           FROM recent_views
          WHERE timestamp > NOW() - make_interval(days => $1) AND ${NOT_A_BOT}
          GROUP BY 1`, [DAYS]);
    for (const row of r.rows) readers[row.m] += row.n;

    const mem = await pool.query(
        `WITH e AS (
             SELECT created_at AS at FROM solution_comments WHERE created_at > NOW() - make_interval(days => $1) AND is_deleted = false AND user_id IS NOT NULL
             UNION ALL SELECT edited_at FROM contributions WHERE edited_at > NOW() - make_interval(days => $1) AND user_id IS NOT NULL
             UNION ALL SELECT created_at FROM messages WHERE created_at > NOW() - make_interval(days => $1) AND sender_id IS NOT NULL
             UNION ALL SELECT created_at FROM user_activities WHERE created_at > NOW() - make_interval(days => $1) AND user_id IS NOT NULL)
         SELECT (EXTRACT(DOW FROM at) * 1440 + EXTRACT(HOUR FROM at) * 60 + EXTRACT(MINUTE FROM at))::int AS m, count(*)::int AS n
           FROM e GROUP BY 1`, [MEMBER_DAYS]);
    for (const row of mem.rows) members[row.m] += row.n;

    const readersSmooth = normalise(smooth(readers, SMOOTH_READERS));
    const membersSmooth = normalise(smooth(members, SMOOTH_MEMBERS));
    const both = readersSmooth.map((v, i) => (v + membersSmooth[i]) / 2);
    return {
        readers: readersSmooth,
        members: membersSmooth,
        both,
        readerEvents: readers.reduce((a, b) => a + b, 0),
        memberEvents: members.reduce((a, b) => a + b, 0),
    };
}

/**
 * How this audience responds after a send, per hour of lag. Opens are divided by how busy the
 * site was at that moment, so what is left is responsiveness rather than the daily rhythm again.
 */
async function respondCurve(online) {
    const hours = new Array(LAG_HOURS + 1).fill(0);
    const { rows } = await pool.query(
        `SELECT created_at FROM email_events WHERE event = 'open' AND campaign <> '' ORDER BY created_at`);
    if (rows.length < 30) {
        console.log(`(only ${rows.length} opens on record, using a plain decay instead)`);
        for (let h = 0; h <= LAG_HOURS; h += 1) hours[h] = Math.exp(-h / 3);
        return normalise(hours);
    }
    const sentAt = new Date(rows[0].created_at);
    for (const row of rows) {
        const at = new Date(row.created_at);
        const lag = Math.floor((at - sentAt) / 3600000);
        if (lag >= 0 && lag <= LAG_HOURS) {
            const minute = (at.getUTCDay() * 1440 + at.getUTCHours() * 60 + at.getUTCMinutes()) % MINUTES;
            // Divide out how busy the site is at that moment, so the curve is responsiveness.
            hours[lag] += 1 / Math.max(online[minute], 1e-9);
        }
    }
    return normalise(hours);
}

function scoreAll(online, respond) {
    const score = new Array(MINUTES).fill(0);
    for (let t = 0; t < MINUTES; t += 1) {
        let s = 0;
        for (let h = 0; h < respond.length; h += 1) {
            // Each hour of lag is spread over its sixty minutes.
            for (let k = 0; k < 60; k += 6) s += (respond[h] / 10) * online[(t + h * 60 + k) % MINUTES];
        }
        score[t] = s;
    }
    return score;
}

const label = (m) => `${DAY_NAMES[Math.floor(m / 1440)]} ${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} UTC`;
const localTimes = (m) => ELSEWHERE.map(([city, offset]) => {
    const local = (m + offset * 60) % MINUTES;
    return `${String(Math.floor((local % 1440) / 60)).padStart(2, '0')}:${String(local % 60).padStart(2, '0')} ${city}`;
}).join(', ');

(async () => {
    const online = await onlineProfile();
    const audience = flag('readers') ? online.readers : flag('members') ? online.members : online.both;
    const respond = await respondCurve(audience);
    const score = scoreAll(audience, respond);

    const best = score.map((s, m) => ({ m, s }))
        .filter((x) => x.m % 60 !== 0 && x.m % 60 !== 30)   // the crowded minutes
        .sort((a, b) => b.s - a.s);
    const top = best.slice(0, TOP);
    const peak = top[0].s;

    console.log(`traffic: ${online.readerEvents.toLocaleString()} reader views over ${DAYS} days, ` +
        `${online.memberEvents.toLocaleString()} member events over ${MEMBER_DAYS} days`);
    console.log(`response: ${respond.map((v, h) => `${h}h ${(v * 100).toFixed(0)}%`).slice(0, 6).join('  ')}`);
    console.log('');
    console.table(top.map((x, i) => ({
        rank: i + 1,
        slot: label(x.m),
        'reach vs best': `${((x.s / peak) * 100).toFixed(1)}%`,
        elsewhere: localTimes(x.m),
    })));

    // How a slot already in use compares.
    const current = (() => {
        try {
            const { SCHEDULE } = require('../digest');
            return SCHEDULE.dayUtc * 1440 + SCHEDULE.hourUtc * 60 + SCHEDULE.minuteUtc;
        } catch (_err) { return null; }
    })();
    if (current !== null) {
        const rank = best.findIndex((x) => x.m === current) + 1;
        console.log(`in use now: ${label(current)}, ${((score[current] / peak) * 100).toFixed(1)}% of the best` +
            (rank ? `, rank ${rank} of ${best.length}` : ''));
    }

    const winner = top[0];
    if (flag('apply')) {
        const file = path.join(__dirname, '..', 'data', 'digest-schedule.json');
        const payload = {
            dayUtc: Math.floor(winner.m / 1440),
            hourUtc: Math.floor((winner.m % 1440) / 60),
            minuteUtc: winner.m % 60,
            measuredAt: new Date().toISOString(),
            note: `chosen by scripts/digest-best-time.js from ${DAYS} days of traffic; ` +
                  `${((winner.s / peak) * 100).toFixed(1)}% is the best reach found`,
        };
        fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
        console.log(`\nwrote ${file}: ${label(winner.m)} (digest.js reads it at startup)`);
    } else {
        console.log(`\nbest: ${label(winner.m)} (${localTimes(winner.m)}). --apply to use it.`);
    }
    await pool.end();
})().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
