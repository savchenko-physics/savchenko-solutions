// botgate.js — request classifier that separates people from machines.
//
// GOVERNING RULE: never block a real user. A blocked student is silent and gone; a bot
// that slips through is merely visible in the logs and costs microseconds. The asymmetry
// is total, so this module is deliberately biased toward letting things through.
//
// Concretely: NO RULE HERE BLOCKS BASED ON IP ADDRESS. Every BLOCK fires only on
// something the client *declared about itself* (a self-named crawler, an automation
// client, a search-engine claim that fails reverse DNS) or on its own headers
// contradicting each other. IP/CIDR lists are used ONLY to decide COUNT-NOTHING, which
// costs a misjudged human nothing they can perceive — the page renders identically, it
// just isn't counted and doesn't get the analytics tag.
//
// Why the address is the least trustworthy signal available on this site:
//   - 89% of "residential" IPs make exactly one request (Bright Data exit nodes),
//   - the datacenter ranges contain real users on personal VPN droplets, Google One VPN
//     and Tor,
//   - and one Novosibirsk school — the most engaged audience on the site — sits behind a
//     single shared NAT gateway.
// Any address-based block gets those wrong in both directions. Header evidence does not.
//
// HOT PATH: this middleware runs on EVERY request including static assets. Everything
// here must be regex, integer compare and Map.get. No awaits, no DB queries, no DNS.
const dns = require('node:dns').promises;
const net = require('node:net');

const CLASS = {
    HUMAN: 'human',            // normal: session, view counted, analytics tag served
    COUNT_NOTHING: 'quiet',    // served in full, but invisible to sessions/counters/analytics
    BLOCK: 'block',            // 403 with a bilingual page and a contact address
};

// ── Mode ────────────────────────────────────────────────────────────────────────────
// off      → pass-through; isCountable()/isTaggable() always true. The kill switch.
// observe  → classify and record, but never block and never suppress. Ship in this mode.
// enforce  → act on the verdict, but only for the rules named in BOTGATE_ENFORCE_RULES.
const MODE = (process.env.BOTGATE_MODE || 'observe').trim().toLowerCase();

