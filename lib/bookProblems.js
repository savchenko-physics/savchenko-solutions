// Which numbers are problems of the book: the 2,023 of Savchenko's collection, section by section,
// from the third column of src/database/sections.csv (authoritative, see CLAUDE.md). Written the
// canonical way only, as the site's addresses are: 8.2.27, never 08.2.27.
//
// Used by the solution page (post.js) to tell an unsolved problem from a mistyped address, and by
// «Последняя задача» (lastProblem.js) to count solutions toward the 2000th.
'use strict';

const fs = require('fs');
const path = require('path');

const ID_RE = /^([1-9]\d?)\.([1-9]\d?)\.([1-9]\d{0,2})$/;

let counts = null;

function sectionCounts() {
    if (counts) return counts;
    const map = new Map();
    let text = '';
    try {
        text = fs.readFileSync(path.join(__dirname, '..', 'src', 'database', 'sections.csv'), 'utf8').replace(/^﻿/, '');
    } catch (_err) {
        return map;
    }
    for (const line of text.split(/\r?\n/)) {
        const first = line.indexOf(',');
        const last = line.lastIndexOf(',');
        if (first <= 0 || last <= first) continue;
        const n = Number(line.slice(last + 1).trim());
        if (Number.isInteger(n) && n > 0) map.set(line.slice(0, first).trim(), n);
    }
    counts = map;
    return map;
}

function isBookProblem(id) {
    const m = typeof id === 'string' ? ID_RE.exec(id) : null;
    if (!m) return false;
    const count = sectionCounts().get(`${m[1]}.${m[2]}`);
    return !!count && Number(m[3]) <= count;
}

module.exports = { isBookProblem, sectionCounts };
