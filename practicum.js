// practicum.js — Front-page announcement for the Theoretical Physics Research
// Practicum 2026, an external program (sites.google.com/view/theorphys-2026)
// whose admission contest is hosted on this site's audience.
//
// Mirrors the contest-banner pattern (see contest.js): a cheap, DB-free
// descriptor injected into res.locals so every page can render a slim strip and
// the homepage a full banner. It auto-expires at the registration deadline, so
// no stale content is ever shown and no manual takedown is needed.

const PRACTICUM = {
    // Registration closes 26 July 2026, 12:00 Kyiv time (EEST, UTC+3). After
    // this instant getPracticumBanner() returns null and every banner vanishes.
    registrationClose: '2026-07-26T12:00:00+03:00',
    email: 'theorphys2022@gmail.com',
    links: {
        eng: 'https://sites.google.com/view/theorphys-2026/2026-front-page-eng',
        ru: 'https://sites.google.com/view/theorphys-2026/2026-front-page-ru',
        ukr: 'https://sites.google.com/view/theorphys-2026/2026-front-page-ukr',
        detailsEng: 'https://sites.google.com/view/theorphys-2026/2026-front-page-details-eng',
        detailsRu: 'https://sites.google.com/view/theorphys-2026/2026-front-page-details-ru',
        practice: 'https://sites.google.com/view/theorphys-2026/' + encodeURIComponent('тренировочные-задачи-2025'),
    },
    // Real preprint used as anonymous social proof (arXiv:2512.16571).
    proofUrl: 'https://arxiv.org/abs/2512.16571',
};

const CLOSE_INSTANT = new Date(PRACTICUM.registrationClose).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function daysLeft() {
    const diff = CLOSE_INSTANT - Date.now();
    return diff <= 0 ? 0 : Math.ceil(diff / DAY_MS);
}

function isLive() {
    return Date.now() < CLOSE_INSTANT;
}

// Build a mailto: that opens pre-addressed with the required subject and the
// three fields the organizers ask for already typed into the body — the single
// biggest friction remover in the whole funnel.
function mailtoHref(lang) {
    const subject = 'Practicum 2026';
    const body = lang === 'ru'
        ? 'Имя: \nУниверситет: \nЗаканчиваю курс: '
        : 'Name: \nUniversity: \nYear of study I am completing: ';
    return `mailto:${PRACTICUM.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Russian plural for "день/дня/дней".
function ruDays(n) {
    const mod100 = n % 100;
    const mod10 = n % 10;
    if (mod100 >= 11 && mod100 <= 14) return `${n} дней`;
    if (mod10 === 1) return `${n} день`;
    if (mod10 >= 2 && mod10 <= 4) return `${n} дня`;
    return `${n} дней`;
}

// Full descriptor for both the homepage banner and the site-wide header strip,
// in the viewer's language. Returns null once registration has closed.
function getPracticumBanner(lang) {
    if (!isLive()) return null;
    const l = lang === 'ru' ? 'ru' : 'en';
    const d = daysLeft();
    const common = {
        lang: l,
        daysLeft: d,
        closeInstant: new Date(CLOSE_INSTANT).toISOString(),
        mailto: mailtoHref(l),
        email: PRACTICUM.email,
        links: PRACTICUM.links,
        proofUrl: PRACTICUM.proofUrl,
    };

    if (l === 'ru') {
        return {
            ...common,
            eyebrow: 'Исследовательский практикум · Бесплатно · Онлайн',
            headline: 'Международный практикум по теоретической физике 2026',
            sub: 'Пройдите конкурс по решению задач — прямо здесь, на этом сайте, — и проведите собственное мини-исследование вместе с физиками из MIT, Caltech, Harvard, Flatiron Institute и других центров. Языки практикума: английский, украинский, русский.',
            facts: ['Регистрация до 26 июля', 'Конкурс 27–30 июля', 'Практикум 10–21 августа · Zoom'],
            eligibility: 'Приглашаются студенты, заканчивающие 1–3 курс, — но организаторы предлагают попробовать всем желающим, включая школьников.',
            deadline: `До конца регистрации ${ruDays(d)}`,
            ctaLabel: 'Зарегистрироваться письмом',
            regDetail: `На ${PRACTICUM.email}, тема «Practicum 2026». Укажите имя, университет и курс — письмо уже заполнено этими полями.`,
            detailsLabel: 'О программе:',
            rulesUrl: PRACTICUM.links.detailsRu,
            rulesLabel: 'Правила конкурса',
            practiceLabel: 'Тренировочные задачи',
            proofText: 'Участники прошлого года доводили проекты практикума до настоящих препринтов — в том числе в соавторстве с организаторами практикума.',
            proofCta: 'Пример работы →',
            stripText: 'Международный практикум по теоретической физике 2026 — конкурс на этом сайте.',
            stripCta: 'Регистрация до 26 июля',
        };
    }

    return {
        ...common,
        eyebrow: 'Research program · Free · Online',
        headline: 'International Theoretical Physics Practicum 2026',
        sub: 'Pass the problem-solving contest — held right here on this site — then run your own mini research project with physicists from MIT, Caltech, Harvard, the Flatiron Institute and more. Working languages: English, Ukrainian, Russian.',
        facts: ['Register by Jul 26', 'Contest Jul 27–30', 'Practicum Aug 10–21 · Zoom'],
        eligibility: 'Open to students finishing years 1–3 — and the organizers welcome anyone to register and try, school students included.',
        deadline: d === 1 ? 'Registration closes in 1 day' : `Registration closes in ${d} days`,
        ctaLabel: 'Register by email',
        regDetail: `To ${PRACTICUM.email}, subject “Practicum 2026”. Include your name, university and year — the email opens pre-filled with these fields.`,
        detailsLabel: 'Program details:',
        rulesUrl: PRACTICUM.links.detailsEng,
        rulesLabel: 'Contest rules',
        practiceLabel: 'Practice problems',
        proofText: 'Past participants have taken practicum projects all the way to real preprints — some co-authored with the practicum’s own organizers.',
        proofCta: 'See an example →',
        stripText: 'International Theoretical Physics Practicum 2026 — contest hosted on this site.',
        stripCta: 'Register by Jul 26',
    };
}

module.exports = { getPracticumBanner, PRACTICUM };
