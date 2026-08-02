/**
 * recommendationsForChapter.js — pick catalog entries relevant to a problem's chapter.
 *
 * Solution pages are 57.8% of all pageviews on this site; /tools, which is only
 * reachable from a nav dropdown and the footer, drew 392 pageviews in 21 months.
 * A catalog nobody can reach from where the readers already are repeats that
 * outcome, so this surfaces a small, topic-matched entry point from the page they
 * are actually on.
 *
 * Reads the already-loaded catalog — no extra file I/O and no client fetch, so
 * the solution page costs nothing extra to render.
 */

/** Savchenko's 14 chapters mapped to the topic vocabulary the catalog tags with. */
const CHAPTER_TOPICS = {
    1: ['mechanics'],                       // Кинематика
    2: ['mechanics'],                       // Динамика
    3: ['mechanics', 'optics'],             // Колебания и волны
    4: ['mechanics'],                       // Механика жидкости
    5: ['thermodynamics'],                  // Молекулярная физика
    6: ['electromagnetism'],                // Электростатика
    7: ['electromagnetism'],                // Движение зарядов в электрическом поле
    8: ['electromagnetism'],                // Электрический ток
    9: ['electromagnetism'],                // Постоянное магнитное поле
    10: ['electromagnetism'],               // Движение зарядов в сложных полях
    11: ['electromagnetism'],               // Электромагнитная индукция
    12: ['electromagnetism', 'optics'],     // Электромагнитные волны
    13: ['optics', 'quantum'],              // Геометрическая оптика, квантовая природа света
    14: ['relativity_gravitation'],         // Специальная теория относительности
};

/** Rubrics a student stuck on a problem actually wants. */
const USEFUL_RUBRICS = new Set([
    'olympiad_problem_solving',
    'physics_concepts_resources',
    'entrance_exam_prep',
]);

/**
 * @param {object|null} catalog  parsed data/recommendations.json
 * @param {string} problemRef    e.g. "2.2.12"
 * @param {string} lang          'ru' | 'en'
 * @param {number} limit
 * @returns {Array} entries, possibly empty — the caller renders nothing when empty
 */
function recommendationsForChapter(catalog, problemRef, lang, limit = 3) {
    if (!catalog) return [];
    const chapter = parseInt(String(problemRef || '').split('.')[0], 10);
    const topics = CHAPTER_TOPICS[chapter];
    if (!topics) return [];

    const entries = catalog.telegram?.entries || [];
    // Prefer the reader's own language; a Russian student should not be sent to a
    // Persian channel because it happened to score well.
    const preferred = lang === 'ru' ? ['ru', 'uk', 'kk', 'uz'] : ['en'];

    const matches = entries.filter((e) => (
        !e.generic
        && USEFUL_RUBRICS.has(e.rubric)
        && (e.topics || []).some((t) => topics.includes(t))
        && preferred.includes(e.language)
    ));

    // Already sorted by score in the catalog; keep that order.
    return matches.slice(0, limit);
}

module.exports = { recommendationsForChapter, CHAPTER_TOPICS, USEFUL_RUBRICS };
