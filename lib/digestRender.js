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
// cannot be loaded by a mail client, so this is the one place in the project that names a
// font stack: Georgia for what the site sets in SS Text (problem numbers, prose excerpts) and
// the ordinary sans stack for interface text. Colours are the design tokens, written out.
//
// Two rules the markup follows, both learned from what mail clients do:
//   - there are no images. Gmail and Outlook block them until the reader allows them, and
//     Gmail fetches through a proxy the bot gate used to answer with 403, so the mark in the
//     masthead is the integral sign as text and a name is its initial drawn as a table cell.
//   - nothing is wider than 600px and every cell stacks readably at 320px.
//
// The data comes from digest.js; this file only formats it and escapes it.

const { ruPlural } = require('./ruPlural');

const C = {
    navy: '#1a1a2e',
    text: '#2d2d2d',
    secondary: '#6c757d',
    link: '#1a5276',
    rule: '#dee2e6',
    surface: '#ffffff',
    surfaceAlt: '#f8f9fa',
    page: '#f1f1f4',
    onNavy: '#ffffff',
    navyMuted: '#b9bcc9',
};
const SERIF = "Georgia, 'Times New Roman', 'Droid Serif', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";

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
    },
};

const copyFor = (lang) => (lang === 'ru' ? COPY.ru : COPY.en);

// ── Blocks ──────────────────────────────────────────────────────────────────────────────

const sectionTitle = (title) => `
          <tr><td style="padding:26px 24px 0;">
            <div style="font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${C.secondary};">${escapeHtml(title)}</div>
            <div style="height:1px;line-height:1px;background:${C.rule};margin-top:8px;">&nbsp;</div>
          </td></tr>`;

const avatarCell = (name) => `
              <td width="40" valign="top" style="width:40px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                  <td width="36" height="36" align="center" valign="middle" style="width:36px;height:36px;background:${C.navy};border-radius:18px;font-family:${SANS};font-size:15px;font-weight:600;color:${C.onNavy};">${escapeHtml(initial(name))}</td>
                </tr></table>
              </td>`;

function personalItem(item, t) {
    const line = item.kind === 'reply' ? t.replied(item.author) : t.commented(item.author, item.problem);
    return `
          <tr><td style="padding:14px 24px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${avatarCell(item.author)}
              <td valign="top" style="padding-left:12px;font-family:${SANS};font-size:14px;color:${C.text};">
                <a href="${escapeHtml(item.url)}" style="color:${C.link};text-decoration:none;font-weight:600;">${escapeHtml(line)}</a>
                <div style="font-family:${SERIF};font-size:14px;line-height:1.5;color:${C.text};padding-top:4px;">${escapeHtml(excerpt(item.excerpt, 120))}</div>
                <div style="font-size:12px;color:${C.secondary};padding-top:4px;">${escapeHtml(t.problem(item.problem))}</div>
              </td>
            </tr></table>
          </td></tr>`;
}

function discussionCard(d, t) {
    return `
          <tr><td style="padding:14px 24px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.surfaceAlt};border:1px solid ${C.rule};border-radius:8px;">
              <tr><td style="padding:14px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${avatarCell(d.lastAuthor)}
                  <td valign="top" style="padding-left:12px;">
                    <a href="${escapeHtml(d.url)}" style="font-family:${SERIF};font-size:16px;font-weight:700;color:${C.navy};text-decoration:none;">${escapeHtml(t.problem(d.problem))}</a>
                    <div style="font-family:${SANS};font-size:12px;color:${C.secondary};padding-top:2px;">${escapeHtml(d.lastAuthor)} · ${escapeHtml(t.commentsMeta(d.comments))}</div>
                    <div style="font-family:${SERIF};font-size:14px;line-height:1.55;color:${C.text};padding-top:8px;">${escapeHtml(excerpt(d.excerpt))}</div>
                    <div style="padding-top:8px;"><a href="${escapeHtml(d.url)}" style="font-family:${SANS};font-size:13px;font-weight:600;color:${C.link};text-decoration:none;">${escapeHtml(t.readMore)} →</a></div>
                  </td>
                </tr></table>
              </td></tr>
            </table>
          </td></tr>`;
}

function listRow(left, right, url) {
    return `
              <tr>
                <td style="padding:6px 0;font-family:${SERIF};font-size:15px;color:${C.text};border-bottom:1px solid ${C.rule};">
                  <a href="${escapeHtml(url)}" style="color:${C.link};text-decoration:none;">${escapeHtml(left)}</a>
                </td>
                <td align="right" style="padding:6px 0;font-family:${SANS};font-size:12px;color:${C.secondary};border-bottom:1px solid ${C.rule};white-space:nowrap;">${escapeHtml(right)}</td>
              </tr>`;
}

