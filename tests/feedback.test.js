// Unit tests for the feedback module's pure logic.
//
// Same approach as tests/brainstorm.test.js: node:test, no framework, no database. The
// route handlers are not covered here because there is no test database in the project;
// what IS covered is everything that decides whether a person's message is accepted, which
// is the part where a bug is silent and expensive — a rejected submission produces no error
// anyone will ever see, just one more person who tried to help and gave up.
//
// The last block mirrors the "must never block" invariants in tests/botgate.test.js and
// exists for the same reason. This site's governing rule is that turning away a real person
// costs everything and letting a duplicate through costs nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateFeedback, validatePollAnswer, voterKey, MIN_BODY, MAX_BODY } = require('../feedback');
const { pickPollQuestion, POLL_IDS, CATEGORY_IDS, getCategories, getWidgetCopy } = require('../feedbackQuestions');

const ok = (over) => ({ category: 'idea', body: 'Добавьте, пожалуйста, задачник Иродова.', ...over });

// ── Body ────────────────────────────────────────────────────────────────────────────

test('a normal suggestion is accepted and trimmed', () => {
    const r = validateFeedback(ok({ body: '  Добавьте Иродова, я решаю его параллельно.  ' }));
    assert.equal(r.ok, true);
    assert.equal(r.value.body, 'Добавьте Иродова, я решаю его параллельно.');
});

test('an empty or whitespace-only body is rejected', () => {
    assert.equal(validateFeedback(ok({ body: '' })).error, 'too_short');
    assert.equal(validateFeedback(ok({ body: '     ' })).error, 'too_short');
    assert.equal(validateFeedback(ok({ body: undefined })).error, 'too_short');
});

test('a body under the minimum is rejected, at the minimum is accepted', () => {
    assert.equal(validateFeedback(ok({ body: 'x'.repeat(MIN_BODY - 1) })).error, 'too_short');
    assert.equal(validateFeedback(ok({ body: 'x'.repeat(MIN_BODY) })).ok, true);
});

test('an oversized body is rejected rather than silently truncated', () => {
    // Truncation would mangle exactly the long, careful messages that turned out to be the
    // most valuable ones: the "what do you dislike" answers averaged 196 characters and
    // some real reports run to several paragraphs of derivation.
    assert.equal(validateFeedback(ok({ body: 'x'.repeat(MAX_BODY + 1) })).error, 'too_long');
    assert.equal(validateFeedback(ok({ body: 'x'.repeat(MAX_BODY) })).ok, true);
});

// ── Category ────────────────────────────────────────────────────────────────────────

test('every advertised category is accepted', () => {
    for (const category of CATEGORY_IDS) {
        assert.equal(validateFeedback(ok({ category })).ok, true, category);
    }
});

test('an unknown, missing or non-string category is rejected', () => {
    assert.equal(validateFeedback(ok({ category: 'spam' })).error, 'category');
    assert.equal(validateFeedback(ok({ category: undefined })).error, 'category');
    assert.equal(validateFeedback(ok({ category: 42 })).error, 'category');
});

// ── Honeypot and timing ─────────────────────────────────────────────────────────────

test('a filled honeypot is rejected', () => {
    assert.equal(validateFeedback(ok({ hp: 'http://spam.example' })).error, 'honeypot');
});

test('an empty honeypot does not reject — the field ships on every real submission', () => {
    assert.equal(validateFeedback(ok({ hp: '' })).ok, true);
    assert.equal(validateFeedback(ok({ hp: '   ' })).ok, true);
});

test('a submission faster than a human could type is rejected', () => {
    assert.equal(validateFeedback(ok({ elapsedMs: 200 })).error, 'too_fast');
});

test('a missing or unusable elapsedMs never rejects', () => {
    // No script, an old browser, or a resubmitted form all legitimately omit it. Rejecting
    // those would turn a spam heuristic into a way of silencing real people.
    assert.equal(validateFeedback(ok({ elapsedMs: undefined })).ok, true);
    assert.equal(validateFeedback(ok({ elapsedMs: null })).ok, true);
    assert.equal(validateFeedback(ok({ elapsedMs: 'nonsense' })).ok, true);
    assert.equal(validateFeedback(ok({ elapsedMs: -1 })).ok, true);
});

// ── Contact ─────────────────────────────────────────────────────────────────────────

test('no contact at all is fine — it is optional and most people leave it blank', () => {
    const r = validateFeedback(ok({ contactValue: '', contactKind: 'telegram' }));
    assert.equal(r.ok, true);
    assert.equal(r.value.contactKind, null);
    assert.equal(r.value.contactValue, null);
});

test('a telegram handle is normalised to carry its @', () => {
    assert.equal(validateFeedback(ok({ contactKind: 'telegram', contactValue: 'arsen_almaskhan' })).value.contactValue, '@arsen_almaskhan');
    assert.equal(validateFeedback(ok({ contactKind: 'telegram', contactValue: '@jzmicer' })).value.contactValue, '@jzmicer');
});

