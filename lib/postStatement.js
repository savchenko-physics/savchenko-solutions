// The statement section of a solution post, as markdown. A handful of statements in
// problem_statements are still the flattened text recovered from the scanned book
// ("ω = √g/l", needs_review), and the problem database and the hover previews showed them
// that way while the post of the same problem carried the statement properly typeset by its
// contributor (/ru/3.5.27, 2026-09-20). lib/statementRender.js prefers the post's section for
// such rows. Reading only: posts/ is the contributors' work and is never written here.
'use strict';

const fs = require('fs');
const path = require('path');

// The statement heading in the spellings the posts use (js/solution-structure.js KINDS).
const STATEMENT_HEADING = /^#{1,6}\s*(?:у?сл?л?овие|условия|statement|problem(?:\s+statement)?|condition)\s*:?\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
// The book's number at the start, in the forms the posts use (counted over all of them):
// "$3.5.27.$" (1,912), "$3.5.32^*.$" (265, the ∗ as a superscript, also "^{∗}", "^∗"), "$1.1.1$",
// "**3.5.27.**", "3.5.27.", and a sub-item letter inside the same dollars, "$1.1.9. а.$", which
// stays. The ∗ goes with the number (the starred column carries it); leaving "^*.$" behind put
// a stray dollar in front of the statement and set its first sentence as maths (3.5.32's
// preview, 2026-09-20). Mirrors scripts/build-statements.js NUMBER_PREFIX.
const LEADING_NUMBER = /^\s*(?:\$\s*)?(?:\*\*)?\d{1,2}\.\d{1,2}\.\d{1,3}\s*(?:\^\s*\{?\s*[*∗]\s*\}?)?\s*\.?\s*(?:([а-яa-z])\s*\.\s*)?(?:\*\*)?(?:\s*\$)?[.\s]*/i;

function postStatement(name, lang, root = path.join(__dirname, '..')) {
    if (!/^\d{1,2}\.\d{1,2}\.\d{1,3}$/.test(String(name))) return null;
    let text;
    try {
        text = fs.readFileSync(path.join(root, 'posts', lang === 'ru' ? 'ru' : 'en', `${name}.md`), 'utf8');
    } catch (_err) {
        return null;
    }
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => STATEMENT_HEADING.test(l.trim()));
    if (start === -1) return null;
    const body = [];
    for (let i = start + 1; i < lines.length; i++) {
        if (ANY_HEADING.test(lines[i]) || /^---\s*$/.test(lines[i])) break;
        body.push(lines[i]);
    }
    const md = body.join('\n').trim().replace(LEADING_NUMBER, (m, letter) => (letter ? `${letter}. ` : ''));
    return md || null;
}

module.exports = { postStatement };
