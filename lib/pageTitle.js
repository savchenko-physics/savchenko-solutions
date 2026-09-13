/**
 * Page titles: the text in <title>, og:title, twitter:title and the JSON-LD headline.
 *
 * House rule since 2026-09-12: no em dash, en dash, colon or semicolon in a page title,
 * and the parts of a title are separated by " | ". Before that every solution page read
 * "Problem 1.1.1 Solution — Kinematics | Savchenko Solutions", 36 templates hand-wrote
 * " — Savchenko Solutions", section 14.2 added a semicolon from sections.csv, and forum
 * topics arrived as "Discussion: Problem 1.2.3".
 *
 * titleText() cleans one piece of text, including whatever a database row or a user typed;
 * docTitle() joins pieces. Both are exposed to every template as app.locals, and
 * tests/page-titles.test.js fails on any title that is built without them.
 */

const SEPARATOR = ' | ';

const SITE_NAME = {
    en: 'Savchenko Solutions',
    ru: 'Решения Савченко',
};

/** One piece of a title with the banned punctuation rewritten. Idempotent. */
function titleText(value) {
    let s = String(value == null ? '' : value);
    s = s.replace(/(\d)\s*:\s*(\d)/g, '$1.$2');   // 12:00 → 12.00
    s = s.replace(/\s+[—–]\s+/g, ', ');            // "Tools — Free utilities" → "Tools, Free utilities"
    s = s.replace(/[—–]/g, '-');                   // "27–30", "Овчинкина–Прута"
    s = s.replace(/\s*[:;]\s*/g, ', ');            // "Preparation: Thermodynamics"
    s = s.replace(/\s+/g, ' ');
    s = s.replace(/\s*,(?:\s*,)+/g, ',');
    s = s.replace(/^[\s,]+|[\s,]+$/g, '');
    return s;
}

/** Title parts, each cleaned, empty ones dropped, joined with " | ". */
function docTitle(...parts) {
    return parts
        .flat()
        .map(titleText)
        .filter(Boolean)
        .join(SEPARATOR);
}

/** "Problem 1.1.1 Solution | Kinematics | Savchenko Solutions" and its Russian twin. */
function solutionTitle(name, sectionTitle, lang) {
    const ru = lang === 'ru';
    if (!sectionTitle) return docTitle(name, ru ? SITE_NAME.ru : SITE_NAME.en);
    return ru
        ? docTitle(`Задача ${name} Решение`, sectionTitle, SITE_NAME.ru)
        : docTitle(`Problem ${name} Solution`, sectionTitle, SITE_NAME.en);
}

module.exports = { SEPARATOR, SITE_NAME, titleText, docTitle, solutionTitle };
