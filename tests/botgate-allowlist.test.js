// The allow-list, as a table: every client that must keep working, and the exact form in
// which it arrives — search engines and answer engines without an Accept-Language
// header, messengers fetching a link card, page-speed tools, and real people on every
// browser this audience actually uses (Yandex Browser, Amigo, Atom, Opera Mini, UC,
// Samsung, Huawei, in-app WebViews, Tor, IE11, Lynx, a PlayStation).
//
// Rule 6 blocks a *browser-claiming* request that sends no Accept-Language. The two ways
// it could go wrong are (a) a good crawler that omits the header and borrows a browser
// engine token, and (b) a real person whose client is unusual. Both are enumerated here,
// and the last block records the one residual we accept on purpose.
//
// Fixture rule, from botgate.test.js: plain modern Chrome always sends Sec-CH-UA, so a
// plain-Chrome fixture without it describes a browser that does not exist and would be
// (rightly) demoted for that — pass `hints: null` only to model a stripped/forged UA.
process.env.BOTGATE_MODE = 'observe';

const test = require('node:test');
const assert = require('node:assert');
const { classify, CLASS } = require('../botgate');

function req({ ua, ip = '203.0.113.5', lang = 'ru-RU,ru;q=0.9,en;q=0.8', encoding = 'gzip, deflate, br, zstd', path = '/ru/1.1.1', hints, extra = {} }) {
    const headers = { 'user-agent': ua };
    if (lang !== null) headers['accept-language'] = lang;
    if (encoding !== null) headers['accept-encoding'] = encoding;
    const isPlainChrome = /Chrome\/\d+/.test(ua) && !/Edg|OPR|YaBrowser|SamsungBrowser|CriOS|bot|compatible|Lighthouse|PTST|GTmetrix|Google|Yandex/i.test(ua);
    if (hints === undefined && isPlainChrome) {
        const major = /Chrome\/(\d+)/.exec(ua)[1];
        headers['sec-ch-ua'] = `"Not;A=Brand";v="8", "Chromium";v="${major}", "Google Chrome";v="${major}"`;
    } else if (hints) {
        headers['sec-ch-ua'] = hints;
    }
    Object.assign(headers, extra);
    return { headers, ip, path };
}

