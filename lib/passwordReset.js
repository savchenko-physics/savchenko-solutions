// lib/passwordReset.js: every decision behind "Forgot password?" and the recovery appeal,
// kept free of Express and the database so tests/password-reset.test.js can check them.
// accountRecovery.js does the I/O.
//
// Why it was rewritten (2026-09-15). The owner clicked "Forgot password?", typed an address
// that is on no account, read "If an account exists with that email, a reset link has been
// sent", and nothing ever came: from the outside that is indistinguishable from a broken site.
// Real people had hit the same wall. Of the 35 requests since May that matched no account,
// 7 came from 5 people who afterwards registered a new account with that same address, two of
// them within 15 minutes; one had asked three times in ten minutes. Login is by username, and
// the form took only an address. Two more faults were waiting:
//   - the lookup was `WHERE email = $1`, case-sensitive, and 18 accounts store an address with
//     capitals in it, which hardly anyone retypes the same way;
//   - every request replaced the token, so asking twice killed the link in the first email,
//     which is usually the one people open.
// And it was an open mail relay. /recover-account emailed whatever address was typed, and
// neither form had any rate limit, so anyone could make the site send mail as fast as they
// could POST, burning the SES reputation every verification and notification email depends on.
//
// The rules that fix it:
//   1. Mail only ever goes to an address already on an account, never to the text typed.
//   2. The limits on email volume are counted in the database, under a lock, before anything
//      is sent: per account, and a site-wide ceiling. The per-IP limiter in front of the forms
//      is only a first filter. Its counters live in memory and every restart empties them, and
//      a proxy pool has thousands of addresses; only the account and site limits are hard.
//   3. Whether an account matched never changes the page. The form answers the same for a
//      registered address, an unknown one, and an account that has used up its emails.

const { ruPlural } = require('./ruPlural');

const LIMITS = Object.freeze({
    // Per IP address (IPv6 collapsed to its /56), in memory. Loose on purpose: a whole school
    // shares one NAT gateway, and the limits below are the ones that hold.
    requestsPerIpPerHour: 30,
    appealsPerIpPerHour: 10,
    // Per account, in the database. The person who asked three times in ten minutes (2026-06-10,
    // 463 and 119 seconds apart) would get all three emails; a repeat within the hour carries
    // the same link. Three a day is also the most anyone can make land in someone else's inbox.
    emailsPerAccountPerDay: 3,
    secondsBetweenAccountEmails: 60,
    // Site-wide, in the database. From 2026-05-17 to 2026-09-15 the busiest real hour had 3
    // requests and so did the busiest real day (a test burst on 2026-05-28 aside). The ceilings
    // leave room for a classroom and make "thousands an hour" impossible whatever is thrown at
    // the form; the price is that a determined flood pauses reset emails for everyone for up to
    // a day, and the page says so and gives an address to write to.
    emailsPerSitePerHour: 20,
    emailsPerSitePerDay: 60,
    // The token: 24 hours, as the emails have always said. A request within the first hour
    // of a token reuses it, so every email of a quick series carries a link that works.
    tokenHours: 24,
    tokenReuseMinutes: 60,
    // A typed value that matches several accounts (usernames that differ only in case) mails
    // each of them, up to this many.
    accountsPerRequest: 3,
    identifierMaxLength: 254,
    passwordMinLength: 8,
});

// What password_reset_requests.outcome records (migration 053), with the words the admin queue
// shows for each. The first two are emails, and only those count toward the limits.
const OUTCOME_LABELS = Object.freeze({
    sent: 'emailed',
    failed: 'email failed',
    no_account: 'no account matched',
    account_limit: 'not emailed, account limit',
    site_limit: 'not emailed, site limit',
});
const OUTCOMES = Object.freeze(Object.keys(OUTCOME_LABELS));
const EMAIL_OUTCOMES = Object.freeze(['sent', 'failed']);

// Durations and lengths in the copy come from LIMITS, so a changed limit cannot leave a page
// or an email promising the old one.
const HOURS_EN = `${LIMITS.tokenHours} hour${LIMITS.tokenHours === 1 ? '' : 's'}`;
const HOURS_RU = `${LIMITS.tokenHours} ${ruPlural(LIMITS.tokenHours, 'час', 'часа', 'часов')}`;
const CHARS_EN = `${LIMITS.passwordMinLength} character${LIMITS.passwordMinLength === 1 ? '' : 's'}`;
const CHARS_RU = `${LIMITS.passwordMinLength} ${ruPlural(LIMITS.passwordMinLength, 'символа', 'символов', 'символов')}`;

