/**
 * heatColor.js — continuous version of the site's 9-step YlOrRd difficulty ramp
 * (the same anchor colors as css/design-system.css's .heat-1..9 and
 * views/problems/index.ejs's .pf-heat-bg-1..9).
 *
 * The 9-bucket version is fine when a page shows the whole 0-100 spread — but a
 * list that's already narrowed to one tier (e.g. "every problem at the maximum
 * rating") would render as one flat color under bucketing, since they're all in
 * bucket 9 by construction. Interpolating continuously on the raw 0-100 value
 * instead gives every problem its own shade, proportional to its own score, even
 * within an already-narrow slice.
 */

const RAMP = ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'];

function hexToRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function toHex(n) {
    return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** 0-100 -> a hex color continuously interpolated along the ramp. */
function heatColor(value) {
    if (value == null) return '#adb5bd';
    const t = (Math.max(0, Math.min(100, value)) / 100) * (RAMP.length - 1);
    const i = Math.floor(t);
    const frac = t - i;
    const [r1, g1, b1] = hexToRgb(RAMP[Math.min(i, RAMP.length - 1)]);
    const [r2, g2, b2] = hexToRgb(RAMP[Math.min(i + 1, RAMP.length - 1)]);
    return `#${toHex(r1 + (r2 - r1) * frac)}${toHex(g1 + (g2 - g1) * frac)}${toHex(b1 + (b2 - b1) * frac)}`;
}

/** Relative luminance (WCAG-style approximation) decides readable text color. */
function heatTextColor(value) {
    if (value == null) return '#2d2d2d';
    const [r, g, b] = hexToRgb(heatColor(value));
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? '#2d2d2d' : '#fff';
}

module.exports = { heatColor, heatTextColor, RAMP };
