#!/usr/bin/env node
/**
 * svg-statement-figures.js — give every post the book's vector statement figure, sized the way
 * astrosander sized section 1.1 by hand on 2026-09-20 (contributions 20837–20856).
 *
 * What those edits did, and what this repeats for every other post:
 *   - `statement.png` → `statement.svg` (the potrace tracing of the 3rd edition's bitmap,
 *     `scripts/book3/vectorize.py`; transparent, crisp at any zoom, a few KB);
 *   - a contributor's own crop of the same book figure (`1.1.19/<mojibake>.png`,
 *     `11.1.10/11.1.10.png`, screenshots…) → `statement.svg` as well, when it is the only image
 *     in the statement section and its alt calls it the problem's figure or says nothing;
 *   - the display size retuned so every figure shows the book at the same magnification: the
 *     captions inside the sixteen figures come out the same size on the page. That is
 *     `display width = 0.5 × the SVG's 300-dpi width` (1.2 × the printed size), as a share of
 *     transformImageMarkdown's 800 px basis, rounded to 5 %. A small figure is lifted a little,
 *     as the owner lifted 1.1.18 and 1.1.21 (412 px pulleys and mirrors shown at 240, not 206):
 *     a quarter of what its width lacks to 480 px is added, and nothing goes under 25 %, so the
 *     book's smallest drawings (250 px) show at 200 px rather than 125. A very flat figure
 *     (1.1.5, three microphones on a line) is lifted until it is 120 px tall. Against the
 *     owner's sixteen choices the rule is exact seven times, one step off eight times, and two
 *     under on 1.1.13;
 *   - the `|WxH` before the scale is the SVG's own viewBox, so the box the browser reserves has
 *     the figure's real proportions (the old `507x327` was another site's PNG, and the page
 *     shifted when the file arrived);
 *   - an alt that is only a caption the book already draws inside the figure ("Для 1.1.13",
 *     "Figure for 1.2.16", "2.7.20.png") is blanked, as the owner blanked "Для"; "К задаче N" /
 *     "For problem N" alts stay, isBookCaption already hides them.
 *
 * Left alone, and listed in the report: a statement section with several images (14.3.6's three
 * parts, scans), an image whose alt is a real caption of the contributor's own, the twenty
 * problems whose book bitmap was never split from a neighbour's (figures.py's OVERRIDES need
 * them; 5.4.6's SVG shows 5.4.7 too), and the three crops that are not the book's figure at all
 * (13.2.9 is the contributor's own diagram, 2.3.37 is a scan of the whole solution, 3.2.7 shows
 * one of the book's two cases).
 *
 * The files are written in place and nothing is recorded in `contributions` — this is not an
 * edit by anyone. Back `posts/` up first (`tar czf ~/deploy-backups/posts-before-svg-figures-<ts>.tgz posts`).
 *
 *   node scripts/svg-statement-figures.js [--root DIR] [--only 1.1] [--apply]
 *
 * Without --apply it only reports. --root is the app directory holding posts/ and img/ (the
 * server's, where posts/ is authoritative). --only keeps posts whose number starts with the prefix.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { isBookCaption } = require('../js/solution-structure');

const BASIS = 800;            // transformImageMarkdown's basis: display width = BASIS × pct
const MAGNIFICATION = 0.5;    // display px per 300-dpi px of the SVG's viewBox
const SMALL_BELOW = 480;      // a figure narrower than this is lifted by LIFT × the shortfall
const LIFT = 0.25;
const MIN_PCT = 25;
const MIN_HEIGHT = 120;
const STEP = 5;

/** Problems whose 3rd-edition bitmap holds a neighbour's figure too (figure_map.json pieces with several names). */
const SHARED_BITMAP = new Set([
    '2.1.25', '2.1.26', '2.4.20', '2.4.21', '3.1.8', '3.1.10', '5.4.6', '5.4.7', '5.5.3', '5.5.4',
    '5.5.10', '6.1.9', '6.1.10', '7.2.4', '7.2.5', '9.1.7', '9.1.8', '9.1.9', '13.3.5', '13.3.6',
]);
/** Contributor images in the statement section that are not the book's figure (checked by eye, 2026-09-20). */
const NOT_THE_BOOK_FIGURE = new Set(['13.2.9', '2.3.37', '3.2.7']);

const IMAGE_RE = /!\[([^\]]*)\]\(\.\.\/\.\.\/img\/([^/)]+)\/([^)]+)\)/g;
const HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]/;
const STATEMENT_FILE_RE = /^statement\.(png|webp|jpe?g)$/i;
/** An alt that only names the figure: "Для 1.1.13", "Для задачи $2.4.35$", "Figure for 1.2.16", "2.7.20.png", "1.1.5". */
const CAPTION_ONLY_RE = /^\s*(?:к задаче|для задачи|для|for problem|for the problem|figure for problem|figure for|figure|problem|to problem|for|рис\.?|fig\.?)?\s*\$?\s*\d{1,2}\.\d{1,2}\.\d{1,3}\s*(?:\^\{?\s*[*∗]?\s*\}?|\\\*|[*∗])?\s*\.?\s*\$?\s*(?:\.png|problem)?\s*$/i;

