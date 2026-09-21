// The rules of a poll in the messenger (migration 065): what may be created, who may vote how,
// and the state a viewer is shown. Pure, so tests/polls.test.js can cover the decisions; the
// SQL and the routes live in messages.js.
//
// Telegram's model, trimmed to what fits here: anonymous (the default) or public, one or several
// answers, revoting allowed or not, options shuffled per viewer, a quiz with one right answer
// (single answer, no revoting, as Telegram), and a closing time. Percentages are per voter, not
// per vote, so with several answers allowed they need not sum to 100.
'use strict';

const LIMITS = { question: 500, option: 100, minOptions: 2, maxOptions: 10, maxDurationDays: 30 };

// { ok: true, poll } with the fields normalised, or { ok: false, error }.
function validatePollInput(body, { now = new Date() } = {}) {
    const b = body || {};
    const question = String(b.question || '').trim().replace(/\s+/g, ' ');
    if (!question) return { ok: false, error: 'question' };
    if (question.length > LIMITS.question) return { ok: false, error: 'question_length' };
    const raw = Array.isArray(b.options) ? b.options : [];
    const options = raw.map((o) => String(o || '').trim().replace(/\s+/g, ' ')).filter(Boolean);
    if (options.length < LIMITS.minOptions) return { ok: false, error: 'options_few' };
    if (options.length > LIMITS.maxOptions) return { ok: false, error: 'options_many' };
    if (options.some((o) => o.length > LIMITS.option)) return { ok: false, error: 'option_length' };
    const quiz = !!b.quiz;
    let correctIndex = null;
    if (quiz) {
        correctIndex = Number.isInteger(b.correctIndex) ? b.correctIndex : parseInt(b.correctIndex, 10);
        if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) return { ok: false, error: 'correct' };
    }
    let closesAt = null;
    if (b.durationMinutes != null && b.durationMinutes !== '' && Number(b.durationMinutes) > 0) {
        const minutes = Number(b.durationMinutes);
        if (!Number.isFinite(minutes) || minutes < 5 || minutes > LIMITS.maxDurationDays * 24 * 60) return { ok: false, error: 'duration' };
        closesAt = new Date(now.getTime() + minutes * 60 * 1000);
    }
    return {
        ok: true,
        poll: {
            question, options,
            anonymous: b.anonymous === undefined ? true : !!b.anonymous,
            // A quiz has one answer and no second try, as on Telegram.
            multiple: quiz ? false : !!b.multiple,
            revote: quiz ? false : (b.revote === undefined ? true : !!b.revote),
            shuffle: !!b.shuffle,
            quiz, correctIndex, closesAt,
        },
    };
}

function isClosed(poll, now = new Date()) {
    if (poll.closed_at) return true;
    return !!(poll.closes_at && new Date(poll.closes_at).getTime() <= now.getTime());
}

// Whether `optionIds` is an acceptable vote from someone whose current votes are `mine`.
function canVote(poll, mine, optionIds, { optionIdsInPoll, now = new Date() } = {}) {
    if (isClosed(poll, now)) return { ok: false, error: 'closed' };
    const ids = [...new Set((optionIds || []).map((x) => parseInt(x, 10)).filter(Number.isInteger))];
    if (!ids.length) return { ok: false, error: 'empty' };
    if (optionIdsInPoll && ids.some((id) => !optionIdsInPoll.includes(id))) return { ok: false, error: 'option' };
    if (!poll.multiple && ids.length > 1) return { ok: false, error: 'single' };
    if ((mine || []).length && !poll.revote) return { ok: false, error: 'voted' };
    return { ok: true, ids };
}

function canRetract(poll, mine, now = new Date()) {
    if (isClosed(poll, now)) return { ok: false, error: 'closed' };
    if (!(mine || []).length) return { ok: false, error: 'none' };
    if (!poll.revote) return { ok: false, error: 'revote' };
    return { ok: true };
}

// The creator, or a moderator of the chat, may close a poll early.
function canClose(poll, userId, { isModerator = false } = {}) {
    if (poll.closed_at) return { ok: false, error: 'closed' };
    if (poll.created_by !== userId && !isModerator) return { ok: false, error: 'owner' };
    return { ok: true };
}

// A stable order per viewer: the same shuffle every time they look, a different one for the
// next person (a small hash of the viewer id and the poll id).
function orderFor(options, poll, viewerId) {
    if (!poll.shuffle) return options.slice();
    let h = (Number(viewerId) || 0) * 2654435761 + (Number(poll.id) || 0) * 40503;
    const out = options.slice();
    for (let i = out.length - 1; i > 0; i--) {
        h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
        const j = h % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// What a viewer is shown. `counts` maps option id to votes, `voters` is the number of distinct
// voters, `mine` the viewer's option ids. The right answer is revealed only once the viewer has
// voted or the poll is closed. Voter identities are never here (public polls show them on a
// separate request, anonymous ones never).
function pollState(poll, options, counts, voters, mine, viewerId, { now = new Date(), canManage = false } = {}) {
    const closed = isClosed(poll, now);
    const voted = (mine || []).length > 0;
    const reveal = closed || voted;
    return {
        id: poll.id,
        question: poll.question,
        anonymous: !!poll.anonymous,
        multiple: !!poll.multiple,
        revote: !!poll.revote,
        quiz: !!poll.quiz,
        closed,
        closesAt: poll.closes_at ? new Date(poll.closes_at).toISOString() : null,
        voters: Number(voters) || 0,
        voted,
        mine: (mine || []).slice(),
        canRetract: canRetract(poll, mine, now).ok,
        canClose: canManage && !poll.closed_at,
        correct: reveal && poll.quiz ? poll.correct_option_id : null,
        options: orderFor(options, poll, viewerId).map((o) => {
            const n = Number(counts[o.id]) || 0;
            return {
                id: o.id, text: o.text, votes: n,
                percent: voters ? Math.round(100 * n / voters) : 0,
                mine: (mine || []).includes(o.id),
            };
        }),
    };
}

module.exports = { LIMITS, validatePollInput, isClosed, canVote, canRetract, canClose, orderFor, pollState };
