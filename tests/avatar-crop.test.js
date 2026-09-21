// The profile photo crop stage — js/avatar-crop.js, the geometry underneath the canvas.
//
// Added 2026-09-21 with the stage itself: a chosen photo is placed in a circle or square
// frame with composition guides (thirds, golden ratio, diagonals, golden spiral) and what
// is uploaded is the adjusted crop. The invariant the whole thing rests on is that the
// frame is always fully covered by the picture: no pan, zoom, turn or resize may show the
// frame's background, or the uploaded avatar would have a blank stripe. That, the zoom
// keeping the point under the cursor, the crop rectangle staying inside the image, and the
// guides staying inside the frame are what this file pins. The drawing and the pointer
// handling run only in a browser and were checked in Firefox by hand.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../js/avatar-crop');

const V = 320;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** True when the turned image, drawn for state s, covers the whole V × V viewport. */
function covers(s) {
    const t = C.turned(s.w, s.h, s.rot);
    const left = V / 2 + s.x - (t.w * s.scale) / 2;
    const top = V / 2 + s.y - (t.h * s.scale) / 2;
    return left <= 1e-9 && top <= 1e-9 && left + t.w * s.scale >= V - 1e-9 && top + t.h * s.scale >= V - 1e-9;
}

// ── Fit and cover ─────────────────────────────────────────────────────────────

test('fit covers the viewport for landscape, portrait, square and tiny images', () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [500, 500], [100, 40], [40, 100], [1, 1]]) {
        const s = C.fit(w, h, V);
        assert.ok(covers(s), `${w}x${h}`);
        assert.equal(s.x, 0);
        assert.equal(s.y, 0);
        assert.ok(near(s.scale, C.minScale(w, h, 0, V)));
    }
});

test('a quarter turn swaps the sides and keeps the cover', () => {
    const s = C.fit(4000, 3000, V);
    const r = C.rotate(s, 1, V);
    assert.equal(r.rot, 1);
    assert.deepEqual(C.turned(4000, 3000, 1), { w: 3000, h: 4000 });
    assert.ok(covers(r));
    const back = C.rotate(r, -1, V);
    assert.equal(back.rot, 0);
    assert.ok(covers(back));
    assert.equal(C.rotate(s, 4, V).rot, 0);
    assert.equal(C.rotate(s, -1, V).rot, 3);
});

test('rotation keeps the zoom ratio and turns the offset with the picture', () => {
    let s = C.fit(4000, 3000, V);
    s = C.zoomAt(s, 2, V / 2, V / 2, V);
    s = C.pan(s, 50, -30, V);
    const r = C.rotate(s, 1, V);
    assert.ok(near(r.scale / C.minScale(r.w, r.h, r.rot, V), s.scale / C.minScale(s.w, s.h, s.rot, V)));
    assert.ok(near(r.x, 30) && near(r.y, 50), `offset turned: ${r.x}, ${r.y}`);
    assert.ok(covers(r));
});

// ── Pan and zoom ──────────────────────────────────────────────────────────────

test('a pan never uncovers the frame, however far it is dragged', () => {
    let s = C.zoomAt(C.fit(4000, 3000, V), 1.5, V / 2, V / 2, V);
    for (const [dx, dy] of [[5000, 0], [-9000, 0], [0, 4000], [0, -8000], [123, -77]]) {
        s = C.pan(s, dx, dy, V);
        assert.ok(covers(s), `after ${dx},${dy}`);
    }
});

test('at the fitting scale the image cannot move along its tight axis', () => {
    const s = C.fit(4000, 3000, V); // height is tight: 3000 * scale == V
    const moved = C.pan(s, 100, 100, V);
    assert.equal(moved.y, 0);
    assert.ok(moved.x > 0);
    assert.ok(covers(moved));
});

test('zooming out below the fit is refused, zooming in stops at MAX_ZOOM', () => {
    const s = C.fit(1000, 1000, V);
    const out = C.zoomAt(s, 0.1, V / 2, V / 2, V);
    assert.ok(near(out.scale, s.scale));
    const far = C.zoomAt(s, 1000, V / 2, V / 2, V);
    assert.ok(near(far.scale, s.scale * C.MAX_ZOOM));
    assert.ok(covers(far));
});

test('a zoom about a point keeps the image point under it in place', () => {
    const s = C.fit(4000, 3000, V);
    const px = 80, py = 200;
    // image-space coordinate under (px, py) before and after
    const under = (st) => ({ ix: (px - V / 2 - st.x) / st.scale, iy: (py - V / 2 - st.y) / st.scale });
    const before = under(s);
    const z = C.zoomAt(s, 1.7, px, py, V);
    const after = under(z);
    assert.ok(near(before.ix, after.ix, 1e-6) && near(before.iy, after.iy, 1e-6));
    assert.ok(covers(z));
});

