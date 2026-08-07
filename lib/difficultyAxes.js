/**
 * difficultyAxes.js — reader-facing labels and explanations for every axis in
 * difficultyRubric.js.
 *
 * difficultyRubric.js stays the LLM-facing half: the prompt text and JSON schema
 * sent to the model. This is the reader-facing half: what a human sees on the
 * solution page, the methodology page, and the problem finder's filter panel.
 * Splitting them means the same explanation is written once and never drifts
 * between the three places it's shown — see recommendationLabels.js for the same
 * pattern applied to the recommendations catalog's facet values.
 *
 * Only 9 of these 22 axes are shown on the solution page (views/solution_post.ejs);
 * the rest exist in problem_difficulty.scores today with no reader-facing text
 * anywhere. The explanations below are written for a reader seeing the axis name
 * for the first time, compressed from the grounding quotes already in
 * difficultyRubric.js — they don't introduce any claim that isn't already there.
 */

const { AXIS_KEYS } = require('../difficultyRubric');

// category groups mirror the three comment-delimited sections in difficultyRubric.js
// (AXES, lines ~38/60/72), plus `headline` for overall_difficulty alone — it's shown
// as the big /100 number, never as a bar alongside the others.
const META = {
    overall_difficulty: {
        category: 'headline',
        labelEn: 'Difficulty', labelRu: 'Сложность',
        explainEn: 'The headline number: overall difficulty for the reference solver, described below.',
        explainRu: 'Итоговое число: общая сложность для эталонного решающего, описанного ниже.',
    },

    // ── what it costs ───────────────────────────────────────────────────────
    insight_required: {
        category: 'cost',
        labelEn: 'Insight', labelRu: 'Идея',
        explainEn: 'The size of the "aha". Low: grind it out with standard machinery. High: nothing happens until you see the one idea.',
        explainRu: 'Размер «озарения». Низкое значение — решается стандартными приёмами. Высокое — ничего не выйдет, пока не увидишь единственную нужную идею.',
    },
    math_level: {
        category: 'cost',
        labelEn: 'Mathematics', labelRu: 'Математика',
        explainEn: 'How much mathematical machinery is needed — integration, differential equations, series, vector calculus.',
        explainRu: 'Насколько сложный математический аппарат нужен — интегрирование, дифференциальные уравнения, ряды, векторный анализ.',
    },
    physics_depth: {
        category: 'cost',
        labelEn: 'Physics depth', labelRu: 'Глубина физики',
        explainEn: 'How much physics beyond the school syllabus you need to already know, walking in.',
        explainRu: 'Сколько физики сверх школьной программы нужно знать заранее, ещё до решения.',
    },
    computational_load: {
        category: 'cost',
        labelEn: 'Computation', labelRu: 'Вычисления',
        explainEn: 'The algebraic grind after the idea is found. Independent of how hard the idea itself was.',
        explainRu: 'Объём вычислений после того, как идея уже найдена. Не зависит от того, насколько сложно было её найти.',
    },
    trap_density: {
        category: 'cost',
        labelEn: 'Traps', labelRu: 'Подводные камни',
        explainEn: "How easy it is to take a plausible-looking step that's actually wrong.",
        explainRu: 'Насколько легко сделать шаг, который выглядит правдоподобно, но на самом деле неверен.',
    },
    specialist_knowledge: {
        category: 'cost',
        labelEn: 'Specialist knowledge', labelRu: 'Спец. знания',
        explainEn: 'Machinery from outside any school curriculum — a felt cost, distinct from general physics depth.',
        explainRu: 'Приёмы, выходящие за рамки любой школьной программы — ощутимая, но отдельная от общей глубины физики трудность.',
    },
    modelling_judgement: {
        category: 'cost',
        labelEn: 'Modelling judgement', labelRu: 'Выбор модели',
        explainEn: 'Choosing the right physical model and deciding what can be neglected.',
        explainRu: 'Умение выбрать физическую модель и решить, чем можно пренебречь.',
    },
    estimation: {
        category: 'cost',
        labelEn: 'Estimation', labelRu: 'Оценка порядка',
        explainEn: 'How much the problem calls for order-of-magnitude reasoning rather than an exact answer.',
        explainRu: 'Насколько задача требует оценки по порядку величины, а не точного ответа.',
    },
    branching: {
        category: 'cost',
        labelEn: 'Branching', labelRu: 'Разбор случаев',
        explainEn: 'How many separate cases or regimes have to be enumerated and handled one by one.',
        explainRu: 'Сколько отдельных случаев или режимов нужно перебрать и разобрать по отдельности.',
    },

    // ── the shape of the problem ────────────────────────────────────────────
    statement_simplicity_gap: {
        category: 'shape',
        labelEn: 'Simplicity gap', labelRu: 'Разрыв простоты',
        explainEn: 'How far the real difficulty exceeds what the statement looks like — an innocent-looking sentence hiding a hard problem.',
        explainRu: 'Насколько реальная сложность превышает ту, что кажется по условию — безобидная на вид фраза может скрывать трудную задачу.',
    },
    self_containedness: {
        category: 'shape',
        labelEn: 'Self-containedness', labelRu: 'Самодостаточность',
        explainEn: 'Can it be solved from the statement plus general reasoning alone, with nothing looked up? High means yes.',
        explainRu: 'Можно ли решить только из условия и общих рассуждений, ничего не ища дополнительно? Высокое значение — да.',
    },
    hidden_data: {
        category: 'shape',
        labelEn: 'Hidden data', labelRu: 'Скрытые данные',
        explainEn: 'Does solving it secretly require a number or fact the statement never gives you? High is a real defect.',
        explainRu: 'Требует ли решение числа или факта, которого нет в условии? Высокое значение — это недостаток задачи.',
    },
    answer_opacity: {
        category: 'shape',
        labelEn: 'Answer opacity', labelRu: 'Непрозрачность ответа',
        explainEn: "Would seeing the final answer help you find the route to it? High means no — the answer alone tells you nothing.",
        explainRu: 'Помог бы готовый ответ найти путь к решению? Высокое значение — нет, сам по себе ответ ничего не подсказывает.',
    },
    wellposedness: {
        category: 'shape',
        labelEn: 'Well-posedness', labelRu: 'Корректность постановки',
        explainEn: 'Is the problem sound — a consistent idealisation, enough data, a determinate answer? Low flags a defect in the problem itself, not in the solver.',
        explainRu: 'Корректно ли поставлена задача — непротиворечивая идеализация, достаточно данных, однозначный ответ? Низкое значение указывает на изъян в самой задаче, а не в решающем.',
    },

    // ── why anyone would want to solve it ───────────────────────────────────
    elegance: {
        category: 'reward',
        labelEn: 'Elegance', labelRu: 'Красота решения',
        explainEn: 'The beauty of the route the solution actually takes — the short way past the integral, not the answer itself.',
        explainRu: 'Красота пути, которым идёт решение — короткая дорога в обход громоздкого интеграла, а не сам ответ.',
    },
    creativity: {
        category: 'reward',
        labelEn: 'Creativity', labelRu: 'Изобретательность',
        explainEn: 'How inventive the solver has to be, as opposed to simply well-drilled.',
        explainRu: 'Насколько изобретательным нужно быть решающему, в отличие от простой натренированности.',
    },
    curiosity: {
        category: 'reward',
        labelEn: 'Curiosity', labelRu: 'Любопытство',
        explainEn: 'Does the setup itself make you want to know the answer?',
        explainRu: 'Вызывает ли сама постановка задачи желание узнать ответ?',
    },
    pleasure: {
        category: 'reward',
        labelEn: 'Pleasure', labelRu: 'Удовольствие',
        explainEn: 'The satisfaction of finally getting it out.',
        explainRu: 'Удовлетворение от того, что задача наконец поддалась.',
    },
    novelty: {
        category: 'reward',
        labelEn: 'Novelty', labelRu: 'Новизна',
        explainEn: "The opposite of formulaic. High means you haven't seen this kind of problem before.",
        explainRu: 'Противоположность шаблонности. Высокое значение — такого рода задача ещё не встречалась.',
    },
    generality: {
        category: 'reward',
        labelEn: 'Generality', labelRu: 'Общность результата',
        explainEn: 'Does the result reach further than what was actually asked?',
        explainRu: 'Выходит ли результат за рамки того, что было прямо спрошено?',
    },
    instructiveness: {
        category: 'reward',
        labelEn: 'Instructiveness', labelRu: 'Обучающая ценность',
        explainEn: "Does solving it teach a transferable idea you'll use again?",
        explainRu: 'Учит ли решение переносимой идее, которая пригодится снова?',
    },
};

