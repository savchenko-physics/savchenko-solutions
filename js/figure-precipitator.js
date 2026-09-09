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
    var HOT = "#a93226";
    var COL_A = "#1a5276";                   // fine fraction
    var COL_B = "#b8791f";                   // coarse fraction
    var DEPOSIT = "#2d2d2d";
    var RULE = "#dee2e6";
    var PAPER = "#ffffff";

    var SANS = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
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

    /* Force ratio between the two fractions: the answer to parts (b) and (d). */
    function forceRatio() {
        return (K(params.eps2) / K(EPS1)) * Math.pow(params.rad, 3);
    }

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
    var weak = (navigator.hardwareConcurrency || 8) <= 4;
    var N = small || weak ? 700 : 2100;

    var pr = new Float32Array(N);            // radius fraction ρ
    var pth = new Float32Array(N);           // angle θ
    var pz = new Float32Array(N);            // height fraction, 0 = inlet (top)
    var psp = new Uint8Array(N);             // 0 = fine, 1 = coarse
    var deposit = new Float32Array(DEP_BINS);
    var caughtA = 0, caughtB = 0, seenA = 0, seenB = 0;   // capture efficiency, decayed

    var seed = 6615;
    function rnd() {                          // deterministic, so a reset is reproducible
        seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
        return seed / 0x7fffffff;
    }

    function seedGrain(i, freshZ) {
        pr[i] = Math.sqrt(rnd()) * (1 - RHO_CATCH) + RHO_CATCH;   // uniform over the cross-section
        pth[i] = rnd() * Math.PI * 2;
        pz[i] = freshZ ? rnd() * 0.03 : rnd();   // spread the inlet, or it piles onto the rim
        if (psp[i]) seenB++; else seenA++;
    }

    function resetParticles() {
        seed = 6615;
        for (var i = 0; i < N; i++) {
            psp[i] = rnd() < 0.35 ? 1 : 0;    // coarse dust is the minority, as in real air
            seedGrain(i, false);
        }
        deposit.fill(0);
        caughtA = caughtB = seenA = seenB = 0;
    }

    function step(dt) {
        var kA = driftK(1, EPS1);
        var kB = driftK(params.rad, params.eps2);
        var decay = Math.exp(-dt / DEP_TAU);
        var i, k, r4, rho, catch4 = Math.pow(RHO_CATCH, 4);

        for (i = 0; i < DEP_BINS; i++) deposit[i] *= decay;
        caughtA *= decay; caughtB *= decay; seenA *= decay; seenB *= decay;

        for (i = 0; i < N; i++) {
            k = psp[i] ? kB : kA;
            rho = pr[i];
            /* Closed-form step of ρ̇ = −k/ρ³. Euler blows up as ρ → 0, where 1/ρ³ is
               unbounded; ρ⁴ − 4k·dt is exact and unconditionally stable. */
            r4 = rho * rho * rho * rho - 4 * k * dt;
            pz[i] += U_AXIAL * dt;

            if (r4 <= catch4) {
                var bin = Math.min(DEP_BINS - 1, Math.max(0, (pz[i] * DEP_BINS) | 0));
                deposit[bin] += 1;
                if (psp[i]) caughtB++; else caughtA++;
                seedGrain(i, true);
                continue;
            }
            pr[i] = Math.pow(r4, 0.25);
            if (pz[i] > 1) seedGrain(i, true);
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
    function runsWidth(ctx, runs) {
        var w = 0;
        for (var i = 0; i < runs.length; i++) {
            ctx.font = runs[i].f;
            w += ctx.measureText(runs[i].t).width;
        }
        return w;
    }

    function drawRuns(ctx, x, y, runs, align) {
        var w = runsWidth(ctx, runs);
        var cx = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (var i = 0; i < runs.length; i++) {
            ctx.font = runs[i].f;
            ctx.fillStyle = runs[i].c || INK;
            ctx.fillText(runs[i].t, cx, y + (runs[i].dy || 0));
            cx += ctx.measureText(runs[i].t).width;
        }
        return w;
    }

    function sym(t, px, color) { return { t: t, f: "italic " + px + 'px ' + MATHF, c: color }; }
    function sub(t, px, color) { return { t: t, f: (px - 3) + "px " + MATHF, c: color, dy: (px * 0.22) }; }
    function word(t, px, color, weight) { return { t: t, f: (weight || 400) + " " + px + "px " + SANS, c: color }; }

    function panelLetter(ctx, letter) {
        ctx.font = "700 13px " + SANS;
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

    function tubeLines(ctx) {
        var thC = camAngle(), hw = nearHalfWidth();
        var i, j, th, p, y, first;

        /* Rings and generatrices are each stroked twice — once for everything on the
           far side of the silhouette, once for the near side — so a whole wireframe
           costs four stroke calls instead of one per segment. */
        for (var pass = 0; pass < 2; pass++) {
            var nearPass = pass === 1;
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
        ctx.lineWidth = 1.05;
        for (var i = 0; i < specs.length; i++) {
            var sp = specs[i];
            var k = driftK(sp.sp ? params.rad : 1, sp.sp ? params.eps2 : EPS1);
            var th = thC + sp.dth;
            var r04 = Math.pow(sp.r0, 4), catch4 = Math.pow(RHO_CATCH, 4);
            var lastX = 0, lastY = 0, prevX = 0, prevY = 0, started = false, n = 0;
            ctx.beginPath();
            for (var q = 0; q <= 90; q++) {
                var t = (q / 90) * (1 / U_AXIAL);
                var r4 = r04 - 4 * k * t;
                if (r4 <= catch4) break;
                var rho = Math.pow(r4, 0.25);
                var pt = projectFast(rho * Math.cos(th), HH - 2 * HH * (U_AXIAL * t), rho * Math.sin(th));
                if (!pt) { started = false; continue; }
                if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
                else { prevX = lastX; prevY = lastY; ctx.lineTo(pt.x, pt.y); }
                lastX = pt.x; lastY = pt.y; n++;
            }
            ctx.strokeStyle = sp.sp ? COL_B : COL_A;
            ctx.globalAlpha = 0.85;
            ctx.stroke();
            if (n > 2) {
                var dx = lastX - prevX, dy = lastY - prevY, L = Math.hypot(dx, dy) || 1;
                ctx.fillStyle = sp.sp ? COL_B : COL_A;
                arrowHead(ctx, lastX, lastY, dx / L, dy / L, 4.4);
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

        /* One projection pass, cached — the draw pass below walks the same grains again
           and reprojecting them cost as much as drawing them. */
        for (i = 0; i < N; i++) {
            p = projectFast(pr[i] * Math.cos(pth[i]), HH - 2 * HH * pz[i], pr[i] * Math.sin(pth[i]));
            if (!p) { binNext[i] = -2; _pd[i] = -1; continue; }
            _px[i] = p.x; _py[i] = p.y; _pd[i] = p.d;
            b = Math.min(BINS - 1, Math.max(0, (((p.d - dMin) / span) * BINS) | 0));
            binNext[i] = binHead[b];
            binHead[b] = i;
        }

        var wireBin = Math.min(BINS - 1, Math.max(0, (((wireDepth - dMin) / span) * BINS) | 0));
        var TAU = Math.PI * 2;
        var FINE_R = 1.15;                               // radius in CSS px at the default camera
        var COARSE_R = 1.15 * Math.min(2.2, params.rad); // part (d), drawn to scale

        for (b = BINS - 1; b >= 0; b--) {                    // far to near
            if (b === wireBin && drawWire) drawWire();
            if (binHead[b] === -1) continue;
            var t = 1 - b / (BINS - 1);                      // 0 = far, 1 = near
            ctx.globalAlpha = 0.26 + 0.40 * t;
            for (var sp = 0; sp < 2; sp++) {
                ctx.beginPath();
                var any = false;
                for (i = binHead[b]; i !== -1; i = binNext[i]) {
                    if (psp[i] !== sp || _pd[i] < 0) continue;
                    var d = (sp ? COARSE_R : FINE_R) * (cam.dist / _pd[i]);
                    d = Math.max(0.5, Math.min(3.4, d));
                    ctx.moveTo(_px[i] + d, _py[i]);
                    ctx.arc(_px[i], _py[i], d, 0, TAU);
                    any = true;
                }
                if (any) { ctx.fillStyle = sp ? COL_B : COL_A; ctx.fill(); }
            }
        }
        ctx.globalAlpha = 1;
    }

    function legendA(ctx, w, h) {
        var y = h - 32, x = 2;
        ctx.globalAlpha = 1;
        ctx.fillStyle = COL_A;
        ctx.beginPath(); ctx.arc(x + 3, y, 2.4, 0, Math.PI * 2); ctx.fill();
        drawRuns(ctx, x + 11, y, [word(S.fine || "fine", 11, MUTED)], "left");
        y += 14;
        ctx.fillStyle = COL_B;
        ctx.beginPath(); ctx.arc(x + 3, y, 3.6, 0, Math.PI * 2); ctx.fill();
        drawRuns(ctx, x + 11, y, [word(S.coarse || "coarse", 11, MUTED)], "left");

        /* Capture efficiency, decayed on the same clock as the deposit, so it reads the
           current settings rather than the whole history. */
        var effA = seenA > 4 ? caughtA / seenA : 0;
        var effB = seenB > 4 ? caughtB / seenB : 0;
        var rt = [word((S.caught || "captured") + "  ", 11, MUTED)];
        rt.push(word(Math.round(effA * 100) + "%", 11, COL_A, 600));
        rt.push(word(" / ", 11, MUTED));
        rt.push(word(Math.round(effB * 100) + "%", 11, COL_B, 600));
        drawRuns(ctx, x, h - 4, rt, "left");
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
        drawRuns(ctx, 0, 0, [word(S.airflow || "air", 10.5, MUTED)], "center");
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

    function drawA(w, h) {
        ctxA.clearRect(0, 0, w, h);
        fitCamera(w, h);

        tubeShell(ctxA);
        var thC = camAngle(), hw = nearHalfWidth();

        /* Far wireframe, then the cut-plane field, then grains with the wire slotted in
           at its own depth, then the near wireframe on top. */
        tubeLines(ctxA);
        if (showPaths) streamlines(ctxA);

        var dCentre = cam.dist;
        var dMin = dCentre - (HH * Math.abs(se) + 1.05);
        var dMax = dCentre + (HH * Math.abs(se) + 1.05);
        drawParticles(ctxA, dMin, dMax, dCentre, function () { wireAndDeposit(ctxA); });

        flowArrow(ctxA, w, h);

        /* R0 leader on the top rim, drawn into the far half where it stays clear. */
        var thR = thC - 0.85;
        var pC = project(0, HH, 0);
        var pR = project(Math.cos(thR), HH, Math.sin(thR));
        if (pC && pR) {
            var mx = (pC.x + pR.x) / 2, my = (pC.y + pR.y) / 2;
            ctxA.save();
            ctxA.setLineDash([3, 2.5]);
            ctxA.strokeStyle = INK; ctxA.globalAlpha = 0.7; ctxA.lineWidth = 0.9;
            ctxA.beginPath(); ctxA.moveTo(pC.x, pC.y); ctxA.lineTo(pR.x, pR.y); ctxA.stroke();
            ctxA.restore();
            placeLabel(labRad, { x: mx, y: my }, 0, -12);
        } else { if (labRad) labRad.hidden = true; }

        panelLetter(ctxA, "a");
        legendA(ctxA, w, h);

        placeLabel(labWire, project(0, HH + 0.20, 0), 0, -11);
        /* V = 0 names the wall, so it sits astride the left silhouette; the knockout
           behind it keeps both the label and the line underneath readable. */
        placeLabel(labTube, project(Math.cos(thC + hw), -HH * 0.62, Math.sin(thC + hw)), 0, 0);
    }

    /* ------------------------------------------------------- panel b: one grain */

    /* A cross-section through the tube, close in on the wire. Drawing the field as a fan
       of rays out of the wire — rather than as parallel arrows — is what makes the 1/x
       visible: the rays are evenly spaced in angle, so their linear density falls off as
       1/x on its own, with nothing to fake. The two faces of the grain then sit in
       measurably different fields, which is the whole of part (a). */
    function drawB(w, h) {
        ctxB.clearRect(0, 0, w, h);
        panelLetter(ctxB, "b");

        var padL = 16, padR = 12, padT = 30, padB = 30;
        var yMid = padT + (h - padT - padB) / 2;
        var wx = padL + 4;                                  // the wire, seen end-on
        var reach = w - padR - wx;
        if (reach < 60 || h < 90) return;

        var FAN = 0.46;                                      // half-angle of the drawn fan
        var nRays = 11;

        /* Field rays. */
        ctxB.save();
        ctxB.strokeStyle = HOT;
        ctxB.fillStyle = HOT;
        ctxB.lineWidth = 0.8;
        ctxB.globalAlpha = 0.38;
        var halfH = (h - padT - padB) / 2;
        for (var i = 0; i < nRays; i++) {
            var a = -FAN + (2 * FAN * i) / (nRays - 1);
            var ca2 = Math.cos(a), sa2 = Math.sin(a);
            /* The outer rays would leave the panel through the top and bottom edges, so
               each is cut where it first meets the frame rather than at a fixed length. */
            var len = Math.min(reach, Math.abs(sa2) > 1e-3 ? halfH / Math.abs(sa2) : reach);
            var ex = wx + ca2 * len, ey = yMid + sa2 * len;
            ctxB.beginPath();
            ctxB.moveTo(wx + ca2 * 8, yMid + sa2 * 8);
            ctxB.lineTo(ex - ca2 * 7, ey - sa2 * 7);
            ctxB.stroke();
            arrowHead(ctxB, ex - ca2 * 7, ey - sa2 * 7, ca2, sa2, 4.2);
        }
        ctxB.restore();

        /* The grain, on the central ray. Its drawn radius follows the R/r slider, so the
           part (d) control is visible here as well as in the numbers. */
        var gx = wx + reach * 0.56;
        var gR = Math.min((h - padT - padB) * 0.26, reach * 0.115 * params.rad);
        var xNear = gx - gR, xFar = gx + gR;

        /* Equipotential arcs through the two faces: equal potential steps crowd toward the
           wire, so the near arc is drawn where the field is measurably stronger. */
        ctxB.save();
        ctxB.strokeStyle = INK;
        ctxB.globalAlpha = 0.30;
        ctxB.lineWidth = 0.8;
        ctxB.setLineDash([3.5, 3]);
        for (var f = 0; f < 2; f++) {
            var rr = (f ? xFar : xNear) - wx;
            ctxB.beginPath();
            ctxB.arc(wx, yMid, rr, -FAN, FAN);
            ctxB.stroke();
        }
        ctxB.restore();

        /* The wire itself, end-on. */
        ctxB.beginPath();
        ctxB.arc(wx, yMid, 4.2, 0, Math.PI * 2);
        ctxB.fillStyle = HOT;
        ctxB.fill();
        drawRuns(ctxB, wx, yMid - 15, [sym("+V", 12, HOT)], "center");

        /* The grain. */
        ctxB.beginPath();
        ctxB.arc(gx, yMid, gR, 0, Math.PI * 2);
        ctxB.fillStyle = PAPER;
        ctxB.fill();
        ctxB.fillStyle = COL_B;
        ctxB.globalAlpha = 0.06;
        ctxB.fill();
        ctxB.globalAlpha = 1;
        ctxB.strokeStyle = COL_B;
        ctxB.lineWidth = 1.3;
        ctxB.stroke();

        /* Induced bound charge: − drawn on the face toward the wire, + on the far face. */
        ctxB.textAlign = "center";
        ctxB.textBaseline = "middle";
        ctxB.font = "600 12px " + SANS;
        ctxB.fillStyle = INK;
        for (var k = -1; k <= 1; k++) {
            var ang = k * 0.66;
            ctxB.fillText("−", gx - Math.cos(ang) * (gR - 5.5), yMid + Math.sin(ang) * (gR - 5.5));
            ctxB.fillText("+", gx + Math.cos(ang) * (gR - 5.5), yMid + Math.sin(ang) * (gR - 5.5));
        }

        /* Induced dipole moment. */
        ctxB.strokeStyle = INK;
        ctxB.fillStyle = INK;
        ctxB.lineWidth = 1.1;
        ctxB.beginPath();
        ctxB.moveTo(gx - gR * 0.40, yMid);
        ctxB.lineTo(gx + gR * 0.40, yMid);
        ctxB.stroke();
        arrowHead(ctxB, gx + gR * 0.40, yMid, 1, 0, 4);
        drawRuns(ctxB, gx, yMid - gR - 9, [sym("p", 12, INK)], "center");

        /* The two Coulomb forces, drawn to the true ratio E(x−a) : E(x+a) at this grain,
           anchored on the faces they act on. The near one is longer because the field is
           stronger there — which is the argument, not an illustration of it. */
        var xg = (gx - wx) / reach;                          // grain centre, in tube radii
        var ag = gR / reach;
        var eNear = 1 / Math.max(0.02, xg - ag);
        var eFar = 1 / (xg + ag);
        var unit = Math.min(reach * 0.30, 60);
        var lFar = unit * (eFar / eNear);
        var yF = yMid + gR + 17;

        ctxB.lineWidth = 1.6;
        ctxB.strokeStyle = COL_A;
        ctxB.fillStyle = COL_A;
        ctxB.beginPath();
        ctxB.moveTo(xNear, yF);
        ctxB.lineTo(xNear - unit, yF);
        ctxB.stroke();
        arrowHead(ctxB, xNear - unit, yF, -1, 0, 5);

        ctxB.strokeStyle = MUTED;
        ctxB.fillStyle = MUTED;
        ctxB.beginPath();
        ctxB.moveTo(xFar, yF);
        ctxB.lineTo(xFar + lFar, yF);
        ctxB.stroke();
        arrowHead(ctxB, xFar + lFar, yF, 1, 0, 5);

        drawRuns(ctxB, xNear - unit / 2, yF + 11,
            [sym("qE", 11, COL_A), sub("near", 11, COL_A)], "center");
        drawRuns(ctxB, xFar + lFar / 2, yF + 11,
            [sym("qE", 11, MUTED), sub("far", 11, MUTED)], "center");

        /* Which side of the picture is which. */
        drawRuns(ctxB, wx + 9, padT - 6, [word(S.stronger || "stronger field", 10.5, MUTED)], "left");
        drawRuns(ctxB, w - padR, padT - 6, [word(S.weaker || "weaker field", 10.5, MUTED)], "right");

        /* The resultant and the statement it proves. */
        var yN = h - padB + 12;
        ctxB.strokeStyle = INK;
        ctxB.fillStyle = INK;
        ctxB.lineWidth = 2;
        var nl = Math.max(16, unit - lFar);
        ctxB.beginPath();
        ctxB.moveTo(gx, yN);
        ctxB.lineTo(gx - nl, yN);
        ctxB.stroke();
        arrowHead(ctxB, gx - nl, yN, -1, 0, 5.5);
        drawRuns(ctxB, gx + 9, yN,
            [sym("F", 11.5, INK), word(" = ", 11.5, INK), sym("p", 11.5, INK),
             word(" ∂", 11.5, INK), sym("E", 11.5, INK), word("/∂", 11.5, INK),
             sym("x", 11.5, INK), word(" < 0", 11.5, INK)], "left");
    }

    /* ------------------------------------------------- panel c: the scaling laws */

    var C_XMIN = 0.05, C_XMAX = 1, C_YMIN = -1, C_YMAX = 7;

    function drawC(w, h) {
        ctxC.clearRect(0, 0, w, h);
        panelLetter(ctxC, "c");

        var padL = 40, padR = 12, padT = 22, padB = 42;
        var pw = w - padL - padR, ph = h - padT - padB;
        if (pw < 40 || ph < 40) return;

        var lx0 = Math.log10(C_XMIN), lx1 = Math.log10(C_XMAX);
        function X(rho) { return padL + ((Math.log10(rho) - lx0) / (lx1 - lx0)) * pw; }
        function Y(dec) { return padT + ph - ((dec - C_YMIN) / (C_YMAX - C_YMIN)) * ph; }

        /* Frame: two axes, no box, no grid — a Nature panel, not a spreadsheet. */
        ctxC.strokeStyle = INK; ctxC.lineWidth = 0.9; ctxC.globalAlpha = 0.75;
        ctxC.beginPath();
        ctxC.moveTo(padL, padT); ctxC.lineTo(padL, padT + ph); ctxC.lineTo(padL + pw, padT + ph);
        ctxC.stroke();
        ctxC.globalAlpha = 1;

        var xTicks = [0.05, 0.1, 0.2, 0.5, 1];
        ctxC.strokeStyle = MUTED; ctxC.lineWidth = 0.8;
        for (var i = 0; i < xTicks.length; i++) {
            var xx = X(xTicks[i]);
            ctxC.beginPath(); ctxC.moveTo(xx, padT + ph); ctxC.lineTo(xx, padT + ph + 4); ctxC.stroke();
            drawRuns(ctxC, xx, padT + ph + 13, [word(String(xTicks[i]), 10.5, MUTED)], "center");
        }
        for (var d = 0; d <= 6; d += 2) {
            var yy = Y(d);
            ctxC.beginPath(); ctxC.moveTo(padL - 4, yy); ctxC.lineTo(padL, yy); ctxC.stroke();
            drawRuns(ctxC, padL - 7, yy, [word("10", 10.5, MUTED), { t: String(d), f: "8px " + SANS, c: MUTED, dy: -4 }], "right");
        }

        drawRuns(ctxC, padL + pw / 2, padT + ph + 27,
            [sym("x", 11, INK), word("/", 11, INK), sym("R", 11, INK), sub("0", 11, INK)], "center");
        ctxC.save();
        ctxC.translate(11, padT + ph / 2);
        ctxC.rotate(-Math.PI / 2);
        drawRuns(ctxC, 0, 0, [word(S.axisY || "arb. units", 10.5, MUTED)], "center");
        ctxC.restore();

        function plot(fn, color, width, dash, alpha) {
            ctxC.save();
            ctxC.beginPath();
            var started = false;
            for (var k = 0; k <= 120; k++) {
                var rho = Math.pow(10, lx0 + ((lx1 - lx0) * k) / 120);
                var v = fn(rho);
                if (!(v > 0)) { started = false; continue; }
                var dec = Math.log10(v);
                if (dec < C_YMIN - 1 || dec > C_YMAX + 1) { started = false; continue; }
                var px = X(rho), py = Y(Math.max(C_YMIN, Math.min(C_YMAX, dec)));
                if (!started) { ctxC.moveTo(px, py); started = true; } else ctxC.lineTo(px, py);
            }
            ctxC.strokeStyle = color;
            ctxC.lineWidth = width;
            ctxC.globalAlpha = alpha || 1;
            if (dash) ctxC.setLineDash(dash);
            ctxC.stroke();
            ctxC.restore();
        }

        /* E ∝ 1/x for reference, then |F| ∝ 1/x³ for each fraction. */
        plot(function (r) { return 1 / r; }, MUTED, 1, [4, 3], 0.85);
        plot(function (r) { return forceOf(1, EPS1, r); }, COL_A, 1.6, null, 1);
        plot(function (r) { return forceOf(params.rad, params.eps2, r); }, COL_B, 1.6, null, 1);

        /* Slope triangles: the −3 and −1 the problem asks for, read straight off. */
        function slopeMark(rhoAt, fn, slope, color, label) {
            var v = fn(rhoAt);
            if (!(v > 0)) return;
            var dec = Math.log10(v);
            if (dec < C_YMIN || dec > C_YMAX - 0.4) return;
            var r2 = rhoAt * 1.9;
            if (r2 > C_XMAX) return;
            var xA = X(rhoAt), yA = Y(dec);
            var xB = X(r2), yB = Y(dec);
            var yC2 = Y(dec + slope * (Math.log10(r2) - Math.log10(rhoAt)));
            if (yC2 > padT + ph || yC2 < padT) return;
            ctxC.save();
            ctxC.strokeStyle = color; ctxC.globalAlpha = 0.75; ctxC.lineWidth = 0.9;
            ctxC.beginPath();
            ctxC.moveTo(xA, yA); ctxC.lineTo(xB, yA); ctxC.lineTo(xB, yC2);
            ctxC.stroke();
            ctxC.restore();
            drawRuns(ctxC, (xA + xB) / 2, yA - 7, [word(label, 10, color, 600)], "center");
        }
        slopeMark(0.14, function (r) { return forceOf(1, EPS1, r); }, -3, COL_A, "−3");
        slopeMark(0.34, function (r) { return 1 / r; }, -1, MUTED, "−1");

        /* Where the grains actually are, as two thin histograms on the baseline. */
        var nb = 46, hA = new Float32Array(nb), hB = new Float32Array(nb), mx = 1;
        for (var q = 0; q < N; q++) {
            var rr = pr[q];
            if (rr < C_XMIN) continue;
            var bi = Math.min(nb - 1, Math.max(0, (((Math.log10(rr) - lx0) / (lx1 - lx0)) * nb) | 0));
            if (psp[q]) hB[bi]++; else hA[bi]++;
        }
        for (q = 0; q < nb; q++) { if (hA[q] > mx) mx = hA[q]; if (hB[q] > mx) mx = hB[q]; }
        var base = padT + ph, hMax = 16;
        for (var sp2 = 0; sp2 < 2; sp2++) {
            var arr = sp2 ? hB : hA;
            ctxC.fillStyle = sp2 ? COL_B : COL_A;
            ctxC.globalAlpha = 0.42;
            for (q = 0; q < nb; q++) {
                if (!arr[q]) continue;
                var bx = padL + (q / nb) * pw, bw = pw / nb;
                var bh = (arr[q] / mx) * hMax;
                ctxC.fillRect(bx, base - bh, Math.max(1, bw - 0.6), bh);
            }
        }
        ctxC.globalAlpha = 1;

        /* Series labels, placed at the left edge of each curve. */
        function seriesLabel(fn, color, runs) {
            var v = fn(C_XMIN * 1.08);
            if (!(v > 0)) return;
            var dec = Math.log10(v);
            if (dec < C_YMIN || dec > C_YMAX) return;
            drawRuns(ctxC, X(C_XMIN * 1.08) + 3, Y(dec) - 8, runs, "left");
        }
        seriesLabel(function (r) { return forceOf(params.rad, params.eps2, r); }, COL_B,
            [sym("F", 10.5, COL_B), sub("2", 10.5, COL_B)]);
        seriesLabel(function (r) { return forceOf(1, EPS1, r); }, COL_A,
            [sym("F", 10.5, COL_A), sub("1", 10.5, COL_A)]);
        seriesLabel(function (r) { return 1 / r; }, MUTED, [sym("E", 10.5, MUTED)]);
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
            g.font = "600 " + 12 * scale + "px " + SANS;
            g.fillText(S.figTitle || "", pad * scale, (totalH - foot + 18) * scale);
            g.fillStyle = MUTED;
            g.font = 400 + " " + 10.5 * scale + "px " + SANS;
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
    var outRatio = root.querySelector("[data-fig-ratio]");
    var btnPlay = root.querySelector('[data-fig-btn="play"]');
    var btnField = root.querySelector('[data-fig-btn="field"]');
    var btnReset = root.querySelector('[data-fig-btn="reset"]');
    var btnPng = root.querySelector('[data-fig-btn="png"]');
    var btnPlayText = btnPlay && btnPlay.querySelector("[data-fig-btn-text]");
    var btnPlayGlyph = btnPlay && btnPlay.querySelector("[data-fig-glyph]");
    var hint = root.querySelector("[data-fig-hint]");

    var dirtyB = true, needsDraw = true;

    function syncReadout() {
        if (outV) outV.textContent = params.V.toFixed(2);
        if (outE) outE.textContent = params.eps2.toFixed(1);
        if (outR) outR.textContent = params.rad.toFixed(2);
        var r = forceRatio();
        if (outRatio) outRatio.textContent = r >= 100 ? r.toFixed(0) : r.toFixed(1);
        dirtyB = true;
        needsDraw = true;
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

    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    });
    if (btnReset) btnReset.addEventListener("click", function () {
        params.V = 1; params.eps2 = 6; params.rad = 1.6;
        if (elV) elV.value = "1";
        if (elE) elE.value = "6";
        if (elR) elR.value = "1.6";
        cam.az = 0.62; cam.el = 0.24; cam.dist = 4.4;
        updateTrig();
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

    function orbit(dx, dy) {
        cam.az -= dx * 0.008;
        cam.el = Math.max(-1.2, Math.min(1.25, cam.el + dy * 0.006));
        updateTrig();
        needsDraw = true;
    }

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
    }, { passive: false });

    canvasA.addEventListener("touchmove", function (e) {
        if (e.touches.length !== 2) return;
        var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                           e.touches[0].clientY - e.touches[1].clientY);
        if (pinch) cam.dist = Math.max(2.6, Math.min(8, cam.dist * (pinch / d)));
        pinch = d;
        needsDraw = true;
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
        dirtyB = true;
        needsDraw = true;
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

        if (playing && dt > 0) step(dt);
        drawA(sizeA.w, sizeA.h);
        if (dirtyB) { drawB(sizeB.w, sizeB.h); dirtyB = false; }
        drawC(sizeC.w, sizeC.h);
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
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { layout(); dirtyB = true; });
    }
})();