test('the zoom slider position round-trips through the scale', () => {
    const s = C.fit(1200, 900, V);
    for (const p of [0, 0.25, 0.5, 1]) {
        const scale = C.scaleForPosition(s, p, V);
        assert.ok(near(C.zoomPosition(Object.assign({}, s, { scale }), V), p, 1e-9));
    }
    assert.equal(C.zoomPosition(s, V), 0);
});

// ── The crop ──────────────────────────────────────────────────────────────────

test('the crop rectangle is a square inside the turned image, for any state', () => {
    let s = C.fit(4000, 3000, V);
    const states = [s, C.zoomAt(s, 3, 10, 300, V), C.pan(C.zoomAt(s, 2, V / 2, V / 2, V), -700, 400, V), C.rotate(s, 1, V), C.rotate(C.zoomAt(s, 2.5, 0, 0, V), 3, V)];
    for (const st of states) {
        const t = C.turned(st.w, st.h, st.rot);
        const r = C.cropRect(st, V);
        assert.ok(r.x >= -1e-6 && r.y >= -1e-6, `origin ${r.x},${r.y}`);
        assert.ok(r.x + r.size <= t.w + 1e-6 && r.y + r.size <= t.h + 1e-6, `extent ${r.x + r.size} / ${t.w}`);
        assert.ok(near(r.size, V / st.scale));
    }
});

test('the fitted crop of a landscape photo is its full height, centred', () => {
    const r = C.cropRect(C.fit(4000, 3000, V), V);
    assert.ok(near(r.size, 3000));
    assert.ok(near(r.y, 0));
    assert.ok(near(r.x, 500));
});

test('the export side is the crop\'s own pixels within 320 and 800', () => {
    const s = C.fit(4000, 3000, V);
    assert.equal(C.exportSize(s, V), 800);                        // 3000 px of source, capped
    assert.equal(C.exportSize(C.fit(200, 200, V), V), 320);       // 200 px of source, floored
    const mid = C.zoomAt(s, 5, V / 2, V / 2, V);                  // 4× → 750 px
    assert.equal(C.exportSize(mid, V), 750);
});

// ── The guides ────────────────────────────────────────────────────────────────

test('every guide line lies in the unit square', () => {
    for (const kind of C.GRIDS) {
        for (const l of C.gridLines(kind)) {
            for (const v of l) assert.ok(v >= 0 && v <= 1, `${kind}: ${l}`);
        }
    }
    assert.equal(C.gridLines('none').length, 0);
    assert.equal(C.gridLines('thirds').length, 4);
    assert.equal(C.gridLines('golden').length, 4);
    assert.equal(C.gridLines('diagonals').length, 4);
});

test('the golden grid sits at 1/phi and 1 - 1/phi', () => {
    const xs = C.gridLines('golden').filter((l) => l[0] === l[2]).map((l) => l[0]).sort();
    assert.ok(near(xs[0], 0.381966, 1e-5));
    assert.ok(near(xs[1], 0.618034, 1e-5));
});

test('the golden spiral is continuous, shrinks by phi each turn, and stays in the square', () => {
    const arcs = C.spiralArcs(8);
    assert.equal(arcs.length, 8);
    for (let i = 0; i < arcs.length; i++) {
        const a = arcs[i];
        const ends = C.arcEnds(a);
        for (const p of [ends.start, ends.end]) {
            assert.ok(p.x >= -1e-9 && p.x <= 1 + 1e-9 && p.y >= -1e-9 && p.y <= 1 + 1e-9, `arc ${i} end ${p.x},${p.y}`);
        }
        if (i > 0) {
            const prev = C.arcEnds(arcs[i - 1]).end;
            assert.ok(near(prev.x, ends.start.x, 1e-9) && near(prev.y, ends.start.y, 1e-9), `arc ${i} joins arc ${i - 1}`);
            assert.ok(near(arcs[i - 1].r / a.r, C.PHI, 1e-9), `radius ratio at ${i}`);
        }
    }
    assert.ok(near(arcs[0].r, 1 / C.PHI));
});

// ── Must never ────────────────────────────────────────────────────────────────

test('must never: uncover the frame through any sequence of operations', () => {
    let s = C.fit(3024, 4032, V);
    let seed = 7;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 2000; i++) {
        const op = rnd();
        if (op < 0.4) s = C.pan(s, (rnd() - 0.5) * 600, (rnd() - 0.5) * 600, V);
        else if (op < 0.8) s = C.zoomAt(s, 0.5 + rnd() * 2, rnd() * V, rnd() * V, V);
        else s = C.rotate(s, Math.floor(rnd() * 4) - 2, V);
        assert.ok(covers(s), `step ${i}`);
        const r = C.cropRect(s, V);
        const t = C.turned(s.w, s.h, s.rot);
        assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.size <= t.w + 1e-6 && r.y + r.size <= t.h + 1e-6, `crop at step ${i}`);
    }
});