// Which BLOCK rules are live. Enabling them one at a time (safest first, 24h apart) is
// the whole point — you should never have to choose between all-on and all-off.
const ENFORCED_RULES = new Set(
    (process.env.BOTGATE_ENFORCE_RULES || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
);

// ── Rule 2: crawlers that name themselves and send us no readers ────────────────────
// Safe to block: the client literally says "I am MJ12bot" in its own User-Agent. These
// were measured at ~14k hits/7d with zero referral value to a Russian-language physics
// site. Google/Bing/Yandex/Baidu/DuckDuckGo are deliberately NOT here — they drive ~45%
// of real acquisition.
// Kept deliberately in step with public/robots.txt — a crawler we tell to go away in one
// place and block in the other is coherent; blocking one we publicly invite is not.
//
// NOT here, on purpose: ChatGPT-User, OAI-SearchBot, PerplexityBot, Perplexity-User,
// ClaudeBot and Claude-User. Those are answer-engine fetchers, robots.txt welcomes them
// by name, and being cited by an answer engine is the point — a solution that gets quoted
// with a link is worth more than one that never gets read. GPTBot, CCBot and cohere-ai
// are a different thing: bulk training scrapers, already disallowed in robots.txt.
const FREELOADER_UA = new RegExp([
    'PetalBot', 'MJ12bot', 'DotBot', 'Babbar', 'Barkrowler', 'Bytespider', 'DataForSeoBot',
    'SemrushBot', 'AhrefsBot', 'BLEXBot', 'MauiBot', 'Amazonbot', 'meta-externalagent',
    'facebookexternalhit', 'GPTBot', 'CCBot',
    'Applebot-Extended', 'SeznamBot', 'serpstatbot', 'ImagesiftBot', 'omgili', 'Timpibot',
    'cohere-ai', 'ZoominfoBot', 'MegaIndex', 'keys-so-bot', 'NetcraftSurveyAgent',
].join('|'), 'i');

// Anything else that calls itself a bot. Kept to COUNT-NOTHING rather than BLOCK because
// this is a broad pattern and the list above is the considered one. Word boundaries
// matter: `\bbot\b` must not fire on "Cubot", a phone brand that appears in Android UAs.
const GENERIC_BOT_UA = /\b(bot|bots|crawler|spider|scraper|fetcher|monitoring)\b/i;

// ── Rule 3: clients that declare they are not a browser ─────────────────────────────
// Also safe: the UA says so. Note this will catch a contributor scripting curl/wget —
// check request_log for that pattern and add them to trusted_ips before enforcing.
const AUTOMATION_UA = new RegExp([
    'HeadlessChrome', 'PhantomJS', 'Puppeteer', 'Playwright', 'Selenium',
    'python-requests', 'python-urllib', 'aiohttp', 'httpx',
    'Go-http-client', 'curl/', 'Wget/', 'Scrapy', 'node-fetch', 'axios/', 'got/',
    'okhttp', 'Java/', 'libwww-perl', 'Apache-HttpClient', 'WinHttp', 'PostmanRuntime',
].join('|'), 'i');

// ── Rule 1/4: the search engines worth keeping, and how to prove it ─────────────────
// Forward-confirmed reverse DNS is the method Google, Bing and Yandex all document:
// PTR must end in the operator's domain, and the forward lookup of that name must
// resolve back to the same address. Verified live for all three from the prod box.
const SEARCH_ENGINES = [
    { name: 'googlebot', ua: /Googlebot|Google-InspectionTool|Storebot-Google|GoogleOther/i, domains: ['.googlebot.com', '.google.com'] },
    { name: 'bingbot', ua: /bingbot|adidxbot|BingPreview/i, domains: ['.search.msn.com'] },
    { name: 'yandex', ua: /YandexBot|YandexRenderResourcesBot|YandexImages|YandexMetrika|YandexWebmaster/i, domains: ['.yandex.ru', '.yandex.net', '.yandex.com'] },
    { name: 'applebot', ua: /Applebot(?!-Extended)/i, domains: ['.applebot.apple.com'] },
    { name: 'duckduckbot', ua: /DuckDuckBot|DuckAssistBot/i, domains: ['.duckduckgo.com'] },
    { name: 'baidu', ua: /Baiduspider/i, domains: ['.baidu.com', '.baidu.jp'] },
];

// ── Rule 5: browsers whose own headers contradict their own claims ──────────────────
// The farm sends `Accept-Encoding: gzip,deflate,br` — no spaces, no zstd — while
// advertising Sec-CH-UA "Google Chrome";v="145". Chrome has offered zstd since v123 and
// uses ", " separators. A client cannot be Chrome 145 and also not support zstd.
// Measured 317/317 precision, and being IP-independent it survives range rotation.
//
// This is deliberately narrow. We require ALL THREE conditions, because real traffic in
// the same capture included users behind proxies that normalise Accept-Encoding down to
// `gzip,deflate` (no spaces, no zstd, but ALSO no br) — those must not be caught.
const CHROME_ZSTD_MIN_VERSION = 123;
// Chromium forks ship zstd on their own timelines, and Yandex Browser alone is ~11.5% of
// this audience. Only plain Chrome makes a claim we can check.
const CHROME_FORK = /Edg\/|EdgA\/|OPR\/|SamsungBrowser|YaBrowser|Yowser|Brave|Vivaldi|CriOS|HeadlessChrome|Whale|QQBrowser|UCBrowser|MiuiBrowser|HuaweiBrowser/i;

// ── COUNT-NOTHING networks ──────────────────────────────────────────────────────────
// These NEVER produce a block. They exist so datacenter traffic stops inflating the
// counters, while a real person on a $5 VPN droplet keeps a working site.
const DATACENTER_CIDRS = [
    // Alibaba Cloud — the browser farm's core exits
    '43.119.0.0/16', '47.74.0.0/15', '47.76.0.0/14', '47.80.0.0/14', '8.208.0.0/12',
    // DigitalOcean
    '168.144.0.0/16', '152.42.0.0/16', '157.230.0.0/16', '157.245.0.0/16', '159.65.0.0/16',
    '159.223.0.0/16', '165.22.0.0/16', '178.128.0.0/16', '188.166.0.0/16', '206.189.0.0/16',
    '143.198.0.0/16', '159.89.0.0/16', '104.248.0.0/16', '167.172.0.0/16', '161.35.0.0/16',
    '68.183.0.0/16', '46.101.0.0/16', '138.68.0.0/16', '134.209.0.0/16', '142.93.0.0/16',
    '128.199.0.0/16',
    // Vultr — note 139.180 is Vultr only in its upper half
    '45.32.0.0/16', '45.76.0.0/16', '45.77.0.0/16', '64.176.0.0/16', '66.42.0.0/16',
    '149.28.0.0/16', '207.148.0.0/16', '139.180.128.0/17',
    // Huawei Cloud (PetalBot and friends)
    '42.201.192.0/20', '183.87.0.0/16', '114.119.128.0/17',
    // OVH / Hetzner
    '141.94.0.0/16', '65.108.0.0/16', '65.109.0.0/16', '65.21.0.0/16', '95.216.0.0/16',
    '135.181.0.0/16',
    // AWS ap-southeast-1 slice seen scraping (NOT all of AWS — bingbot lives in Azure)
    '47.128.0.0/18',
    // Specific GCP customer ranges observed running fixed-IP scrapers here (400-800
    // problem pages each from a single address). Deliberately enumerated rather than
    // listing 34/8 + 35/8, which are ~33.5M addresses of customer space fronting school,
    // university, corporate-VPN and mobile-carrier traffic. Even so this only ever means
    // "don't count", never "don't serve".
    '8.228.0.0/14', '34.34.0.0/16', '34.82.0.0/16', '34.83.0.0/16', '34.145.0.0/16',
    '34.169.0.0/16', '35.185.0.0/16', '35.203.0.0/16', '136.109.0.0/16',
];

const TOR_CIDRS = ['192.42.116.0/24', '185.220.100.0/22', '171.25.192.0/18', '23.129.64.0/24', '199.249.230.0/24'];

// Never demoted, never blocked, under any rule.
//
// Loopback and RFC1918 are deliberately NOT here. They look like an obvious convenience,
// but they are a bypass: the app listens on 0.0.0.0:3000 and that port is reachable from
// the internet, so a direct connection carrying `X-Forwarded-For: 127.0.0.1` resolves —
// under `trust proxy: 1` — to req.ip === '127.0.0.1'. Allowlisting loopback would hand
// every rule in this file to anyone who sends one header. Local health checks fall
// through to ordinary classification instead, and post.js skips counting them separately.
const ALWAYS_ALLOW_CIDRS = [
    '162.120.128.0/17', // "VPN by Google" (Google One VPN) — measured 348 hits/117 IPs of real users
];

// ── CIDR matching (IPv4, integer compare) ───────────────────────────────────────────
function ipToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        const o = Number(p);
        if (!Number.isInteger(o) || o < 0 || o > 255) return null;
        n = (n * 256) + o;
    }
    return n;
}