test('a malformed telegram handle or email is rejected', () => {
    assert.equal(validateFeedback(ok({ contactKind: 'telegram', contactValue: 'ab' })).error, 'contact_telegram');
    assert.equal(validateFeedback(ok({ contactKind: 'telegram', contactValue: 'has spaces' })).error, 'contact_telegram');
    assert.equal(validateFeedback(ok({ contactKind: 'email', contactValue: 'not-an-email' })).error, 'contact_email');
    assert.equal(validateFeedback(ok({ contactKind: 'email', contactValue: 'a@b' })).error, 'contact_email');
});

test('a valid email is accepted, including the relay aliases privacy-minded people use', () => {
    assert.equal(validateFeedback(ok({ contactKind: 'email', contactValue: 'emixter@ukr.net' })).ok, true);
    assert.equal(validateFeedback(ok({ contactKind: 'email', contactValue: 'z0osveq9g@mozmail.com' })).ok, true);
});

test('a contact value with no recognised kind is rejected rather than stored uncategorised', () => {
    assert.equal(validateFeedback(ok({ contactKind: 'carrier-pigeon', contactValue: 'somewhere' })).error, 'contact_kind');
});

test('notifyOnShip only sticks when there is somewhere to send the notification', () => {
    // Otherwise the item carries a promise nothing can keep, and the admin queue shows a
    // "notify" flag that silently does nothing.
    assert.equal(validateFeedback(ok({ notifyOnShip: true })).value.notifyOnShip, false);
    assert.equal(validateFeedback(ok({ notifyOnShip: true, userId: 28 })).value.notifyOnShip, true);
    assert.equal(validateFeedback(ok({ notifyOnShip: true, contactKind: 'email', contactValue: 'a@b.co' })).value.notifyOnShip, true);
});

// ── The poll ────────────────────────────────────────────────────────────────────────

test('a fresh visitor gets exactly one question, and it is a real one', () => {
    const q = pickPollQuestion('ru', [], 0);
    assert.ok(q);
    assert.ok(POLL_IDS.includes(q.id));
    assert.equal(typeof q.question, 'string');
    assert.ok(q.options || q.freeText, 'a question must be answerable somehow');
});

test('an answered question is never shown again', () => {
    const first = pickPollQuestion('en', [], 3);
    const next = pickPollQuestion('en', [first.id], 3);
    assert.notEqual(next.id, first.id);
});

test('a visitor who has answered everything is shown nothing, not an error', () => {
    assert.equal(pickPollQuestion('ru', POLL_IDS, 0), null);
    assert.equal(pickPollQuestion('ru', POLL_IDS, 999), null);
});

test('the seed round-robins rather than favouring one question', () => {
    // Random selection starves the tail of the queue by luck; the whole point of the queue
    // is that every question ends up with a comparable sample.
    const seen = new Set();
    for (let i = 0; i < POLL_IDS.length * 3; i += 1) seen.add(pickPollQuestion('ru', [], i).id);
    assert.equal(seen.size, POLL_IDS.length);
});

test('an unknown seed or answered list degrades gracefully instead of throwing', () => {
    assert.ok(pickPollQuestion('ru', null, NaN));
    assert.ok(pickPollQuestion('zz', ['not-a-question'], -7));
});

test('the teacher follow-up is attached to the role question and to nothing else', () => {
    const role = pickPollQuestion('ru', POLL_IDS.filter((id) => id !== 'role'), 0);
    assert.equal(role.id, 'role');
    assert.ok(role.followUp, 'teachers are the one group worth a second line');
    assert.ok(role.followUp.when.includes('Учитель'));
});

test('poll answers require an actual answer', () => {
    assert.equal(validatePollAnswer({ questionId: 'role', choice: 'Учитель' }).ok, true);
    assert.equal(validatePollAnswer({ questionId: 'not_found', freeText: 'Иродов 2.15' }).ok, true);
    assert.equal(validatePollAnswer({ questionId: 'role' }).error, 'empty');
    assert.equal(validatePollAnswer({ questionId: 'role', choice: '   ' }).error, 'empty');
    assert.equal(validatePollAnswer({ questionId: 'made_up', choice: 'x' }).error, 'question');
});

// ── Vote identity ───────────────────────────────────────────────────────────────────
//
// This block exists because the first deploy shipped a bug. voterKey hashed req.sessionID,
// but sessions are saveUninitialized:false, so a visitor who has never caused a session
// write has no cookie and gets a brand-new sessionID on every request. Every repeat vote
// therefore looked like a first vote, and one browser could run a counter up without limit.
// Caught by pressing the button twice on production and watching 4 become 5.

test('a signed-in member is keyed by account, and never gets an anonymous id', () => {
    const req = { session: { userId: 28 } };
    assert.equal(voterKey(req), 'u:28');
    assert.equal(voterKey(req, { create: true }), 'u:28');
    assert.equal(req.session.fbv, undefined);
});

