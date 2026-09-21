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

    // 9-step YlOrRd ramp for difficulty (0-100 → 1…9). Navy ink on steps 1-5, white on 6-9.
    // Step 6 is the one judgement call: navy on its red-orange measures 5.1:1 against white's
    // 3.35:1, and yet the owner could not read the navy numerals there (2026-09-20); the
    // numerals are bold, for which 3:1 is the threshold, and a red-orange field reads as one
    // that carries white. A red dark enough for 4.5:1 would be step 7's colour. Step 5 stays
    // navy: white on its orange is 2.3:1, unreadable by any measure.
    const HEAT = ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'];
    const HEAT_INK = ['#1a1a2e', '#1a1a2e', '#1a1a2e', '#1a1a2e', '#1a1a2e', '#ffffff', '#ffffff', '#ffffff', '#ffffff'];
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

    // Codeforces-style rank tiers (deliberately the Codeforces colours, which this audience knows):
    // the three grandmaster tiers are one red, and a legendary grandmaster's first letter is black,
    // as on Codeforces (the `first` colour, drawn by the .ss-rank-<key>::first-letter rules in
    // design-system.css; grandmaster was a darker #CC0000 until 2026-09-21). The site's owner has
    // no tier: "Headquarters" is plain black.
    const RANK_HQ = { key: 'headquarters', color: '#000000' };
    const RANKS = [
        // 170 since 2026-09-21 (was 200, which nobody had reached): the top scorer is legendary.
        { min: 170, key: 'legendaryGrandmaster', color: '#FF0000', first: '#000000' },
        { min: 160, key: 'internationalGrandmaster', color: '#FF0000' },
        { min: 130, key: 'grandmaster', color: '#FF0000' },
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

    /** The per-tier rules scripts/build-css.js writes into the bundle: the colour as a class (with
     *  link states, so a page's own a:hover cannot take it back, and --ss-rank-current for an
     *  element whose own rule says color: inherit), and the first letter's colour where a tier
     *  has one (the legendary grandmaster's black, as on Codeforces). */
    function rankCss() {
        const lines = [];
        for (const r of [...RANKS, RANK_HQ]) {
            const c = `.ss-rank-c-${r.key}`;
            lines.push(`${c}, a${c}:link, a${c}:visited, a${c}:hover { --ss-rank-current: var(--ss-rank-${r.key}); color: var(--ss-rank-${r.key}); }`);
            if (r.first) lines.push(`${c}::first-letter, .ss-rank-${r.key}::first-letter { color: var(--ss-rank-${r.key}-first); }`);
        }
        return lines.join('\n');
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
        for (const r of [...RANKS, RANK_HQ]) {
            vars[`--ss-rank-${r.key}`] = r.color;
            if (r.first) vars[`--ss-rank-${r.key}-first`] = r.first;
        }
        return vars;
    }

    return { HEAT, HEAT_INK, HEAT_NONE, LANG, ACTIVITY, SERIES, RANKS, RANK_HQ, rankFor, rankCss, cssVariables };
}));
