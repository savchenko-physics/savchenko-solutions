// A cache that never makes a visitor wait for a refresh. A value is served as long as one is
// held; once it is older than `ttlMs` the next reader still gets it at once and one refresh
// runs behind the page for whoever comes next. Only the very first reader after a restart
// waits (and `warm` takes even that away when it is called at boot).
//
// Before this every cache on the site was a plain TTL: the homepage's widgets, held for a
// minute, cost 400–600 ms of queries for the first visitor of every quiet minute; a profile
// held for an hour cost 6.5 s for the first visitor of every hour (the owner's own, 2026-09-19).
// The busiest profile's numbers being an hour old is fine; someone waiting six seconds for
// them is not.
//
// `maxAgeMs` bounds the staleness: past it the reader waits for a fresh value (a loader that
// has been failing for that long is a real outage, and its last good value may be misleading).
'use strict';

class SwrCache {
    constructor({ ttlMs, maxAgeMs = 24 * 60 * 60 * 1000, name = 'cache' } = {}) {
        if (!(ttlMs > 0)) throw new Error('SwrCache needs ttlMs');
        this.ttlMs = ttlMs;
        this.maxAgeMs = maxAgeMs;
        this.name = name;
        this.items = new Map();
        this.inflight = new Map();
    }

    /** The held value, refreshed behind the reader when older than ttlMs. */
    async get(key, loader) {
        const item = this.items.get(key);
        const age = item ? Date.now() - item.at : Infinity;
        if (item && age < this.ttlMs) return item.value;
        if (item && age < this.maxAgeMs) {
            this.refresh(key, loader).catch((err) => {
                console.error(`${this.name}: refresh of ${key} failed, keeping the held value:`, err.message);
            });
            return item.value;
        }
        return this.refresh(key, loader);
    }

    /** Runs the loader once for concurrent callers and stores what it returns. */
    refresh(key, loader) {
        if (this.inflight.has(key)) return this.inflight.get(key);
        const pending = (async () => {
            try {
                const value = await loader();
                this.items.set(key, { at: Date.now(), value });
                return value;
            } finally {
                this.inflight.delete(key);
            }
        })();
        this.inflight.set(key, pending);
        return pending;
    }

    /** The held value or undefined, without loading anything. */
    peek(key) {
        const item = this.items.get(key);
        return item ? item.value : undefined;
    }

    delete(key) { this.items.delete(key); }
    clear() { this.items.clear(); }
}

module.exports = { SwrCache };
