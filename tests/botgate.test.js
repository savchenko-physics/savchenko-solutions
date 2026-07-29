// Regression tests for the bot classifier.
//
// The cases below are not invented — every User-Agent, Accept-Encoding and address here
// was captured from live production traffic on 2026-07-29. The two "must never block"
// blocks at the end are the important ones: they encode the rule that this project would
// rather let a bot through than turn away a reader.
process.env.BOTGATE_MODE = 'observe';

const test = require('node:test');
const assert = require('node:assert');
const { classify, CLASS } = require('../botgate');

// Minimal request double. botgate runs before session(), so req.session is undefined.
function req({ ua, ip = '203.0.113.5', lang = 'ru-RU,ru;q=0.9', encoding = 'gzip, deflate, br, zstd', cookie, path = '/ru/1.1.1' }) {
    const headers = { 'user-agent': ua };
    if (lang !== null) headers['accept-language'] = lang;
    if (encoding !== null) headers['accept-encoding'] = encoding;
    if (cookie) headers.cookie = cookie;
    return { headers, ip, path };
}

const FARM_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const REAL_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const REAL_FIREFOX = 'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0';

test('real browsers are classified human', () => {
    assert.strictEqual(classify(req({ ua: REAL_CHROME })).cls, CLASS.HUMAN);
    assert.strictEqual(classify(req({ ua: REAL_FIREFOX, encoding: 'gzip, deflate, br' })).cls, CLASS.HUMAN);
    // Android Chrome, as captured from a real Russian-speaking visitor.
    assert.strictEqual(classify(req({
        ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
        lang: 'ru-RU,ru;q=0.9,uk-UA;q=0.8',
    })).cls, CLASS.HUMAN);
});

test('rule 2: crawlers that name themselves are blocked', () => {
    for (const ua of [
        'Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot; help@moz.com)',
        'Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)',
        'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36',
        'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
        'Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (HTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)',
    ]) {
        const v = classify(req({ ua }));
        assert.strictEqual(v.cls, CLASS.BLOCK, `expected block for ${ua}`);
        assert.strictEqual(v.rule, 2);
    }
});

test('rule 3: clients that declare they are not a browser are blocked', () => {
    for (const ua of [
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36',
        'curl/7.88.1',
        'python-requests/2.31.0',
        'Go-http-client/1.1',
    ]) {
        assert.strictEqual(classify(req({ ua })).rule, 3, `expected rule 3 for ${ua}`);
    }
});

test('rule 5: the farm fingerprint — Chrome 145 that cannot do zstd', () => {
    const v = classify(req({ ua: FARM_UA, lang: null, encoding: 'gzip,deflate,br', ip: '43.119.100.198' }));
    assert.strictEqual(v.cls, CLASS.BLOCK);
    assert.strictEqual(v.rule, 5);
});

test('rule 5 does not fire on browsers that make no checkable claim', () => {
    // Firefox never promised zstd.
    assert.notStrictEqual(classify(req({ ua: REAL_FIREFOX, encoding: 'gzip,deflate,br' })).rule, 5);
    // Chromium forks ship zstd on their own schedules. Yandex Browser alone is ~11.5%
    // of this site's audience, so a false positive here would be expensive.
    for (const ua of [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 YaBrowser/24.10.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
    ]) {
        assert.notStrictEqual(classify(req({ ua, encoding: 'gzip,deflate,br' })).rule, 5, `must not fire on ${ua}`);
    }
    // Pre-zstd Chrome is allowed to lack zstd.
    assert.notStrictEqual(classify(req({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36', encoding: 'gzip,deflate,br' })).rule, 5);
});

test('rule 5 does not fire on proxies that downgrade Accept-Encoding wholesale', () => {
    // Real visitors were observed behind proxies normalising to "gzip,deflate" — no
    // spaces and no zstd, but also no br. Requiring br is what keeps them safe.
    const v = classify(req({ ua: REAL_CHROME, encoding: 'gzip,deflate' }));
    assert.notStrictEqual(v.rule, 5);
    assert.notStrictEqual(v.cls, CLASS.BLOCK);
});

test('missing Accept-Language is never a block, only invisibility', () => {
    // bingbot and Chrome's prefetch proxy both omit it legitimately.
    const v = classify(req({ ua: REAL_CHROME, lang: null }));
    assert.strictEqual(v.cls, CLASS.COUNT_NOTHING);
    assert.ok(v.reasons.includes('no-accept-language'));
});

test('datacenter and Tor addresses are never blocked, only uncounted', () => {
    for (const ip of ['168.144.138.49', '152.42.173.246', '45.76.155.1', '192.42.116.20', '185.220.101.10']) {
        const v = classify(req({ ua: REAL_CHROME, ip }));
        assert.notStrictEqual(v.cls, CLASS.BLOCK, `${ip} must not be blocked`);
    }
});

test('MUST NEVER BLOCK: Google One VPN carries real users', () => {
    // 162.120.128.0/17 — measured 348 hits from 117 IPs of real readers.
    const v = classify(req({ ua: REAL_CHROME, ip: '162.120.188.230' }));
    assert.strictEqual(v.cls, CLASS.HUMAN);
    // Even a request that trips every heuristic must survive from this range.
    const worst = classify(req({ ua: FARM_UA, ip: '162.120.188.230', lang: null, encoding: 'gzip,deflate,br' }));
    assert.strictEqual(worst.cls, CLASS.HUMAN);
});

test('MUST NEVER BLOCK: the Novosibirsk school NAT gateway', () => {
    // 84.237.49.x — one gateway, 10,692 visits at 3.14 pages each, 9.5% bounce: the most
    // engaged audience on the site, and the one a per-IP rule would punish hardest.
    // It shares an address, so it must never look like a single heavy client.
    const v = classify(req({ ua: REAL_CHROME, ip: '84.237.49.12' }));
    assert.strictEqual(v.cls, CLASS.HUMAN);
});

test('a session cookie is NOT proof of humanity', () => {
    // The farm drives a real rendering engine and returns cookies on 493 of 553 requests.
    // An earlier version of this classifier exempted anything with a connect.sid and
    // consequently let the whole farm through. Replaying captured traffic caught it.
    const v = classify(req({
        ua: FARM_UA, lang: null, encoding: 'gzip,deflate,br',
        ip: '47.82.201.206', cookie: 'connect.sid=s%3Aabc123',
    }));
    assert.strictEqual(v.cls, CLASS.BLOCK);
});

test('unverified search-engine claims are not blocked while DNS is still pending', () => {
    // First sight of a claimed crawler must never 403 — Googlebot cannot be made to wait
    // on our resolver.
    const v = classify(req({ ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', ip: '66.249.73.65' }));
    assert.strictEqual(v.cls, CLASS.COUNT_NOTHING);
    assert.strictEqual(v.rule, 1);
});

test('classify never throws on malformed or absent headers', () => {
    assert.doesNotThrow(() => classify({ headers: {}, ip: undefined, path: '/' }));
    assert.doesNotThrow(() => classify({ headers: { 'user-agent': '' }, ip: 'not-an-ip', path: '/' }));
    assert.doesNotThrow(() => classify({ headers: { 'user-agent': 'x'.repeat(5000) }, ip: '::ffff:1.2.3.4', path: '/' }));
});
