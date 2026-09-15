// The rules for the site's flat drawings: the reaction emoji (img/emoji, tests/reactions.test.js)
// and the art of the «Последняя задача» mini app (img/apps/last-problem, tests/last-problem.test.js).
//
// They are served from our own origin with no CSP and shown through <img>, so a drawing must be
// inert (nothing that runs, fetches or pulls in other markup), small, flat (no gradients or
// filters, per the design system) and drawn only in the palette below: the design system's
// colours plus the art palette the community emoji were drawn in.
'use strict';

const assert = require('node:assert/strict');

const PALETTE = new Set([
    '#1a1a2e', '#ffffff', '#dee2e6', '#adb5bd', '#6c757d', '#1a5276', '#27ae60', '#c0392b',
    '#4fc3f7', '#d6eaf8', '#9ccc65', '#689f38', '#8d5a2b', '#5d3a1a', '#e0a458', '#d7a86e',
    '#f39c4a', '#f1c40f', '#f7dc6f', '#e9b43a', '#b0bec5', '#78909c',
]);

function assertSvgArt(svg, where) {
    assert.ok(Buffer.byteLength(svg) <= 4096, `${where} is over 4 KB`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64"/, `${where} root`);
    // Anything that could run, fetch, or pull in other markup.
    assert.doesNotMatch(svg, /<script|\son\w+\s*=|javascript:|<foreignObject|<!DOCTYPE|<!ENTITY|<image|<style|@import|<animate|<set\b/i, where);
    assert.doesNotMatch(svg, /href\s*=\s*["'](?!#)|url\((?!#)/i, `${where} references something outside itself`);
    // Design rules, and web fonts do not load inside <img>.
    assert.doesNotMatch(svg, /gradient|<filter|<text/i, where);
    // Editor leftovers (img/logo.svg carries a C:\Users path).
    assert.doesNotMatch(svg, /inkscape:|sodipodi:|<metadata|\\Users\\/i, where);
    for (const colour of svg.match(/#[0-9a-f]{3,8}\b/gi) || []) {
        assert.ok(PALETTE.has(colour.toLowerCase()), `${where} uses ${colour}, which is not in the palette`);
    }
}

module.exports = { PALETTE, assertSvgArt };
