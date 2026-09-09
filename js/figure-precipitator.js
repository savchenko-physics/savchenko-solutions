/*
 * figure-precipitator.js — the interactive figure for problem 6.6.15, the
 * electrostatic precipitator (электрофильтр).
 *
 * Why this exists: the answer to part (a) — a *neutral* grain is pulled toward the
 * wire whatever the sign of V — is the kind of thing a still picture cannot argue.
 * It needs the 1/x field, the induced dipole, and the two unequal Coulomb forces on
 * the two faces of one grain, all at once. So the figure is three panels driven by
 * one simulation: (a) the tube you can rotate, (b) the mechanism on a single grain,
 * (c) the scaling laws on log axes.
 *
 * Why it is hand-rolled rather than three.js: CLAUDE.md forbids new npm dependencies
 * and tests/external-assets.test.js forbids third-party origins, so a 3-D library
 * would have to be vendored — ~600 KB shipped to the most-visited page type on the
 * site for one problem. The scene is a cylinder, a line and ~1300 points; a camera
 * and a painter's-algorithm pass over Canvas 2-D covers it in a few hundred lines,
 * and hairline canvas strokes read closer to a printed figure than a lit render.
 *
 * Design rules it obeys (see css/figures.css): flat ink on white, no gradients, no
 * glows, no shadows, six colours, every one separated in luminance so the figure
 * survives greyscale and red-green colour blindness. Fractions are encoded by colour
 * *and* diameter, so colour is never the only channel.
 *
 * Lifecycle follows the D3 globe in views/contributors_ranking.ejs: paused off-screen
 * and on document.hidden, capped frame rate, fewer grains on small screens, honours
 * prefers-reduced-motion, tears itself down on pagehide.
 */
