// lib/digestRender.js: the weekly digest email, as HTML and as plain text.
//
// Why a digest (2026-09-16). Every notification worth an email sent one immediately, so a
// discussion on 7.2.10 meant three emails in nine minutes and a follow/unfollow toggle meant
// ten in twenty-seven seconds. The owner asked for the shape Discourse uses: one email a week
// that says what happened, instead of one email per thing that happened. Immediate mail is now
// only for accounts (reset, verify, email change); everything else waits for this.
//
// Email HTML is not web HTML. Tables, not flex; every style inline; a 600px body; no
// stylesheet, no script, no web font. The site's own faces (New Computer Modern, IBM Plex)
// cannot be loaded by a mail client, so this is the one place in the project that names a font
// stack — and it is one stack for the whole email, at the owner's request (2026-09-16).
//
// Colour comes from the site's own palettes: the band is the link blue, the accents are the
// four data-series colours in js/palettes.js, so a name always gets the same circle.
//
// Three rules the markup follows, all learned from what mail clients do:
//   - one image only, the official mark, with alt text that reads as the name. Gmail and
//     Outlook block images until the reader allows them, so nothing that carries meaning is a
//     picture: a person's avatar is their initial drawn as a coloured table cell.
//   - nothing is wider than 600px and every cell stacks readably at 320px.
//   - padding is small: 16px at the edges, 12px inside a card. Mail is read in a narrow
//     column, often on a phone, and generous whitespace there reads as emptiness.
//
// The data comes from digest.js; this file only formats it and escapes it.

const { ruPlural } = require('./ruPlural');