test('an anonymous voter gets one id and keeps it across requests', () => {
    const session = {};
    const first = voterKey({ session }, { create: true });
    const second = voterKey({ session }, { create: true });
    assert.ok(first.startsWith('a:'));
    assert.equal(first, second, 'a second press must produce the SAME key or it cannot toggle');
    assert.ok(session.fbv, 'the id has to land in the session, which is what persists the cookie');
});

test('two browsers get different keys', () => {
    const a = voterKey({ session: {} }, { create: true });
    const b = voterKey({ session: {} }, { create: true });
    assert.notEqual(a, b);
});

test('reads never mint an identity — that would create a session row per crawler', () => {
    const session = {};
    assert.equal(voterKey({ session }), null);
    assert.equal(session.fbv, undefined, 'rendering the board must not write to the session');
    // An existing id is still honoured on a read, so "you already voted" renders correctly.
    voterKey({ session }, { create: true });
    assert.equal(voterKey({ session }), voterKey({ session }, { create: true }));
});

test('a request with no session at all does not throw', () => {
    assert.doesNotThrow(() => voterKey({}));
    assert.equal(voterKey({}), null);
    assert.equal(voterKey({}, { create: true }), null);
});

// ── Copy ────────────────────────────────────────────────────────────────────────────

test('every category and every widget string exists in both languages', () => {
    // A missing translation renders as "undefined" on a page seen by the ~73% of readers
    // who arrive on /ru — the kind of thing nobody reports, they just leave.
    for (const lang of ['ru', 'en']) {
        const cats = getCategories(lang);
        assert.equal(cats.length, CATEGORY_IDS.length);
        for (const c of cats) {
            for (const field of ['label', 'prompt', 'placeholder']) {
                assert.equal(typeof c[field], 'string', `${lang}/${c.id}/${field}`);
                assert.ok(c[field].length > 0, `${lang}/${c.id}/${field} is empty`);
            }
        }
        const copy = getWidgetCopy(lang);
        for (const [k, v] of Object.entries(copy)) {
            if (Array.isArray(v) || k === 'lang') continue;
            assert.equal(typeof v, 'string', `${lang}/${k}`);
            assert.ok(v.length > 0, `${lang}/${k} is empty`);
        }
    }
});

test('every poll question is fully translated in both languages', () => {
    for (const lang of ['ru', 'en']) {
        for (const id of POLL_IDS) {
            const q = pickPollQuestion(lang, POLL_IDS.filter((x) => x !== id), 0);
            assert.equal(q.id, id);
            assert.ok(q.question && q.question.length > 0, `${lang}/${id} has no question text`);
            if (q.options) {
                assert.ok(q.options.length >= 2, `${lang}/${id} needs at least two options`);
                for (const o of q.options) assert.ok(typeof o === 'string' && o.length > 0);
            } else {
                assert.ok(q.freeText, `${lang}/${id} has neither options nor free text`);
            }
        }
    }
});

// ── Invariants: never turn away a real person ───────────────────────────────────────
//
// Mirrors the closing block of tests/botgate.test.js. These are the submissions that
// actually arrive on this site, taken from real messages, and none of them may ever be
// rejected by a heuristic.

test('real messages the site has received are all accepted', () => {
    const real = [
        // A terse but specific correction — the most common useful report shape.
        { category: 'error', body: 'В решении ошибка, в третьей строке потерян множитель 2.' },
        // A bug that only ever reached the owner as a private DM.
        { category: 'broken', body: 'когда пишу в LaTeX-е не компилируется и кнопка submit не активен' },
        // A bug reported in Portuguese by a contributor in Brazil.
        { category: 'broken', body: 'Não consigo enviá-lo pelo sistema de envio. Parece que há uma limitação de tamanho.' },
        // The single most-cited feature request, in English.
        { category: 'idea', body: 'Add books like Irodov or Prut-Ovchinkin.' },
        // A rendering bug that got mis-filed as a physics error, for want of a category.
        { category: 'error', body: 'we cannot understand the type of answer with symbols like $, varphi, left or right' },
        // Mixed script, emoji, newlines and maths all in one.
        { category: 'other', body: 'Привет! 👋\n\nВопрос по $\\vec{v}_\\parallel$ — это компонента вдоль线? thanks' },
    ];
    for (const m of real) {
        const r = validateFeedback(m);
        assert.equal(r.ok, true, `rejected (${r.error}): ${m.body.slice(0, 40)}`);
    }
});

test('a body of exactly the minimum length in Cyrillic is accepted', () => {
    assert.equal(validateFeedback({ category: 'error', body: 'Нерешено!!' }).ok, true);
});

test('unexpected input shapes are rejected cleanly rather than throwing', () => {
    // The endpoint is open to the internet with no account behind it, so it will be sent
    // every shape there is.
    for (const bad of [null, undefined, {}, { category: null, body: null }, { category: {}, body: [] }]) {
        assert.doesNotThrow(() => validateFeedback(bad));
        const r = validateFeedback(bad);
        assert.equal(r.ok, false);
        assert.equal(typeof r.error, 'string');
    }
});
