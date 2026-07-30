// difficultyRubric.js
//
// The axes an LLM scores each Savchenko problem on, the prompt that anchors them, and the
// strict JSON schema the response must satisfy.
//
// Two rules govern everything here.
//
// The model is never told which problems Savchenko starred. 565 of 2,023 carry his ∗, and
// that is the only independent difficulty ground truth this project has. Reveal it and the
// model echoes it back, the starred-vs-unstarred AUC becomes circular, and the one honest
// check on whether any of this works is gone.
//
// The reward axes are judged from the solution, not the statement. You cannot tell whether
// a problem is beautiful until you have seen how it comes out — which is why the solution
// text is part of the input wherever the site has one.
//
// The axes are not invented. Each traces to something a real solver said: interviews with
// BelPhO alumni (Andrei Katsevich, Stasis Chuchurka), the site's own #2 contributor
// Evgeniy Dubrovin, and 136 substantive comments and messages on savchenkosolutions.com.
// The grounding quote for each is in the rubric text below, because the anchor is what
// makes a 0–100 axis mean anything.

const SCALE = `Every axis is an integer 0-100, judged against an IPhO-level reference
solver: someone who has trained for the International Physics Olympiad and has calculus,
mechanics, thermodynamics, electromagnetism and special relativity at their command.

Anchor the scale like this, and use its full width — most problems in this book are NOT
average, and a wall of 50s is a useless answer:
   0-20   routine for such a solver; one standard law applied once
   21-40  a school-olympiad exercise; the method is obvious, the work is short
   41-60  a national-olympiad problem; a real step is needed but it is a known step
   61-80  hard; "задача повышенной трудности" — the phrase the book's own readers use
   81-100 IPhO problem 3; the idea is not something you can look up`;

// Each axis: the key stored in problem_difficulty.scores, and the definition sent to the
// model. Keep the definitions terse — they are re-sent for all 2,023 problems.
const AXES = [
    // ── what it costs to solve ──────────────────────────────────────────────
    ['overall_difficulty',
        'Overall difficulty for the reference solver. The headline number.'],
    ['insight_required',
        'Size of the "aha". 0 = grind it out with standard machinery, 100 = nothing happens until you see the one idea.'],
    ['math_level',
        'Mathematical machinery: integration, differential equations, series, vector calculus. Katsevich puts Irodov above Savchenko precisely because Irodov is "problems where you have to take integrals".'],
    ['physics_depth',
        'How much physics beyond the school syllabus the solver must already know.'],
    ['computational_load',
        'Algebraic grind AFTER the idea is found. Independent of insight_required.'],
    ['trap_density',
        'How easy it is to take a plausible step that is wrong. A reader of 3.4.6 wrote "Ошибиться тут сложно ;)" — that is a 0. Problems 10.2.8 and 13.1.20 drew long disputes over a subtly wrong step — those are high.'],
    ['specialist_knowledge',
        'Machinery outside any school curriculum. A reader of 6.6.2: "меня всегда напрягают слегка формулы со страшными названиями, незнакомые со школьной программы". Named because it is a felt cost, distinct from physics_depth.'],
    ['modelling_judgement',
        'Choosing the physical model and deciding what may be neglected. Dubrovin names this as its own skill: "как выбирать физическую модель, чем можно пренебречь".'],
    ['estimation',
        'Order-of-magnitude reasoning rather than an exact answer.'],
    ['branching',
        'Several cases or regimes that must be enumerated separately.'],

    // ── the shape of the problem ────────────────────────────────────────────
    ['statement_simplicity_gap',
        'How far the difficulty exceeds what the statement looks like. Katsevich states this twice as his own criterion for a good problem: "легко формулируемые тяжелые задачи" — easily stated, hard to solve. A one-line statement hiding a hard problem scores 100.'],
    ['self_containedness',
        'Can it be solved from the statement plus general reasoning, with nothing looked up? Katsevich: "мне нравятся такие задачи, которые может решить школьник... больше ничего не надо знать". High = self-contained. Deliberately separate from difficulty: hard-because-you-must-know-a-fact is not the same as hard-because-you-must-think.'],
    ['hidden_data',
        'Does solving require a number or fact the statement never gives? Dubrovin on 5.8.10, where the substance turned out to be pyrite and its molar mass was simply assumed: "Ну откуда знать это школьнику?" High = bad.'],
    ['answer_opacity',
        'Would seeing the answer help you find the route? Savchenko ships answers without solutions, so this is a real cost. Chuchurka, an IPhO silver medallist, on a problem he never solved: "Я даже на ответ смотрел, и это мне ничего не подсказывало". High = the answer tells you nothing.'],
    ['wellposedness',
        'Is the problem sound — consistent idealisation, enough data, a determinate answer? High = well posed. Low flags a defect: Dubrovin dislikes 4.2.22 for an incompressible bubble rising through changing pressure, and found outright errors in the book\'s own answers to 14.2.1 and 2.6.15.'],

    // ── why anyone would want to solve it ───────────────────────────────────
    ['elegance',
        'Beauty of the route the solution actually takes. Katsevich: "можно брать какой-то интеграл, а можно какое-то красивое решение" — elegance is the short way past the integral, and it is a property of the solution, not the answer.'],
    ['creativity',
        'How inventive the solver must be, as opposed to well-drilled.'],
    ['curiosity',
        'Does the setup itself make you want to know the answer?'],
    ['pleasure',
        'Satisfaction on finally getting it out.'],
    ['novelty',
        'The opposite of formulaic. Katsevich dismisses the Phystech style as "простая, шаблонная задача" — templated. High = you have not seen this before.'],
    ['generality',
        'Does the result reach further than asked? Katsevich on a problem whose answer is 4: "результат верен для любого выпуклого тела". Dubrovin on 5.6.8, where two independent methods converge — "самым красивым моментом".'],
    ['instructiveness',
        'Does solving it teach a transferable idea? A reader of 2.2.24 argues another route is "более красивое и поучительное" — didactic value named alongside beauty.'],
];