function counterCell(value, label) {
    return `
                <td align="center" valign="top" width="33%" style="padding:8px 4px;">
                  <div style="font-family:${SERIF};font-size:30px;line-height:1.1;color:${C.navy};">${escapeHtml(String(value))}</div>
                  <div style="font-family:${SANS};font-size:12px;line-height:1.4;color:${C.secondary};padding-top:4px;">${escapeHtml(label)}</div>
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

    // Masthead
    parts.push(`
          <tr><td style="background:${C.navy};padding:20px 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="36" valign="middle" style="width:36px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                  <td width="36" height="36" align="center" valign="middle" style="width:36px;height:36px;background:${C.onNavy};border-radius:8px;font-family:${SERIF};font-size:22px;line-height:36px;color:${C.navy};">&#8747;</td>
                </tr></table>
              </td>
              <td valign="middle" style="padding-left:12px;">
                <div style="font-family:${SERIF};font-size:18px;line-height:1.2;color:${C.onNavy};">Savchenko Solutions</div>
                <div style="font-family:${SANS};font-size:12px;line-height:1.4;color:${C.navyMuted};padding-top:2px;">${escapeHtml(t.masthead)} · ${escapeHtml(period)}</div>
              </td>
            </tr></table>
          </td></tr>`);

    // Greeting and counters
    parts.push(`
          <tr><td style="padding:24px 24px 0;font-family:${SANS};font-size:15px;line-height:1.55;color:${C.text};">
            <span style="font-weight:600;">${escapeHtml(t.hello(d.username))}</span> ${escapeHtml(hasPersonal ? t.introWithNews : t.introQuiet)}
          </td></tr>
          <tr><td style="padding:16px 16px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.surfaceAlt};border:1px solid ${C.rule};border-radius:8px;">
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
          <tr><td style="padding:14px 24px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${avatarCell(names[0])}
              <td valign="middle" style="padding-left:12px;font-family:${SANS};font-size:14px;color:${C.text};">
                <a href="${escapeHtml(followers[0].url)}" style="color:${C.link};text-decoration:none;font-weight:600;">${escapeHtml(line)}</a>
              </td>
            </tr></table>
          </td></tr>`);
        }
        if (likes > 0) {
            parts.push(`
          <tr><td style="padding:14px 24px 0;font-family:${SANS};font-size:14px;color:${C.text};">${escapeHtml(t.likes(likes))}</td></tr>`);
        }
    }

    // Being discussed
    if ((d.discussions || []).length > 0) {
        parts.push(sectionTitle(t.discussionsTitle));
        for (const item of d.discussions.slice(0, 4)) parts.push(discussionCard(item, t));
    }

    // New and updated solutions
    if ((d.updates || []).length > 0) {
        parts.push(sectionTitle(t.updatesTitle));
        parts.push(`
          <tr><td style="padding:8px 24px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${d.updates.slice(0, 8).map((u) => listRow(t.problem(u.problem), `${u.authors.join(', ')} · ${t.langLabel(u.language)}`, u.url)).join('')}
            </table>
          </td></tr>`);
    }

    // Waiting for a solution
    if ((d.wanted || []).length > 0) {
        const translate = d.wantedKind === 'translate';
        parts.push(sectionTitle(translate ? t.translateTitle : t.wantedTitle));
        parts.push(`
          <tr><td style="padding:8px 24px 0;font-family:${SANS};font-size:13px;color:${C.secondary};">${escapeHtml(translate ? t.translateNote : t.wantedNote)}</td></tr>
          <tr><td style="padding:8px 24px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${d.wanted.slice(0, 3).map((w) => listRow(t.problem(w.problem), t.views(w.views), w.url)).join('')}
            </table>
          </td></tr>`);
    }

    // Call to action and footer
    parts.push(`
          <tr><td align="center" style="padding:28px 24px 8px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td align="center" style="background:${C.navy};border-radius:6px;">
                <a href="${escapeHtml(d.siteUrl)}" style="display:inline-block;padding:12px 28px;font-family:${SANS};font-size:14px;font-weight:600;color:${C.onNavy};text-decoration:none;">${escapeHtml(t.cta)}</a>
              </td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:24px;">
            <div style="height:1px;line-height:1px;background:${C.rule};">&nbsp;</div>
            <div style="font-family:${SANS};font-size:12px;line-height:1.6;color:${C.secondary};padding-top:14px;">
              ${escapeHtml(t.footerWhy)}<br>
              <a href="${escapeHtml(d.settingsUrl)}" style="color:${C.secondary};text-decoration:underline;">${escapeHtml(t.settings)}</a>
              &nbsp;·&nbsp;
              <a href="${escapeHtml(d.unsubscribeUrl)}" style="color:${C.secondary};text-decoration:underline;">${escapeHtml(t.unsubscribe)}</a>
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
  <tr><td align="center" style="padding:24px 12px;">
    <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${C.surface};border:1px solid ${C.rule};border-radius:8px;">
${parts.join('')}
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
    <div style="font-family:${SANS};font-size:11px;color:${C.secondary};padding:14px 8px 0;max-width:600px;">
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