function compileCidrs(list) {
    const out = [];
    for (const cidr of list) {
        const [base, bitsRaw] = cidr.split('/');
        const baseInt = ipToInt(base);
        const bits = Number(bitsRaw);
        if (baseInt === null || !Number.isInteger(bits)) continue;
        // >>> 0 everywhere: JS bitwise ops yield a SIGNED int32, so without it every
        // network at or above 128.0.0.0 stores a negative base and can never match the
        // unsigned value computed in inCidrs(). That silently disabled most of the list
        // — including the Google One VPN allowlist — until a test caught it.
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        out.push([(baseInt & mask) >>> 0, mask]);
    }
    return out;
}

const DATACENTER = compileCidrs(DATACENTER_CIDRS);
const TOR = compileCidrs(TOR_CIDRS);
const ALWAYS_ALLOW = compileCidrs(ALWAYS_ALLOW_CIDRS);

// Node hands back IPv4-mapped addresses (::ffff:1.2.3.4) on dual-stack sockets.
function normalizeIp(raw) {
    let ip = String(raw || '').trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return net.isIPv4(ip) ? ip : null;
}

function inCidrs(ipInt, compiled) {
    if (ipInt === null) return false;
    for (const [base, mask] of compiled) {
        if ((ipInt & mask) >>> 0 === base) return true;
    }
    return false;
}