const SITE_ORIGIN = 'https://savchenkosolutions.com';
const RESET_COOKIE = 'ss_reset';
const CONTACT = 'alex@savchenkosolutions.com';

/** The username or address from the form: a trimmed string, or why there is none. */
function parseIdentifier(raw) {
    // body-parser turns `email[]=a&email[]=b` into an array; only a plain string is input.
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return { ok: false, error: 'empty' };
    if (value.length > LIMITS.identifierMaxLength) return { ok: false, error: 'too_long' };
    return { ok: true, value };
}

/**
 * Which accounts a request is for. `rows` come from the lookup in accountRecovery.js, which
 * compares case-insensitively in SQL and reports per row: email_match, email_exact,
 * username_match, username_exact. An address match wins over a username match (four old
 * usernames are email addresses); within the winning kind an exact match wins over matches
 * that differ only in case ("mark" and "Mark" are two accounts).
 */
function pickAccounts(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const byEmail = list.filter((r) => r.email_match);
    const group = byEmail.length > 0 ? byEmail : list.filter((r) => r.username_match);
    const exact = group.filter((r) => (byEmail.length > 0 ? r.email_exact : r.username_exact));
    return (exact.length > 0 ? exact : group).slice(0, LIMITS.accountsPerRequest);
}

/** True when the site-wide ceiling is reached; checked before looking anything up. */
function siteLimitReached({ lastHour, lastDay }) {
    return Number(lastHour) >= LIMITS.emailsPerSitePerHour || Number(lastDay) >= LIMITS.emailsPerSitePerDay;
}

/**
 * Whether one more email may go to an account: 'send', 'site_limit' or 'account_limit'.
 * Counts are of emails (outcome sent or failed) in the last hour and 24 hours;
 * secondsSinceLast is null when the account has had none in 24 hours.
 */
function decideSend({ site, account }) {
    if (siteLimitReached(site)) return 'site_limit';
    if (Number(account.lastDay) >= LIMITS.emailsPerAccountPerDay) return 'account_limit';
    if (account.secondsSinceLast != null && Number(account.secondsSinceLast) < LIMITS.secondsBetweenAccountEmails) {
        return 'account_limit';
    }
    return 'send';
}

/**
 * Where a form submission came from: false for this site's own page, true for a form on
 * another site (or a sibling subdomain) posting here. The session cookie's SameSite=Lax does
 * not stop that for a signed-out visitor, and without this check any popular page could turn
 * its readers' browsers into a distributed sender against the account limits. A browser that
 * sends neither header is let through: the limits still hold.
 */
function isCrossSite({ fetchSite, origin, host }) {
    if (fetchSite) return fetchSite !== 'same-origin' && fetchSite !== 'none';
    if (origin && origin !== 'null') {
        try {
            return new URL(origin).host !== String(host || '');
        } catch (_err) {
            return true;
        }
    }
    return false;
}