/** Where the statement section ends: the first heading after the first line of content. */
function statementEnd(text) {
    const lines = text.split('\n');
    let seenContent = false;
    let offset = 0;
    for (const line of lines) {
        const heading = HEADING_RE.test(line);
        if (seenContent && heading) return offset;
        if (!heading && line.trim()) seenContent = true;
        offset += line.length + 1;
    }
    return text.length;
}

function svgBox(file) {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
    const m = head.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
    if (!m) return null;
    const w = Math.round(Number(m[1]));
    const h = Math.round(Number(m[2]));
    return w > 0 && h > 0 ? { w, h } : null;
}

const roundStep = (pct) => Math.round(pct / STEP) * STEP;

/** The display share of the 800 px basis for a figure of this viewBox. */
function scalePercent({ w, h }) {
    const width = MAGNIFICATION * w + LIFT * Math.max(0, SMALL_BELOW - w);
    let pct = Math.max(MIN_PCT, roundStep((width * 100) / BASIS));
    const height = ((BASIS * pct) / 100) * (h / w);
    if (height < MIN_HEIGHT) pct = Math.max(pct, roundStep((MIN_HEIGHT * (w / h) * 100) / BASIS));
    return Math.min(100, pct);
}

/**
 * Decide what to do with one post. Returns { action, ... } where action is 'rewrite' with
 * the new text, or a reason for leaving it: 'no-svg', 'no-image', 'already-svg', 'several-images',
 * 'shared-bitmap', 'not-book-figure', 'own-caption', 'other-folder'.
 */
function plan(text, name, svgPath) {
    if (!fs.existsSync(svgPath)) return { action: 'no-svg' };
    const end = statementEnd(text);
    const section = text.slice(0, end);
    const images = [...section.matchAll(IMAGE_RE)];
    if (!images.length) return { action: 'no-image' };
    if (images.length > 1) return { action: 'several-images', files: images.map((m) => m[3]) };
    const [match, altPart, folder, file] = images[0];
    if (folder !== name) return { action: 'other-folder', file: `${folder}/${file}` };
    if (/^statement\.svg$/i.test(file)) return { action: 'already-svg' };
    if (SHARED_BITMAP.has(name)) return { action: 'shared-bitmap', file };
    if (NOT_THE_BOOK_FIGURE.has(name)) return { action: 'not-book-figure', file };

    const pipe = altPart.indexOf('|');
    const alt = pipe >= 0 ? altPart.slice(0, pipe) : altPart;
    const isStatementFile = STATEMENT_FILE_RE.test(file);
    const bookCaption = isBookCaption(alt, name, 'statement.svg');
    const captionOnly = CAPTION_ONLY_RE.test(alt);
    const blank = !alt.trim();
    if (!isStatementFile && !bookCaption && !captionOnly && !blank) return { action: 'own-caption', file, alt };

    const box = svgBox(svgPath);
    if (!box) return { action: 'no-svg' };
    const pct = scalePercent(box);
    const keptAlt = bookCaption ? alt : '';
    const replacement = `![${keptAlt}|${box.w}x${box.h}, ${pct}%](../../img/${name}/statement.svg)`;
    if (replacement === match) return { action: 'already-svg' };
    const at = images[0].index;
    return {
        action: 'rewrite',
        from: match,
        to: replacement,
        text: text.slice(0, at) + replacement + text.slice(at + match.length),
    };
}

function main() {
    const args = process.argv.slice(2);
    const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
    const root = path.resolve(opt('--root') || path.join(__dirname, '..'));
    const only = opt('--only');
    const apply = args.includes('--apply');

    const counts = {};
    const notes = [];
    for (const lang of ['ru', 'en']) {
        const dir = path.join(root, 'posts', lang);
        for (const f of fs.readdirSync(dir).sort()) {
            if (!f.endsWith('.md')) continue;
            const name = f.slice(0, -3);
            if (only && !(name === only || name.startsWith(`${only}.`))) continue;
            const file = path.join(dir, f);
            const text = fs.readFileSync(file, 'utf8');
            const p = plan(text, name, path.join(root, 'img', name, 'statement.svg'));
            counts[p.action] = (counts[p.action] || 0) + 1;
            if (p.action === 'rewrite') {
                notes.push(`${lang}/${name}: ${p.from}\n    -> ${p.to}`);
                if (apply) fs.writeFileSync(file, p.text);
            } else if (!['no-svg', 'no-image', 'already-svg'].includes(p.action)) {
                notes.push(`${lang}/${name}: ${p.action} ${JSON.stringify(p.files || p.file || '')}${p.alt ? ` alt=${JSON.stringify(p.alt)}` : ''}`);
            }
        }
    }
    console.log(notes.join('\n'));
    console.log(`\n${apply ? 'applied' : 'dry run'}: ${JSON.stringify(counts)}`);
}

module.exports = { plan, scalePercent, statementEnd, CAPTION_ONLY_RE, SHARED_BITMAP };

if (require.main === module) main();
