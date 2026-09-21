/*
 * Profile photo crop stage (settings page, 2026-09-21).
 *
 * A chosen photo lands in a square frame the person can drag, zoom (wheel, pinch, slider or
 * keyboard) and turn in quarter turns. The frame is a circle or a square, and over it lie
 * the composition guides a photo editor offers: rule of thirds, the golden ratio (phi grid),
 * the diagonals with the centre cross, and the golden spiral. What is uploaded is the crop
 * itself, rendered here at up to 800 px, always the full square as an opaque JPEG (the owner,
 * 2026-09-21: every avatar is stored square; the circle is a preview of how the round surfaces
 * show it, and a round version can be cut from a square at any time, never the reverse). The
 * server then makes its 320 px WebP and 96 px thumbnail from that as before (avatar.js).
 *
 * The geometry (fit, clamping, zoom about a point, the crop rectangle, the guide lines and
 * the spiral's arcs) is pure and exported for tests/avatar-crop.test.js; the DOM part is
 * mount(). UMD like js/lmsr.js. No dependencies, no storage, no network.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AvatarCrop = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const PHI = (1 + Math.sqrt(5)) / 2;
    const MAX_ZOOM = 4;          // times the fitting scale
    const EXPORT_MIN = 320;      // what avatar.js keeps
    const EXPORT_MAX = 800;
    const GRIDS = ['none', 'thirds', 'golden', 'diagonals', 'spiral'];
    const SHAPES = ['circle', 'square'];

    // ── Geometry ──────────────────────────────────────────────────────────────
    // The viewport is a V × V square. The image, w × h and turned by `rot` quarter turns,
    // is drawn about the point (V/2 + x, V/2 + y) at `scale` viewport px per image px.

    /** The image's width and height after `rot` quarter turns. */
    function turned(w, h, rot) {
        return ((rot % 4) + 4) % 4 % 2 === 1 ? { w: h, h: w } : { w, h };
    }

    /** The smallest scale at which the turned image still covers the whole viewport. */
    function minScale(w, h, rot, V) {
        const t = turned(w, h, rot);
        return Math.max(V / t.w, V / t.h);
    }

    /** Clamp one offset so the image's edge on that axis never enters the viewport. */
    function clampOffset(offset, side, scale, V) {
        const limit = Math.max(0, (side * scale - V) / 2);
        return Math.min(limit, Math.max(-limit, offset));
    }

    /** A state with its scale and offsets brought back within the cover constraint. */
    function clampState(s, V) {
        const t = turned(s.w, s.h, s.rot);
        const lo = minScale(s.w, s.h, s.rot, V);
        const scale = Math.min(lo * MAX_ZOOM, Math.max(lo, s.scale));
        return Object.assign({}, s, {
            scale,
            x: clampOffset(s.x, t.w, scale, V),
            y: clampOffset(s.y, t.h, scale, V),
        });
    }

    /** Zoom by `factor` about the viewport point (px, py), keeping what is under it there. */
    function zoomAt(s, factor, px, py, V) {
        const lo = minScale(s.w, s.h, s.rot, V);
        const scale = Math.min(lo * MAX_ZOOM, Math.max(lo, s.scale * factor));
        const f = scale / s.scale;
        return clampState(Object.assign({}, s, {
            scale,
            x: px - V / 2 - f * (px - V / 2 - s.x),
            y: py - V / 2 - f * (py - V / 2 - s.y),
        }), V);
    }

    /** Move the image by (dx, dy) viewport px. */
    function pan(s, dx, dy, V) {
        return clampState(Object.assign({}, s, { x: s.x + dx, y: s.y + dy }), V);
    }

    /** Turn by `quarters` quarter turns about the viewport centre, keeping the zoom ratio. */
    function rotate(s, quarters, V) {
        const ratio = s.scale / minScale(s.w, s.h, s.rot, V);
        const rot = (((s.rot + quarters) % 4) + 4) % 4;
        const scale = minScale(s.w, s.h, rot, V) * ratio;
        // The offset turns with the picture: what was at the centre stays at the centre.
        const q = ((quarters % 4) + 4) % 4;
        let x = s.x, y = s.y;
        for (let i = 0; i < q; i++) { const nx = -y; y = x; x = nx; }
        return clampState(Object.assign({}, s, { rot, scale, x, y }), V);
    }

    /** The zoom slider's position, 0..1, for the state's scale (logarithmic). */
    function zoomPosition(s, V) {
        const lo = minScale(s.w, s.h, s.rot, V);
        return Math.log(s.scale / lo) / Math.log(MAX_ZOOM);
    }

    /** The scale for a slider position 0..1. */
    function scaleForPosition(s, position, V) {
        const lo = minScale(s.w, s.h, s.rot, V);
        return lo * Math.pow(MAX_ZOOM, Math.min(1, Math.max(0, position)));
    }

    /** The initial state: the image fitted to cover the viewport, centred. */
    function fit(w, h, V) {
        return { w, h, rot: 0, scale: minScale(w, h, 0, V), x: 0, y: 0 };
    }

    /**
     * The part of the turned image the viewport shows, in turned-image pixels:
     * { x, y, size }. Always inside the image, by the cover constraint.
     */
    function cropRect(s, V) {
        const t = turned(s.w, s.h, s.rot);
        const left = V / 2 + s.x - (t.w * s.scale) / 2;
        const top = V / 2 + s.y - (t.h * s.scale) / 2;
        return { x: -left / s.scale, y: -top / s.scale, size: V / s.scale };
    }

    /** The side of the exported image: the crop's own pixels, within the two bounds. */
    function exportSize(s, V) {
        return Math.round(Math.min(EXPORT_MAX, Math.max(EXPORT_MIN, V / s.scale)));
    }

    // ── Guides, in the unit square ────────────────────────────────────────────

    /** Line segments [x1, y1, x2, y2] for a grid kind, in 0..1 coordinates. */
    function gridLines(kind) {
        switch (kind) {
            case 'thirds':
                return [[1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 2 / 3, 1], [0, 1 / 3, 1, 1 / 3], [0, 2 / 3, 1, 2 / 3]];
            case 'golden': {
                const a = 1 - 1 / PHI, b = 1 / PHI;
                return [[a, 0, a, 1], [b, 0, b, 1], [0, a, 1, a], [0, b, 1, b]];
            }
            case 'diagonals':
                return [[0, 0, 1, 1], [1, 0, 0, 1], [0.5, 0, 0.5, 1], [0, 0.5, 1, 0.5]];
            default:
                return [];
        }
    }

    /**
     * The golden spiral: quarter-circle arcs { cx, cy, r, a0, a1 } (canvas angles, y down)
     * through the squares of a golden rectangle of width 1 centred in the unit square.
     * Each arc ends where the next begins.
     */
    function spiralArcs(turns) {
        const n = turns || 8;
        const arcs = [];
        let x = 0, y = (1 - 1 / PHI) / 2, w = 1, h = 1 / PHI;
        for (let i = 0; i < n; i++) {
            switch (i % 4) {
                case 0: // square on the left; arc from bottom-left up to the square's top-right
                    arcs.push({ cx: x + h, cy: y + h, r: h, a0: Math.PI, a1: 1.5 * Math.PI });
                    x += h; w -= h;
                    break;
                case 1: // square on top; arc from top-left round to bottom-right
                    arcs.push({ cx: x, cy: y + w, r: w, a0: 1.5 * Math.PI, a1: 2 * Math.PI });
                    y += w; h -= w;
                    break;
                case 2: // square on the right; arc from top-right down to bottom-left
                    arcs.push({ cx: x + w - h, cy: y, r: h, a0: 0, a1: 0.5 * Math.PI });
                    w -= h;
                    break;
                default: // square at the bottom; arc from bottom-right round to top-left
                    arcs.push({ cx: x + w, cy: y + h - w, r: w, a0: 0.5 * Math.PI, a1: Math.PI });
                    h -= w;
                    break;
            }
        }
        return arcs;
    }

    /** Where an arc starts and ends, for tests and for drawing polylines. */
    function arcEnds(a) {
        return {
            start: { x: a.cx + a.r * Math.cos(a.a0), y: a.cy + a.r * Math.sin(a.a0) },
            end: { x: a.cx + a.r * Math.cos(a.a1), y: a.cy + a.r * Math.sin(a.a1) },
        };
    }

    // ── Drawing ───────────────────────────────────────────────────────────────

    /** Draw the image for state `s` on a context whose unit is one viewport px. */
    function drawImage(ctx, img, s, V) {
        ctx.save();
        ctx.translate(V / 2 + s.x, V / 2 + s.y);
        ctx.rotate((s.rot * Math.PI) / 2);
        ctx.scale(s.scale, s.scale);
        ctx.drawImage(img, -s.w / 2, -s.h / 2, s.w, s.h);
        ctx.restore();
    }

    function maskPath(ctx, shape, V) {
        ctx.beginPath();
        if (shape === 'circle') ctx.arc(V / 2, V / 2, V / 2, 0, 2 * Math.PI);
        else ctx.rect(0, 0, V, V);
    }

    function strokeGuide(ctx, path) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        path();
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        path();
        ctx.stroke();
    }

    /** The whole stage: image, dimmed outside the mask, the mask's edge, the guides. */
    function drawStage(ctx, img, s, shape, grid, V) {
        ctx.clearRect(0, 0, V, V);
        drawImage(ctx, img, s, V);
        if (shape === 'circle') {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, V, V);
            ctx.arc(V / 2, V / 2, V / 2, 0, 2 * Math.PI, true);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.fill('evenodd');
            ctx.restore();
        }
        ctx.save();
        maskPath(ctx, shape, V);
        ctx.clip();
        const lines = gridLines(grid);
        if (lines.length) {
            strokeGuide(ctx, function () {
                ctx.beginPath();
                lines.forEach(function (l) {
                    ctx.moveTo(l[0] * V, l[1] * V);
                    ctx.lineTo(l[2] * V, l[3] * V);
                });
            });
        }
        if (grid === 'spiral') {
            const arcs = spiralArcs();
            strokeGuide(ctx, function () {
                ctx.beginPath();
                arcs.forEach(function (a) { ctx.arc(a.cx * V, a.cy * V, a.r * V, a.a0, a.a1); });
            });
        }
        ctx.restore();
        ctx.save();
        maskPath(ctx, shape, V);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.stroke();
        ctx.restore();
    }

    // ── The stage on the page ─────────────────────────────────────────────────

    /**
     * Mount on an element holding:
     *   [data-crop-canvas]        the <canvas>
     *   [data-crop-shape=circle|square]  buttons
     *   [data-crop-grid]          a <select> of GRIDS
     *   [data-crop-zoom]          an <input type=range min=0 max=100>
     *   [data-crop-rotate=-1|1]   buttons
     * load(file) shows the picture; export() resolves { blob, name } of the crop.
     */
    function mount(el) {
        const canvas = el.querySelector('[data-crop-canvas]');
        const ctx = canvas.getContext('2d');
        const zoomInput = el.querySelector('[data-crop-zoom]');
        const gridSelect = el.querySelector('[data-crop-grid]');
        const shapeButtons = Array.prototype.slice.call(el.querySelectorAll('[data-crop-shape]'));
        let img = null, objectUrl = null;
        let state = null;
        let shape = 'circle', grid = 'thirds';
        let V = 320;
        let raf = 0;

        function size() {
            const width = Math.max(120, Math.min(320, Math.floor(el.clientWidth || 320)));
            const dpr = Math.min(3, window.devicePixelRatio || 1);
            V = width;
            canvas.style.width = width + 'px';
            canvas.style.height = width + 'px';
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(width * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        function render() {
            raf = 0;
            if (!img || !state) return;
            drawStage(ctx, img, state, shape, grid, V);
            if (zoomInput) zoomInput.value = String(Math.round(zoomPosition(state, V) * 100));
        }
        function schedule() {
            if (!raf) raf = window.requestAnimationFrame(render);
        }
        function set(next) { state = next; schedule(); }

        function setShape(next) {
            shape = SHAPES.indexOf(next) >= 0 ? next : 'circle';
            shapeButtons.forEach(function (b) {
                const on = b.getAttribute('data-crop-shape') === shape;
                b.classList.toggle('is-active', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            schedule();
        }
        function setGrid(next) {
            grid = GRIDS.indexOf(next) >= 0 ? next : 'none';
            if (gridSelect && gridSelect.value !== grid) gridSelect.value = grid;
            schedule();
        }

        // Pointers: one drags, two pinch.
        const pointers = new Map();
        let pinch = null;
        function point(e) {
            const r = canvas.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        }
        canvas.addEventListener('pointerdown', function (e) {
            if (!state) return;
            canvas.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, point(e));
            if (pointers.size === 2) {
                const p = Array.from(pointers.values());
                pinch = { dist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
            }
            e.preventDefault();
        });
        canvas.addEventListener('pointermove', function (e) {
            if (!state || !pointers.has(e.pointerId)) return;
            const prev = pointers.get(e.pointerId);
            const now = point(e);
            pointers.set(e.pointerId, now);
            if (pointers.size === 2 && pinch) {
                const p = Array.from(pointers.values());
                const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
                const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
                if (pinch.dist > 0) set(zoomAt(state, dist / pinch.dist, mid.x, mid.y, V));
                pinch.dist = dist;
            } else if (pointers.size === 1) {
                set(pan(state, now.x - prev.x, now.y - prev.y, V));
            }
        });
        function release(e) {
            pointers.delete(e.pointerId);
            if (pointers.size < 2) pinch = null;
        }
        canvas.addEventListener('pointerup', release);
        canvas.addEventListener('pointercancel', release);
        canvas.addEventListener('wheel', function (e) {
            if (!state) return;
            e.preventDefault();
            const p = point(e);
            set(zoomAt(state, Math.pow(1.1, -e.deltaY / 100), p.x, p.y, V));
        }, { passive: false });
        canvas.addEventListener('keydown', function (e) {
            if (!state) return;
            const step = e.shiftKey ? 20 : 4;
            const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
            if (moves[e.key]) { set(pan(state, moves[e.key][0], moves[e.key][1], V)); e.preventDefault(); }
            else if (e.key === '+' || e.key === '=') { set(zoomAt(state, 1.1, V / 2, V / 2, V)); e.preventDefault(); }
            else if (e.key === '-') { set(zoomAt(state, 1 / 1.1, V / 2, V / 2, V)); e.preventDefault(); }
        });
        if (zoomInput) {
            zoomInput.addEventListener('input', function () {
                if (!state) return;
                const scale = scaleForPosition(state, Number(zoomInput.value) / 100, V);
                set(zoomAt(state, scale / state.scale, V / 2, V / 2, V));
            });
        }
        if (gridSelect) gridSelect.addEventListener('change', function () { setGrid(gridSelect.value); });
        shapeButtons.forEach(function (b) {
            b.addEventListener('click', function () { setShape(b.getAttribute('data-crop-shape')); });
        });
        Array.prototype.forEach.call(el.querySelectorAll('[data-crop-rotate]'), function (b) {
            b.addEventListener('click', function () {
                if (state) set(rotate(state, Number(b.getAttribute('data-crop-rotate')) || 1, V));
            });
        });
        window.addEventListener('resize', function () {
            if (!state) return;
            const before = V;
            size();
            if (V !== before) set(clampState(Object.assign({}, state, { scale: state.scale * V / before, x: state.x * V / before, y: state.y * V / before }), V));
        });

        function unload() {
            if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
            img = null;
            state = null;
        }

        /** Show a File; resolves once it is decoded and drawn. */
        function load(file) {
            unload();
            return new Promise(function (resolve, reject) {
                const url = URL.createObjectURL(file);
                const image = new Image();
                image.onload = function () {
                    if (objectUrl !== url) { URL.revokeObjectURL(url); return; }
                    if (!image.naturalWidth || !image.naturalHeight) { reject(new Error('empty image')); return; }
                    img = image;
                    size();
                    state = fit(image.naturalWidth, image.naturalHeight, V);
                    setShape(shape);
                    setGrid(grid);
                    render();
                    resolve();
                };
                image.onerror = function () { URL.revokeObjectURL(url); if (objectUrl === url) objectUrl = null; reject(new Error('undecodable image')); };
                objectUrl = url;
                image.src = url;
            });
        }

        /** The crop as a File-like { blob, name, type }: always the full square, as a JPEG, whatever the preview mask. */
        function exportCrop() {
            return new Promise(function (resolve, reject) {
                if (!img || !state) { reject(new Error('nothing loaded')); return; }
                const E = exportSize(state, V);
                const out = document.createElement('canvas');
                out.width = E;
                out.height = E;
                const octx = out.getContext('2d');
                const k = E / V;
                octx.setTransform(k, 0, 0, k, 0, 0);
                octx.fillStyle = '#ffffff'; // a PNG's transparent areas end up white, as on the page
                octx.fillRect(0, 0, V, V);
                drawImage(octx, img, state, V);
                out.toBlob(function (blob) {
                    if (!blob) { reject(new Error('export failed')); return; }
                    resolve({ blob, name: 'avatar.jpg', type: 'image/jpeg' });
                }, 'image/jpeg', 0.92);
            });
        }

        return {
            load, export: exportCrop, unload,
            setShape, setGrid,
            get state() { return state; },
            get shape() { return shape; },
            get grid() { return grid; },
            get viewport() { return V; },
        };
    }

    return {
        PHI, MAX_ZOOM, EXPORT_MIN, EXPORT_MAX, GRIDS, SHAPES,
        turned, minScale, clampOffset, clampState, zoomAt, pan, rotate,
        zoomPosition, scaleForPosition, fit, cropRect, exportSize,
        gridLines, spiralArcs, arcEnds, drawStage, mount,
    };
});