const SYSTEM = `You rate physics problems from Savchenko's "Problems in Physics", the
standard hard problem book of the post-Soviet physics olympiad tradition. Your ratings help
students choose what to attempt next and find the problems worth their time.

${SCALE}

Rate each problem on these axes:

${AXES.map(([k, d]) => `- ${k}: ${d}`).join('\n')}

Also give:
- est_minutes: how long the reference solver needs, in minutes. Be realistic; these range
  from 3 to well over 180.
- key_idea: the one thing that unlocks it, in under 15 words. No preamble.
- prerequisites: up to 4 short topic tags, e.g. ["rotating frames", "Gauss's law"].

Judge the reward axes (elegance, creativity, curiosity, pleasure, novelty, generality,
instructiveness) from the SOLUTION where one is supplied — you cannot tell whether a
problem is beautiful until you have seen how it comes out. Judge the cost axes from what
the solver faces before they have it.

Be decisive and spread your scores. Two problems in the same section should rarely get the
same overall_difficulty.`;

// strict:true requires every property in `required` and additionalProperties:false.
function buildSchema() {
    const properties = {};
    for (const [key] of AXES) {
        properties[key] = { type: 'integer', minimum: 0, maximum: 100 };
    }
    properties.est_minutes = { type: 'integer', minimum: 1, maximum: 600 };
    properties.key_idea = { type: 'string' };
    properties.prerequisites = { type: 'array', items: { type: 'string' } };
    return {
        type: 'object',
        properties,
        required: [...AXES.map(([k]) => k), 'est_minutes', 'key_idea', 'prerequisites'],
        additionalProperties: false,
    };
}

/**
 * Build the user message for one problem.
 * `starred` is deliberately not a parameter — there is no way to leak it from here.
 */
function buildUserMessage({ name, sectionTitle, statement, solution }) {
    const parts = [`Problem ${name}${sectionTitle ? ` (section: ${sectionTitle})` : ''}`, '', statement];
    if (solution) {
        // Long solutions are truncated rather than dropped: the opening of a solution
        // carries the idea, which is what the reward axes turn on.
        const trimmed = solution.length > 6000 ? `${solution.slice(0, 6000)}\n[...]` : solution;
        parts.push('', 'Published solution:', trimmed);
    } else {
        parts.push('', '(No published solution — judge the reward axes from the statement alone.)');
    }
    return parts.join('\n');
}

module.exports = {
    AXES,
    AXIS_KEYS: AXES.map(([k]) => k),
    SYSTEM,
    buildSchema,
    buildUserMessage,
};
