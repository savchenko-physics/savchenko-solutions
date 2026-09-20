// lib/swr.js: a reader is never made to wait for a refresh once a value is held. The homepage's
// first visitor of every quiet minute paid 400–600 ms of queries, a profile's first visitor of
// every hour paid 6.5 s (2026-09-19); a value a minute or an hour old costs nothing to serve.

const test = require('node:test');
const assert = require('node:assert/strict');
const { SwrCache } = require('../lib/swr');

const tick = () => new Promise((r) => setImmediate(r));

test('the first reader waits for the loader; later readers inside the ttl get the held value', async () => {
    const c = new SwrCache({ ttlMs: 1000 });
    let loads = 0;
    const loader = async () => { loads++; return `v${loads}`; };
    assert.equal(await c.get('k', loader), 'v1');
    assert.equal(await c.get('k', loader), 'v1');
    assert.equal(loads, 1);
});

test('past the ttl the stale value is returned at once and one refresh runs behind it', async () => {
    const c = new SwrCache({ ttlMs: 1 });
    let loads = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const loader = async () => { loads++; if (loads > 1) await gate; return `v${loads}`; };
    assert.equal(await c.get('k', loader), 'v1');
    await new Promise((r) => setTimeout(r, 5));
    const started = Date.now();
    assert.equal(await c.get('k', loader), 'v1', 'stale, served at once');
    assert.equal(await c.get('k', loader), 'v1', 'still the held value while the refresh runs');
    assert.ok(Date.now() - started < 50, 'nobody waited');
    assert.equal(loads, 2, 'one refresh, not one per reader');
    release();
    await tick(); await tick();
    assert.equal(await c.get('k', loader), 'v2');
});

test('a failing background refresh keeps the held value; a failing first load throws', async () => {
    const c = new SwrCache({ ttlMs: 1 });
    let fail = false;
    const loader = async () => { if (fail) throw new Error('db down'); return 'good'; };
    assert.equal(await c.get('k', loader), 'good');
    await new Promise((r) => setTimeout(r, 5));
    fail = true;
    const errors = [];
    const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
    try {
        assert.equal(await c.get('k', loader), 'good');
        await tick(); await tick();
        assert.equal(await c.get('k', loader), 'good');
    } finally { console.error = orig; }
    assert.ok(errors.some((e) => e.includes('db down')), 'the failure is logged');
    await assert.rejects(c.get('other', loader), /db down/);
});

test('past maxAge a reader waits for a fresh value rather than serve one that old', async () => {
    const c = new SwrCache({ ttlMs: 1, maxAgeMs: 2 });
    let loads = 0;
    const loader = async () => { loads++; return `v${loads}`; };
    assert.equal(await c.get('k', loader), 'v1');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await c.get('k', loader), 'v2');
});

test('concurrent first readers share one load', async () => {
    const c = new SwrCache({ ttlMs: 1000 });
    let loads = 0;
    const loader = async () => { loads++; await tick(); return 'v'; };
    await Promise.all([c.get('k', loader), c.get('k', loader), c.get('k', loader)]);
    assert.equal(loads, 1);
});
