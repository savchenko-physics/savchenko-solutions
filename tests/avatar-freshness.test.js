// A changed profile picture must show everywhere at once — contributorsUserMetricsApi.js
// and lib/presence.js.
//
// Guards the report of 2026-09-13. A new picture was set for Anakewit Boonkasame (@Tete):
// the file was on disk, users.profile_picture held its versioned URL, and /user/Tete still
// showed the placeholder. The picture itself was fine (tests/avatar-cache.test.js covers
// the file and its URL). The page was built from this module's in-memory cache, which had
// stored the profile, picture included, as `user:Tete:stats:v4` and serves an entry for an
// hour. Nothing ever invalidated it: only a restart, which empties the cache, made the
// picture appear. The same hour applied to every picture uploaded from the settings page,
// for everyone who looked at that person wherever this cache feeds a page — the profile's
// header, its collaborators, the people lists under a profile, the leaderboard.
//
// The fix keeps the expensive part cached (counts, rankings, who worked with whom) and
// never answers a name, a picture or an online dot from it: those are read fresh on every
// request, in the query that already fetched presence (getPeopleNow).
//
// These tests run the real route handlers against a fake pool that answers the queries
// they make, change a picture between two requests, and require the second response to
// show it, while the aggregate queries still ran once, so the cache is still a cache. The
// fake recognises each query by a fragment of its SQL and throws on anything else, so a
// rewritten query fails here loudly instead of passing by accident.
//
// Not covered: the homepage, where index.js lays the same lookup over its one-minute widget
// cache (index.js cannot be loaded without a database and a session secret); and the SQL
// itself, since there is no test database.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { getPeopleNow, DEFAULT_PROFILE_PICTURE } = require('../lib/presence');

const API_PATH = require.resolve('../contributorsUserMetricsApi');
const TETE_NEW = '/img/profile_images/2547.webp?v=1ee7381c';
const IGOR_NEW = '/img/profile_images/176.webp?v=0a1b2c3d';

// ── A database, as far as these handlers can tell ─────────────────────────────

function fakeDatabase() {
    const users = [
        { id: 2547, username: 'Tete', full_name: 'Anakewit Boonkasame', profile_picture: null,
            country_location: 'Thailand', bio: '', github: null, online: false },
        { id: 176, username: 'igor', full_name: 'Igor Kravchenko',
            profile_picture: '/img/profile_images/176.webp?v=5c648846', country_location: null, bio: '', online: true },
        { id: 2543, username: 'Valter', full_name: 'Valter Msryan',
            profile_picture: '/img/profile_images/2543.webp?v=e64aa047', country_location: 'Armenia', bio: '', online: false },
    ];
    const byName = (name) => users.find((u) => u.username === name);
    const byId = (id) => users.find((u) => u.id === id);
    // Every call returns new objects, as pg does: nothing the handlers keep can alias a row.
    const row = (u) => ({ ...u, created_at: null, last_seen_at: null, is_verified_user: false });
    const person = (u, extra) => ({ username: u.username, full_name: u.full_name, profile_picture: u.profile_picture, ...extra });

    const ran = {};
    let failFreshLookups = false;
    const count = (label) => { ran[label] = (ran[label] || 0) + 1; };

    const answers = [
        // lib/presence.js getPeopleNow: the fresh names, pictures and online dots.
        [/WHERE u\.username = ANY\(\$1\)/, (params) => {
            count('peopleNow');
            if (failFreshLookups) throw new Error('connection terminated');
            return params[0].map(byName).filter(Boolean).map((u) => person(u, { is_online: u.online }));
        }],
        // The profile's own row, per request, with its presence preference.
        [/SELECT u\.\*, COALESCE\(pr\.show_online_status, true\) AS show_online/, (params) => {
            count('profileNow');
            if (failFreshLookups) throw new Error('connection terminated');
            const u = byId(params[0]);
            return u ? [{ ...row(u), show_online: true }] : [];
        }],
        // Everything below is what the cache holds.
        [/SELECT \*\s+FROM users\s+WHERE username = \$1/, (params) => {
            count('statsUser');
            const u = byName(params[0]);
            return u ? [row(u)] : [];
        }],
        [/pair_union/, () => {
            count('statsAggregate');
            return [{ solutions: 12, edits: 30, translations: 2, likes_received: 5 }];
        }],
        [/FROM aggregated a/, (params) => {
            count('collaborators');
            return users.filter((u) => u.id !== params[0]).map((u) => person(u, { shared_problems: 3 }));
        }],
        [/SELECT id FROM users WHERE username = \$1/, (params) => {
            count('socialUser');
            const u = byName(params[0]);
            return u ? [{ id: u.id }] : [];
        }],
        [/SELECT u\.username, u\.full_name, u\.profile_picture, (COUNT|SUM)/, (params) => {
            count('socialPeople');
            return users.filter((u) => u.id !== params[0]).map((u) => person(u, { count: 4 }));
        }],
        [/AS comments_written/, () => [{ comments_written: 1, likes_given: 2, comments_received: 3 }]],
        [/SELECT id, problem_name, language, content, created_at/, () => []],
        [/SELECT problem_name, language, created_at\s+FROM solution_likes/, () => []],
        [/rank_position/, () => {
            count('leaderboard');
            return users.map((u, i) => ({
                user_id: u.id, username: u.username, full_name: u.full_name,
                profile_picture: u.profile_picture, country_location: u.country_location,
                show_country: true, created_at: null, is_verified_user: false,
                edits_total: 30 - i, unique_solutions: 10 - i, score: 100 - i, rank_position: i + 1,
            }));
        }],
        [/FROM user_follows/, () => []],
    ];

    const pool = {
        async query(sql, params = []) {
            const text = String(sql);
            const match = answers.find(([pattern]) => pattern.test(text));
            if (!match) throw new Error(`fake pool: unexpected query: ${text.trim().slice(0, 120)}`);
            return { rows: match[1](params) };
        },
    };

    return {
        pool,
        ran,
        user: byName,
        failFreshLookups(on = true) { failFreshLookups = on; },
    };
}