// Ordered the same way AXIS_KEYS is (difficultyRubric.js's own order), each entry
// carrying its key alongside the label/explain text above.
const AXIS_META = AXIS_KEYS.map((key) => {
    const m = META[key];
    if (!m) throw new Error(`difficultyAxes.js: no metadata for axis "${key}"`);
    return { key, ...m };
});

const AXIS_BY_KEY = new Map(AXIS_META.map((a) => [a.key, a]));

function label(key, lang) {
    const a = AXIS_BY_KEY.get(key);
    if (!a) return key;
    return lang === 'ru' ? a.labelRu : a.labelEn;
}

function explain(key, lang) {
    const a = AXIS_BY_KEY.get(key);
    if (!a) return '';
    return lang === 'ru' ? a.explainRu : a.explainEn;
}

function axesByCategory(category) {
    return AXIS_META.filter((a) => a.category === category);
}

// A bare "75" on a bar means nothing to a reader who hasn't memorized the 0-100 scale —
// real feedback confirmed this ("i still don't understand how to read Insight 75..."),
// and a hover tooltip alone doesn't fix it: there's no hover on a touchscreen, and this
// audience skews mobile. Same 5-tier anchor difficultyRubric.js's SCALE already uses for
// the headline score, reused here so every number in the widget reads in words first.
const BUCKETS = [
    { max: 20, en: 'Minimal', ru: 'Минимум' },
    { max: 40, en: 'Slight', ru: 'Слегка' },
    { max: 60, en: 'Moderate', ru: 'Средне' },
    { max: 80, en: 'High', ru: 'Высоко' },
    { max: 101, en: 'Extreme', ru: 'Максимум' },
];
function bucketWord(value, lang) {
    if (value == null) return '';
    const v = Math.max(0, Math.min(100, Number(value)));
    const bucket = BUCKETS.find((b) => v < b.max) || BUCKETS[BUCKETS.length - 1];
    return lang === 'ru' ? bucket.ru : bucket.en;
}

// The 9 axes shown on the per-problem widget today (views/solution_post.ejs),
// split into the same two display groups used there. Kept here so the widget,
// the methodology page and the finder page never disagree on which 9 those are.
const WIDGET_COST_KEYS = ['insight_required', 'math_level', 'computational_load', 'trap_density', 'specialist_knowledge'];
const WIDGET_REWARD_KEYS = ['elegance', 'novelty', 'curiosity', 'pleasure'];

module.exports = {
    AXIS_META,
    AXIS_BY_KEY,
    label,
    explain,
    axesByCategory,
    bucketWord,
    WIDGET_COST_KEYS,
    WIDGET_REWARD_KEYS,
};
