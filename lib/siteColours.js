// lib/siteColours.js: the site's colours, read from the site's stylesheet.
//
// The weekly digest is an email, so every colour has to be written into the markup as a literal
// (mail clients have no custom properties and no stylesheet). Copying the hexes by hand would
// mean the email drifts the first time a token changes, which is exactly the "one source for
// every number" rule this project keeps. So the tokens are parsed out of css/design-system.css
// §1 at startup, and lib/digestRender.js asks for them by name.
//
// The data colours (the four series a chart uses) come from js/palettes.js, which is the one
// place they exist, so a person's avatar circle is a colour the site already owns.

const fs = require('fs');
const path = require('path');
const palettes = require('../js/palettes');

const CSS = path.join(__dirname, '..', 'css', 'design-system.css');

// Every `--ss-thing: #rrggbb;` in the stylesheet, by name without the prefix.
function readTokens() {
    const out = {};
    let source = '';
    try {
        source = fs.readFileSync(CSS, 'utf8');
    } catch (err) {
        console.error('siteColours: design-system.css unreadable, falling back to the navy:', err.message);
        return out;
    }
    for (const m of source.matchAll(/--ss-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
        out[m[1]] = m[2].toLowerCase();
    }
    return out;
}

const TOKENS = readTokens();

/** One token by its name without the `--ss-` prefix, or the given fallback. */
function colour(name, fallback = '#1a1a2e') {
    const value = TOKENS[name];
    if (!value) {
        console.error(`siteColours: --ss-${name} is not in design-system.css, using ${fallback}`);
        return fallback;
    }
    return value;
}

module.exports = { colour, TOKENS, SERIES: palettes.SERIES };
