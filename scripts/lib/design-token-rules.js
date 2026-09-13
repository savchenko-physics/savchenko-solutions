// design-token-rules.js — pure mapping rules for scripts/codemod-design-tokens.js.
//
// The 2026-09 typography unification found 39 font stacks, 110 font sizes, 291 hex colours and
// no spacing grid across ~68 templates. This module decides, one declaration at a time, which
// token a literal value becomes. It never touches selectors, only values, and returns null when
// a value should be left alone or looked at by a person (the caller reports those).
//
// Exported for tests/design-rules.test.js, which checks the rules on real lines.

'use strict';

const SCALE = [12, 13, 14, 16, 18, 20, 24, 28, 32, 40];
const SPACE = [[4, 1], [8, 2], [12, 3], [16, 4], [20, 5], [24, 6], [32, 7], [40, 8], [48, 9], [64, 10]];

// ── font-family ────────────────────────────────────────────────────────────────────────────
const UI_FAMILIES = /^(inter|roboto|lato|-apple-system|blinkmacsystemfont|system-ui|ui-sans-serif|segoe ui|segoe ui web.*|helvetica|helvetica neue|arial|sans-serif|open sans|pt sans|montserrat|nunito|roboto condensed|microsoft yahei|lucida grande|verdana|trebuchet ms|gothampro)$/i;
const TEXT_FAMILIES = /^(computer modern serif|computer modern|latin modern roman|lm roman 10|cmu serif|linux libertine|libertinus serif|georgia|times new roman|times|serif|noto serif|cambria|source serif pro|pt serif)$/i;
const MONO_FAMILIES = /^(jetbrains mono|roboto mono|menlo|monaco|consolas|courier|courier new|courier prime|monospace|ui-monospace|sfmono-regular|source code pro|fira code|lucida console|liberation mono)$/i;
const KEEP_FAMILIES = /^(inherit|initial|unset|stix two math|font awesome.*|fontawesome|bootstrap-icons|glyphicons halflings|mjx.*)$/i;

function firstFamily(value) {
    const v = String(value).replace(/!important/i, '').trim();
    const m = v.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/);
    return m ? (m[1] || m[2] || m[3] || '').trim() : '';
}