// A freshly loaded copy of the module, so every test starts with an empty cache, mounted
// on an app that only records its routes. Returns a function that calls a route.
function mountApi(pool) {
    delete require.cache[API_PATH];
    const register = require(API_PATH);
    const routes = new Map();
    const app = { get: (route, handler) => { routes.set(route, handler); }, locals: {} };
    register({ app, pool, baseDir: path.join(__dirname, '..') });

    return async function call(route, { params = {}, query = {}, session = {} } = {}) {
        const handler = routes.get(route);
        assert.ok(handler, `no route ${route}`);
        const res = {
            statusCode: 200,
            headers: {},
            body: undefined,
            set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
            setHeader(name, value) { return this.set(name, value); },
            status(code) { this.statusCode = code; return this; },
            // Serialised, as the wire would: a later change to anything cannot reach back
            // into a response already sent.
            json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; },
        };
        await handler({ params, query, session, headers: {} }, res);
        assert.equal(res.statusCode, 200, `${route} answered ${res.statusCode}: ${JSON.stringify(res.body)}`);
        return res;
    };
}

const STATS = '/api/user/:username/stats';
const SOCIAL = '/api/user/:username/social';
const LEADERBOARD = '/api/contributors/leaderboard';
const profileOf = (username, session = {}) => ({ params: { username }, session });
const find = (list, username) => list.find((p) => p.username === username);

// ── getPeopleNow ──────────────────────────────────────────────────────────────

test('getPeopleNow applies the fallbacks every list uses', async () => {
    const pool = { query: async () => ({ rows: [
        { username: 'Tete', full_name: null, profile_picture: null, is_online: null },
        { username: 'igor', full_name: 'Igor Kravchenko', profile_picture: '/img/profile_images/176.webp?v=1', is_online: true },
    ] }) };
    const now = await getPeopleNow(pool, ['Tete', 'igor']);
    assert.deepEqual(now.get('Tete'), { fullName: 'Tete', profilePicture: DEFAULT_PROFILE_PICTURE, isOnline: false });
    assert.deepEqual(now.get('igor'), { fullName: 'Igor Kravchenko', profilePicture: '/img/profile_images/176.webp?v=1', isOnline: true });
});