// ── Verified-crawler cache ──────────────────────────────────────────────────────────
// DNS is NEVER awaited on the request path. A first request from an unseen claimed
// crawler reads a miss and is treated as COUNT-NOTHING (never blocked) while the lookup
// runs in the background — so Googlebot is never blocked waiting on a resolver.
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFY_MAX = 5000;
const verifyCache = new Map(); // ip -> { verified: bool, engine: string, at: number }
const verifyInflight = new Set();

// If the resolver itself breaks, every real crawler starts looking unverified. Fail open.
let verifyFailures = 0;
let verifyAttempts = 0;

function verifyCrawlerAsync(ip, engine) {
    if (verifyInflight.has(ip) || verifyInflight.size > 200) return;
    verifyInflight.add(ip);
    (async () => {
        try {
            verifyAttempts++;
            const names = await dns.reverse(ip);
            const name = names.find((n) => engine.domains.some((d) => n.toLowerCase().endsWith(d)));
            let verified = false;
            if (name) {
                const forward = await dns.resolve4(name);
                verified = forward.includes(ip);
            }
            if (verifyCache.size >= VERIFY_MAX) verifyCache.clear();
            verifyCache.set(ip, { verified, engine: engine.name, at: Date.now() });
        } catch (_err) {
            // NXDOMAIN is a real answer (unverified); a resolver outage is not. We cannot
            // reliably tell them apart here, so count it and let the fail-open guard below
            // decide. Cache nothing, so we retry rather than latching a wrong verdict.
            verifyFailures++;
        } finally {
            verifyInflight.delete(ip);
        }
    })();
}

// True when reverse DNS looks broken often enough that rule 4 can no longer be trusted.
function resolverLooksBroken() {
    return verifyAttempts > 20 && verifyFailures / verifyAttempts > 0.5;
}

// ── Admin-managed IP lists (cached; never queried per request) ───────────────────────
let blockedIps = new Set();
let trustedCidrs = [];
let listsLoaded = false;

async function refreshLists(pool) {
    if (!pool) return;
    try {
        const blocked = await pool.query('SELECT ip_address FROM blocked_ips');
        blockedIps = new Set(blocked.rows.map((r) => String(r.ip_address).trim()));
    } catch (_err) { /* table may not exist yet; keep the previous value */ }
    try {
        const trusted = await pool.query('SELECT ip_address FROM trusted_ips');
        trustedCidrs = compileCidrs(trusted.rows.map((r) => {
            const v = String(r.ip_address).trim();
            return v.includes('/') ? v : `${v}/32`;
        }));
    } catch (_err) { /* table arrives with migration 037 */ }
    listsLoaded = true;
}

// ── Header consistency (rule 5) ─────────────────────────────────────────────────────
function chromeEncodingContradiction(ua, acceptEncoding) {
    if (!ua || !acceptEncoding) return false;
    if (CHROME_FORK.test(ua)) return false;            // forks ship zstd on their own schedule
    const m = /Chrome\/(\d+)/.exec(ua);
    if (!m) return false;
    if (Number(m[1]) < CHROME_ZSTD_MIN_VERSION) return false;

    const ae = acceptEncoding.toLowerCase();
    const hasZstd = ae.includes('zstd');
    const hasBr = ae.includes('br');
    // No space after a comma — real Chrome and Firefox both emit ", ".
    const noSpaceSeparators = /,[^ ]/.test(ae);

    // All three required. `br` present rules out a proxy that stripped modern encodings
    // wholesale — real users behind such proxies were observed sending plain "gzip,deflate"
    // and must not be caught here.
    return hasBr && !hasZstd && noSpaceSeparators;
}

// Chrome and every Chromium fork have sent Sec-CH-UA on secure origins since v89
// (2021). Absence, on a UA claiming a modern Chrome, means the UA string is invented.
function missingClientHints(ua, secChUa) {
    if (secChUa) return false;
    if (!/Chrome\/(\d+)/.test(ua)) return false;
    if (/Edg\/|EdgA\/|OPR\/|SamsungBrowser|YaBrowser|Yowser|CriOS|Vivaldi|Whale/i.test(ua)) return false;
    const major = Number(/Chrome\/(\d+)/.exec(ua)[1]);
    return major >= 89;
}