function mapFontFamily(value) {
    const v = String(value);
    if (/var\(--ss-font-/.test(v)) return null;
    const important = /!important/i.test(v) ? ' !important' : '';
    if (/^\s*var\(\s*--(font-mono|source-font-family)/.test(v)) return 'var(--ss-font-mono)' + important;
    if (/^\s*var\(\s*--palette-vk-font/.test(v)) return 'var(--ss-font-ui)' + important;
    const f = firstFamily(v);
    if (!f || KEEP_FAMILIES.test(f)) return null;
    if (MONO_FAMILIES.test(f)) return 'var(--ss-font-mono)' + important;
    if (TEXT_FAMILIES.test(f)) return 'var(--ss-font-text)' + important;
    if (UI_FAMILIES.test(f)) return 'var(--ss-font-ui)' + important;
    return null;
}

// ── font-size ──────────────────────────────────────────────────────────────────────────────
function toPx(token) {
    const m = String(token).trim().match(/^(-?\d*\.?\d+)(px|rem)$/i);
    if (!m) return null;
    return m[2].toLowerCase() === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
}

const CONTROL_SEL = /(^|[^a-z])(btn|button|tab|chip|badge|pill|nav|select|seg|toggle|tag|menu-item|dropdown-item|page-link)/i;
const INPUT_SEL = /(^|[\s,>+~(])(input|textarea|select)\b|form-control|form-select|-input\b|_input\b|search-?box|searchbar-input|composer|msg-input|comment-input|\binput\[/i;
const CODEMIRROR_SEL = /CodeMirror/;

function snapSize(px, selector) {
    if (px <= 12.8) return px < 12.4 ? 12 : 13;
    if (px < 13.7) return 13;
    if (px <= 14.5) return 14;
    if (px < 15.1) return CONTROL_SEL.test(selector || '') ? 14 : 16;
    if (px <= 17) return 16;
    if (px <= 19.2) return 18;
    if (px <= 22.4) return 20;
    if (px <= 26) return 24;
    if (px <= 30) return 28;
    if (px <= 36) return 32;
    return 40;
}

function mapFontSize(value, selector = '') {
    const v = String(value).trim();
    const important = /!important/i.test(v) ? ' !important' : '';
    const bare = v.replace(/!important/i, '').trim();
    if (/var\(--ss-/.test(bare)) return null;
    const px = toPx(bare);
    if (px === null) return null;               // em, %, calc, keywords: left alone
    if (INPUT_SEL.test(selector) && !/::?placeholder/.test(selector) && px < 16) return 'var(--ss-fs-16)' + important;
    if (CODEMIRROR_SEL.test(selector)) return 'var(--ss-fs-14)' + important;
    const s = snapSize(px, selector);
    return `var(--ss-fs-${s})${important}`;
}

// ── font-weight ────────────────────────────────────────────────────────────────────────────
const STRONG_SEL = /(btn|button|nav|tab|label|title|name|badge|chip|th\b|heading|header|brand|count|score|stat|num|rank|link-strong|seg|pill|kicker|legend-title)/i;
function mapFontWeight(value, selector = '') {
    const v = String(value).trim();
    const important = /!important/i.test(v) ? ' !important' : '';
    const bare = v.replace(/!important/i, '').trim().toLowerCase();
    if (/var\(--ss-/.test(bare) || bare === 'inherit') return null;
    let n = null;
    if (bare === 'normal' || bare === 'lighter') n = 400;
    else if (bare === 'bold' || bare === 'bolder') n = 700;
    else if (/^\d{3}$/.test(bare)) n = parseInt(bare, 10);
    if (n === null) return null;
    if (n <= 400) return bare === '400' || bare === 'normal' ? null : 'var(--ss-fw-regular)' + important;
    if (n === 500) return (STRONG_SEL.test(selector) ? 'var(--ss-fw-strong)' : 'var(--ss-fw-regular)') + important;
    return 'var(--ss-fw-strong)' + important;
}

// ── colour ─────────────────────────────────────────────────────────────────────────────────
function normHex(h) {
    let x = h.toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(x)) x = '#' + x.slice(1).split('').map((c) => c + c).join('');
    return x;
}
const TEXT = {
    'var(--ss-text)': ['#2d2d2d', '#333333', '#24292f', '#1a202c', '#212529', '#1f2328', '#1f2937', '#1a1a1a', '#0f172a', '#1e293b', '#222222', '#111111', '#000000', '#2c3e50', '#343a40', '#303030', '#262626'],
    'var(--ss-navy)': ['#1a1a2e', '#0d0d1a', '#16162a', '#11111d'],
    'var(--ss-text-secondary)': ['#6c757d', '#495057', '#57606a', '#64748b', '#6b7280', '#666666', '#656d76', '#54595d', '#475569', '#555555', '#5f6b76', '#6a737d', '#586069', '#777777', '#7a7a7a', '#707070', '#6e7781', '#999999', '#adb5bd', '#9e9e9e', '#8c959f', '#94a3b8', '#888888', '#aaaaaa', '#9aa0a6', '#8b949e', '#868e96', '#909090', '#a0a0a0'],
    'var(--ss-link)': ['#1a5276', '#3366cc', '#007bff', '#0d6efd', '#0056b3', '#0969da', '#4a90e2', '#3182ce', '#2b6cb0', '#3b82f6', '#0066cc', '#1a8bff', '#4689d6', '#3a7bc8', '#3b59f2', '#2563eb', '#1d4ed8', '#1e88e5', '#0000ee', '#2980b9', '#3498db'],
    'var(--ss-link-hover)': ['#0d3b54', '#00408a', '#1e3a8a', '#0a58ca'],
    'var(--ss-link-visited)': ['#4a235a'],
    'var(--ss-success-strong)': ['#27ae60', '#28a745', '#22863a', '#219a52', '#10b981', '#1e8449', '#1a7f37', '#155724', '#1e6b3a', '#198754', '#2e7d32', '#16a34a'],
    'var(--ss-error)': ['#c0392b', '#dc3545', '#e74c3c', '#a93226', '#721c24', '#cb2431', '#8b2e22', '#ef4444', '#b00020', '#d32f2f', '#e53935', '#dc2626', '#b91c1c'],
    'var(--ss-warning)': ['#856404', '#d7a63b', '#f39c12', '#b5651d', '#9a6700', '#ffc107', '#e67e22', '#d97706', '#b45309', '#f0ad4e'],
    'var(--ss-accent)': ['#7d3c98', '#833fba', '#6f42c1'],
    'var(--ss-on-navy)': ['#ffffff'],
};
const BG = {
    'var(--ss-surface)': ['#ffffff'],
    'var(--ss-surface-alt)': ['#f8f9fa', '#f9f9f9', '#fafafa', '#f6f8fa', '#f5f5f5', '#fafbfc', '#f7f7f7', '#f8fafc', '#f9fafb', '#fcfcfd', '#fbfbfb', '#f7f8fa'],
    'var(--ss-surface-hover)': ['#e9ecef', '#ebedf0', '#f0f2f5', '#eef1f4', '#f1f3f5', '#f0f3f6', '#f0f4f8', '#eef1f5', '#f0f0f0', '#eeeeee', '#f2f2f2', '#f1f1f1', '#e6e6e6', '#e8f0fe', '#eef4fb', '#e7f1fb', '#f3f4f6', '#e5e7eb', '#f4f5f7', '#edf0f3', '#eaecef'],
    'var(--ss-navy)': ['#1a1a2e', '#0d0d1a', '#212529', '#16162a', '#11111d', '#1b222c'],
    'var(--ss-navy-hover)': ['#2c2c4a', '#2a2a44', '#2d2d4a', '#2d2d4e', '#2a2a4e', '#343a40', '#2f3a4c'],
    'var(--ss-success-soft)': ['#d4edda', '#e8f8ef', '#eaf7ef', '#dcffe4', '#c3e6cb', '#e6f4ea', '#ecfdf5', '#f0fdf4'],
    'var(--ss-error-soft)': ['#f8d7da', '#fdecea', '#fdf0ef', '#fdf2f0', '#fee2e2', '#fef2f2', '#ffebee'],
    'var(--ss-warning-soft)': ['#fff3cd', '#fef3e6', '#fff8e1', '#fffbea', '#fef9e7', '#fffbeb', '#fff7e6'],
    'var(--ss-accent-soft)': ['#f3ecf7'],
    'var(--ss-success)': ['#27ae60', '#28a745', '#1e8449'],
    'var(--ss-error)': ['#c0392b', '#dc3545', '#e74c3c'],
    'var(--ss-accent)': ['#7d3c98'],
    'var(--ss-link)': ['#1a5276', '#007bff', '#0d6efd', '#36c', '#3366cc'],
};
const RULE = {
    'var(--ss-rule)': ['#dee2e6', '#d0d7de', '#dddddd', '#cccccc', '#ced4da', '#e0e0e0', '#d1d9e0', '#d8dee4', '#d9d9d9', '#e1e4e8', '#d0d0d0', '#d6d6d6', '#dadce0', '#e2e8f0', '#e5e5e5', '#d4d4d4'],
    'var(--ss-rule-soft)': ['#f0f0f0', '#eeeeee', '#eef1f4', '#f1f3f5', '#eceff2', '#eceff1', '#e9ecef', '#ebedf0', '#e6e6e6', '#f2f2f2', '#f3f3f3', '#f1f5f9'],
    'var(--ss-rule-strong)': ['#adb5bd', '#999999', '#bbbbbb', '#aaaaaa', '#c6ccd2', '#b0b0b0', '#c9c9d4', '#8c959f'],
    'var(--ss-navy)': ['#1a1a2e', '#0d0d1a', '#212529'],
    'var(--ss-link)': ['#1a5276', '#0d6efd', '#007bff', '#3366cc', '#80bdff', '#86b7fe'],
    'var(--ss-error)': ['#c0392b', '#dc3545', '#e74c3c'],
    'var(--ss-success)': ['#27ae60', '#28a745'],
    'var(--ss-accent)': ['#7d3c98'],
    'var(--ss-warning-rule)': ['#ffc107', '#e9b43a', '#ffeeba', '#f0c260'],
    'var(--ss-error-rule)': ['#f5c6cb', '#eccfcb', '#f1b0b7'],
};
function index(table) {
    const out = new Map();
    for (const [token, list] of Object.entries(table)) for (const h of list) if (!out.has(normHex(h))) out.set(normHex(h), token);
    return out;
}
const TEXT_IX = index(TEXT);
const BG_IX = index(BG);
const RULE_IX = index(RULE);
const NAMED = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', grey: '#808080', gray: '#808080' };

const DATA_SEL = /(problem-dot|problem-grid-item|legend-(both|en|ru|unsolved)|sg-sw|heat-|pf-heat|rank-|tier-|medal|gold|silver|bronze|activity|contrib-cell|heatmap|flag|globe|geo-|chart|legend-swatch|swatch|color-dot|avatar-palette|emoji|reaction-|fig-|precipitator)/i;
const TERTIARY_SEL = /(placeholder|disabled|icon|\bfa-|\bbi-|svg|::?before|::?after|separator|\bsep\b|divider|chevron|caret|arrow)/i;

function mapColorValue(value, property, selector = '') {
    const v = String(value);
    if (/gradient\(|var\(|url\(|currentcolor|transparent|inherit/i.test(v) && !/^\s*#[0-9a-f]{3,6}\s*(!important)?\s*$/i.test(v)) {
        // Compound value (border shorthand etc.): replace hex colours inside, but never inside gradients.
        if (/gradient\(/i.test(v)) return null;
    }
    if (DATA_SEL.test(selector)) return null;
    const prop = property.toLowerCase();
    const kind = /^(background|background-color)$/.test(prop) ? 'bg'
        : /^(border|border-color|border-(top|right|bottom|left)(-color)?|outline|outline-color|border-block.*|border-inline.*|column-rule.*)$/.test(prop) ? 'rule'
        : /^(color|fill|stroke|caret-color|text-decoration-color|-webkit-text-fill-color)$/.test(prop) ? 'text' : null;
    if (!kind) return null;
    const ix = kind === 'bg' ? BG_IX : kind === 'rule' ? RULE_IX : TEXT_IX;
    let changed = false;
    let unmapped = false;
    // Never rewrite inside var(…) — a fallback like var(--text, #2d2d2d) or a name like
    // --ss-white would turn into nonsense.
    const varSpans = [];
    const varRe = /var\(/g;
    let vm;
    while ((vm = varRe.exec(v))) {
        let depth = 0; let k = vm.index + 3;
        for (; k < v.length; k++) { if (v[k] === '(') depth++; else if (v[k] === ')') { depth--; if (depth === 0) break; } }
        varSpans.push([vm.index, k]);
    }
    const insideVar = (pos) => varSpans.some(([a, b]) => pos >= a && pos <= b);
    const out = v.replace(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|(?<![-\w])(white|black|red|green|blue|grey|gray)(?![-\w])/g, (m, _named, pos) => {
        if (insideVar(pos)) return m;
        const hex = m.startsWith('#') ? normHex(m) : NAMED[m.toLowerCase()];
        if (!hex || hex.length === 9) { unmapped = true; return m; }
        let token = ix.get(hex);
        if (kind === 'text' && token === 'var(--ss-text-secondary)' && TERTIARY_SEL.test(selector) && ['#999999', '#adb5bd', '#9e9e9e', '#8c959f', '#94a3b8', '#888888', '#aaaaaa', '#9aa0a6', '#8b949e', '#868e96', '#909090', '#a0a0a0'].includes(hex)) {
            token = 'var(--ss-text-tertiary)';
        }
        if (kind === 'text' && hex === '#ffffff' && !/color$/.test(prop)) token = null;
        if (!token) { unmapped = true; return m; }
        changed = true;
        return token;
    });
    if (!changed) return unmapped ? { review: true } : null;
    return unmapped ? { value: out, review: true } : { value: out };
}

// ── radius ─────────────────────────────────────────────────────────────────────────────────
const ROUND_SEL = /(avatar|dot|circle|round|thumb|switch|toggle|knob|spinner|indicator|presence|online|status-dot|bullet|radio|profile-pic|pfp|userpic|photo)/i;
const PILL_SEL = /(btn|button|tag|chip|badge|pill|input|search|select|seg|filter|label|count|bubble)/i;
function mapRadius(value, selector = '') {
    const v = String(value).trim();
    const important = /!important/i.test(v) ? ' !important' : '';
    const bare = v.replace(/!important/i, '').trim();
    if (/var\(|calc\(|%|\/|em\b/.test(bare) && !/^\d/.test(bare)) return null;
    if (/%/.test(bare)) return null;
    const parts = bare.split(/\s+/);
    const out = [];
    for (const p of parts) {
        const px = toPx(p);
        if (p === '0') { out.push('0'); continue; }
        if (px === null) return null;
        if (px >= 99 && ROUND_SEL.test(selector)) return null;
        if (/bubble/i.test(selector)) return { review: true };
        if (px < 5.5) out.push('var(--ss-radius-sm)');
        else if (px < 7.5) out.push('var(--ss-radius)');
        else if (PILL_SEL.test(selector) && px >= 10) out.push('var(--ss-radius)');
        else out.push('var(--ss-radius-lg)');
    }
    const value2 = out.join(' ') + important;
    return value2 === v ? null : { value: value2 };
}

// ── shadow ─────────────────────────────────────────────────────────────────────────────────
function mapShadow(value) {
    const v = String(value).trim();
    const bare = v.replace(/!important/i, '').trim();
    if (/^(none|0|initial|inherit|unset)$/i.test(bare) || /var\(--ss-shadow\)/.test(bare)) return null;
    if (/inset/i.test(bare)) return { review: true };
    // focus rings: 0 0 0 Npx colour
    if (/^0(px)?\s+0(px)?\s+0(px)?\s+\d/.test(bare)) return { review: true };
    const important = /!important/i.test(v) ? ' !important' : '';
    return { value: 'var(--ss-shadow)' + important };
}

// ── spacing ────────────────────────────────────────────────────────────────────────────────
function snapSpace(px) {
    const a = Math.abs(px);
    if (a < 3) return null;            // hairline offsets stay as they are
    let best = SPACE[0];
    for (const s of SPACE) if (Math.abs(s[0] - a) < Math.abs(best[0] - a) || (Math.abs(s[0] - a) === Math.abs(best[0] - a) && s[0] > best[0])) best = s;
    if (a > 80) return null;           // layout sizes, not spacing
    return best;
}
function mapSpacing(value) {
    const v = String(value).trim();
    const important = /!important/i.test(v) ? ' !important' : '';
    const bare = v.replace(/!important/i, '').trim();
    if (/var\(|calc\(|%|vh|vw|em\b|auto|inherit|initial|unset/.test(bare.replace(/rem/g, ''))) {
        if (!/^[\d.\s\-remp]+$/.test(bare.replace(/auto/g, ''))) return null;
    }
    const parts = bare.split(/\s+/);
    const out = [];
    let changed = false;
    for (const p of parts) {
        if (p === 'auto' || p === '0') { out.push(p); continue; }
        const px = toPx(p);
        if (px === null) return null;
        const snap = snapSpace(px);
        if (!snap) { out.push(p); continue; }
        const tok = `var(--ss-space-${snap[1]})`;
        out.push(px < 0 ? `calc(-1 * ${tok})` : tok);
        changed = true;
    }
    if (!changed) return null;
    return { value: out.join(' ') + important };
}

module.exports = {
    SCALE, firstFamily, mapFontFamily, toPx, snapSize, mapFontSize, mapFontWeight,
    normHex, mapColorValue, mapRadius, mapShadow, snapSpace, mapSpacing,
};
