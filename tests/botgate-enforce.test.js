// Enforcement tests for the botgate middleware itself — what actually goes out on the
// wire when a rule is switched on. botgate.test.js covers the classifier in observe
// mode; this file boots the module in enforce mode with rule 6 live, because the
// middleware reads its mode from the environment once, at load.
//
// The important cases are the deferred ones: rule 6 fires on an ABSENT header, so it is
// the one rule that gets a second look after session(). A signed-in person must come
// through it whatever their proxy strips, and that promise has to hold in the code that
// sends the response, not just in the classifier.
process.env.BOTGATE_MODE = 'enforce';
process.env.BOTGATE_ENFORCE_RULES = '2,3,4,5,6';

const test = require('node:test');
const assert = require('node:assert');
const { botgate, botgateAfterSession, CLASS } = require('../botgate');

const FARM_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// Plain Chrome always sends Sec-CH-UA on a secure origin; a fixture without it would
// describe a browser that does not exist and be (rightly) demoted for that instead.
function req({ ua = FARM_UA, lang, cookie, path = '/ru/1.1.1', session } = {}) {
    const headers = { 'user-agent': ua, 'accept-encoding': 'gzip, deflate, br, zstd' };
    if (/Chrome\/\d+/.test(ua) && !/bot|curl/i.test(ua)) {
        headers['sec-ch-ua'] = '"Not;A=Brand";v="8", "Chromium";v="145", "Google Chrome";v="145"';
    }
    if (lang !== undefined) headers['accept-language'] = lang;
    if (cookie) headers.cookie = cookie;
    return { headers, ip: '203.0.113.5', path, session };
}

function res() {
    return {
        statusCode: 200, sent: false, body: '',
        status(c) { this.statusCode = c; return this; },
        set() { return this; },
        type() { return this; },
        send(b) { this.sent = true; this.body = String(b); },
    };
}

function run(middleware, r) {
    const s = res();
    let nexted = false;
    middleware(r, s, () => { nexted = true; });
    return { res: s, nexted };
}

test('a farm request is refused before session() with the bilingual page', () => {
    const r = req();
    const { res: s, nexted } = run(botgate, r);
    assert.strictEqual(nexted, false);
    assert.strictEqual(s.statusCode, 403);
    assert.ok(s.body.includes('alex@savchenkosolutions.com'));
    assert.strictEqual(r.bot.rule, 6);
});

test('the same client with Accept-Language passes as a person', () => {
    const r = req({ lang: 'ru-RU,ru;q=0.9' });
    const { res: s, nexted } = run(botgate, r);
    assert.strictEqual(nexted, true);
    assert.strictEqual(s.sent, false);
    assert.strictEqual(r.bot.cls, CLASS.HUMAN);
});

test('the paths a misclassified person needs are never blocked', () => {
    for (const path of ['/ru/login', '/en/register', '/forgot-password', '/robots.txt', '/sitemap.xml']) {
        const { nexted } = run(botgate, req({ path }));
        assert.strictEqual(nexted, true, `${path} must stay reachable`);
    }
});

test('with our session cookie the rule-6 verdict is deferred, not applied', () => {
    const r = req({ cookie: 'connect.sid=s%3Aabc.def' });
    const { res: s, nexted } = run(botgate, r);
    assert.strictEqual(nexted, true);
    assert.strictEqual(s.sent, false);
    assert.strictEqual(r.bot.deferred, true);
});

test('MUST NEVER BLOCK: a signed-in person comes through rule 6 after session()', () => {
    const r = req({ cookie: 'connect.sid=s%3Aabc.def' });
    run(botgate, r);
    r.session = { userId: 28 };
    const { res: s, nexted } = run(botgateAfterSession, r);
    assert.strictEqual(nexted, true);
    assert.strictEqual(s.sent, false);
    assert.strictEqual(r.bot.cls, CLASS.HUMAN);
    // The near-miss stays on the record, so it can be counted.
    assert.ok(r.bot.reasons.includes('logged-in'));
    assert.ok(r.bot.reasons.includes('no-accept-language'));
});

test('a stale or forged cookie with no signed-in session is still refused', () => {
    const r = req({ cookie: 'connect.sid=s%3Aabc.def' });
    run(botgate, r);
    r.session = {};
    const { res: s, nexted } = run(botgateAfterSession, r);
    assert.strictEqual(nexted, false);
    assert.strictEqual(s.statusCode, 403);
});

test('the after-session pass is a no-op for everything that was not deferred', () => {
    const r = req({ lang: 'en-US,en;q=0.9' });
    run(botgate, r);
    const { res: s, nexted } = run(botgateAfterSession, r);
    assert.strictEqual(nexted, true);
    assert.strictEqual(s.sent, false);
    // And it never throws on a request botgate never saw.
    assert.doesNotThrow(() => run(botgateAfterSession, { headers: {}, path: '/' }));
});

test('rules 2, 3 and 5 are unchanged by the rule-6 plumbing', () => {
    const cases = [
        ['Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)', 2],
        ['curl/7.88.1', 3],
    ];
    for (const [ua, rule] of cases) {
        const r = req({ ua, lang: 'en' });
        const { res: s, nexted } = run(botgate, r);
        assert.strictEqual(nexted, false, `rule ${rule} must still block`);
        assert.strictEqual(s.statusCode, 403);
        assert.strictEqual(r.bot.rule, rule);
    }
    const r5 = req({ lang: undefined });
    r5.headers['accept-encoding'] = 'gzip,deflate,br';
    const { res: s5 } = run(botgate, r5);
    assert.strictEqual(s5.statusCode, 403);
    assert.strictEqual(r5.bot.rule, 5);
});
