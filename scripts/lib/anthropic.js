/**
 * anthropic.js — minimal Claude client for the offline catalog build.
 *
 * Offline only. `CLAUDE.md` forbids runtime AI features; the two sanctioned
 * exceptions (scripts/score-difficulty.js, scripts/repair-ru-latex.js) are both
 * build-time metadata scripts, and this is a third of the same kind. The website
 * never calls this, which is also why no Anthropic key needs to exist on the
 * server.
 *
 * Budget handling mirrors scripts/score-difficulty.js: a hard dollar ceiling
 * checked before every request, with real usage accounting from the response
 * rather than an estimate.
 */

const MODEL = 'claude-haiku-4-5';

// Standard (non-batch) rates, $/token. The Batch API halves both.
const RATE = { in: 1.0 / 1e6, out: 5.0 / 1e6 };

class BudgetExceeded extends Error {}

class Client {
    constructor({ apiKey, budget = 5.0, model = MODEL, batchDiscount = false } = {}) {
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
        this.apiKey = apiKey.trim();
        this.model = model;
        this.budget = budget;
        this.discount = batchDiscount ? 0.5 : 1.0;
        this.spent = 0;
        this.calls = 0;
        this.tokensIn = 0;
        this.tokensOut = 0;
    }

    remaining() { return Math.max(0, this.budget - this.spent); }

    _account(usage) {
        const i = usage?.input_tokens || 0;
        const o = usage?.output_tokens || 0;
        this.tokensIn += i;
        this.tokensOut += o;
        this.spent += (i * RATE.in + o * RATE.out) * this.discount;
        this.calls += 1;
    }

    /**
     * One structured-output request. `schema` is enforced server-side via
     * output_config.format, so the response parses without repair.
     *
     * Note: Haiku 4.5 does not accept the `effort` parameter — sending it 400s.
     */
    async json({ system, user, schema, maxTokens = 2048, retries = 4 }) {
        if (this.spent >= this.budget) {
            throw new BudgetExceeded(`budget $${this.budget.toFixed(2)} exhausted`);
        }
        const body = {
            model: this.model,
            max_tokens: maxTokens,
            output_config: { format: { type: 'json_schema', schema } },
            system,
            messages: [{ role: 'user', content: user }],
        };

        let lastErr;
        for (let attempt = 0; attempt < retries; attempt += 1) {
            let res;
            try {
                res = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': this.apiKey,
                        'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify(body),
                });
            } catch (err) {
                lastErr = err;
                await sleep(1500 * (attempt + 1));
                continue;
            }

            if (res.status === 429 || res.status >= 500) {
                const retryAfter = Number(res.headers.get('retry-after')) || 0;
                lastErr = new Error(`http ${res.status}`);
                await sleep(retryAfter ? retryAfter * 1000 : 2000 * (attempt + 1));
                continue;
            }

            const payload = await res.json();
            if (payload.error) {
                // 400s are our bug (bad schema, oversized input) — surface immediately.
                throw new Error(`${payload.error.type}: ${payload.error.message}`);
            }
            this._account(payload.usage);

            if (payload.stop_reason === 'refusal') {
                throw new Error(`refusal: ${payload.stop_details?.category || 'unspecified'}`);
            }
            const text = (payload.content || []).find((b) => b.type === 'text')?.text;
            if (!text) { lastErr = new Error('empty response'); continue; }
            try {
                return JSON.parse(text);
            } catch (err) {
                lastErr = new Error(`unparseable json: ${text.slice(0, 160)}`);
            }
        }
        throw lastErr || new Error('request failed');
    }

    report() {
        return {
            calls: this.calls,
            tokensIn: this.tokensIn,
            tokensOut: this.tokensOut,
            spent: Number(this.spent.toFixed(4)),
            budget: this.budget,
        };
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = cursor;
            cursor += 1;
            if (i >= items.length) return;
            try {
                results[i] = await worker(items[i], i);
            } catch (err) {
                if (err instanceof BudgetExceeded) throw err;
                results[i] = { __error: err.message };
            }
        }
    });
    await Promise.all(runners);
    return results;
}

const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
};

module.exports = { Client, BudgetExceeded, mapLimit, chunk, sleep, MODEL, RATE };
