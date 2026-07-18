// IndexNow — instantly notify Yandex + Bing when a URL changes.
// Yandex is a first-class search channel for this audience, so pushing edits
// here gets solutions re-crawled in minutes instead of waiting for a crawl.
// Fire-and-forget; never throws, never blocks the request.
const https = require('https');

const INDEXNOW_KEY = '7c3f9a1e5b2d8c4f6a0e3b7d9c1f2a48';
const HOST = 'savchenkosolutions.com';

function pingIndexNow(urls) {
    try {
        const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
        if (!list.length) return;
        const body = JSON.stringify({
            host: HOST,
            key: INDEXNOW_KEY,
            keyLocation: `https://${HOST}/${INDEXNOW_KEY}.txt`,
            urlList: list,
        });
        const req = https.request({
            hostname: 'api.indexnow.org',
            path: '/indexnow',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 5000,
        }, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
        req.on('error', (e) => console.error('IndexNow ping failed:', e.message));
        req.on('timeout', () => req.destroy());
        req.write(body);
        req.end();
    } catch (e) {
        console.error('IndexNow error:', e.message);
    }
}

module.exports = { pingIndexNow, INDEXNOW_KEY };
