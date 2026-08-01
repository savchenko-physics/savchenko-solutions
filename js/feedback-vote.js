// feedback-vote.js: the up/down control on the suggestion board.
//
// Reddit's semantics, because they are the ones people already have in their fingers:
// pressing the direction you already chose clears the vote, pressing the opposite swings it
// by two, and a mis-click is always undone by the same button that caused it. Never an
// error, never "you have already voted".
//
// Optimistic: the number moves on click and is then corrected by whatever the server says.
// A vote that fails silently rolls back rather than leaving a lie on screen.
(function feedbackVote() {
    'use strict';

    const applyState = (pill, myVote, votes) => {
        pill.classList.toggle('is-up', myVote === 1);
        pill.classList.toggle('is-down', myVote === -1);
        pill.querySelector('.fb-score').textContent = votes;
        const up = pill.querySelector('.fb-arrow-up');
        const down = pill.querySelector('.fb-arrow-down');
        if (up) up.setAttribute('aria-pressed', String(myVote === 1));
        if (down) down.setAttribute('aria-pressed', String(myVote === -1));
    };

    const currentVote = (pill) =>
        (pill.classList.contains('is-up') ? 1 : (pill.classList.contains('is-down') ? -1 : 0));

    document.addEventListener('click', async (e) => {
        const arrow = e.target.closest('.fb-arrow');
        if (!arrow) return;
        const pill = arrow.closest('[data-fb-vote]');
        if (!pill || pill.dataset.busy === '1') return;

        const dir = Number(arrow.dataset.dir);
        const was = currentVote(pill);
        const now = was === dir ? 0 : dir;
        const score = Number(pill.querySelector('.fb-score').textContent) || 0;

        pill.dataset.busy = '1';
        applyState(pill, now, score - was + now);   // optimistic; -1 to +1 is a swing of two

        try {
            const res = await fetch(`/api/feedback/${encodeURIComponent(pill.dataset.fbVote)}/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dir }),
            });
            const data = await res.json();
            if (data && data.ok) applyState(pill, data.myVote, data.votes);
            else applyState(pill, was, score);
        } catch (_) {
            applyState(pill, was, score);   // offline or blocked: put it back as it was
        }
        pill.dataset.busy = '';
    });
})();