// A genuine Chrome older than ~v70 does not exist in 2026 — it auto-updates, and it
// could not render this site if it did. The instances seen here also carry randomised
// build numbers (Chrome/43.0.9291.1758; the real 43.x builds were 2357.x) and pair
// Chrome 43-50 with Android 8.0, which shipped two years after those releases.
function impossibleChromeVersion(ua) {
    const m = /Chrome\/(\d+)\.\d+\.(\d+)\.\d+/.exec(ua);
    if (!m) return false;
    const major = Number(m[1]);
    const build = Number(m[2]);
    if (major >= 70) return false;
    // Real pre-70 Chrome build numbers sit in the 1000-3600 band; anything above that
    // for an old major version was generated, not shipped.
    return build > 3800 || major <= 60;
}

// ── The classifier ──────────────────────────────────────────────────────────────────
// Rules in order; first match wins. Ordering is load-bearing: verified-crawler checks
// MUST precede the Accept-Language rule, because bingbot and Amazonbot omit that header.
function classify(req) {
    const reasons = [];
    const ua = req.headers['user-agent'] || '';
    const ip = normalizeIp(req.ip);
    const ipInt = ip ? ipToInt(ip) : null;

    // Rule 0 — nothing below can demote or block these.
    if (req.session && req.session.userId) {
        return { cls: CLASS.HUMAN, rule: 0, reasons: ['logged-in'] };
    }
    if (inCidrs(ipInt, ALWAYS_ALLOW) || inCidrs(ipInt, trustedCidrs)) {
        return { cls: CLASS.HUMAN, rule: 0, reasons: ['allowlisted'] };
    }
    // NOTE: presence of a `connect.sid` cookie is deliberately NOT an exemption. It was,
    // briefly, and replaying real captured traffic through this classifier showed it
    // swallowing the entire browser farm — 493 of 553 of its requests carry cookies,
    // because it drives a real rendering engine with a real cookie jar. A cookie proves
    // the client has storage, not that it is a person.
    //
    // Being logged in is a genuine exemption, but this middleware runs before session()
    // so `req.session` is normally undefined here; the check below only matters if the
    // mount point ever moves. That is acceptable: every BLOCK rule fires on
    // self-declaration or self-contradiction, and a signed-in reader does not put
    // "MJ12bot" or "curl/" in their User-Agent.

    // Manual admin block — an explicit human decision, one address at a time.
    if (ip && blockedIps.has(ip)) {
        return { cls: CLASS.BLOCK, rule: 'admin', reasons: ['blocked_ips'] };
    }

    // Rules 1 and 4 — a search-engine claim, checked against reverse DNS.
    for (const engine of SEARCH_ENGINES) {
        if (!engine.ua.test(ua)) continue;
        const hit = ip ? verifyCache.get(ip) : null;
        if (hit && Date.now() - hit.at < VERIFY_TTL_MS) {
            if (hit.verified) return { cls: CLASS.COUNT_NOTHING, rule: 1, reasons: [`verified:${engine.name}`] };
            if (resolverLooksBroken()) {
                return { cls: CLASS.COUNT_NOTHING, rule: 1, reasons: [`unverified:${engine.name}`, 'resolver-degraded-fail-open'] };
            }
            return { cls: CLASS.BLOCK, rule: 4, reasons: [`spoofed:${engine.name}`] };
        }
        // Cache miss: kick off the lookup and let this request through uncounted.
        if (ip) verifyCrawlerAsync(ip, engine);
        return { cls: CLASS.COUNT_NOTHING, rule: 1, reasons: [`pending-verify:${engine.name}`] };
    }

    // Rule 2 — it named itself as a crawler we don't want.
    if (FREELOADER_UA.test(ua)) {
        return { cls: CLASS.BLOCK, rule: 2, reasons: ['self-declared-crawler'] };
    }

    // Rule 3 — it named itself as something other than a browser.
    if (AUTOMATION_UA.test(ua)) {
        return { cls: CLASS.BLOCK, rule: 3, reasons: ['automation-client'] };
    }

    // Rule 5 — its own headers contradict its own claim.
    if (chromeEncodingContradiction(ua, req.headers['accept-encoding'])) {
        return { cls: CLASS.BLOCK, rule: 5, reasons: ['ua-encoding-contradiction'] };
    }

    // ── Below here, nothing blocks. Only visibility is affected. ──
    if (GENERIC_BOT_UA.test(ua)) reasons.push('self-declared-bot');
    // Chrome has sent Sec-CH-UA on every secure origin since v89, so a UA claiming a
    // modern Chrome without it is a forged string. Demote only, never block: a few
    // privacy builds strip client hints, and being uncounted costs such a reader nothing.
    if (missingClientHints(ua, req.headers['sec-ch-ua'])) reasons.push('no-client-hints');
    // Chrome auto-updates. A 2015-era version number in 2026 is a UA randomiser, and the
    // ones seen here pair impossible build numbers (Chrome/43.0.9291.1758) with an
    // Android release that postdates the browser by two years.
    if (impossibleChromeVersion(ua)) reasons.push('implausible-chrome-version');
    if (req.headers['accept-language'] === undefined) reasons.push('no-accept-language');
    if (inCidrs(ipInt, TOR)) reasons.push('tor-exit');
    if (inCidrs(ipInt, DATACENTER)) reasons.push('datacenter');
    if (!ua) reasons.push('no-user-agent');

    if (reasons.length > 0) {
        return { cls: CLASS.COUNT_NOTHING, rule: reasons[0] === 'no-accept-language' ? 6 : 7, reasons };
    }

    return { cls: CLASS.HUMAN, rule: null, reasons: [] };
}