test('getPeopleNow asks once per person, and not at all for nobody', async () => {
    const asked = [];
    const pool = { query: async (_sql, params) => { asked.push(params[0]); return { rows: [] }; } };
    await getPeopleNow(pool, ['igor', 'Tete', 'igor', '', null, undefined]);
    assert.deepEqual(asked, [['igor', 'Tete']]);
    assert.equal((await getPeopleNow(pool, [])).size, 0);
    assert.equal((await getPeopleNow(pool, undefined)).size, 0);
    assert.equal(asked.length, 1);
});

test('getPeopleNow never throws: a failed query is an empty map', async () => {
    const pool = { query: async () => { throw new Error('connection terminated'); } };
    const now = await getPeopleNow(pool, ['Tete']);
    assert.equal(now.size, 0);
});

// ── A changed picture, on every page the hour-long cache feeds ─────────────────

test('the profile shows a new picture on the very next request, the case that was reported', async () => {
    const db = fakeDatabase();
    const call = mountApi(db.pool);

    const before = await call(STATS, profileOf('Tete'));
    assert.equal(before.body.user.profilePicture, DEFAULT_PROFILE_PICTURE);

    db.user('Tete').profile_picture = TETE_NEW;
    const after = await call(STATS, profileOf('Tete'));
    assert.equal(after.body.user.profilePicture, TETE_NEW);

    // And the cache still did its job: the aggregates were computed once.
    assert.equal(db.ran.statsAggregate, 1);
    assert.equal(db.ran.collaborators, 1);
    assert.equal(after.body.stats.solutions, 12);
});

test('everything else one save of the settings form changes shows at once too', async () => {
    const db = fakeDatabase();
    const call = mountApi(db.pool);
    await call(STATS, profileOf('Tete'));

    Object.assign(db.user('Tete'), {
        full_name: 'Anakewit B.', bio: 'Physics olympiad, Bangkok', country_location: 'Japan', github: 'https://github.com/tete',
    });
    const { body } = await call(STATS, profileOf('Tete'));
    assert.equal(body.user.fullName, 'Anakewit B.');
    assert.equal(body.user.bio, 'Physics olympiad, Bangkok');
    assert.equal(body.user.countryLocation, 'Japan');
    assert.equal(body.user.github, 'https://github.com/tete');
    assert.equal(db.ran.statsAggregate, 1);
});

test('a collaborator who changes their picture shows it on other people\'s profiles at once', async () => {
    const db = fakeDatabase();
    const call = mountApi(db.pool);
    await call(STATS, profileOf('Tete'));

    db.user('igor').profile_picture = IGOR_NEW;
    db.user('igor').full_name = 'Igor K.';
    const { body } = await call(STATS, profileOf('Tete'));
    const igor = find(body.collaborators, 'igor');
    assert.equal(igor.profilePicture, IGOR_NEW);
    assert.equal(igor.fullName, 'Igor K.');
    assert.equal(igor.isOnline, true); // the dot comes from the same lookup
    assert.equal(igor.sharedProblems, 3); // and the count from the cache
    assert.equal(find(body.collaborators, 'Valter').isOnline, false);
    assert.equal(db.ran.collaborators, 1);
});

test('the people lists under a profile show a new picture at once', async () => {
    const db = fakeDatabase();
    const call = mountApi(db.pool);
    await call(SOCIAL, profileOf('Tete'));

    db.user('igor').profile_picture = IGOR_NEW;
    const { body } = await call(SOCIAL, profileOf('Tete'));
    for (const list of ['likedBy', 'commentedBy', 'likesGiven', 'commentsGiven']) {
        const igor = find(body[list], 'igor');
        assert.equal(igor.profilePicture, IGOR_NEW, list);
        assert.equal(igor.count, 4, list);
    }
    assert.equal(db.ran.socialPeople, 4); // four lists, computed once each
    assert.equal(db.ran.peopleNow, 2); // one fresh lookup per request, for all four
});

test('the leaderboard shows a new picture at once', async () => {
    const db = fakeDatabase();
    const call = mountApi(db.pool);
    const before = await call(LEADERBOARD);
    assert.equal(find(before.body.rows, 'Tete').profilePicture, DEFAULT_PROFILE_PICTURE);

    db.user('Tete').profile_picture = TETE_NEW;
    const after = await call(LEADERBOARD);
    const tete = find(after.body.rows, 'Tete');
    assert.equal(tete.profilePicture, TETE_NEW);
    assert.equal(tete.score, 100); // ranking from the cache
    assert.equal(find(after.body.rows, 'igor').isOnline, true);
    assert.equal(db.ran.leaderboard, 1);
});

