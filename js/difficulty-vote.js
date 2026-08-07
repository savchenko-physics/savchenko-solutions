// Reader difficulty-vote widget on the solution page (views/solution_post.ejs).
// Same slider+submit shape as views/bank/problem.ejs's difficulty vote, adapted to
// POST /api/problems/:name/difficulty-vote. Never touches the AI score panel above it.
(function () {
    var slider = document.getElementById('ssDiffVoteSlider');
    if (!slider) return;

    var val = document.getElementById('ssDiffVoteVal');
    var btn = document.getElementById('ssDiffVoteBtn');
    var scoreEl = document.getElementById('ssDiffVotesScore');
    var countEl = document.getElementById('ssDiffVotesCount');
    var emptyEl = document.getElementById('ssDiffVotesEmpty');
    var lang = document.documentElement.lang === 'ru' ? 'ru' : 'en';

    // Same mod10/mod100 rule as lib/ruPlural.js (duplicated, not shared: this file
    // ships to the browser with no bundler, that module runs server-side only).
    function ruVotes(n) {
        var mod100 = n % 100, mod10 = n % 10;
        if (mod100 >= 11 && mod100 <= 14) return n + ' голосов';
        if (mod10 === 1) return n + ' голос';
        if (mod10 >= 2 && mod10 <= 4) return n + ' голоса';
        return n + ' голосов';
    }
    function voteCountText(n) {
        return '(' + (lang === 'ru' ? ruVotes(n) : (n + (n === 1 ? ' vote' : ' votes'))) + ')';
    }

    slider.addEventListener('input', function () {
        val.textContent = this.value;
    });

    btn.addEventListener('click', function () {
        var problem = btn.getAttribute('data-problem');
        btn.disabled = true;
        fetch('/api/problems/' + encodeURIComponent(problem) + '/difficulty-vote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vote: parseInt(slider.value, 10) }),
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                btn.disabled = false;
                if (!data.ok) return;

                if (!scoreEl && emptyEl) {
                    // First vote for this problem: swap "no votes yet" for real score/count nodes.
                    scoreEl = document.createElement('span');
                    scoreEl.className = 'ss-diff-votes-score';
                    scoreEl.id = 'ssDiffVotesScore';
                    countEl = document.createElement('span');
                    countEl.className = 'ss-diff-votes-count';
                    countEl.id = 'ssDiffVotesCount';
                    emptyEl.replaceWith(scoreEl);
                    scoreEl.insertAdjacentElement('afterend', countEl);
                    emptyEl = null;
                }

                if (scoreEl) scoreEl.textContent = data.avgVote + '/10';
                if (countEl) countEl.textContent = voteCountText(data.voteCount);

                btn.textContent = lang === 'ru' ? 'Изменить оценку' : 'Update rating';
                btn.setAttribute('data-voted', '1');
            })
            .catch(function () { btn.disabled = false; });
    });
})();
