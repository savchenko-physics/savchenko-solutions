// Runs an Express JSON handler without a request on the wire and hands back what it would
// have sent. The profile page did this for its seven /api/user/:username/* endpoints
// (contributorsUserMetricsApi.js) and the contributors page now does it for its five: a page
// ships the answers inside its own HTML instead of having the browser ask for them one
// round trip each (~130 ms from Europe to us-east-2, six times, 2026-09-19). The handlers
// themselves are untouched, so the endpoints keep working for anything else that calls them.
//
// Anything that errors or answers 4xx/5xx resolves to null rather than taking the page down;
// the page's script then fetches as it always did.
'use strict';

function runHandler(handler, req) {
    if (typeof handler !== 'function') return Promise.resolve(null);
    return new Promise((resolve) => {
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; resolve(value); } };
        const res = {
            statusCode: 200,
            set() { return this; },
            setHeader() { return this; },
            status(code) { this.statusCode = code; return this; },
            json(body) { done(this.statusCode >= 400 ? null : body); return this; },
            send(body) { done(this.statusCode >= 400 ? null : body); return this; },
        };
        Promise.resolve()
            .then(() => handler(req, res))
            .then(() => done(null))
            .catch(() => done(null));
    });
}

// A request object with just what a JSON handler reads.
function fakeRequest(req, { params = {}, query = {} } = {}) {
    return {
        params,
        query,
        session: (req && req.session) || {},
        headers: (req && req.headers) || {},
        ip: req ? req.ip : undefined,
        app: req ? req.app : undefined,
    };
}

// Pre-answers a page's own API calls: `urls` maps each URL the page will fetch to
// { handler, query }; the result maps the same URLs to the JSON, ready for window.__PRELOADED__.
// Bounded by `budgetMs`: whatever has not answered by then is left for the browser to fetch.
async function preloadApis(req, urls, budgetMs = 400) {
    const entries = Object.entries(urls);
    const answers = await Promise.race([
        Promise.all(entries.map(([, { handler, query, params }]) => runHandler(handler, fakeRequest(req, { query, params })))),
        new Promise((resolve) => setTimeout(() => resolve(null), budgetMs)),
    ]);
    const out = {};
    if (answers) entries.forEach(([url], i) => { if (answers[i] != null) out[url] = answers[i]; });
    return out;
}

module.exports = { runHandler, fakeRequest, preloadApis };