// ── (a) Good crawlers, exactly as they arrive: NO Accept-Language ───────────────────
// Every one of these must be served. Some are settled by the verified-crawler rule
// (COUNT_NOTHING while DNS is pending), the rest by self-identification. None may be
// a BLOCK of any rule.
const GOOD_CRAWLERS = {
    // Google
    'Googlebot desktop': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Googlebot smartphone': 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.175 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Googlebot-Image': 'Googlebot-Image/1.0',
    'Google-InspectionTool (Search Console live test)': 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)',
    'GoogleOther': 'Mozilla/5.0 (compatible; GoogleOther)',
    'Storebot-Google': 'Mozilla/5.0 (Linux; Android 8.0; Pixel 2 Build/OPD3.170816.012) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Mobile Safari/537.36 (compatible; Storebot-Google/1.0)',
    'AdsBot-Google': 'AdsBot-Google (+http://www.google.com/adsbot.html)',
    'Google-Read-Aloud': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Google-Read-Aloud; +https://support.google.com/webmasters/answer/1061943)',
    'FeedFetcher-Google': 'FeedFetcher-Google; (+http://www.google.com/feedfetcher.html)',
    'Google-PageRenderer': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; Google-PageRenderer Google (+https://developers.google.com/+/web/snippet/)) Chrome/128.0.0.0 Safari/537.36',
    'Chrome-Lighthouse (PageSpeed Insights)': 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
    'Mediapartners-Google': 'Mediapartners-Google',
    'Google Favicon': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/49.0.2623.75 Safari/537.36 Google Favicon',
    // Yandex — ~40% of search acquisition
    'YandexBot': 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
    'YandexMobileBot': 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2272.96 Mobile Safari/537.36 (compatible; YandexMobileBot/3.0; +http://yandex.com/bots)',
    'YandexImages': 'Mozilla/5.0 (compatible; YandexImages/3.0; +http://yandex.com/bots)',
    'YandexRenderResourcesBot': 'Mozilla/5.0 (compatible; YandexRenderResourcesBot/1.0; +http://yandex.com/bots)',
    'YandexMetrika': 'Mozilla/5.0 (compatible; YandexMetrika/2.0; +http://yandex.com/bots yabs01)',
    'YandexWebmaster (server response check)': 'Mozilla/5.0 (compatible; YandexWebmaster/2.0; +http://yandex.com/bots)',
    'YandexTurbo': 'Mozilla/5.0 (compatible; YandexTurbo/1.0; +http://yandex.com/bots)',
    'YandexAccessibilityBot': 'Mozilla/5.0 (compatible; YandexAccessibilityBot/3.0; +http://yandex.com/bots)',
    'YandexUserproxy': 'Mozilla/5.0 (compatible; YandexUserproxy; robot; +http://yandex.com/bots)',
    'YandexScreenshotBot': 'Mozilla/5.0 (compatible; YandexScreenshotBot/3.0; +http://yandex.com/bots)',
    // Bing / Microsoft
    'bingbot (Chrome-shaped)': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
    'bingbot (classic)': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'BingPreview': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/534+ (KHTML, like Gecko) BingPreview/1.0b',
    'adidxbot': 'Mozilla/5.0 (compatible; adidxbot/2.0; +http://www.bing.com/bingbot.htm)',
    'MicrosoftPreview': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MicrosoftPreview/2.0; +https://aka.ms/MicrosoftPreview) Chrome/116.0.1938.76 Safari/537.36',
    // Other engines
    'DuckDuckBot': 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
    'DuckAssistBot': 'Mozilla/5.0 (compatible; DuckAssistBot/1.0; +http://duckduckgo.com/duckassistbot.html)',
    'Applebot (Siri, Spotlight, iMessage cards)': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
    'Baiduspider': 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
    'Mail.RU_Bot': 'Mozilla/5.0 (compatible; Linux x86_64; Mail.RU_Bot/2.0; +http://go.mail.ru/help/robots)',
    'Yeti (Naver)': 'Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)',
    'Qwantify': 'Mozilla/5.0 (compatible; Qwantify/2.4w; +https://www.qwant.com/)/2.4w',
    'MojeekBot': 'Mozilla/5.0 (compatible; MojeekBot/0.11; +https://www.mojeek.com/bot.html)',
    // Answer engines — welcomed by name in robots.txt
    'ChatGPT-User': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    'OAI-SearchBot': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
    'PerplexityBot': 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    'Perplexity-User': 'Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
    'ClaudeBot': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'Claude-User': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com',
    // Messengers and social link cards — how this audience shares problems
    'Telegram': 'TelegramBot (like TwitterBot)',
    'WhatsApp / Signal': 'WhatsApp/2.23.20.0 A',
    'Viber': 'Viber/20.3.0.0 CFNetwork/1410.0.3 Darwin/22.6.0',
    'VK': 'Mozilla/5.0 (compatible; vkShare; +http://vk.com/dev/Share)',
    'Odnoklassniki': 'Mozilla/5.0 (compatible; OdklBot/1.0 like Linux; klass@odnoklassniki.ru)',
    'Discord': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Slack': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Skype / Teams': 'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com',
    'Twitter/X': 'Twitterbot/1.0',
    'LinkedIn': 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Pinterest': 'Pinterest/0.2 (+https://www.pinterest.com/bot.html)',
    'Reddit': 'Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)',
    'Mastodon': 'http.rb/5.1.1 (Mastodon/4.2.10; +https://mastodon.social/)',
    'Bluesky': 'Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)',
    // Tools that report on the site
    'WebPageTest': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 PTST/240301.000000',
    'GTmetrix': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 GTmetrix',
    'UptimeRobot': 'Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
    'Internet Archive': 'Mozilla/5.0 (compatible; archive.org_bot +http://archive.org/details/archive.org_bot)',
    'Feedly': 'Feedly/1.0 (+http://www.feedly.com/fetcher.html; 3 subscribers; like FeedFetcher-Google)',
};

test('MUST NEVER BLOCK: every good crawler, arriving without Accept-Language', () => {
    for (const [name, ua] of Object.entries(GOOD_CRAWLERS)) {
        // Crawlers do not send zstd; give them the encoding they actually send.
        const v = classify(req({ ua, lang: null, encoding: 'gzip, deflate', hints: null }));
        assert.notStrictEqual(v.cls, CLASS.BLOCK, `${name} was blocked (rule ${v.rule}: ${v.reasons})`);
    }
});

test('the verified-crawler rule settles the search engines before rule 6 is consulted', () => {
    for (const name of ['Googlebot desktop', 'Googlebot smartphone', 'YandexBot', 'bingbot (Chrome-shaped)', 'BingPreview', 'DuckDuckBot', 'Applebot (Siri, Spotlight, iMessage cards)', 'Baiduspider']) {
        const v = classify(req({ ua: GOOD_CRAWLERS[name], lang: null, encoding: 'gzip, deflate', hints: null }));
        assert.strictEqual(v.rule, 1, `${name} should be rule 1, got ${v.rule}`);
    }
});

// The earlier rules block these ON PURPOSE (bulk scrapers that send no readers, and
// HTTP libraries). Recorded so a change here is a decision, not an accident.
test('bulk scrapers and HTTP libraries stay blocked by rules 2 and 3', () => {
    const blocked = {
        'Amazonbot': ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36', 2],
        'GPTBot': ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)', 2],
        'CCBot': ['CCBot/2.0 (https://commoncrawl.org/faq/)', 2],
        'meta-externalagent': ['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 2],
        'python-requests': ['python-requests/2.31.0', 3],
        'HeadlessChrome': ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36', 3],
    };
    for (const [name, [ua, rule]] of Object.entries(blocked)) {
        const v = classify(req({ ua, lang: null, encoding: 'gzip, deflate', hints: null }));
        assert.strictEqual(v.cls, CLASS.BLOCK, `${name} should be blocked`);
        assert.strictEqual(v.rule, rule, `${name} should be rule ${rule}`);
    }
});

// ── (b) Real people, on the browsers this audience uses, WITH Accept-Language ───────
// Every real browser sends the header from its locale. These must all be served;
// "HUMAN" additionally means counted. Where an older rule demotes a client to
// COUNT_NOTHING it is noted — that costs the reader nothing visible.
const REAL_BROWSERS = [
    ['Chrome Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36', {}],
    ['Chrome Android', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36', {}],
    ['Chrome iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.108 Mobile/15E148 Safari/604.1', {}],
    ['Safari macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', {}],
    ['Safari iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', {}],
    ['Firefox Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0', { encoding: 'gzip, deflate, br, zstd' }],
    ['Firefox Android', 'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0', {}],
    ['Firefox iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/128.0 Mobile/15E148 Safari/605.1.15', {}],
    ['Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', { hints: '"Chromium";v="130", "Microsoft Edge";v="130", "Not?A_Brand";v="99"' }],
    ['Opera desktop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0', { hints: '"Chromium";v="130", "Opera";v="115", "Not?A_Brand";v="99"' }],
    ['Opera Mini (Presto, proxy-rendered)', 'Opera/9.80 (Android; Opera Mini/58.0.2254/191.303; U; ru) Presto/2.12.423 Version/12.16', { encoding: 'gzip, deflate' }],
    ['Opera Mini (Chromium)', 'Mozilla/5.0 (Linux; U; Android 10; ru-RU; SM-A505F Build/QP1A.190711.020) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 OPR/57.0.2830.0 Mobile Safari/537.36', {}],
    ['Yandex Browser desktop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 YaBrowser/24.10.0 Safari/537.36', { encoding: 'gzip, deflate, br' }],
    ['Yandex Browser Android', 'Mozilla/5.0 (Linux; arm_64; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.5.53.00 SA/3 Mobile Safari/537.36', {}],
    ['Yandex app WebView', 'Mozilla/5.0 (Linux; arm_64; Android 12; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 YaApp_Android/24.66.1 YaSearchBrowser/24.66.1 BroPP/1.0 SA/3 Mobile Safari/537.36', {}],
    ['Amigo (Mail.ru, Chromium 61)', 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36 MRCHROME SOC', { encoding: 'gzip, deflate, br', hints: null }],
    ['Atom (Mail.ru)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Atom/28.0.0.0', {}],
    ['UC Browser', 'Mozilla/5.0 (Linux; U; Android 12; ru; SM-A125F Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UCBrowser/15.5.0.1200 Mobile Safari/537.36', { encoding: 'gzip, deflate, br', hints: '"Chromium";v="100", "UCBrowser";v="15"' }],
    ['Samsung Internet', 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', { hints: '"Chromium";v="121", "Samsung Internet";v="25"' }],
    ['Huawei Browser', 'Mozilla/5.0 (Linux; Android 10; HarmonyOS; ELS-NX9; HMSCore 6.13.0.302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 HuaweiBrowser/14.0.5.301 Mobile Safari/537.36', { hints: '"Chromium";v="114", "HuaweiBrowser";v="14"' }],
    ['Xiaomi Mi Browser', 'Mozilla/5.0 (Linux; U; Android 13; ru-ru; Redmi Note 12 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.5615.136 Mobile Safari/537.36 XiaoMi/MiuiBrowser/14.10.0-gn', { hints: '"Chromium";v="112", "MiuiBrowser";v="14"' }],
    ['Brave (with Global Privacy Control)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', { hints: '"Chromium";v="130", "Brave";v="130", "Not?A_Brand";v="99"', extra: { 'sec-gpc': '1', dnt: '1' } }],
    ['Vivaldi (mimics Chrome)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', {}],
    ['Android WebView (Telegram/VK in-app)', 'Mozilla/5.0 (Linux; Android 13; SM-A536E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36', { hints: '"Chromium";v="128", "Android WebView";v="128"' }],
    ['iOS in-app (Instagram)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0', {}],
    ['iOS in-app (Facebook)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.0;FBBV/1;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/ru_RU;FBOP/5]', {}],
    ['KaiOS feature phone', 'Mozilla/5.0 (Mobile; Nokia 8110 4G; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5', { encoding: 'gzip, deflate' }],
    ['Internet Explorer 11', 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko', { encoding: 'gzip, deflate' }],
    ['Lynx (text browser)', 'Lynx/2.9.0dev.10 libwww-FM/2.14 SSL-MM/1.4.1 OpenSSL/1.1.1n', { encoding: 'gzip' }],
    ['PlayStation 5', 'Mozilla/5.0 (PlayStation; PlayStation 5/8.60) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', {}],
    ['Kindle', 'Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+', { encoding: 'gzip' }],
    ['Pale Moon', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) Gecko/20100101 Goanna/6.6 Firefox/102.0 PaleMoon/33.0.0', { encoding: 'gzip, deflate, br' }],
    ['LibreWolf / Mullvad (resistFingerprinting)', 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0', { lang: 'en-US,en;q=0.5' }],
    ['Tor Browser on an exit node', 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0', { lang: 'en-US,en;q=0.5', ip: '185.220.101.10' }],
    ['Chrome with reduced Accept-Language', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36', { lang: 'ru' }],
    ['Accept-Language: *', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36', { lang: '*' }],
    ['Accept-Language present but empty', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36', { lang: '' }],
    ['behind a proxy that drops Accept-Encoding', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36', { encoding: null }],
    ['behind a proxy that downgrades Accept-Encoding', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36', { encoding: 'gzip,deflate' }],
];

test('MUST NEVER BLOCK: real people on every browser this audience uses', () => {
    for (const [name, ua, opts] of REAL_BROWSERS) {
        const v = classify(req({ ua, ...opts }));
        assert.notStrictEqual(v.cls, CLASS.BLOCK, `${name} was blocked (rule ${v.rule}: ${v.reasons})`);
    }
});

test('and they are counted as people, not merely tolerated', () => {
    // Everything above except the deliberately-uncounted Tor exit.
    for (const [name, ua, opts] of REAL_BROWSERS) {
        if (name.startsWith('Tor')) continue;
        const v = classify(req({ ua, ...opts }));
        assert.strictEqual(v.cls, CLASS.HUMAN, `${name} should be human, got ${v.cls} (${v.reasons})`);
    }
});

test('ad blockers and privacy extensions never cause a block', () => {
    const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
    // uBlock Origin / AdGuard / Privacy Badger / Ghostery change nothing about these
    // headers — they block third-party requests. AdGuard Stealth Mode additionally hides
    // Referer and can strip client hints; Chameleon/Trace spoof Accept-Language to a
    // different value. None of them removes it. The worst case is demotion.
    const variants = [
        ['ad blocker (no header changes)', {}],
        ['GPC + DNT signals', { extra: { 'sec-gpc': '1', dnt: '1' } }],
        ['AdGuard Stealth: no Referer', { extra: {} }],
        ['AdGuard Stealth: client hints stripped', { hints: null }],
        ['Chameleon: spoofed Accept-Language', { lang: 'en-US,en;q=0.9' }],
        ['a header-modifying extension that keeps the header', { lang: 'de-DE,de;q=0.9' }],
    ];
    for (const [name, opts] of variants) {
        const v = classify(req({ ua: CHROME, ...opts }));
        assert.notStrictEqual(v.cls, CLASS.BLOCK, `${name} was blocked (${v.reasons})`);
    }
});

test('an old Amigo build is demoted by the version rule, never blocked', () => {
    // Amigo shipped on Chromium 60 as well; the implausible-version heuristic (rule 7)
    // treats a Chrome/60 claim in 2026 as a UA randomiser and stops counting it. The
    // person still gets the full page. This is the existing behaviour, recorded.
    const v = classify(req({ ua: 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.113 Safari/537.36 MRCHROME SOC', encoding: 'gzip, deflate, br', hints: null }));
    assert.notStrictEqual(v.cls, CLASS.BLOCK);
});

// ── The residual, on the record ─────────────────────────────────────────────────────
test('KNOWN RESIDUAL: an anonymous person whose setup strips Accept-Language, typing the URL', () => {
    // Measured at <=2 ambiguous single-request visitors in 14 days. They see the bilingual
    // 403 with a contact address; /login and /register stay open, and once signed in the
    // after-session pass exempts them. A search-result click is already exempt.
    const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
    const v = classify(req({ ua: CHROME, lang: null, extra: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1' } }));
    assert.strictEqual(v.cls, CLASS.BLOCK);
    assert.strictEqual(v.rule, 6);
});