(function () {
    "use strict";

    var root = document.querySelector('[data-ss-figure="precipitator"]');
    if (!root) return;                       // not this page

    var cfgNode = root.querySelector('[data-fig-config="precipitator"]');
    var CFG = { lang: "en", strings: {} };
    try { CFG = JSON.parse(cfgNode.textContent); } catch (e) { /* keep defaults */ }
    var S = CFG.strings || {};

    var canvasA = root.querySelector('[data-fig-canvas="a"]');
    var canvasB = root.querySelector('[data-fig-canvas="b"]');
    var canvasC = root.querySelector('[data-fig-canvas="c"]');
    if (!canvasA || !canvasB || !canvasC || !canvasA.getContext) return;

    var ctxA = canvasA.getContext("2d");
    var ctxB = canvasB.getContext("2d");
    var ctxC = canvasC.getContext("2d");
    if (!ctxA || !ctxB || !ctxC) return;

    /* ------------------------------------------------------------------ palette */

    var INK = "#1a1a2e";
    var MUTED = "#6c757d";
    var HOT = "#e5194b";                     // the live electrode, crimson
    var COL_A = "#00857a";                   // panel c: the small-grain force curve, teal
    var COL_B = "#b8560f";                   // panel c: the large-grain force curve, umber
    var FIELDC = "#8b5cf6";                  // the E reference curve, violet
    var DEPOSIT = "#2d2d2d";
    var RULE = "#dee2e6";
    var PAPER = "#ffffff";

    /* The same stack the statement and the solution are set in (solution_post.ejs:211):
       Latin from Latin Modern, Cyrillic falling through per-glyph to CMU Serif. Canvas does
       not itself trigger a webfont download, so start() asks for these explicitly. */
    var BODY = '"Computer Modern Serif", "Latin Modern Roman", "CMU Serif", "Times New Roman", serif';
    var TXT = 1;                             // css font-size / 15, refreshed on every layout
    var MATHF = '"Latin Modern Roman", "CMU Serif", "STIX Two Math", "Times New Roman", serif';

    /* ------------------------------------------------------------------ physics */

    var EPS1 = 2;                            // fine fraction, fixed by the caption
    var RHO0 = 0.02;                         // r0/R0 — sets Λ = ln(R0/r0)
    var LAMBDA = Math.log(1 / RHO0);
    var RHO_CATCH = 0.035;                   // grains this close count as collected
    var U_AXIAL = 0.16;                      // plug-flow speed, tube lengths per second
    var K_BASE = 0.048;                      // sets the drift timescale; see the header
    var DEP_TAU = 6.0;                       // deposit memory, seconds
    var HH = 1.55;                           // tube half-height in radii
    var DEP_BINS = 64;

    /** Clausius–Mossotti factor (ε−1)/(ε+2) — the whole ε dependence of part (b). */
    function K(eps) { return (eps - 1) / (eps + 2); }

    var params = { V: 1, eps2: 6, rad: 1.6 };

    /* Radial drift constant. The grain is overdamped in air, so Stokes drag balances
       the dielectrophoretic force and ρ̇ = −k/ρ³ with k ∝ a²·K(ε)·V². Note a² here and
       a³ in the force itself — drag also scales with the radius. */
    function driftK(a, eps) {
        return K_BASE * a * a * K(eps) * params.V * params.V;
    }

    /* Force in units of "fine grain, V = 1, at the tube wall", for panel c. */
    function forceOf(a, eps, rho) {
        return (Math.pow(a, 3) * K(eps) * params.V * params.V) / (K(EPS1) * rho * rho * rho);
    }

    /* ----------------------------------------------------------------- particles */

    var small = window.matchMedia && window.matchMedia("(max-width: 899px)").matches;
    var cores = navigator.hardwareConcurrency || 8;
    var N = small ? 900 : cores <= 4 ? 1200 : 2400;
    var nActive = N;                         // trimmed at runtime if frames get expensive

    var pr = new Float32Array(N);            // radius fraction ρ
    var pct = new Float32Array(N);           // cos θ and sin θ, cached: θ never changes for a
    var pst = new Float32Array(N);           //   grain, and recomputing them was 2N trig calls a frame
    var pz = new Float32Array(N);            // height fraction, 0 = inlet (top)
    var psp = new Uint8Array(N);             // 0 = fine, 1 = coarse
    var pshape = new Uint8Array(N);          // which mote outline this grain wears
    var deposit = new Float32Array(DEP_BINS);
    var caughtA = 0, caughtB = 0, seenA = 0, seenB = 0;   // capture efficiency, decayed

    var seed = 6615;
    function rnd() {                          // deterministic, so a reset is reproducible
        seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
        return seed / 0x7fffffff;
    }

    function seedGrain(i, freshZ) {
        pr[i] = Math.sqrt(rnd()) * (1 - RHO_CATCH) + RHO_CATCH;   // uniform over the cross-section
        var th = rnd() * Math.PI * 2;
        pct[i] = Math.cos(th);
        pst[i] = Math.sin(th);
        pz[i] = freshZ ? rnd() * 0.03 : rnd();   // spread the inlet, or it piles onto the rim
        if (psp[i]) seenB++; else seenA++;
    }

    function resetParticles() {
        seed = 6615;
        for (var i = 0; i < N; i++) {
            psp[i] = rnd() < 0.35 ? 1 : 0;    // coarse dust is the minority, as in real air
            pshape[i] = (rnd() * SHAPES) | 0;
            seedGrain(i, false);
        }
        deposit.fill(0);
        caughtA = caughtB = seenA = seenB = 0;
    }

    function step(dt) {
        var kA = driftK(1, EPS1);
        var kB = driftK(params.rad, params.eps2);
        var decay = Math.exp(-dt / DEP_TAU);
        var i, k, r4, rho, catch4 = RHO_CATCH * RHO_CATCH * RHO_CATCH * RHO_CATCH;
        var dz = U_AXIAL * dt, k4A = 4 * kA * dt, k4B = 4 * kB * dt;

        for (i = 0; i < DEP_BINS; i++) deposit[i] *= decay;
        caughtA *= decay; caughtB *= decay; seenA *= decay; seenB *= decay;

        for (i = 0; i < nActive; i++) {
            k = psp[i] ? k4B : k4A;
            rho = pr[i];
            /* Closed-form step of ρ̇ = −k/ρ³. Euler blows up as ρ → 0, where 1/ρ³ is
               unbounded; ρ⁴ − 4k·dt is exact and unconditionally stable. Two sqrts beat
               Math.pow(r4, 0.25) by a wide margin at this call count. */
            r4 = rho * rho * rho * rho - k;
            pz[i] += dz;

            if (r4 <= catch4) {
                var bin = (pz[i] * DEP_BINS) | 0;
                if (bin < 0) bin = 0; else if (bin >= DEP_BINS) bin = DEP_BINS - 1;
                deposit[bin] += 1;
                if (psp[i]) caughtB++; else caughtA++;
                seedGrain(i, true);
                continue;
            }
            pr[i] = Math.sqrt(Math.sqrt(r4));
            if (pz[i] > 1) seedGrain(i, true);
        }

        /* Panel b's single grain, on the same ρ⁴ = ρ₀⁴ − 4kt law, slowed so one traverse
           reads at a glance. With V = 0 it does not move, which is the honest answer. */
        var b4 = bGrainX * bGrainX * bGrainX * bGrainX - 4 * kB * 0.18 * dt;
        bGrainX = b4 <= B_X1 * B_X1 * B_X1 * B_X1 ? B_X0 : Math.sqrt(Math.sqrt(b4));
    }

    /* ------------------------------------------------------------ grain sprites */

    /* Real dust is not spherical, and a field of identical discs looks like a screensaver.
       Each grain wears one of a few irregular outlines, pre-rendered once into small
       offscreen canvases: the variety is free at draw time, and blitting a sprite is
       cheaper than tessellating a path per grain. */
    var SHAPES = 7;
    var RAMP = 14;                           // colour steps from the tube wall to the wire
    var RAMP_GAMMA = 0.85;                   /* Grains are seeded uniformly over the
       cross-section, so their density runs as ρ and most of them sit in the outer half of
       the tube. Straight 1 − ρ therefore spent the whole population in the blue end of the
       scale; this leans it warm just enough that the wall is blue, mid-tube magenta and
       the last third properly red. */
    var SPRITE_PX = 26;
    var COLD = "#0000ff";                    // at the wall, where E is weakest
    var HOTC = "#ff0000";                    // at the wire, where E blows up
    var sprites = null;
    var rampLut = new Uint8Array(256);

    function hexToRgb(h) {
        return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    }
    function mixHex(a, b, t) {
        var A = hexToRgb(a), B = hexToRgb(b);
        return "rgb(" + Math.round(A[0] + (B[0] - A[0]) * t) + "," +
                        Math.round(A[1] + (B[1] - A[1]) * t) + "," +
                        Math.round(A[2] + (B[2] - A[2]) * t) + ")";
    }

    /* Blue to red, straight between the two primaries. Any two-endpoint ramp has to pass
       through purple at the halfway mark; the smoothstep keeps the run close to one end or
       the other for most of its length so that crossing is brief, and both ends read as
       what they are. */
    function rampColor(t) {
        return mixHex(COLD, HOTC, t * t * (3 - 2 * t));
    }

    function buildRampLut() {
        for (var i = 0; i < 256; i++) {
            var t = Math.pow(1 - i / 255, RAMP_GAMMA);   // 0 at the tube wall, 1 at the wire
            rampLut[i] = Math.min(RAMP - 1, (t * RAMP) | 0);
        }
    }

    function buildSprites() {
        sprites = [];
        buildRampLut();
        var outline = [];
        var srnd = 20260909;
        function r01() { srnd = (srnd * 1664525 + 1013904223) & 0x7fffffff; return srnd / 0x7fffffff; }
        for (var q = 0; q < SHAPES; q++) {
            var n = 6 + ((r01() * 3) | 0), spin = r01() * Math.PI * 2, rs = [];
            for (var v = 0; v < n; v++) rs.push(0.72 + 0.28 * r01());
            outline.push({ n: n, spin: spin, rs: rs });
        }
        for (var lv = 0; lv < RAMP; lv++) {
            var fill = rampColor(lv / (RAMP - 1));
            for (var k = 0; k < SHAPES; k++) {
                var cv = document.createElement("canvas");
                cv.width = cv.height = SPRITE_PX;
                var g = cv.getContext("2d");
                var c = SPRITE_PX / 2, rad = SPRITE_PX * 0.40, o = outline[k];
                g.beginPath();
                for (var v = 0; v < o.n; v++) {
                    var a = o.spin + (v / o.n) * Math.PI * 2;
                    var rr = rad * o.rs[v];
                    var x = c + Math.cos(a) * rr, y = c + Math.sin(a) * rr;
                    if (v === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.closePath();
                g.fillStyle = fill;
                g.fill();
                /* A darker facet on one side reads as a lit grain rather than a flat blob,
                   and survives being scaled down to three pixels. */
                g.globalCompositeOperation = "source-atop";
                g.globalAlpha = 0.28;
                g.fillStyle = "#000";
                g.beginPath();
                g.moveTo(c, 0);
                g.lineTo(SPRITE_PX, SPRITE_PX);
                g.lineTo(0, SPRITE_PX);
                g.closePath();
                g.fill();
                sprites.push(cv);
            }
        }
    }

    resetParticles();

    /* -------------------------------------------------------------------- camera */

    var cam = { az: 0.62, el: 0.24, dist: 4.4 };
    var FOV = 32 * Math.PI / 180;
    var FOCAL = 1 / Math.tan(FOV / 2);

    var view = { cx: 0, cy: 0, k: 1 };       // filled in by fitCamera()

    var ca = 1, sa = 0, ce = 1, se = 0;
    function updateTrig() {
        ca = Math.cos(cam.az); sa = Math.sin(cam.az);
        ce = Math.cos(cam.el); se = Math.sin(cam.el);
    }
    updateTrig();

    /* World (x, y, z) -> screen. y is the tube axis. Returns null behind the camera.
       projectFast() hands back one shared object and is only safe where the result is
       consumed before the next call; project() allocates, so a caller may hold two points
       at once. Getting this backwards silently draws zero-length lines. */
    var _p = { x: 0, y: 0, s: 0, d: 0 };
    function projectFast(x, y, z) {
        var x1 = x * ca - z * sa;
        var z1 = x * sa + z * ca;
        var y2 = y * ce - z1 * se;
        var z2 = y * se + z1 * ce;
        var d = cam.dist - z2;
        if (d < 0.08) return null;
        var s = FOCAL / d;
        _p.x = view.cx + x1 * s * view.k;
        _p.y = view.cy - y2 * s * view.k;
        _p.s = s * view.k;
        _p.d = d;
        return _p;
    }
    function project(x, y, z) {
        var q = projectFast(x, y, z);
        return q && { x: q.x, y: q.y, s: q.s, d: q.d };
    }

    /* Camera azimuth as an angle on the (cosθ, sinθ) surface parametrisation, and the
       half-width of the arc that faces the viewer (the perspective silhouette). */
    function camAngle() { return Math.PI / 2 - cam.az; }
    function nearHalfWidth() {
        var rhoC = cam.dist * ce;
        return Math.acos(Math.min(0.999, 1 / Math.max(1.001, rhoC)));
    }

    function fitCamera(w, h) {
        /* Scale so the tube fills the panel with a consistent margin at any aspect. */
        var sMid = FOCAL / cam.dist;
        var halfW = 1.14 * sMid;
        var halfH = (HH + 0.58) * sMid;                 // room for the +V lead and its label
        view.k = Math.min((w * 0.88) / (2 * halfW), (h * 0.90) / (2 * halfH));
        view.cx = w / 2;
        view.cy = h / 2;
    }

    /* ------------------------------------------------------------------ canvases */

    var dpr = 1, sizeA = { w: 0, h: 0 }, sizeB = { w: 0, h: 0 }, sizeC = { w: 0, h: 0 };

    function sizeCanvas(cv, ctx, out) {
        var r = cv.getBoundingClientRect();
        var w = Math.max(1, Math.round(r.width));
        var h = Math.max(1, Math.round(r.height));
        dpr = Math.min(2.5, window.devicePixelRatio || 1);
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
            cv.width = Math.round(w * dpr);
            cv.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        out.w = w; out.h = h;
    }

    /* ----------------------------------------------------------- text primitives */

    /* Words are set in Inter (a Nature figure is sans-labelled); single symbols are set
       in Latin Modern italic so they match the server-rendered TeX elsewhere on the page.
       A label is therefore a list of runs, laid out here rather than in one fillText. */
    /* measureText is one of the more expensive things a 2-D context does, and drawRuns
       used to call it twice per run. Widths are memoised on (font, text) and the cache is
       dropped whenever the type scale or the webfonts change. */
    var textCache = new Map();
    var _wbuf = [];

    function measure(ctx, font, text) {
        var key = font + "\u0000" + text;
        var w = textCache.get(key);
        if (w === undefined) {
            ctx.font = font;
            w = ctx.measureText(text).width;
            textCache.set(key, w);
        }
        return w;
    }

    function drawRuns(ctx, x, y, runs, align) {
        var i, n = runs.length, w = 0;
        for (i = 0; i < n; i++) { _wbuf[i] = measure(ctx, runs[i].f, runs[i].t); w += _wbuf[i]; }
        var cx = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (i = 0; i < n; i++) {
            ctx.font = runs[i].f;
            ctx.fillStyle = runs[i].c || INK;
            ctx.fillText(runs[i].t, cx, y + (runs[i].dy || 0));
            cx += _wbuf[i];
        }
        return w;
    }

    function sym(t, px, color) { return { t: t, f: "italic " + (px * TXT) + 'px ' + MATHF, c: color }; }
    function sub(t, px, color) { return { t: t, f: ((px - 3) * TXT) + "px " + MATHF, c: color, dy: (px * TXT * 0.22) }; }
    function sup(t, px, color) { return { t: t, f: ((px - 3) * TXT) + "px " + MATHF, c: color, dy: -(px * TXT * 0.34) }; }
    function word(t, px, color, weight) { return { t: t, f: (weight || 400) + " " + (px * TXT) + "px " + BODY, c: color }; }

    function panelLetter(ctx, letter) {
        ctx.font = "400 " + 15 * TXT + "px " + BODY;
        ctx.fillStyle = INK;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(letter, 0, 0);
    }

    function arrowHead(ctx, x, y, ux, uy, size) {
        var px = -uy, py = ux;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - ux * size + px * size * 0.42, y - uy * size + py * size * 0.42);
        ctx.lineTo(x - ux * size - px * size * 0.42, y - uy * size - py * size * 0.42);
        ctx.closePath();
        ctx.fill();
    }

    /* ---------------------------------------------------------------- panel a: 3-D */

    var showPaths = true;
    var RING_N = 6, RING_SEG = 72, GEN_N = 12;

    function tubeLines(ctx, nearPass) {
        var thC = camAngle(), hw = nearHalfWidth();
        var i, j, th, p, y, first;

        /* Rings and generatrices are stroked as two batched paths — everything on the far
           side of the silhouette, then everything on the near side — so a whole wireframe
           costs two stroke calls instead of one per segment. The two halves go on
           different cached layers, with the grains sandwiched between them. */
        for (var pass = 0; pass < 1; pass++) {
            ctx.beginPath();
            for (i = 0; i < RING_N; i++) {
                y = -HH + (2 * HH * i) / (RING_N - 1);
                first = true;
                for (j = 0; j <= RING_SEG; j++) {
                    th = (j / RING_SEG) * Math.PI * 2;
                    var d = Math.abs(((th - thC + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
                    if ((d < hw) !== nearPass) { first = true; continue; }
                    p = projectFast(Math.cos(th), y, Math.sin(th));
                    if (!p) { first = true; continue; }
                    if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
                }
            }
            for (i = 0; i < GEN_N; i++) {
                th = (i / GEN_N) * Math.PI * 2;
                var dd = Math.abs(((th - thC + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
                if ((dd < hw) !== nearPass) continue;
                p = projectFast(Math.cos(th), -HH, Math.sin(th));
                if (!p) continue;
                ctx.moveTo(p.x, p.y);
                p = projectFast(Math.cos(th), HH, Math.sin(th));
                if (p) ctx.lineTo(p.x, p.y);
            }
            ctx.strokeStyle = INK;
            ctx.globalAlpha = nearPass ? 0.30 : 0.09;
            ctx.lineWidth = 0.8;
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    function tubeShell(ctx) {
        /* The body silhouette only. Filling the end caps too made an open pipe read as a
           closed can, and buried the R0 leader drawn on the top rim. */
        var j, th, p;
        ctx.beginPath();
        for (j = 0; j <= RING_SEG; j++) {
            th = (j / RING_SEG) * Math.PI * 2;
            p = projectFast(Math.cos(th), HH, Math.sin(th));
            if (!p) return;
            if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        for (j = RING_SEG; j >= 0; j--) {
            th = (j / RING_SEG) * Math.PI * 2;
            p = projectFast(Math.cos(th), -HH, Math.sin(th));
            if (!p) return;
            ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.fillStyle = INK;
        ctx.globalAlpha = 0.035;
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    /* The wire, with whatever has settled on it. The deposit profile along the tube is
       the distribution of collection depths — grains that entered near the wall travel
       further before they are caught — so it is data, not decoration. */
    function wireAndDeposit(ctx) {
        var pts = [], i, p, y;
        for (i = 0; i <= DEP_BINS; i++) {
            y = HH - (2 * HH * i) / DEP_BINS;            // z = 0 is the top inlet
            p = project(0, y, 0);
            if (!p) return;
            pts.push({ x: p.x, y: p.y, s: p.s });
        }

        var peak = 1;
        for (i = 0; i < DEP_BINS; i++) if (deposit[i] > peak) peak = deposit[i];
        var norm = Math.min(1, peak / (N * 0.06));

        ctx.beginPath();
        for (i = 0; i <= DEP_BINS; i++) {
            var v = deposit[Math.min(DEP_BINS - 1, i)] / peak;
            var hw = (0.005 + 0.014 * v * norm) * pts[i].s;
            if (i === 0) ctx.moveTo(pts[i].x - hw, pts[i].y); else ctx.lineTo(pts[i].x - hw, pts[i].y);
        }
        for (i = DEP_BINS; i >= 0; i--) {
            var v2 = deposit[Math.min(DEP_BINS - 1, i)] / peak;
            var hw2 = (0.005 + 0.014 * v2 * norm) * pts[i].s;
            ctx.lineTo(pts[i].x + hw2, pts[i].y);
        }
        ctx.closePath();
        ctx.fillStyle = DEPOSIT;
        ctx.globalAlpha = 0.42;
        ctx.fill();
        ctx.globalAlpha = 1;

        var top = project(0, HH + 0.22, 0), bot = project(0, -HH - 0.22, 0);
        ctx.beginPath();
        if (top) ctx.moveTo(top.x, top.y); else ctx.moveTo(pts[0].x, pts[0].y);
        if (bot) ctx.lineTo(bot.x, bot.y); else ctx.lineTo(pts[DEP_BINS].x, pts[DEP_BINS].y);
        ctx.strokeStyle = PAPER;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 4.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = HOT;
        ctx.lineWidth = 2.2;
        ctx.stroke();
    }

    /* A cloud of moving dots shows that something happens; four integrated paths show
       what. Each is the exact solution x⁴ = x₀⁴ − 4kt of the same drift the grains obey,
       so the coarse pair visibly reaches the wire while the fine pair is still falling. */
    function streamlines(ctx) {
        var specs = [
            { r0: 0.97, dth: 0.95, sp: 1 },
            { r0: 0.88, dth: -1.25, sp: 1 },
            { r0: 0.97, dth: 2.35, sp: 0 },
            { r0: 0.74, dth: -2.45, sp: 0 }
        ];
        var thC = camAngle();
        ctx.save();
        ctx.lineCap = "round";
        for (var i = 0; i < specs.length; i++) {
            var sp = specs[i];
            var k = driftK(sp.sp ? params.rad : 1, sp.sp ? params.eps2 : EPS1);
            var th = thC + sp.dth, cth = Math.cos(th), sth = Math.sin(th);
            var r04 = Math.pow(sp.r0, 4), catch4 = Math.pow(RHO_CATCH, 4);
            ctx.lineWidth = sp.sp ? 2.2 : 1.1;
            ctx.globalAlpha = 0.9;

            var prev = null, lastRho = sp.r0;
            for (var q = 0; q <= 90; q++) {
                var t = (q / 90) * (1 / U_AXIAL);
                var r4 = r04 - 4 * k * t;
                if (r4 <= catch4) break;
                var rho = Math.sqrt(Math.sqrt(r4));
                var pt = projectFast(rho * cth, HH - 2 * HH * (U_AXIAL * t), rho * sth);
                if (!pt) { prev = null; continue; }
                if (prev) {
                    /* One short stroke per step, coloured by where the grain is: the path
                       reddens as it closes on the wire, exactly as the grains do. */
                    ctx.strokeStyle = rampColor(Math.pow(1 - (rho + lastRho) / 2, RAMP_GAMMA));
                    ctx.beginPath();
                    ctx.moveTo(prev.x, prev.y);
                    ctx.lineTo(pt.x, pt.y);
                    ctx.stroke();
                }
                prev = { x: pt.x, y: pt.y };
                lastRho = rho;
            }
            if (prev) {
                ctx.fillStyle = rampColor(Math.pow(1 - lastRho, RAMP_GAMMA));
                ctx.beginPath();
                ctx.arc(prev.x, prev.y, ctx.lineWidth * 1.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    var BINS = 48;
    var binHead = new Int32Array(BINS);
    var binNext = new Int32Array(N);

    var _px = new Float32Array(N), _py = new Float32Array(N), _pd = new Float32Array(N);

    function drawParticles(ctx, dMin, dMax, wireDepth, drawWire) {
        var i, b, p;
        binHead.fill(-1);
        var span = Math.max(0.001, dMax - dMin);
        var binK = BINS / span;
        var yTop = HH, yK = 2 * HH;

        /* One projection pass, cached — the draw pass below walks the same grains again,
           and reprojecting them cost as much as drawing them. */
        for (i = 0; i < nActive; i++) {
            var rho = pr[i];
            p = projectFast(rho * pct[i], yTop - yK * pz[i], rho * pst[i]);
            if (!p) { binNext[i] = -2; _pd[i] = -1; continue; }
            _px[i] = p.x; _py[i] = p.y; _pd[i] = p.d;
            b = ((p.d - dMin) * binK) | 0;
            if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
            binNext[i] = binHead[b];
            binHead[b] = i;
        }

        var wireBin = ((wireDepth - dMin) * binK) | 0;
        if (wireBin < 0) wireBin = 0; else if (wireBin >= BINS) wireBin = BINS - 1;

        var FINE_R = 1.5;                                 // radius in CSS px at the default camera
        var COARSE_R = 1.5 * Math.min(2.4, params.rad);   // part (d), drawn to scale
        var dist = cam.dist;
        var prevAlpha = -1;

        for (b = BINS - 1; b >= 0; b--) {                    // far to near
            if (b === wireBin && drawWire) drawWire();
            var head = binHead[b];
            if (head === -1) continue;
            var t = 1 - b / (BINS - 1);                      // 0 = far, 1 = near
            var a = 0.42 + 0.48 * t;
            if (a !== prevAlpha) { ctx.globalAlpha = a; prevAlpha = a; }
            for (i = head; i !== -1; i = binNext[i]) {
                if (_pd[i] < 0) continue;
                var sp = psp[i];
                var d = (sp ? COARSE_R : FINE_R) * (dist / _pd[i]);
                if (d < 0.7) d = 0.7; else if (d > 4.6) d = 4.6;
                var spr = sprites[rampLut[(pr[i] * 255) | 0] * SHAPES + pshape[i]];
                ctx.drawImage(spr, _px[i] - d, _py[i] - d, d + d, d + d);
            }
        }
        ctx.globalAlpha = 1;
    }

    function legendA(ctx, w, h) {
        var x = 2, y = h - 52 * TXT, mid = rampColor(0.42);
        ctx.globalAlpha = 1;

        /* Two sizes, one neutral colour: in this panel hue is the field, not the size. */
        var effA = seenA > 4 ? caughtA / seenA : 0;
        var effB = seenB > 4 ? caughtB / seenB : 0;
        var rows = [
            { r: 2.1 * TXT, label: S.fine || "small grains", eff: effA },
            { r: 5.0 * TXT, label: S.coarse || "large grains", eff: effB }
        ];
        for (var i = 0; i < rows.length; i++) {
            ctx.fillStyle = mid;
            ctx.beginPath();
            ctx.arc(x + 5 * TXT, y, rows[i].r, 0, Math.PI * 2);
            ctx.fill();
            drawRuns(ctx, x + 14 * TXT, y, [
                word(rows[i].label + "   ", 12, MUTED),
                word((S.settled || "settled") + " " + Math.round(rows[i].eff * 100) + "%", 12, INK)
            ], "left");
            y += 17 * TXT;
        }

        /* The colour scale, as discrete swatches — the ramp really is quantised, and a
           painted gradient would be the one gradient in the whole figure. */
        var sw = 9 * TXT, sh = 7 * TXT;
        for (i = 0; i < RAMP; i++) {
            ctx.fillStyle = rampColor(i / (RAMP - 1));
            ctx.fillRect(x + i * sw, y - sh / 2, sw - 1, sh);
        }
        drawRuns(ctx, x + RAMP * sw + 7 * TXT, y,
            [word(S.ramp || "weak field → strong", 12, MUTED)], "left");
    }

    function flowArrow(ctx, w, h) {
        /* Which way the air goes. An annotation, not part of the scene, so it is placed in
           screen space — anchored to the tube it would swing behind the wall on rotation. */
        var x = 16, y0 = h * 0.30, y1 = h * 0.46;
        ctx.save();
        ctx.strokeStyle = MUTED;
        ctx.fillStyle = MUTED;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
        ctx.stroke();
        arrowHead(ctx, x, y1, 0, 1, 5);
        ctx.save();
        ctx.translate(x - 6, (y0 + y1) / 2);
        ctx.rotate(-Math.PI / 2);
        drawRuns(ctx, 0, 0, [word(S.airflow || "air", 12, MUTED)], "center");
        ctx.restore();
        ctx.restore();
    }

    /* Labels ride on the scene as real DOM, so their maths is the page's own MathJax. */
    var labWire = root.querySelector('[data-fig-label="wire"]');
    var labTube = root.querySelector('[data-fig-label="tube"]');
    var labRad = root.querySelector('[data-fig-label="radius"]');

    function placeLabel(el, p, dx, dy) {
        if (!el) return;
        if (!p) { el.hidden = true; return; }
        el.hidden = false;
        el.style.transform = "translate(" + (p.x + dx) + "px," + (p.y + dy) + "px) translate(-50%,-50%)";
    }

    var backCv = null, backCtx = null, frontCv = null, frontCtx = null, sceneDirty = true;

    function layerFor(cv, w, h) {
        var ctx = cv.getContext("2d");
        var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
        if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        return ctx;
    }

    /* The tube, its wireframe, the trajectories and the annotations are ~2000 projections
       and a dozen strokes, and none of it changes while the grains fall. Drawing it into
       two offscreen layers — one behind the grains, one in front — and blitting those each
       frame is the single biggest thing keeping the frame rate up. */
    function buildScene(w, h) {
        if (!backCv) { backCv = document.createElement("canvas"); frontCv = document.createElement("canvas"); }
        fitCamera(w, h);
        backCtx = layerFor(backCv, w, h);
        frontCtx = layerFor(frontCv, w, h);

        tubeShell(backCtx);
        tubeLines(backCtx, false);
        if (showPaths) streamlines(backCtx);

        tubeLines(frontCtx, true);
        flowArrow(frontCtx, w, h);

        /* R0 leader, drawn into the near half of the top rim where it stays clear. */
        var thC = camAngle(), hw = nearHalfWidth();
        var pC = project(0, HH, 0);
        var pR = project(Math.cos(thC - 0.85), HH, Math.sin(thC - 0.85));
        if (pC && pR) {
            frontCtx.save();
            frontCtx.setLineDash([3, 2.5]);
            frontCtx.strokeStyle = INK; frontCtx.globalAlpha = 0.7; frontCtx.lineWidth = 0.9;
            frontCtx.beginPath(); frontCtx.moveTo(pC.x, pC.y); frontCtx.lineTo(pR.x, pR.y); frontCtx.stroke();
            frontCtx.restore();
            placeLabel(labRad, { x: (pC.x + pR.x) / 2, y: (pC.y + pR.y) / 2 }, 0, -12 * TXT);
        } else if (labRad) {
            labRad.hidden = true;
        }

        panelLetter(frontCtx, "a");
        placeLabel(labWire, project(0, HH + 0.20, 0), 0, -11 * TXT);
        placeLabel(labTube, project(Math.cos(thC + hw), -HH * 0.62, Math.sin(thC + hw)), 0, 0);

        sceneDirty = false;
    }

    function drawA(w, h) {
        if (sceneDirty) buildScene(w, h);

        ctxA.clearRect(0, 0, w, h);
        ctxA.drawImage(backCv, 0, 0, w, h);

        var dCentre = cam.dist;
        var reach = HH * Math.abs(se) + 1.05;
        drawParticles(ctxA, dCentre - reach, dCentre + reach, dCentre, wireOnA);

        ctxA.drawImage(frontCv, 0, 0, w, h);
        legendA(ctxA, w, h);
    }

    function wireOnA() { wireAndDeposit(ctxA); }

    /* ------------------------------------------------------- panel b: one grain */

    /* A cross-section through the tube, close in on the wire. Drawing the field as a fan
       of rays out of the wire — rather than as parallel arrows — is what makes the 1/x
       visible: the rays are evenly spaced in angle, so their linear density falls off as
       1/x on its own, with nothing to fake. The two faces of the grain then sit in
       measurably different fields, which is the whole of part (a).

       The grain drifts inward under the same law the grains in panel a obey, so the two
       arrows visibly grow as it closes on the wire. Only that half is redrawn each frame;
       the ray fan and the labels live on a cached layer. */

    var FAN = 0.46;                          // half-angle of the drawn fan
    var B_RAYS = 11;
    var B_X0 = 0.60, B_X1 = 0.22;            // the stretch of the fan the grain crosses
    var bGrainX = B_X0;
    var bCv = null, bStatic = null;
    var bGeom = { wx: 0, yMid: 0, reach: 0, halfH: 0 };

    function buildPanelB(w, h) {
        if (!bCv) bCv = document.createElement("canvas");
        var g = layerFor(bCv, w, h);
        panelLetter(g, "b");

        var padL = 16 * TXT, padR = 14 * TXT, padT = 36 * TXT, padB = 38 * TXT;
        var yMid = padT + (h - padT - padB) / 2;
        var wx = padL + 4;
        var reach = w - padR - wx;
        var halfH = (h - padT - padB) / 2;
        bGeom.wx = wx; bGeom.yMid = yMid; bGeom.reach = reach; bGeom.halfH = halfH;
        bGeom.padT = padT; bGeom.padB = padB; bGeom.padR = padR;
        if (reach < 60 || h < 90) { bStatic = null; return; }

        g.strokeStyle = HOT;
        g.fillStyle = HOT;
        g.lineWidth = 0.8;
        g.globalAlpha = 0.38;
        for (var i = 0; i < B_RAYS; i++) {
            var a = -FAN + (2 * FAN * i) / (B_RAYS - 1);
            var ca2 = Math.cos(a), sa2 = Math.sin(a);
            /* The outer rays would leave the panel through the top and bottom edges, so
               each is cut where it first meets the frame rather than at a fixed length. */
            var len = Math.min(reach, Math.abs(sa2) > 1e-3 ? halfH / Math.abs(sa2) : reach);
            var ex = wx + ca2 * len, ey = yMid + sa2 * len;
            g.beginPath();
            g.moveTo(wx + ca2 * 8, yMid + sa2 * 8);
            g.lineTo(ex - ca2 * 7, ey - sa2 * 7);
            g.stroke();
            arrowHead(g, ex - ca2 * 7, ey - sa2 * 7, ca2, sa2, 4.2);
        }
        g.globalAlpha = 1;

        g.beginPath();
        g.arc(wx, yMid, 4.6, 0, Math.PI * 2);
        g.fillStyle = HOT;
        g.fill();
        drawRuns(g, wx, yMid - 15 * TXT, [sym("+V", 14, HOT)], "center");

        drawRuns(g, wx + 9, padT - 8 * TXT, [word(S.stronger || "stronger field", 12, MUTED)], "left");
        drawRuns(g, w - padR, padT - 8 * TXT, [word(S.weaker || "weaker field", 12, MUTED)], "right");

        bStatic = g;
        dirtyB = false;
    }

    function drawB(w, h) {
        if (dirtyB || !bCv) buildPanelB(w, h);
        ctxB.clearRect(0, 0, w, h);
        if (!bStatic) return;
        ctxB.drawImage(bCv, 0, 0, w, h);

        var wx = bGeom.wx, yMid = bGeom.yMid, reach = bGeom.reach;
        if (reach < 60) return;

        var gx = wx + reach * bGrainX;
        var gR = Math.min(bGeom.halfH * 0.44, reach * 0.10 * params.rad);
        var xNear = gx - gR, xFar = gx + gR;

        /* Equipotential arcs through the two faces: equal potential steps crowd toward the
           wire, so the near arc is where the field is measurably stronger. */
        ctxB.save();
        ctxB.strokeStyle = INK;
        ctxB.globalAlpha = 0.30;
        ctxB.lineWidth = 0.8;
        ctxB.setLineDash([3.5, 3]);
        for (var f = 0; f < 2; f++) {
            ctxB.beginPath();
            ctxB.arc(wx, yMid, (f ? xFar : xNear) - wx, -FAN, FAN);
            ctxB.stroke();
        }
        ctxB.restore();

        var grainCol = rampColor(Math.pow(1 - bGrainX, RAMP_GAMMA));
        ctxB.beginPath();
        ctxB.arc(gx, yMid, gR, 0, Math.PI * 2);
        ctxB.fillStyle = PAPER;
        ctxB.fill();
        ctxB.fillStyle = grainCol;
        ctxB.globalAlpha = 0.13;
        ctxB.fill();
        ctxB.globalAlpha = 1;
        ctxB.strokeStyle = grainCol;
        ctxB.lineWidth = 1.6;
        ctxB.stroke();

        /* Induced bound charge: − on the face toward the wire, + on the far face. */
        ctxB.textAlign = "center";
        ctxB.textBaseline = "middle";
        ctxB.font = "400 " + 14 * TXT + "px " + BODY;
        ctxB.fillStyle = INK;
        for (var k = -1; k <= 1; k++) {
            var ang = k * 0.66;
            ctxB.fillText("−", gx - Math.cos(ang) * (gR - 6 * TXT), yMid + Math.sin(ang) * (gR - 6 * TXT));
            ctxB.fillText("+", gx + Math.cos(ang) * (gR - 6 * TXT), yMid + Math.sin(ang) * (gR - 6 * TXT));
        }

        ctxB.strokeStyle = INK;
        ctxB.fillStyle = INK;
        ctxB.lineWidth = 1.1;
        ctxB.beginPath();
        ctxB.moveTo(gx - gR * 0.40, yMid);
        ctxB.lineTo(gx + gR * 0.40, yMid);
        ctxB.stroke();
        arrowHead(ctxB, gx + gR * 0.40, yMid, 1, 0, 4);
        drawRuns(ctxB, gx, yMid - gR - 9 * TXT, [sym("p", 14, INK)], "center");

        /* The two Coulomb forces, drawn to the true ratio E(x−a) : E(x+a) at wherever the
           grain has got to, anchored on the faces they act on. Both grow as it closes in;
           the near one grows faster, which is why the resultant points inward at all. */
        var xg = bGrainX, ag = gR / reach;
        var eNear = 1 / Math.max(0.02, xg - ag);
        var eFar = 1 / (xg + ag);
        var unit = Math.min(reach * 0.22, 58 * TXT) * Math.min(1.7, 0.55 / Math.max(0.12, xg));
        var lFar = unit * (eFar / eNear);
        lFar = Math.min(lFar, (w - bGeom.padR) - xFar - 8);   // never leave the panel
        var yF = yMid + gR + 17 * TXT;

        ctxB.lineWidth = 1.8;
        ctxB.strokeStyle = COL_A;
        ctxB.fillStyle = COL_A;
        ctxB.beginPath();
        ctxB.moveTo(xNear, yF);
        ctxB.lineTo(Math.max(wx + 4, xNear - unit), yF);
        ctxB.stroke();
        arrowHead(ctxB, Math.max(wx + 4, xNear - unit), yF, -1, 0, 5.5);

        ctxB.strokeStyle = MUTED;
        ctxB.fillStyle = MUTED;
        ctxB.beginPath();
        ctxB.moveTo(xFar, yF);
        ctxB.lineTo(xFar + lFar, yF);
        ctxB.stroke();
        arrowHead(ctxB, xFar + lFar, yF, 1, 0, 5.5);

        drawRuns(ctxB, (xNear + Math.max(wx + 4, xNear - unit)) / 2, yF + 11 * TXT,
            [sym("qE", 13, COL_A), sub("near", 13, COL_A)], "center");
        drawRuns(ctxB, xFar + lFar / 2, yF + 11 * TXT,
            [sym("qE", 13, MUTED), sub("far", 13, MUTED)], "center");

        /* The resultant, and the statement it proves. */
        var yN = h - bGeom.padB + 12 * TXT;
        ctxB.strokeStyle = INK;
        ctxB.fillStyle = INK;
        ctxB.lineWidth = 2.2;
        var nl = Math.max(16, unit - lFar);
        var nx = wx + reach * 0.30;
        ctxB.beginPath();
        ctxB.moveTo(nx, yN);
        ctxB.lineTo(nx - nl, yN);
        ctxB.stroke();
        arrowHead(ctxB, nx - nl, yN, -1, 0, 6);
        drawRuns(ctxB, nx + 9 * TXT, yN,
            [sym("F", 13.5, INK), word(" = ", 13.5, INK), sym("p", 13.5, INK),
             word(" ∂", 13.5, INK), sym("E", 13.5, INK), word("/∂", 13.5, INK),
             sym("x", 13.5, INK), word(" < 0", 13.5, INK)], "left");
    }

    /* ------------------------------------------------- panel c: the scaling laws */

    var C_XMIN = 0.05, C_XMAX = 1, C_YMIN = -1, C_YMAX = 7;
    var cCv = null, cStatic = null, dirtyC = true;
    var cGeom = { padL: 0, padT: 0, pw: 0, ph: 0, lx0: 0, lx1: 0 };

    function buildPanelC(w, h) {
        if (!cCv) cCv = document.createElement("canvas");
        var g = layerFor(cCv, w, h);
        panelLetter(g, "c");

        var padL = 52 * TXT, padR = 14 * TXT, padT = 48 * TXT, padB = 52 * TXT;
        var pw = w - padL - padR, ph = h - padT - padB;
        var lx0 = Math.log10(C_XMIN), lx1 = Math.log10(C_XMAX);
        cGeom.padL = padL; cGeom.padT = padT; cGeom.pw = pw; cGeom.ph = ph;
        cGeom.lx0 = lx0; cGeom.lx1 = lx1;
        if (pw < 40 || ph < 40) { cStatic = null; return; }

        function X(rho) { return padL + ((Math.log10(rho) - lx0) / (lx1 - lx0)) * pw; }
        function Y(dec) { return padT + ph - ((dec - C_YMIN) / (C_YMAX - C_YMIN)) * ph; }

        /* Frame: two axes, no box, no grid — a figure panel, not a spreadsheet. */
        g.strokeStyle = INK; g.lineWidth = 0.9; g.globalAlpha = 0.75;
        g.beginPath();
        g.moveTo(padL, padT); g.lineTo(padL, padT + ph); g.lineTo(padL + pw, padT + ph);
        g.stroke();
        g.globalAlpha = 1;

        var xTicks = [0.05, 0.1, 0.2, 0.5, 1];
        g.strokeStyle = MUTED; g.lineWidth = 0.8;
        for (var i = 0; i < xTicks.length; i++) {
            var xx = X(xTicks[i]);
            g.beginPath(); g.moveTo(xx, padT + ph); g.lineTo(xx, padT + ph + 4); g.stroke();
            drawRuns(g, xx, padT + ph + 15 * TXT, [word(String(xTicks[i]), 12, MUTED)], "center");
        }
        for (var d = 0; d <= 6; d += 2) {
            var yy = Y(d);
            g.beginPath(); g.moveTo(padL - 4, yy); g.lineTo(padL, yy); g.stroke();
            drawRuns(g, padL - 7 * TXT, yy,
                [word("10", 12, MUTED), { t: String(d), f: 9 * TXT + "px " + BODY, c: MUTED, dy: -4.5 * TXT }], "right");
        }

        /* A one-line statement of what the panel is for. The slope triangles below
           quantify it; this says in words what they are quantifying. Its length depends on
           the translation, so it is fitted to the panel rather than trusted to fit. */
        var title = S.cTitle || "closer to the wire: stronger field, larger force";
        var avail = w - 20 * TXT - padR;
        var ts = 12;
        while (ts > 8.5 && measure(g, 400 + " " + ts * TXT + "px " + BODY, title) > avail) ts -= 0.5;
        drawRuns(g, 20 * TXT, 15 * TXT, [word(title, ts, MUTED)], "left");

        drawRuns(g, padL + pw / 2, padT + ph + 32 * TXT,
            [word((S.axisX || "distance from the wire") + ",  ", 12.5, INK),
             sym("x", 13, INK), word("/", 13, INK), sym("R", 13, INK), sub("0", 13, INK)], "center");
        g.save();
        g.translate(13 * TXT, padT + ph / 2);
        g.rotate(-Math.PI / 2);
        drawRuns(g, 0, 0, [word(S.axisY || "force and field, wall = 1", 12, MUTED)], "center");
        g.restore();

        function plot(fn, color, width, dash, alpha) {
            g.save();
            g.beginPath();
            var started = false;
            for (var k = 0; k <= 90; k++) {
                var rho = Math.pow(10, lx0 + ((lx1 - lx0) * k) / 90);
                var v = fn(rho);
                if (!(v > 0)) { started = false; continue; }
                var dec = Math.log10(v);
                if (dec < C_YMIN - 1 || dec > C_YMAX + 1) { started = false; continue; }
                var px = X(rho), py = Y(Math.max(C_YMIN, Math.min(C_YMAX, dec)));
                if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
            }
            g.strokeStyle = color;
            g.lineWidth = width;
            g.globalAlpha = alpha || 1;
            if (dash) g.setLineDash(dash);
            g.stroke();
            g.restore();
        }

        plot(function (r) { return 1 / r; }, FIELDC, 1.5, [5, 3.5], 0.95);
        plot(function (r) { return forceOf(1, EPS1, r); }, COL_A, 1.9, null, 1);
        plot(function (r) { return forceOf(params.rad, params.eps2, r); }, COL_B, 1.9, null, 1);

        /* Slope triangles: the −3 and −1 the problem asks for, read straight off. */
        function slopeMark(rhoAt, fn, slope, color, label, below) {
            var v = fn(rhoAt);
            if (!(v > 0)) return;
            var dec = Math.log10(v);
            if (dec < C_YMIN || dec > C_YMAX - 0.4) return;
            var r2 = rhoAt * 1.9;
            if (r2 > C_XMAX) return;
            var xA = X(rhoAt), yA = Y(dec), xB = X(r2);
            var yC2 = Y(dec + slope * (Math.log10(r2) - Math.log10(rhoAt)));
            if (yC2 > padT + ph || yC2 < padT) return;
            g.save();
            g.strokeStyle = color; g.globalAlpha = 0.75; g.lineWidth = 0.9;
            g.beginPath();
            g.moveTo(xA, yA); g.lineTo(xB, yA); g.lineTo(xB, yC2);
            g.stroke();
            g.restore();
            /* Above the leg for the force curves, below it for E — E is the lowest curve,
               so its label would otherwise land on F1. */
            drawRuns(g, (xA + xB) / 2, yA + (below ? 20 : -15) * TXT, label, "center");
        }
        /* Read straight off the triangle: across that stretch the curve falls three
           decades for one decade of x — which is what F ∝ x⁻³ means. The bare number
           said nothing to anyone who had not already met a log-log slope. */
        slopeMark(0.14, function (r) { return forceOf(1, EPS1, r); }, -3, COL_A,
            [sym("F", 12, COL_A), word(" ∝ ", 12, COL_A), sym("x", 12, COL_A), sup("−3", 12, COL_A)]);
        slopeMark(0.34, function (r) { return 1 / r; }, -1, FIELDC,
            [sym("E", 12, FIELDC), word(" ∝ ", 12, FIELDC), sym("x", 12, FIELDC), sup("−1", 12, FIELDC)], true);

        function seriesLabel(fn, color, runs) {
            var v = fn(C_XMIN * 1.08);
            if (!(v > 0)) return;
            var dec = Math.log10(v);
            if (dec < C_YMIN || dec > C_YMAX) return;
            drawRuns(g, X(C_XMIN * 1.08) + 3, Y(dec) - 8 * TXT, runs, "left");
        }
        seriesLabel(function (r) { return forceOf(params.rad, params.eps2, r); }, COL_B,
            [sym("F", 12.5, COL_B), sub("2", 12.5, COL_B)]);
        seriesLabel(function (r) { return forceOf(1, EPS1, r); }, COL_A,
            [sym("F", 12.5, COL_A), sub("1", 12.5, COL_A)]);
        seriesLabel(function (r) { return 1 / r; }, FIELDC, [sym("E", 12.5, FIELDC)]);

        cStatic = g;
        dirtyC = false;
    }

    function drawC(w, h) {
        if (dirtyC || !cCv) buildPanelC(w, h);
        ctxC.clearRect(0, 0, w, h);
        if (!cStatic) return;
        ctxC.drawImage(cCv, 0, 0, w, h);
    }

    /* -------------------------------------------------------------------- export */

    var PAD = 14;

    function mjxImages(scale) {
        /* MathJax's SSR output is self-contained SVG using currentColor, so it can be
           rasterised into the export as-is once a fill is pinned on it. */
        var out = [];
        var labels = [labWire, labTube, labRad];
        var panelRect = canvasA.getBoundingClientRect();
        for (var i = 0; i < labels.length; i++) {
            var el = labels[i];
            if (!el || el.hidden) continue;
            var svg = el.querySelector("svg");
            if (!svg) continue;
            var r = svg.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            var clone = svg.cloneNode(true);
            clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
            clone.setAttribute("width", r.width);
            clone.setAttribute("height", r.height);
            clone.setAttribute("color", getComputedStyle(el).color);
            var url = "data:image/svg+xml;charset=utf-8," +
                encodeURIComponent(new XMLSerializer().serializeToString(clone));
            out.push({
                url: url,
                x: (r.left - panelRect.left + PAD) * scale,
                y: (r.top - panelRect.top + PAD) * scale,
                w: r.width * scale,
                h: r.height * scale
            });
        }
        return out;
    }

    function exportPng() {
        var scale = 3;
        var pad = PAD;
        var wA = sizeA.w, hA2 = sizeA.h, wB = sizeB.w, hB2 = sizeB.h, hC2 = sizeC.h;
        var gap = 18, foot = 38;
        var totalW = pad * 2 + wA + gap + wB;
        var totalH = pad + Math.max(hA2, hB2 + 14 + hC2) + foot;

        var out = document.createElement("canvas");
        out.width = Math.round(totalW * scale);
        out.height = Math.round(totalH * scale);
        var g = out.getContext("2d");
        g.fillStyle = PAPER;
        g.fillRect(0, 0, out.width, out.height);

        function blit(src, sw, sh, dx, dy) {
            g.drawImage(src, 0, 0, src.width, src.height,
                Math.round(dx * scale), Math.round(dy * scale),
                Math.round(sw * scale), Math.round(sh * scale));
        }
        blit(canvasA, wA, hA2, pad, pad);
        blit(canvasB, wB, hB2, pad + wA + gap, pad);
        blit(canvasC, sizeC.w, hC2, pad + wA + gap, pad + hB2 + 14);

        var imgs = mjxImages(scale);
        var pending = imgs.length;

        function finish() {
            g.textAlign = "left";
            g.textBaseline = "alphabetic";
            g.fillStyle = INK;
            g.font = "400 " + 13.5 * TXT * scale + "px " + BODY;
            g.fillText(S.figTitle || "", pad * scale, (totalH - foot + 18) * scale);
            g.fillStyle = MUTED;
            g.font = 400 + " " + 11.5 * TXT * scale + "px " + BODY;
            g.fillText(S.creditLine || "", pad * scale, (totalH - foot + 34) * scale);

            out.toBlob(function (blob) {
                if (!blob) return;
                var url = URL.createObjectURL(blob);
                var a = document.createElement("a");
                a.href = url;
                a.download = S.downloadName || "figure.png";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
            }, "image/png");
        }

        if (!pending) return finish();
        for (var i = 0; i < imgs.length; i++) {
            (function (spec) {
                var im = new Image();
                im.onload = function () {
                    g.drawImage(im, spec.x, spec.y, spec.w, spec.h);
                    if (--pending === 0) finish();
                };
                im.onerror = function () { if (--pending === 0) finish(); };
                im.src = spec.url;
            })(imgs[i]);
        }
    }

    /* ---------------------------------------------------------------- controls */

    var elV = root.querySelector('[data-fig-input="V"]');
    var elE = root.querySelector('[data-fig-input="eps"]');
    var elR = root.querySelector('[data-fig-input="rad"]');
    var outV = root.querySelector('[data-fig-value="V"]');
    var outE = root.querySelector('[data-fig-value="eps"]');
    var outR = root.querySelector('[data-fig-value="rad"]');
    var btnPlay = root.querySelector('[data-fig-btn="play"]');
    var btnField = root.querySelector('[data-fig-btn="field"]');
    var btnReset = root.querySelector('[data-fig-btn="reset"]');
    var btnPng = root.querySelector('[data-fig-btn="png"]');
    var btnPlayText = btnPlay && btnPlay.querySelector("[data-fig-btn-text]");
    var btnPlayGlyph = btnPlay && btnPlay.querySelector("[data-fig-glyph]");
    var hint = root.querySelector("[data-fig-hint]");

    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var dirtyB = true, needsDraw = true;

    function syncReadout() {
        if (outV) outV.textContent = params.V.toFixed(2);
        if (outE) outE.textContent = params.eps2.toFixed(1);
        if (outR) outR.textContent = params.rad.toFixed(2);
        dirtyB = true;
        dirtyC = true;
        needsDraw = true;
        sceneDirty = true;   // the trajectories are drawn from these numbers
    }

    function bindRange(el, key, parse) {
        if (!el) return;
        el.addEventListener("input", function () {
            params[key] = parse(el.value);
            syncReadout();
        });
    }
    bindRange(elV, "V", parseFloat);
    bindRange(elE, "eps2", parseFloat);
    bindRange(elR, "rad", parseFloat);

    var playing = !reduced;

    function setPlaying(on) {
        playing = on;
        if (btnPlay) btnPlay.setAttribute("aria-pressed", on ? "true" : "false");
        if (btnPlayText) btnPlayText.textContent = on ? (S.pause || "Pause") : (S.play || "Play");
        needsDraw = true;
        if (btnPlayGlyph) {
            btnPlayGlyph.innerHTML = on
                ? '<rect x="0" y="0" width="3" height="10" fill="currentColor"></rect><rect x="6" y="0" width="3" height="10" fill="currentColor"></rect>'
                : '<path d="M0 0 L9 5 L0 10 Z" fill="currentColor"></path>';
        }
    }
    setPlaying(playing);

    if (btnPlay) btnPlay.addEventListener("click", function () { setPlaying(!playing); });
    if (btnField) btnField.addEventListener("click", function () {
        showPaths = !showPaths;
        btnField.setAttribute("aria-pressed", showPaths ? "true" : "false");
        needsDraw = true;
        sceneDirty = true;
    });
    if (btnReset) btnReset.addEventListener("click", function () {
        params.V = 1; params.eps2 = 6; params.rad = 1.6;
        if (elV) elV.value = "1";
        if (elE) elE.value = "6";
        if (elR) elR.value = "1.6";
        cam.az = 0.62; cam.el = 0.24; cam.dist = 4.4;
        updateTrig();
        nActive = N;
        resetParticles();
        syncReadout();
    });
    if (btnPng) btnPng.addEventListener("click", exportPng);

    /* --------------------------------------------------------------- orbiting */

    var panelA = root.querySelector('[data-fig-panel="a"]');
    var dragging = false, lastX = 0, lastY = 0, pinch = 0, touched = false;

    function markTouched() {
        if (touched) return;
        touched = true;
        if (hint) { hint.classList.add("is-gone"); setTimeout(function () { if (hint) hint.hidden = true; }, 400); }
    }

    /* A one-off nudge the first time the pointer crosses the panel: the scene swings a few
       degrees and settles back. Nothing says "this turns" as quickly as seeing it turn, and
       it happens once, never on its own, and not at all for anyone who asked not to be
       moved. The grab cursor on the canvas says the same thing for anyone already there. */
    var nudged = false;
    function nudge() {
        if (nudged || touched || reduced) return;
        nudged = true;
        var az0 = cam.az, t0 = 0, DUR = 850;
        function stepNudge(ts) {
            if (!t0) t0 = ts;
            var u = Math.min(1, (ts - t0) / DUR);
            cam.az = az0 + 0.17 * Math.sin(u * Math.PI);
            updateTrig();
            sceneDirty = true;
            needsDraw = true;
            if (u < 1 && !dragging) requestAnimationFrame(stepNudge);
            else { cam.az = az0; updateTrig(); sceneDirty = true; needsDraw = true; }
        }
        requestAnimationFrame(stepNudge);
    }

    function orbit(dx, dy) {
        cam.az -= dx * 0.008;
        cam.el = Math.max(-1.2, Math.min(1.25, cam.el + dy * 0.006));
        updateTrig();
        needsDraw = true;
        sceneDirty = true;
    }

    canvasA.addEventListener("pointerenter", nudge);

    canvasA.addEventListener("pointerdown", function (e) {
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        if (panelA) panelA.classList.add("is-dragging");
        if (canvasA.setPointerCapture) { try { canvasA.setPointerCapture(e.pointerId); } catch (_) {} }
        markTouched();
    });
    canvasA.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        orbit(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX; lastY = e.clientY;
        e.preventDefault();
    });
    function endDrag() { dragging = false; if (panelA) panelA.classList.remove("is-dragging"); }
    canvasA.addEventListener("pointerup", endDrag);
    canvasA.addEventListener("pointercancel", endDrag);
    canvasA.addEventListener("pointerleave", endDrag);

    canvasA.addEventListener("wheel", function (e) {
        /* Only take the wheel once the reader has shown interest in this panel;
           otherwise scrolling the page past the figure would trap the scroll. */
        if (!touched) return;
        e.preventDefault();
        cam.dist = Math.max(2.6, Math.min(8, cam.dist + e.deltaY * 0.0035));
        needsDraw = true;
        sceneDirty = true;
    }, { passive: false });

    canvasA.addEventListener("touchmove", function (e) {
        if (e.touches.length !== 2) return;
        var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                           e.touches[0].clientY - e.touches[1].clientY);
        if (pinch) cam.dist = Math.max(2.6, Math.min(8, cam.dist * (pinch / d)));
        pinch = d;
        needsDraw = true;
        sceneDirty = true;
        e.preventDefault();
    }, { passive: false });
    canvasA.addEventListener("touchend", function () { pinch = 0; });

    canvasA.addEventListener("keydown", function (e) {
        var k = e.key, step2 = e.shiftKey ? 24 : 8;
        if (k === "ArrowLeft") orbit(-step2, 0);
        else if (k === "ArrowRight") orbit(step2, 0);
        else if (k === "ArrowUp") orbit(0, -step2);
        else if (k === "ArrowDown") orbit(0, step2);
        else if (k === "+" || k === "=") cam.dist = Math.max(2.6, cam.dist - 0.25);
        else if (k === "-") cam.dist = Math.min(8, cam.dist + 0.25);
        else return;
        needsDraw = true;
        sceneDirty = true;
        markTouched();
        e.preventDefault();
    });

    /* -------------------------------------------------------------- lifecycle */

    var onScreen = true, raf = 0, last = 0, lastDraw = 0;
    var MIN_FRAME = 1000 / 52;

    if ("IntersectionObserver" in window) {
        var io = new IntersectionObserver(function (entries) {
            onScreen = entries[0].isIntersecting;
        }, { threshold: 0.02 });
        io.observe(root);
    }

    function layout() {
        sizeCanvas(canvasA, ctxA, sizeA);
        sizeCanvas(canvasB, ctxB, sizeB);
        sizeCanvas(canvasC, ctxC, sizeC);
        /* Canvas text follows the page's type scale, but a label also has to fit the panel
           it is drawn in: on a phone the panels are half the width while the body text is
           only a third smaller, so the panel width gets a vote. */
        var cssFs = (parseFloat(getComputedStyle(root).fontSize) || 15) / 15;
        var newTxt = Math.max(0.75, Math.min(cssFs, sizeA.w / 430));
        if (newTxt !== TXT) { TXT = newTxt; textCache.clear(); }
        dirtyB = true;
        dirtyC = true;
        sceneDirty = true;
        needsDraw = true;
        textCache.clear();
    }

    /* Frame budget. A laptop that cannot hold 50 fps with 2400 grains gets fewer grains
       rather than a stuttering figure; it climbs back when there is headroom. Measured on
       a median of recent frames so one slow frame — a webfont landing, a GC — cannot
       ratchet the count down. */
    var costs = [8, 8, 8, 8, 8, 8, 8], costAt = 0, adaptAt = 0;

    function adapt(cost, ts) {
        costs[costAt = (costAt + 1) % costs.length] = cost;
        if (ts - adaptAt < 700) return;
        adaptAt = ts;
        var sorted = costs.slice().sort(function (a, b) { return a - b; });
        var med = sorted[sorted.length >> 1];
        if (med > 15 && nActive > 260) nActive = Math.max(260, (nActive * 0.75) | 0);
        else if (med < 8 && nActive < N) nActive = Math.min(N, (nActive * 1.25 + 40) | 0);
    }

    function frame(ts) {
        raf = requestAnimationFrame(frame);
        if (!onScreen || document.hidden) { last = ts; return; }
        if (ts - lastDraw < MIN_FRAME) return;
        if (!playing && !needsDraw) { last = ts; return; }

        var dt = last ? Math.min(0.06, (ts - last) / 1000) : 0;
        lastDraw = ts;
        last = ts;
        needsDraw = false;

        var t0 = performance.now();
        if (playing && dt > 0) step(dt);
        drawA(sizeA.w, sizeA.h);
        drawB(sizeB.w, sizeB.h);
        if (dirtyC) drawC(sizeC.w, sizeC.h);   // nothing in panel c moves on its own
        adapt(performance.now() - t0, ts);
    }

    var ro = null;
    if ("ResizeObserver" in window) {
        ro = new ResizeObserver(function () { layout(); });
        ro.observe(root);
    } else {
        window.addEventListener("resize", layout);
    }

    function teardown() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (ro) ro.disconnect();
        if (typeof io !== "undefined" && io) io.disconnect();
    }
    window.addEventListener("pagehide", teardown);

    function start() {
        buildSprites();
        layout();
        syncReadout();
        root.classList.add("is-live");
        drawA(sizeA.w, sizeA.h);
        drawB(sizeB.w, sizeB.h);
        drawC(sizeC.w, sizeC.h);
        if (!raf) raf = requestAnimationFrame(frame);
    }

    /* Metrics are wrong until the webfonts land, so lay out once now and once after. */
    start();
    if (document.fonts && document.fonts.load) {
        Promise.all([
            document.fonts.load('16px "Latin Modern Roman"', "Fx0"),
            document.fonts.load('italic 16px "Latin Modern Roman"', "Fx0"),
            document.fonts.load('16px "CMU Serif"', "пылинки")
        ]).catch(function () { /* a missing face just means the fallback stack */ })
          .then(function () { textCache.clear(); layout(); });
    } else if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { textCache.clear(); layout(); });
    }
})();