// ── Public helpers, consumed by post.js and the /js/analytics.js route ──────────────
function isCountable(req) {
    if (MODE === 'off') return true;
    return !req.bot || req.bot.cls === CLASS.HUMAN;
}

function isTaggable(req) {
    if (MODE === 'off') return true;
    return !req.bot || req.bot.cls === CLASS.HUMAN;
}

// A misclassified person needs to be able to tell us. Built once at boot so a block
// costs no render.
const BLOCK_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Automated request blocked</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#2d2d2d;max-width:34rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6}
h1{font-family:Inter,sans-serif;font-weight:600;font-size:1.25rem}a{color:#1a5276}hr{border:0;border-top:1px solid #dee2e6;margin:2rem 0}</style></head><body>
<h1>This request looked automated</h1>
<p>We blocked it to keep the site usable for readers. If you are a person and are seeing
this, it is our mistake and we would like to fix it — please write to
<a href="mailto:support@savchenkosolutions.com">support@savchenkosolutions.com</a> and mention
the page you were trying to open.</p>
<hr>
<h1>Запрос выглядел автоматическим</h1>
<p>Мы его заблокировали, чтобы сайт оставался доступным для читателей. Если вы человек и
видите это сообщение — это наша ошибка, и мы хотим её исправить. Напишите на
<a href="mailto:support@savchenkosolutions.com">support@savchenkosolutions.com</a> и укажите,
какую страницу вы открывали.</p>
</body></html>`;

// Paths that must never be blocked, whatever the verdict: a misclassified person needs a
// route back in, and the crawl-control files must always be readable.
const NEVER_BLOCK = /^\/(robots\.txt|sitemap[^/]*\.xml|favicon\.ico)$|^\/(en|ru)\/(login|register)$|^\/(login|register|forgot-password|reset-password|recover-account)$/;

function botgate(req, res, next) {
    try {
        if (MODE === 'off') return next();

        req.bot = classify(req);

        if (
            MODE === 'enforce'
            && req.bot.cls === CLASS.BLOCK
            && (ENFORCED_RULES.has(String(req.bot.rule)) || req.bot.rule === 'admin')
            && !NEVER_BLOCK.test(req.path)
        ) {
            res.status(403)
                .set('Cache-Control', 'no-store')
                .type('html')
                .send(BLOCK_PAGE);
            return undefined;
        }
    } catch (err) {
        // A classifier bug must never take the site down.
        console.error('botgate error:', err.message);
    }
    return next();
}

// Called once from index.js with the shared pool.
function init(pool) {
    if (MODE === 'off') return;
    refreshLists(pool);
    const timer = setInterval(() => refreshLists(pool), 60 * 1000);
    if (timer.unref) timer.unref();
}

module.exports = { botgate, classify, init, isCountable, isTaggable, CLASS, MODE };
