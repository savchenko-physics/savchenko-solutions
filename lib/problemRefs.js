// Problem numbers written in a statement become links to those problems. Savchenko's statements
// refer to one another constantly ("решите задачи 14.3.1–14.3.3, 14.3.5", "в задаче 3.4.15а",
// "14.3.6 а, б и 14.3.7"), and on the problem database each such number was plain text
// (the owner, 2026-09-19). A number is linked when it is one of the book's 2,023
// (lib/bookProblems.js), so "0.1.5" or a version number stays text; a letter glued to it
// ("3.4.15а") stays outside the link; a statement's own number is not linked to itself.
//
// Works on rendered HTML, a statement's or a whole solution page's: only text between tags
// is touched, never attributes, anything already inside <a>, a typeset formula (its SVG
// <text> can hold digits, and its TeX source travels beside it), a script, a style, a
// title, a form control or code.
'use strict';

const { isBookProblem } = require('./bookProblems');

const NUMBER_RE = /(?<![\d.])(\d{1,2}\.\d{1,2}\.\d{1,3})(?![\d.]\d)/g;
const KEEP_WHOLE = ['a', 'svg', 'mjx-container', 'script', 'style', 'title', 'textarea', 'pre', 'code', 'option', 'select', 'button', 'noscript'];
const SPLIT_RE = new RegExp(`(${KEEP_WHOLE.map((t) => `<${t}\\b[\\s\\S]*?<\\/${t}>`).join('|')}|<[^>]+>)`, 'g');

function linkProblemRefs(html, lang, { self = null } = {}) {
    if (!html || !/\d\.\d/.test(html)) return html;
    const l = lang === 'ru' ? 'ru' : 'en';
    // Split into the runs that must not be touched (whole elements of the kinds above, any
    // tag) and the text between them.
    return html.split(SPLIT_RE).map((part, i) => {
        if (i % 2) return part; // a tag or a protected block
        return part.replace(NUMBER_RE, (m) => (m !== self && isBookProblem(m)
            ? `<a class="problem-ref" href="/${l}/${m}">${m}</a>`
            : m));
    }).join('');
}

module.exports = { linkProblemRefs };