/** 64 hex characters, which is what crypto.randomBytes(32).toString('hex') produces. */
function isResetToken(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** The token from the Cookie header, if it holds a well-formed one. */
function readResetCookie(cookieHeader) {
    const m = new RegExp(`(?:^|;\\s*)${RESET_COOKIE}=([^;]*)`).exec(String(cookieHeader || ''));
    return m && isResetToken(m[1]) ? m[1] : null;
}

/**
 * The origin for links in emails: the site itself, never the request's Host header, which the
 * client writes (a reset link pointing wherever the requester chose is the classic way to
 * steal a token). SITE_ORIGIN in the environment overrides it for a local copy of the site.
 */
function linkOrigin(override) {
    return typeof override === 'string' && /^https?:\/\/[^/\s?#]+$/.test(override) ? override : SITE_ORIGIN;
}

/** null when the new password is acceptable, otherwise 'missing', 'too_short' or 'mismatch'. */
function validateNewPassword(password, confirm) {
    if (typeof password !== 'string' || typeof confirm !== 'string' || !password) return 'missing';
    if (password.length < LIMITS.passwordMinLength) return 'too_short';
    if (password !== confirm) return 'mismatch';
    return null;
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── Emails ──────────────────────────────────────────────────────────────────────────────
//
// Plain, short, and they name the username: people who forget a password have usually
// forgotten which username they chose too, and login asks for the username.

function emailFrom(paragraphs) {
    const text = paragraphs.map((p) => (Array.isArray(p) ? p.map((part) => part.text ?? part).join('') : p)).join('\n\n');
    const html = paragraphs.map((p) => {
        const parts = Array.isArray(p) ? p : [p];
        return `<p>${parts.map((part) => (part && part.href
            ? `<a href="${escapeHtml(part.href)}">${escapeHtml(part.text)}</a>`
            : escapeHtml(part))).join('')}</p>`;
    }).join('\n');
    return { text, html };
}

function buildResetEmail({ lang, username, url }) {
    const link = { href: url, text: url };
    if (lang === 'ru') {
        return {
            subject: 'Сброс пароля на Savchenko Solutions',
            ...emailFrom([
                `Здравствуйте, ${username}!`,
                'Кто-то (надеемся, вы) попросил сбросить пароль вашего аккаунта на Savchenko Solutions.',
                `Имя пользователя для входа: ${username}`,
                ['Задать новый пароль: ', link],
                `Ссылка действует ${HOURS_RU} и только один раз. Если вы ничего не запрашивали, просто удалите это письмо: пароль останется прежним.`,
            ]),
        };
    }
    return {
        subject: 'Reset your Savchenko Solutions password',
        ...emailFrom([
            `Hello, ${username}.`,
            'Someone, hopefully you, asked to reset the password of your account on Savchenko Solutions.',
            `Your username for signing in: ${username}`,
            ['Set a new password: ', link],
            `The link works for ${HOURS_EN} and only once. If you did not ask for this, delete this email and your password stays as it is.`,
        ]),
    };
}

function buildAppealEmail({ lang, username, forgotUrl }) {
    const link = { href: forgotUrl, text: forgotUrl };
    if (lang === 'ru') {
        return {
            subject: 'Запрос на восстановление аккаунта на Savchenko Solutions',
            ...emailFrom([
                `Здравствуйте, ${username}!`,
                'Мы получили запрос на восстановление доступа к вашему аккаунту. Мы рассмотрим его в течение 5 рабочих дней и ответим по электронной почте.',
                ['Если у вас есть доступ к этому почтовому ящику, пароль можно сбросить сразу: ', link],
                'Если вы ничего не отправляли, просто удалите это письмо: с аккаунтом ничего не произошло.',
            ]),
        };
    }
    return {
        subject: 'Your account recovery request on Savchenko Solutions',
        ...emailFrom([
            `Hello, ${username}.`,
            'We received a request to recover your account. We will review it within 5 business days and reply by email.',
            ['If you can read this mailbox, you can reset your password right away: ', link],
            'If you did not send it, delete this email. Nothing about your account has changed.',
        ]),
    };
}

// ── Page copy ───────────────────────────────────────────────────────────────────────────

const COPY = {
    en: {
        forgotTitle: 'Forgot password',
        forgotIntro: 'Enter your username or the email address of your account, and we will email you a link to set a new password.',
        identifierLabel: 'Username or email',
        forgotSubmit: 'Send reset link',
        sentTitle: 'Check your email',
        sentLead: `If what you entered matches an account, a link to set a new password is on its way to the email address of that account. It usually arrives within a couple of minutes and works for ${HOURS_EN}.`,
        sentSpam: 'Nothing yet? Look in the spam folder.',
        sentOtherAddress: 'You may have signed up with a different address.',
        sentRetry: 'Try your username instead',
        noAccess: 'Lost access to your email?',
        recover: 'Recover your account',
        backToLogin: 'Back to login',
        resetTitle: 'Set a new password',
        resetIntro: 'Choose a new password for',
        passwordLabel: 'New password',
        confirmLabel: 'Repeat the new password',
        passwordHint: `At least ${CHARS_EN}.`,
        resetSubmit: 'Save password and sign in',
        linkInvalid: 'This link has expired or has already been used.',
        linkInvalidHint: `Each link works once, for ${HOURS_EN}.`,
        requestNew: 'Request a new link',
        recoverTitle: 'Recover account',
        recoverIntro: "Can't sign in or reset your password? Send an appeal and we will review it by hand within 5 business days.",
        recoverEmailLabel: 'Account email',
        recoverMessageLabel: 'Describe the problem (optional)',
        recoverSubmit: 'Send appeal',
        recoverReceived: 'We received your appeal. You will get an answer within 5 business days; please check your email.',
        errors: {
            empty: 'Enter your username or email address.',
            empty_email: 'Enter your email address.',
            too_long: 'That is longer than any username or email address.',
            rate_limited: 'Too many requests from your network. Please wait an hour and try again.',
            paused: `Password reset emails are paused because the site received unusually many requests. Please try again in an hour, or write to ${CONTACT}.`,
            busy: 'The site is busy. Please try again in a minute.',
            cross_site: 'Please send the form from this page.',
            server: 'Something went wrong. Please try again.',
            missing: 'Enter the new password twice.',
            too_short: `The password must be at least ${CHARS_EN} long.`,
            mismatch: 'The two passwords do not match.',
        },
    },
    ru: {
        forgotTitle: 'Сброс пароля',
        forgotIntro: 'Введите имя пользователя или адрес электронной почты аккаунта, и мы пришлём ссылку, по которой можно задать новый пароль.',
        identifierLabel: 'Имя пользователя или email',
        forgotSubmit: 'Отправить ссылку',
        sentTitle: 'Проверьте почту',
        sentLead: `Если введённые данные совпадают с аккаунтом, ссылка для нового пароля уже отправлена на адрес этого аккаунта. Обычно письмо приходит в течение пары минут, ссылка действует ${HOURS_RU}.`,
        sentSpam: 'Письма нет? Загляните в папку «Спам».',
        sentOtherAddress: 'Возможно, при регистрации вы указали другой адрес.',
        sentRetry: 'Попробуйте ввести имя пользователя',
        noAccess: 'Нет доступа к почте?',
        recover: 'Восстановить аккаунт',
        backToLogin: 'Вернуться ко входу',
        resetTitle: 'Новый пароль',
        resetIntro: 'Задайте новый пароль для аккаунта',
        passwordLabel: 'Новый пароль',
        confirmLabel: 'Повторите новый пароль',
        passwordHint: `Не короче ${CHARS_RU}.`,
        resetSubmit: 'Сохранить пароль и войти',
        linkInvalid: 'Срок действия ссылки истёк, или она уже использована.',
        linkInvalidHint: `Каждая ссылка срабатывает один раз и действует ${HOURS_RU}.`,
        requestNew: 'Запросить новую ссылку',
        recoverTitle: 'Восстановление аккаунта',
        recoverIntro: 'Не получается войти или сбросить пароль? Отправьте запрос, и мы рассмотрим его вручную в течение 5 рабочих дней.',
        recoverEmailLabel: 'Электронная почта аккаунта',
        recoverMessageLabel: 'Опишите проблему (необязательно)',
        recoverSubmit: 'Отправить запрос',
        recoverReceived: 'Мы получили ваш запрос. Ответ придёт в течение 5 рабочих дней, проверяйте электронную почту.',
        errors: {
            empty: 'Введите имя пользователя или адрес электронной почты.',
            empty_email: 'Укажите адрес электронной почты.',
            too_long: 'Это длиннее любого имени пользователя или адреса почты.',
            rate_limited: 'Слишком много запросов из вашей сети. Подождите час и попробуйте снова.',
            paused: `Отправка писем для сброса пароля приостановлена: сайт получил необычно много запросов. Попробуйте через час или напишите на ${CONTACT}.`,
            busy: 'Сайт перегружен. Попробуйте через минуту.',
            cross_site: 'Пожалуйста, отправьте форму с этой страницы.',
            server: 'Произошла ошибка. Попробуйте ещё раз.',
            missing: 'Введите новый пароль дважды.',
            too_short: `Пароль должен быть не короче ${CHARS_RU}.`,
            mismatch: 'Пароли не совпадают.',
        },
    },
};

function copyFor(lang) {
    return lang === 'ru' ? COPY.ru : COPY.en;
}

module.exports = {
    LIMITS,
    OUTCOMES,
    OUTCOME_LABELS,
    EMAIL_OUTCOMES,
    SITE_ORIGIN,
    RESET_COOKIE,
    parseIdentifier,
    pickAccounts,
    siteLimitReached,
    decideSend,
    isCrossSite,
    isResetToken,
    readResetCookie,
    linkOrigin,
    validateNewPassword,
    escapeHtml,
    buildResetEmail,
    buildAppealEmail,
    copyFor,
};