test('removing a picture brings the placeholder back at once', async () => {
    const db = fakeDatabase();
    const call = mountApi(db.pool);
    db.user('Tete').profile_picture = TETE_NEW;
    await call(STATS, profileOf('Tete'));
    await call(LEADERBOARD);

    db.user('Tete').profile_picture = null;
    assert.equal((await call(STATS, profileOf('Tete'))).body.user.profilePicture, DEFAULT_PROFILE_PICTURE);
    assert.equal(find((await call(LEADERBOARD)).body.rows, 'Tete').profilePicture, DEFAULT_PROFILE_PICTURE);
});

test('no response that carries people may be kept by a browser without asking', async () => {
    const db = fakeDatabase();
    const call = mountApi(db.pool);
    const responses = {
        'stats, signed out': await call(STATS, profileOf('Tete')),
        'stats, signed in': await call(STATS, profileOf('Tete', { userId: 176 })),
        'social': await call(SOCIAL, profileOf('Tete')),
        'leaderboard': await call(LEADERBOARD),
    };
    for (const [name, res] of Object.entries(responses)) {
        const cc = res.headers['cache-control'] || '';
        assert.match(cc, /no-cache/, `${name}: ${cc}`);
        assert.doesNotMatch(cc, /max-age/, `${name}: ${cc}`);
    }
    // Signed in, the answer is personal (isOwnProfile, isFollowing) and stays private.
    assert.match(responses['stats, signed in'].headers['cache-control'], /private/);
});

// ── Must never happen ─────────────────────────────────────────────────────────
// The fresh lookup sits on the busiest profile paths, so its failure modes matter as much
// as its success: it must not take a page down, invent presence, or leak into the cache.

test('a failed fresh lookup never takes a page down, and nobody shows online', async () => {
    const db = fakeDatabase();
    const call = mountApi(db.pool);
    db.failFreshLookups();

    const stats = await call(STATS, profileOf('Tete'));
    assert.equal(stats.body.user.fullName, 'Anakewit Boonkasame'); // the cached header stands in
    assert.equal(stats.body.presence.isOnline, false);
    assert.ok(stats.body.collaborators.every((c) => c.isOnline === false));

    const social = await call(SOCIAL, profileOf('Tete'));
    assert.equal(find(social.body.likedBy, 'igor').profilePicture, '/img/profile_images/176.webp?v=5c648846');

    const board = await call(LEADERBOARD);
    assert.equal(board.body.rows.length, 3);
    assert.ok(board.body.rows.every((r) => r.isOnline === false));
});

test('fresh values are laid over the cache, never written into it', async () => {
    // If a request's fresh picture were stored in the cached payload, a later request whose
    // lookup failed would still show it. It must show what the cache itself holds.
    const db = fakeDatabase();
    const call = mountApi(db.pool);
    await call(STATS, profileOf('Tete'));
    await call(LEADERBOARD);

    db.user('Tete').profile_picture = TETE_NEW;
    db.user('igor').profile_picture = IGOR_NEW;
    assert.equal((await call(STATS, profileOf('Tete'))).body.user.profilePicture, TETE_NEW);
    await call(LEADERBOARD);

    db.failFreshLookups();
    const stats = await call(STATS, profileOf('Tete'));
    assert.equal(stats.body.user.profilePicture, DEFAULT_PROFILE_PICTURE);
    assert.equal(find(stats.body.collaborators, 'igor').profilePicture, '/img/profile_images/176.webp?v=5c648846');
    assert.equal(find((await call(LEADERBOARD)).body.rows, 'Tete').profilePicture, DEFAULT_PROFILE_PICTURE);
});

test('someone renamed since the list was cached keeps their cached face, not a blank one', async () => {
    const db = fakeDatabase();
    const call = mountApi(db.pool);
    await call(STATS, profileOf('Tete'));

    db.user('igor').username = 'igor_k'; // the cached collaborator row still says "igor"
    const igor = find((await call(STATS, profileOf('Tete'))).body.collaborators, 'igor');
    assert.equal(igor.profilePicture, '/img/profile_images/176.webp?v=5c648846');
    assert.equal(igor.fullName, 'Igor Kravchenko');
});