const C = {
    navy: '#1a1a2e',
    text: '#2d2d2d',
    secondary: '#6c757d',
    link: '#1a5276',
    band: '#1a5276',          // the site's link blue, as a field
    bandSoft: '#bcd4e6',      // labels on the band
    rule: '#dee2e6',
    surface: '#ffffff',
    surfaceAlt: '#f8f9fa',
    page: '#eef0f3',
    onNavy: '#ffffff',
};
// js/palettes.js SERIES: the four colours the site already uses for data, so an avatar is
// always the same colour for the same person and never a colour from nowhere.
const AVATAR_COLOURS = ['#2a78d6', '#eb6834', '#1baf7a', '#7d3c98'];
// One family for the whole email (the owner's rule): a mail client has no web fonts.
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF = FONT;
const SANS = FONT;

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A comment as one line of readable prose: no markdown, no dollar signs, no run-on. */
function excerpt(text, max = 150) {
    let s = String(text == null ? '' : text)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // images
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // links keep their words
        .replace(/\$\$?([^$]{1,80})\$\$?/g, '$1')       // $E = mc^2$ reads as E = mc^2
        .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')   // a half stays a half
        .replace(/\\(?:vec|mathbf|mathrm|text|textit|textbf|sqrt|left|right|operatorname)\s*\{([^{}]*)\}/g, '$1')
        .replace(/\\[a-zA-Z]+\s*/g, ' ')              // any other command: drop it, keep the prose
        .replace(/\\[^a-zA-Z]/g, ' ')                  // \, \; \! and friends
        .replace(/[{}]/g, '')
        .replace(/_/g, '')                             // E_0 reads as E0, not as E_0
        .replace(/[*_`>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (s.length <= max) return s;
    s = s.slice(0, max);
    const cut = s.lastIndexOf(' ');
    return `${(cut > max * 0.6 ? s.slice(0, cut) : s).trim()}…`;
}

/** The letter in the coloured circle that stands in for an avatar. */
function initial(name) {
    const s = String(name || '').trim();
    return s ? s[0].toUpperCase() : '?';
}

/** The same person always gets the same colour, so a digest is recognisable at a glance. */
function avatarColour(name) {
    const s = String(name || '');
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 100003;
    return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
}

const MONTHS = {
    ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

/** "8 - 15 сентября" / "8 - 15 September", always in UTC so a run is reproducible. */
function periodLabel(fromISO, toISO, lang) {
    const from = new Date(fromISO);
    const to = new Date(toISO);
    const months = MONTHS[lang === 'ru' ? 'ru' : 'en'];
    const sameMonth = from.getUTCMonth() === to.getUTCMonth();
    if (lang === 'ru') {
        return sameMonth
            ? `${from.getUTCDate()} – ${to.getUTCDate()} ${months[to.getUTCMonth()]}`
            : `${from.getUTCDate()} ${months[from.getUTCMonth()]} – ${to.getUTCDate()} ${months[to.getUTCMonth()]}`;
    }
    return sameMonth
        ? `${months[to.getUTCMonth()]} ${from.getUTCDate()} – ${to.getUTCDate()}`
        : `${months[from.getUTCMonth()]} ${from.getUTCDate()} – ${months[to.getUTCMonth()]} ${to.getUTCDate()}`;
}

const COPY = {
    ru: {
        subject: 'Сводка за неделю на Savchenko Solutions',
        masthead: 'Сводка за неделю',
        hello: (name) => `Здравствуйте, ${name}!`,
        introWithNews: 'Вот что случилось на сайте за неделю и что здесь появилось без вас.',
        introQuiet: 'Вот что появилось на сайте за неделю.',
        counters: {
            solutions: (n) => ruPlural(n, 'решение обновлено', 'решения обновлено', 'решений обновлено'),
            comments: (n) => ruPlural(n, 'комментарий', 'комментария', 'комментариев'),
            members: (n) => ruPlural(n, 'новый участник', 'новых участника', 'новых участников'),
        },
        youTitle: 'Про вас',
        replied: (who) => `${who} ответил вам`,
        commented: (who, problem) => `${who} написал о вашем решении задачи ${problem}`,
        followers: (list) => `${list} подписались на вас`,
        followerOne: (who) => `${who} подписался на вас`,
        likes: (n) => `${n} ${ruPlural(n, 'человек отметил', 'человека отметили', 'человек отметили')} ваши решения`,
        discussionsTitle: 'Обсуждают',
        problem: (n) => `Задача ${n}`,
        commentsMeta: (n) => `${n} ${ruPlural(n, 'комментарий', 'комментария', 'комментариев')}`,
        readMore: 'Читать дальше',
        updatesTitle: 'Новые и обновлённые решения',
        wantedTitle: 'Ждут решения',
        wantedNote: 'Эти задачи ищут чаще всего, а решения у них пока нет.',
        translateTitle: 'Ждут второго языка',
        translateNote: 'Решение есть, но только на одном языке. Перевод — самая короткая дорога помочь.',
        views: (n) => `${n} ${ruPlural(n, 'просмотр', 'просмотра', 'просмотров')}`,
        cta: 'Открыть сайт',
        footerWhy: 'Эта сводка приходит раз в неделю вместо писем на каждое событие.',
        settings: 'Настройки писем',
        unsubscribe: 'Отписаться',
        langLabel: (l) => (l === 'ru' ? 'на русском' : 'на английском'),
        langsLabel: (ls) => (ls.length > 1 ? 'на русском и английском' : (ls[0] === 'ru' ? 'на русском' : 'на английском')),
    },
    en: {
        subject: 'Your week on Savchenko Solutions',
        masthead: 'The week in summary',
        hello: (name) => `Hello, ${name}.`,
        introWithNews: 'Here is what happened on the site this week, and what waited for you.',
        introQuiet: 'Here is what happened on the site this week.',
        counters: {
            solutions: (n) => (n === 1 ? 'solution updated' : 'solutions updated'),
            comments: (n) => (n === 1 ? 'comment' : 'comments'),
            members: (n) => (n === 1 ? 'new member' : 'new members'),
        },
        youTitle: 'About you',
        replied: (who) => `${who} replied to you`,
        commented: (who, problem) => `${who} wrote about your solution to ${problem}`,
        followers: (list) => `${list} started following you`,
        followerOne: (who) => `${who} started following you`,
        likes: (n) => `${n} ${n === 1 ? 'person' : 'people'} liked your solutions`,
        discussionsTitle: 'Being discussed',
        problem: (n) => `Problem ${n}`,
        commentsMeta: (n) => `${n} ${n === 1 ? 'comment' : 'comments'}`,
        readMore: 'Read on',
        updatesTitle: 'New and updated solutions',
        wantedTitle: 'Waiting for a solution',
        wantedNote: 'The most looked-for problems that nobody has written up yet.',
        translateTitle: 'Waiting for the other language',
        translateNote: 'Written up in one language only. A translation is the shortest way to help.',
        views: (n) => `${n} ${n === 1 ? 'view' : 'views'}`,
        cta: 'Open the site',
        footerWhy: 'This summary comes once a week, instead of an email for every single thing.',
        settings: 'Email settings',
        unsubscribe: 'Unsubscribe',
        langLabel: (l) => (l === 'ru' ? 'in Russian' : 'in English'),
        langsLabel: (ls) => (ls.length > 1 ? 'in Russian and English' : (ls[0] === 'ru' ? 'in Russian' : 'in English')),
    },
};

const copyFor = (lang) => (lang === 'ru' ? COPY.ru : COPY.en);

// ── Blocks ──────────────────────────────────────────────────────────────────────────────

const sectionTitle = (title) => `
          <tr><td style="padding:18px 16px 0;">
            <div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${C.secondary};">${escapeHtml(title)}</div>
            <div style="height:1px;line-height:1px;background:${C.rule};margin-top:6px;">&nbsp;</div>
          </td></tr>`;

const avatarCell = (name, size = 32) => `
              <td width="${size + 8}" valign="top" style="width:${size + 8}px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                  <td width="${size}" height="${size}" align="center" valign="middle" style="width:${size}px;height:${size}px;background:${avatarColour(name)};border-radius:${size / 2}px;font-family:${FONT};font-size:${Math.round(size * 0.42)}px;font-weight:700;color:${C.onNavy};">${escapeHtml(initial(name))}</td>
                </tr></table>
              </td>`;

function personalItem(item, t) {
    const line = item.kind === 'reply' ? t.replied(item.author) : t.commented(item.author, item.problem);
    return `
          <tr><td style="padding:10px 16px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${avatarCell(item.author)}
              <td valign="top" style="padding-left:10px;font-family:${FONT};font-size:14px;line-height:1.45;color:${C.text};">
                <a href="${escapeHtml(item.url)}" style="color:${C.link};text-decoration:none;font-weight:700;">${escapeHtml(line)}</a>
                <span style="color:${C.secondary};font-size:13px;"> · ${escapeHtml(t.problem(item.problem))}</span>
                <div style="padding-top:2px;">${escapeHtml(excerpt(item.excerpt, 120))}</div>
              </td>
            </tr></table>
          </td></tr>`;
}

function discussionCard(d, t) {
    return `
              <tr><td style="padding:0 0 10px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.surface};border-radius:6px;">
                  <tr><td style="padding:12px 14px;">
                    <a href="${escapeHtml(d.url)}" style="font-family:${FONT};font-size:16px;font-weight:700;color:${C.link};text-decoration:none;">${escapeHtml(t.problem(d.problem))}</a>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;"><tr>
${avatarCell(d.lastAuthor, 28)}
                      <td valign="middle" style="padding-left:8px;font-family:${FONT};font-size:13px;color:${C.secondary};">${escapeHtml(d.lastAuthor)}</td>
                    </tr></table>
                    <div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${C.text};padding-top:8px;">${escapeHtml(excerpt(d.excerpt))}</div>
                  </td></tr>
                  <tr><td style="padding:0 14px 12px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${C.rule};"><tr>
                      <td valign="middle" style="padding-top:10px;font-family:${FONT};font-size:13px;color:${C.secondary};">${escapeHtml(t.commentsMeta(d.comments))}</td>
                      <td align="right" valign="middle" style="padding-top:10px;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                          <td align="center" style="background:${C.link};border-radius:4px;">
                            <a href="${escapeHtml(d.url)}" style="display:inline-block;padding:7px 14px;font-family:${FONT};font-size:13px;font-weight:700;color:${C.onNavy};text-decoration:none;">${escapeHtml(t.readMore)}</a>
                          </td>
                        </tr></table>
                      </td>
                    </tr></table>
                  </td></tr>
                </table>
              </td></tr>`;
}

function listRow(left, right, url) {
    return `
              <tr>
                <td style="padding:5px 0;font-family:${FONT};font-size:14px;font-weight:600;color:${C.text};border-bottom:1px solid ${C.rule};">
                  <a href="${escapeHtml(url)}" style="color:${C.link};text-decoration:none;">${escapeHtml(left)}</a>
                </td>
                <td align="right" style="padding:5px 0;font-family:${FONT};font-size:12px;color:${C.secondary};border-bottom:1px solid ${C.rule};white-space:nowrap;">${escapeHtml(right)}</td>
              </tr>`;
}

function counterCell(value, label) {
    return `
                <td align="center" valign="top" width="33%" style="padding:2px 4px;">
                  <div style="font-family:${FONT};font-size:30px;font-weight:700;line-height:1.1;color:${C.onNavy};">${escapeHtml(String(value))}</div>
                  <div style="font-family:${FONT};font-size:12px;line-height:1.35;color:${C.bandSoft};padding-top:3px;">${escapeHtml(label)}</div>
                </td>`;
}

// ── The email ───────────────────────────────────────────────────────────────────────────

/**
 * @param {object} d digest data from digest.js
 * @returns {{subject: string, html: string, text: string}}
 */
function renderDigest(d) {
    const lang = d.lang === 'ru' ? 'ru' : 'en';
    const t = copyFor(lang);
    const period = periodLabel(d.period.fromISO, d.period.toISO, lang);
    const personal = [...(d.replies || []), ...(d.onYourSolutions || [])];
    const followers = d.followers || [];
    const likes = d.likes || 0;
    const hasPersonal = personal.length > 0 || followers.length > 0 || likes > 0;

    const preheader = [
        d.counters.solutions ? `${d.counters.solutions} ${t.counters.solutions(d.counters.solutions)}` : '',
        d.counters.comments ? `${d.counters.comments} ${t.counters.comments(d.counters.comments)}` : '',
        hasPersonal ? t.youTitle.toLowerCase() : '',
    ].filter(Boolean).join(' · ');

    const parts = [];

    // Masthead: the official mark and the wordmark, on white, tight.
    parts.push(`
          <tr><td style="padding:14px 16px;border-bottom:1px solid ${C.rule};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="34" valign="middle" style="width:34px;">
                <img src="${escapeHtml(d.origin)}/img/logo.png" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border-radius:6px;border:0;">
              </td>
              <td valign="middle" style="padding-left:10px;font-family:${FONT};font-size:16px;font-weight:700;color:${C.navy};">Savchenko Solutions</td>
              <td align="right" valign="middle" style="font-family:${FONT};font-size:12px;color:${C.secondary};white-space:nowrap;">${escapeHtml(period)}</td>
            </tr></table>
          </td></tr>`);

    // The band: what the week held, in three numbers.
    parts.push(`
          <tr><td style="background:${C.band};padding:18px 16px 16px;">
            <div style="font-family:${FONT};font-size:16px;line-height:1.45;color:${C.onNavy};text-align:center;">
              <span style="font-weight:700;">${escapeHtml(t.hello(d.username))}</span> ${escapeHtml(hasPersonal ? t.introWithNews : t.introQuiet)}
            </div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">
              <tr>
${counterCell(d.counters.solutions, t.counters.solutions(d.counters.solutions))}
${counterCell(d.counters.comments, t.counters.comments(d.counters.comments))}
${counterCell(d.counters.members, t.counters.members(d.counters.members))}
              </tr>
            </table>
          </td></tr>`);

    // About you
    if (hasPersonal) {
        parts.push(sectionTitle(t.youTitle));
        for (const item of personal.slice(0, 6)) parts.push(personalItem(item, t));
        if (followers.length > 0) {
            const names = followers.map((f) => f.username);
            const line = names.length === 1 ? t.followerOne(names[0]) : t.followers(names.slice(0, 4).join(', '));
            parts.push(`
          <tr><td style="padding:10px 16px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${avatarCell(names[0])}
              <td valign="middle" style="padding-left:10px;font-family:${FONT};font-size:14px;color:${C.text};">
                <a href="${escapeHtml(followers[0].url)}" style="color:${C.link};text-decoration:none;font-weight:700;">${escapeHtml(line)}</a>
              </td>
            </tr></table>
          </td></tr>`);
        }
        if (likes > 0) {
            parts.push(`
          <tr><td style="padding:10px 16px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="background:#eaf4ee;border-radius:4px;padding:6px 10px;font-family:${FONT};font-size:13px;font-weight:600;color:#1b7a43;">${escapeHtml(t.likes(likes))}</td>
            </tr></table>
          </td></tr>`);
        }
        parts.push(`<tr><td style="height:4px;line-height:4px;">&nbsp;</td></tr>`);
    }

    // Being discussed: white cards on the page colour, as the reference does
    if ((d.discussions || []).length > 0) {
        parts.push(`
          <tr><td style="background:${C.page};padding:16px 16px 6px;">
            <div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${C.secondary};padding-bottom:10px;">${escapeHtml(t.discussionsTitle)}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${d.discussions.slice(0, 4).map((item) => discussionCard(item, t)).join('')}
            </table>
          </td></tr>`);
    }

    // New and updated solutions
    if ((d.updates || []).length > 0) {
        parts.push(sectionTitle(t.updatesTitle));
        parts.push(`
          <tr><td style="padding:6px 16px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${d.updates.slice(0, 8).map((u) => listRow(t.problem(u.problem), `${u.authors.join(', ')} · ${t.langsLabel(u.languages || [u.language])}`, u.url)).join('')}
            </table>
          </td></tr>`);
    }

    // Waiting for a solution, or for the other language
    if ((d.wanted || []).length > 0) {
        const translate = d.wantedKind === 'translate';
        parts.push(sectionTitle(translate ? t.translateTitle : t.wantedTitle));
        parts.push(`
          <tr><td style="padding:6px 16px 0;font-family:${FONT};font-size:13px;color:${C.secondary};">${escapeHtml(translate ? t.translateNote : t.wantedNote)}</td></tr>
          <tr><td style="padding:6px 16px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${d.wanted.slice(0, 3).map((w) => listRow(t.problem(w.problem), t.views(w.views), w.url)).join('')}
            </table>
          </td></tr>`);
    }

    // Call to action and footer
    parts.push(`
          <tr><td align="center" style="padding:20px 16px 4px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td align="center" style="background:${C.navy};border-radius:6px;">
                <a href="${escapeHtml(d.siteUrl)}" style="display:inline-block;padding:11px 26px;font-family:${FONT};font-size:14px;font-weight:700;color:${C.onNavy};text-decoration:none;">${escapeHtml(t.cta)}</a>
              </td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:16px;">
            <div style="height:1px;line-height:1px;background:${C.rule};">&nbsp;</div>
            <div style="font-family:${FONT};font-size:12px;line-height:1.6;color:${C.secondary};padding-top:10px;text-align:center;">
              ${escapeHtml(t.footerWhy)}<br>
              <a href="${escapeHtml(d.settingsUrl)}" style="color:${C.link};text-decoration:underline;">${escapeHtml(t.settings)}</a>
              &nbsp;·&nbsp;
              <a href="${escapeHtml(d.unsubscribeUrl)}" style="color:${C.link};text-decoration:underline;">${escapeHtml(t.unsubscribe)}</a>
            </div>
          </td></tr>`);

    const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(t.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
  <tr><td align="center" style="padding:16px 8px;">
    <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${C.surface};border:1px solid ${C.rule};border-radius:8px;">
${parts.join('')}
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
    <div style="font-family:${FONT};font-size:11px;color:${C.secondary};padding:10px 8px 0;max-width:600px;">
      <a href="${escapeHtml(d.siteUrl)}" style="color:${C.secondary};text-decoration:none;">savchenkosolutions.com</a>
    </div>
  </td></tr>
</table>
</body>
</html>`;

    // Plain text, same order and the same links.
    const lines = [t.hello(d.username), '', hasPersonal ? t.introWithNews : t.introQuiet, ''];
    lines.push(`${d.counters.solutions} ${t.counters.solutions(d.counters.solutions)} · ${d.counters.comments} ${t.counters.comments(d.counters.comments)} · ${d.counters.members} ${t.counters.members(d.counters.members)}`, '');
    if (hasPersonal) {
        lines.push(`${t.youTitle.toUpperCase()}`);
        for (const item of personal.slice(0, 6)) {
            lines.push(`- ${item.kind === 'reply' ? t.replied(item.author) : t.commented(item.author, item.problem)}: ${excerpt(item.excerpt, 100)}`, `  ${item.url}`);
        }
        if (followers.length) lines.push(`- ${followers.length === 1 ? t.followerOne(followers[0].username) : t.followers(followers.map((f) => f.username).join(', '))}`);
        if (likes) lines.push(`- ${t.likes(likes)}`);
        lines.push('');
    }
    if ((d.discussions || []).length) {
        lines.push(t.discussionsTitle.toUpperCase());
        for (const item of d.discussions.slice(0, 4)) {
            lines.push(`- ${t.problem(item.problem)} (${t.commentsMeta(item.comments)}): ${excerpt(item.excerpt, 100)}`, `  ${item.url}`);
        }
        lines.push('');
    }
    if ((d.updates || []).length) {
        lines.push(t.updatesTitle.toUpperCase());
        for (const u of d.updates.slice(0, 8)) lines.push(`- ${t.problem(u.problem)} — ${u.authors.join(', ')} — ${u.url}`);
        lines.push('');
    }
    if ((d.wanted || []).length) {
        lines.push((d.wantedKind === 'translate' ? t.translateTitle : t.wantedTitle).toUpperCase());
        for (const w of d.wanted.slice(0, 3)) lines.push(`- ${t.problem(w.problem)} (${t.views(w.views)}) — ${w.url}`);
        lines.push('');
    }
    lines.push(d.siteUrl, '', t.footerWhy, `${t.settings}: ${d.settingsUrl}`, `${t.unsubscribe}: ${d.unsubscribeUrl}`);

    return { subject: t.subject, html, text: lines.join('\n') };
}

module.exports = { renderDigest, copyFor, excerpt, initial, periodLabel, escapeHtml, COPY };
