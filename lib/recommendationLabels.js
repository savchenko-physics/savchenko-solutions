/**
 * recommendationLabels.js — human labels for the catalog's facet values.
 *
 * The pipeline stores machine values (`exam_prep`, `fa`, `particle_nuclear`)
 * because they are stable keys for filtering and testing. Those must never reach
 * a reader: a Russian-speaking student seeing "exam_prep / undergraduate / mixed"
 * in a sidebar learns nothing. Every facet value gets a label in both site
 * languages, and anything unmapped falls back to the raw value rather than
 * rendering blank.
 */

const LEVEL = {
    school: { ru: 'Школьный', en: 'School' },
    exam_prep: { ru: 'Подготовка к экзаменам', en: 'Exam prep' },
    olympiad: { ru: 'Олимпиадный', en: 'Olympiad' },
    undergraduate: { ru: 'Университетский', en: 'Undergraduate' },
    research: { ru: 'Исследовательский', en: 'Research' },
    mixed: { ru: 'Разный уровень', en: 'Mixed' },
};

const LANGUAGE = {
    ru: { ru: 'Русский', en: 'Russian' },
    uk: { ru: 'Украинский', en: 'Ukrainian' },
    kk: { ru: 'Казахский', en: 'Kazakh' },
    uz: { ru: 'Узбекский', en: 'Uzbek' },
    be: { ru: 'Белорусский', en: 'Belarusian' },
    en: { ru: 'Английский', en: 'English' },
    fa: { ru: 'Персидский', en: 'Persian' },
    ar: { ru: 'Арабский', en: 'Arabic' },
    tr: { ru: 'Турецкий', en: 'Turkish' },
    az: { ru: 'Азербайджанский', en: 'Azerbaijani' },
    es: { ru: 'Испанский', en: 'Spanish' },
    pt: { ru: 'Португальский', en: 'Portuguese' },
    it: { ru: 'Итальянский', en: 'Italian' },
    de: { ru: 'Немецкий', en: 'German' },
    fr: { ru: 'Французский', en: 'French' },
    pl: { ru: 'Польский', en: 'Polish' },
    ro: { ru: 'Румынский', en: 'Romanian' },
    id: { ru: 'Индонезийский', en: 'Indonesian' },
    vi: { ru: 'Вьетнамский', en: 'Vietnamese' },
    hi: { ru: 'Хинди', en: 'Hindi' },
    zh: { ru: 'Китайский', en: 'Chinese' },
    ko: { ru: 'Корейский', en: 'Korean' },
    other: { ru: 'Другой', en: 'Other' },
    und: { ru: 'Не определён', en: 'Undetermined' },
};

const FORMAT = {
    channel: { ru: 'Канал', en: 'Channel' },
    // Named for what it lets you do, not what it is — only 22 of 600 entries are
    // groups, and "can I actually ask a question here?" is the reason to filter.
    group: { ru: 'Можно спросить', en: 'You can post' },
    site: { ru: 'Сайт', en: 'Website' },
    forum: { ru: 'Можно спросить', en: 'You can post' },
};

const TOPIC = {
    mechanics: { ru: 'Механика', en: 'Mechanics' },
    electromagnetism: { ru: 'Электромагнетизм', en: 'Electromagnetism' },
    thermodynamics: { ru: 'Термодинамика', en: 'Thermodynamics' },
    optics: { ru: 'Оптика', en: 'Optics' },
    quantum: { ru: 'Квантовая физика', en: 'Quantum' },
    astronomy: { ru: 'Астрономия', en: 'Astronomy' },
    relativity_gravitation: { ru: 'Теория относительности', en: 'Relativity' },
    particle_nuclear: { ru: 'Ядерная физика', en: 'Particle and nuclear' },
    condensed_matter: { ru: 'Физика твёрдого тела', en: 'Condensed matter' },
    mathematical_methods: { ru: 'Математические методы', en: 'Mathematical methods' },
    computational: { ru: 'Вычислительная физика', en: 'Computational' },
    plasma: { ru: 'Физика плазмы', en: 'Plasma' },
    biophysics: { ru: 'Биофизика', en: 'Biophysics' },
    geophysics: { ru: 'Геофизика', en: 'Geophysics' },
};

const MAPS = { level: LEVEL, language: LANGUAGE, format: FORMAT, topic: TOPIC };

/** @returns {string} label in `lang`, or the raw value when unmapped. */
function label(facet, value, lang) {
    if (value == null || value === '') return '';
    const entry = MAPS[facet] && MAPS[facet][value];
    if (!entry) return String(value);
    return entry[lang === 'ru' ? 'ru' : 'en'] || entry.en || String(value);
}

module.exports = { label, LEVEL, LANGUAGE, FORMAT, TOPIC };
