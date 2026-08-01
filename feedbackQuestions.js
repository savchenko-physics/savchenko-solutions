// feedbackQuestions.js: all the words the feedback widget says, plus the poll queue.
//
// Config-in-code, in the shape of practicum.js and contest.js: a DB-free descriptor the
// router injects into res.locals so every template renders the same copy. It lives here
// rather than in locales/ because the wording IS the design. The placeholder text is the
// only mechanism forcing specificity, and splitting it across two JSON files would let the
// two languages drift apart silently.
//
// Two things this file encodes that came out of reading every piece of feedback the site
// has ever received:
//
//   1. The category prompts follow the Mom Test rule: ask about a concrete past moment,
//      never an opinion about the future. "Would you use X?" produces flattery; "what were
//      you doing when it broke?" produces a bug report. 13% of the legacy reports were just
//      "неверно" with no detail, which is a question-design failure, not a user failure.
//
//   2. The poll shows exactly ONE question per visitor, ever. One question completes at
//      ~86%, six at ~69%. Because nobody ever sees two, the queue can be as long as it
//      needs to be, and every question in it answers something no channel on this site has
//      ever captured: who the reader is, whether they'd miss the place, which rival problem
//      book they actually use, what they came for and didn't find, what stops them
//      contributing, and whether they have ever paid for physics help.

