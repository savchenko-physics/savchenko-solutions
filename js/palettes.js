/**
 * palettes.js — the site's data colours, in one place.
 *
 * These are not interface colours (those are the --ss-* tokens in css/design-system.css) but
 * colours that carry data: how hard a problem is, which languages a solution exists in, how
 * active a contributor was, and the contributor rank tiers. Before 2026-09 each lived in two to
 * four copies — the difficulty ramp in lib/heatColor.js, twice in design-system.css and again in
 * problems/index.ejs; the rank tiers in forum.js, contributors_ranking.ejs and user_profile.ejs —
 * and the copies had started to disagree (the problem finder coloured Russian orange, the grid
 * coloured it green).
 *
 * UMD, like js/reactions.js: `require('./js/palettes')` on the server, `window.SSPalettes` in the
 * browser (<script src="/js/palettes.js">). scripts/build-css.js turns the same values into CSS
 * custom properties (--ss-heat-1…9, --ss-lang-*, --ss-activity-0…4) so stylesheets never type them.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SSPalettes = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 9-step YlOrRd ramp for difficulty (0-100 → 1…9). Navy ink on steps 1-6, white on 7-9: the
    // ink with the better contrast on each step (white on step 6 was 3.35:1, navy is 5.1:1).
    const HEAT = ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'];
    const HEAT_INK = ['#1a1a2e', '#1a1a2e', '#1a1a2e', '#1a1a2e', '#1a1a2e', '#1a1a2e', '#ffffff', '#ffffff', '#ffffff'];
    const HEAT_NONE = { fill: '#ffffff', ink: '#8c959f' };

    // Which languages a solution exists in. Shape carries the meaning as well as hue (solid = both,
    // left half = English, bottom half = Russian, dashed = unsolved), because roughly one reader in
    // twelve cannot tell purple, blue and green apart.
    const LANG = {
        both: { fill: '#7d3c98', rule: '#7d3c98', ink: '#ffffff' },
        en: { fill: '#cfe0ee', fillHover: '#b9d3e8', rule: '#2471a3', ink: '#17466b' },
        ru: { fill: '#cdebd9', fillHover: '#b6e1c8', rule: '#27ae60', ink: '#1b6b41' },
        unsolved: { fill: '#ffffff', rule: '#c6ccd2', ink: '#6c757d' },
    };

    // Contribution heatmap, least to most active.
    const ACTIVITY = ['#ebedf0', '#b3c6d9', '#6d93b8', '#3a6a9e', '#1a1a2e'];

    // Lines of a chart that tells series apart by colour (the price chart of «Последняя задача»):
    // blue, orange, aqua, and the site's accent purple, in this order. Checked with a colour-vision
    // validator on white: adjacent pairs at least ΔE 9.2 for deuteranopia and 27.6 for normal
    // vision. Aqua is 2.8:1 against white, so every line also carries its name in the legend.
    // The site's own navy and link blue fail as series colours (too dark and grey to tell apart).
    const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#7d3c98'];

    // Codeforces-style rank tiers (deliberately the Codeforces colours, which this audience knows).
    const RANKS = [
        { min: 200, key: 'legendaryGrandmaster', color: '#FF0000' },
        { min: 160, key: 'internationalGrandmaster', color: '#FF0000' },
        { min: 130, key: 'grandmaster', color: '#CC0000' },
        { min: 110, key: 'internationalMaster', color: '#FF8C00' },
        { min: 90, key: 'master', color: '#FF8C00' },
        { min: 70, key: 'candidateMaster', color: '#AA00AA' },
        { min: 50, key: 'expert', color: '#0000FF' },
        { min: 30, key: 'specialist', color: '#03A89E' },
        { min: 10, key: 'pupil', color: '#008000' },
        { min: -Infinity, key: 'newbie', color: '#808080' },
    ];

    function rankFor(score) {
        const s = Number(score) || 0;
        for (const r of RANKS) if (s >= r.min) return r;
        return RANKS[RANKS.length - 1];
    }

    /** CSS custom properties for every palette, as `name: value` pairs (used by scripts/build-css.js). */
    function cssVariables() {
        const vars = {};
        HEAT.forEach((c, i) => { vars[`--ss-heat-${i + 1}`] = c; vars[`--ss-heat-${i + 1}-ink`] = HEAT_INK[i]; });
        vars['--ss-heat-none'] = HEAT_NONE.fill;
        vars['--ss-heat-none-ink'] = HEAT_NONE.ink;
        for (const [k, v] of Object.entries(LANG)) {
            for (const [part, c] of Object.entries(v)) {
                const suffix = part.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
                vars[`--ss-lang-${k}-${suffix}`] = c;
            }
        }
        ACTIVITY.forEach((c, i) => { vars[`--ss-activity-${i}`] = c; });
        SERIES.forEach((c, i) => { vars[`--ss-series-${i + 1}`] = c; });
        return vars;
    }

    return { HEAT, HEAT_INK, HEAT_NONE, LANG, ACTIVITY, SERIES, RANKS, rankFor, cssVariables };
}));