// ── The suggestion box ──────────────────────────────────────────────────────────────
//
// Four categories, one tap, no typing. `broken` is the new one and the whole reason for the
// split: eight distinct bugs reached the owner only as private DMs from top-ten
// contributors, and people in five countries have emailed solutions as attachments because
// the uploader failed. There was never a door marked "something is broken", only "report an
// error in this solution", so display bugs got filed as physics mistakes (8% of reports).
const CATEGORIES = [
    {
        id: 'error',
        ru: {
            label: 'Ошибка в решении',
            prompt: 'Что именно неверно?',
            placeholder:
                'Укажите шаг, формулу или строку, а также правильный ответ, если знаете. '
                + 'Например: «в третьей строке потеряна двойка, должно быть a = 2F/m».',
        },
        en: {
            label: 'Error in a solution',
            prompt: 'What exactly is wrong?',
            placeholder:
                'Name the step, formula or line, plus the correct answer if you know it. '
                + 'For example: "line 3 drops a factor of 2, it should be a = 2F/m".',
        },
    },
    {
        id: 'broken',
        ru: {
            label: 'Что-то сломалось',
            prompt: 'Что вы делали и что произошло вместо ожидаемого?',
            placeholder:
                'Например: «нажал «Отправить решение», кнопка не нажимается» или '
                + '«формулы показываются как $\\frac{a}{b}$ вместо дроби».',
        },
        en: {
            label: 'Something is broken',
            prompt: 'What were you doing, and what happened instead?',
            placeholder:
                'For example: "pressed Submit solution and the button does nothing", or '
                + '"formulas show as $\\frac{a}{b}$ instead of a fraction".',
        },
    },
    {
        id: 'idea',
        ru: {
            // The single best-performing question the site has ever asked: 95% answered it,
            // zero junk, median 103 characters, and nearly every named book, feature and bug
            // in the whole dataset came out of it. "Одно" is what does the work: it caps the
            // effort and forces a priority. Kept almost verbatim.
            label: 'Идея или пожелание',
            prompt: 'Одно предложение по улучшению сайта',
            placeholder:
                'Чем конкретнее, тем лучше: не «добавьте ещё задачник», а какой именно '
                + 'и для чего вы бы им пользовались.',
        },
        en: {
            label: 'Idea or suggestion',
            prompt: 'One suggestion to improve the site',
            placeholder:
                'The more specific the better: not "add another problem book", but which one '
                + 'and what you would use it for.',
        },
    },
    {
        id: 'other',
        ru: { label: 'Другое', prompt: 'Расскажите', placeholder: 'Всё, что не подошло под остальное.' },
        en: { label: 'Other', prompt: 'Tell us', placeholder: 'Anything that did not fit the other options.' },
    },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

// ── The poll ────────────────────────────────────────────────────────────────────────
//
// Ordered by how much the answer would change a decision. Every one of these is a gap the
// research turned up, not a question invented to fill a screen.
const POLL = [
    {
        id: 'role',
        // Never asked, in any channel, in the project's history. The most valuable user
        // found to date is a physics teacher who brought two medallists onto the platform,
        // discovered by accident seven months after a survey he never took. It is also the
        // most contested constituency: one teacher wrote in asking that the site be shut
        // down, another calls it a lifeline for students with no olympiad coach.
        ru: { q: 'Кто вы?', options: ['Школьник', 'Олимпиадник', 'Студент', 'Учитель', 'Преподаватель вуза', 'Другое'] },
        en: { q: 'Who are you?', options: ['School student', 'Olympiad student', 'University student', 'School teacher', 'University lecturer', 'Other'] },
        // Teachers are rare enough that one extra optional line costs almost nothing in
        // aggregate and buys the most from the people best placed to answer.
        followUp: {
            when: ['Учитель', 'Преподаватель вуза', 'School teacher', 'University lecturer'],
            ru: 'Что бы вам помогло больше всего в работе с учениками?',
            en: 'What would help you most in your work with students?',
        },
    },
    {
        id: 'disappointed',
        // The Sean Ellis test. Nothing on this site measures whether it is load-bearing:
        // there is no rating, no NPS, no frequency question anywhere. The share answering
        // "very" is the one externally comparable read available on whether the niche is
        // saturated; the conventional product-market-fit threshold is 40%.
        ru: { q: 'Как бы вы себя чувствовали, если бы этот сайт завтра исчез?', options: ['Очень расстроился(лась)', 'Немного расстроился(лась)', 'Не расстроился(лась)'] },
        en: { q: 'How would you feel if this site disappeared tomorrow?', options: ['Very disappointed', 'Somewhat disappointed', 'Not disappointed'] },
    },
    {
        id: 'other_book',
        // The most strategically load-bearing question here. The stated first plan is to
        // extend the site to other problem books starting with Ovchinkin, and it currently
        // rests on twenty survey responses. Search data shows literally zero spillover
        // demand (Irodov drew 10 visits in 22 months, Goldfarb 0), so this is greenfield and
        // will not be free, which makes asking real readers first worth a great deal.
        // Options are the books users named unprompted, nothing invented.
        ru: { q: 'Какой ещё задачник вы сейчас решаете?', options: ['Иродов', 'Овчинкин–Прут', 'Гольдфарб', 'Мешерский', 'Листки mathus.ru', 'Олимпиадные архивы', 'Никакой'], allowOther: true },
        en: { q: 'Which other problem book are you working through?', options: ['Irodov', 'Ovchinkin–Prut', 'Goldfarb', 'Meshchersky', 'mathus.ru sheets', 'Olympiad archives', 'None'], allowOther: true },
    },
    {
        id: 'not_found',
        // Zero-result searches are not recorded anywhere, so nobody knows what people came
        // for and did not get. Free text, one line.
        ru: { q: 'Что вы искали здесь и не нашли?', freeText: true, placeholder: 'Одной строкой' },
        en: { q: 'What did you look for here and not find?', freeText: true, placeholder: 'One line is enough' },
    },
    {
        id: 'contribute_barrier',
        // Under 10% of registered users have ever contributed and the other 90% have never
        // been asked why. Options are lifted verbatim from real messages: one contributor
        // threw away about ten sheets of worked solutions rather than retype them; another
        // writes in Word because he does not know LaTeX. The last option is the one the
        // email archive proves is happening and nobody counts.
        ru: { q: 'Хотели бы добавить своё решение? Что мешает?', options: ['Нет времени', 'Не знаю LaTeX', 'Лень перенабирать с листа', 'Не уверен(а) в правильности', 'Не знал(а), что можно', 'Пробовал(а), но не получилось загрузить'] },
        en: { q: 'Would you add a solution of your own? What stops you?', options: ['No time', "Don't know LaTeX", 'Too much work to retype from paper', 'Not confident it is right', "Didn't know I could", 'Tried, but the upload failed'] },
    },
    {
        id: 'ever_paid',
        // Deliberately about past behaviour. "Would you pay?" is the textbook Mom Test
        // violation, because people are optimistic and want to be kind. This is the only honest
        // read available on the claim that the platform must pay its authors or the author
        // count stays vanishingly small, which currently rests on one person's opinion.
        ru: { q: 'Вы когда-нибудь платили за подготовку по физике?', options: ['Репетитор', 'Курсы', 'Книги', 'Нет, никогда'] },
        en: { q: 'Have you ever paid for physics preparation?', options: ['A tutor', 'Courses', 'Books', 'No, never'] },
    },
];

const POLL_IDS = POLL.map((q) => q.id);

// Two names for `new` on purpose. In the admin queue it means "untriaged"; on the public
// board it means "collected, not yet decided", because publishing is itself the act of
// having read it. Undecided items have to be visible or there is nothing to vote on, and
// voting is the only way the owner learns which of forty requests actually matter.
const STATUS = {
    new: { ru: 'Предложено', en: 'Suggested' },
    planned: { ru: 'Запланировано', en: 'Planned' },
    in_progress: { ru: 'В работе', en: 'In progress' },
    done: { ru: 'Сделано', en: 'Done' },
    declined: { ru: 'Отклонено', en: 'Declined' },
    duplicate: { ru: 'Дубликат', en: 'Duplicate' },
};

const STATUS_IDS = Object.keys(STATUS);

// Statuses the public board shows, in the order it shows them: what is happening now, what
// is committed, what has merely been asked for, and what has been settled. Nothing is public
// until the owner sets is_public, so an unread item can never appear here.
const PUBLIC_STATUS_ORDER = ['in_progress', 'planned', 'new', 'done', 'declined'];

const l = (lang) => (lang === 'ru' ? 'ru' : 'en');

function getCategories(lang) {
    const k = l(lang);
    return CATEGORIES.map((c) => ({ id: c.id, ...c[k] }));
}

// Which poll question this visitor gets. Round-robin on a caller-supplied integer rather
// than at random, so every question accumulates a comparable sample instead of the queue
// tail being starved by luck. `answered` is the list of ids this browser has already dealt
// with; once it has seen them all it gets nothing, forever.
function pickPollQuestion(lang, answered, seed) {
    const done = new Set(Array.isArray(answered) ? answered : []);
    const open = POLL.filter((q) => !done.has(q.id));
    if (open.length === 0) return null;
    const n = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
    const q = open[n % open.length];
    const k = l(lang);
    const body = q[k];
    return {
        id: q.id,
        question: body.q,
        options: body.options || null,
        freeText: !!body.freeText,
        placeholder: body.placeholder || null,
        allowOther: !!q[k].allowOther,
        followUp: q.followUp
            ? { when: q.followUp.when, prompt: q.followUp[k] }
            : null,
    };
}

function statusLabel(status, lang) {
    return (STATUS[status] || STATUS.new)[l(lang)];
}

// Everything the widget needs, in one object, so index.js can hand it to every page as a
// single res.locals entry and the templates stay free of conditionals.
function getWidgetCopy(lang) {
    const k = l(lang);
    const ru = k === 'ru';
    return {
        lang: k,
        tabLabel: ru ? 'Предложить' : 'Suggest',
        title: ru ? 'Обратная связь' : 'Feedback',
        // No account required, said up front. 59% of visits never return and almost none of
        // them are signed in, so the sign-in wall was the single biggest thing suppressing
        // every other channel on this site.
        subtitle: ru
            ? 'Аккаунт не нужен. Ответ придёт, если оставите контакт.'
            : 'No account needed. We reply if you leave a contact.',
        categoryLegend: ru ? 'О чём речь?' : 'What is this about?',
        contactLegend: ru ? 'Куда ответить? (необязательно)' : 'Where should we reply? (optional)',
        // Telegram first, and first for a reason: it beat email 11 to 5 in the old survey's
        // free-text contact field, and the users table has no column for it to this day.
        contactKinds: [
            { id: 'telegram', label: 'Telegram', placeholder: '@username' },
            { id: 'email', label: ru ? 'Эл. почта' : 'Email', placeholder: 'you@example.com' },
        ],
        notifyLabel: ru ? 'Сообщить мне, когда это будет сделано' : 'Tell me when this ships',
        send: ru ? 'Отправить' : 'Send',
        sending: ru ? 'Отправляем…' : 'Sending…',
        cancel: ru ? 'Отмена' : 'Cancel',
        close: ru ? 'Закрыть' : 'Close',
        thanksTitle: ru ? 'Спасибо' : 'Thank you',
        thanksBody: ru
            ? 'Мы прочитаем и ответим. Сохраните ссылку: по ней видно, что стало с вашим сообщением.'
            : 'We will read it and reply. Keep the link: it shows what happened to your message.',
        receiptLabel: ru ? 'Ссылка на ваше сообщение' : 'Link to your message',
        boardLink: ru ? 'Все предложения' : 'All suggestions',
        again: ru ? 'Отправить ещё' : 'Send another',
        errorGeneric: ru ? 'Не удалось отправить. Попробуйте ещё раз.' : 'Could not send. Please try again.',
        errorTooShort: ru ? 'Напишите хотя бы пару слов.' : 'Please write at least a few words.',
        errorTooLong: ru ? 'Слишком длинно, сократите, пожалуйста.' : 'That is too long, please shorten it.',
        errorTooFast: ru ? 'Слишком быстро. Попробуйте ещё раз.' : 'That was too fast. Please try again.',
        // Never a block. A student behind a school's shared NAT gateway must always be able
        // to come back and try; the cost of turning one real person away is total and the
        // cost of letting a duplicate through is nothing.
        errorRateLimited: ru
            ? 'Вы уже отправили несколько сообщений. Попробуйте, пожалуйста, позже.'
            : 'You have sent a few already. Please try again a bit later.',
        pollSkip: ru ? 'Пропустить' : 'Skip',
        pollThanks: ru ? 'Спасибо!' : 'Thanks!',
        pollOther: ru ? 'Другое' : 'Other',
        pollSubmit: ru ? 'Ответить' : 'Answer',
        promptSolution: ru ? 'Нашли ошибку или есть идея?' : 'Found an error, or have an idea?',
        promptSolutionCta: ru ? 'Напишите нам' : 'Tell us',
        promptSearch: ru ? 'Не нашли, что искали? Скажите, что именно, и мы добавим.' : 'Did not find what you were after? Tell us what it was.',
        promptSearchCta: ru ? 'Сообщить' : 'Tell us',
        prompt404: ru ? 'Пришли по ссылке, которая не работает?' : 'Followed a link that does not work?',
        prompt404Cta: ru ? 'Сообщить об этом' : 'Report it',
        promptUploadFail: ru ? 'Не получается загрузить решение?' : 'Cannot upload your solution?',
        promptUploadFailCta: ru ? 'Напишите нам, поможем' : 'Tell us and we will help',
    };
}

module.exports = {
    CATEGORIES,
    CATEGORY_IDS,
    POLL,
    POLL_IDS,
    STATUS,
    STATUS_IDS,
    PUBLIC_STATUS_ORDER,
    getCategories,
    pickPollQuestion,
    statusLabel,
    getWidgetCopy,
};
