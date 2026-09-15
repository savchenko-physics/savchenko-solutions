// «Последняя задача»: the prediction mini app in the community chats (lastProblem.js).
//
// It exists because emixter asked both chats on 2026-09-15 which problem will be solved last and
// Valter and emixter started naming bets. Real people's quanta move through it, so what this file
// guards against is the market maker handing out free money (a buy followed by a sale must never
// return more than it cost), a solved problem being counted wrong (the /create-problem template
// is not a solution), the market paying before the grace period or paying twice, and the premium
// reactions being bought or used by someone who should not.
//
// The same evening the owner replaced winner-takes-all with "conservation of interest": every
// solve pays interest to everything still in play. So this file also guards that a solve creates
// no value (a complete set of shares is worth the same before and after), that nobody can raise
// the interest they get by trading just before a solve, and that the payout really grows the
// closer to the end a problem is solved, the one before last still winning.
//
// Not covered, because there is no test database or browser here: the SQL in lastProblem.js, the
// sync against a real posts/ folder, the chat card and the app's layout. Those were checked
// against a scratch copy of the production schema in a real browser before release.
//
// The closing block holds the "must never block a real person" invariants.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LMSR = require('../js/lmsr');
const LP = require('../lib/lastProblem');
const Reactions = require('../js/reactions');
const { COPY, clientCopy } = require('../lastProblemCopy');

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// The 32 problems unsolved when the question was asked, and the demon's seed (the plan's table).
const OUTCOMES = '3.6.20 3.6.26 5.3.11 5.4.8 5.4.18 5.8.6 5.8.7 5.8.9 6.6.27 7.2.10 7.2.11 7.2.12 7.2.13 7.2.14 8.2.2 8.2.19 8.2.27 8.2.32 8.2.33 13.3.10 14.2.15 14.3.6 14.3.8 14.3.26 14.3.27 14.3.28 14.4.7 14.4.17 14.4.19 14.4.24 14.4.26 14.4.31'.split(' ');
const WEIGHTS = {
    '7.2.13': 0.177, '6.6.27': 0.155, '14.3.27': 0.143, '7.2.12': 0.119, '14.3.8': 0.113,
    '5.8.9': 0.091, '14.3.26': 0.056, '5.3.11': 0.056, '7.2.14': 0.046, '8.2.32': 0.044,
};

const emptyMarket = () => Object.fromEntries(OUTCOMES.map((k) => [k, 0]));

// ── The market maker ─────────────────────────────────────────────────────────────────────

test('prices always add up to one and start even', () => {
    const q = emptyMarket();
    const p = LMSR.prices(q, 1000);
    assert.equal(Object.keys(p).length, 32);
    for (const v of Object.values(p)) assert.ok(close(v, 1 / 32));
    q['5.8.9'] = 2500;
    q['7.2.13'] = -300;
    const p2 = LMSR.prices(q, 1000);
    assert.ok(close(Object.values(p2).reduce((a, b) => a + b, 0), 1));
    assert.ok(p2['5.8.9'] > p2['14.3.8'] && p2['14.3.8'] > p2['7.2.13']);
});

test('an amount buys exactly the shares that cost that amount', () => {
    const q = emptyMarket();
    for (const amount of [1, 7, 100, 999, 1000, 25000]) {
        const shares = LMSR.sharesForAmount(q, 1000, '7.2.13', amount);
        assert.ok(shares > amount, `shares at a 3% price outnumber quanta (${amount})`);
        assert.ok(close(LMSR.tradeCost(q, 1000, '7.2.13', shares), amount, 1e-9), `${amount}`);
    }
    assert.equal(LMSR.sharesForAmount(q, 1000, '7.2.13', 0), 0);
    assert.equal(LMSR.sharesForAmount(q, 1000, '7.2.13', -5), 0);
});

test('a buy followed by a sale never returns more than it cost', () => {
    let q = emptyMarket();
    const b = 1000;
    for (const [k, amount] of [['5.8.9', 100], ['7.2.11', 1000], ['14.3.27', 1]]) {
        const shares = LMSR.sharesForAmount(q, b, k, amount);
        const after = Object.assign({}, q, { [k]: q[k] + shares });
        const back = LMSR.sellProceeds(after, b, k, shares);
        assert.ok(back <= amount + 1e-9, `${k}: paid ${amount}, got back ${back}`);
        assert.ok(close(back, amount, 1e-9), 'with nothing in between it is exactly what was paid');
        q = after;
    }
    // Someone else buying in between moves the price, and then a round trip can lose, not win.
    const shares = LMSR.sharesForAmount(q, b, '6.6.27', 300);
    let after = Object.assign({}, q, { '6.6.27': q['6.6.27'] + shares });
    const other = LMSR.sharesForAmount(after, b, '14.3.8', 500);
    after = Object.assign({}, after, { '14.3.8': after['14.3.8'] + other });
    assert.ok(LMSR.sellProceeds(after, b, '6.6.27', shares) < 300);
});

test('a solved problem leaves the market and the others scale up', () => {
    const q = emptyMarket();
    q['5.8.9'] = 800;
    const before = LMSR.prices(q, 1000);
    const after = LMSR.prices(LMSR.eliminate(q, '3.6.20'), 1000);
    assert.equal('3.6.20' in after, false);
    assert.ok(close(Object.values(after).reduce((a, b) => a + b, 0), 1));
    const scale = 1 / (1 - before['3.6.20']);
    for (const k of Object.keys(after)) assert.ok(close(after[k], before[k] * scale, 1e-9), k);
});

test('at any scale an amount buys exactly the shares that cost that amount, even late and large', () => {
    const q = emptyMarket();
    q['5.8.9'] = 1200;
    for (const scale of [1, 0.4, 0.03, 1e-6]) {
        for (const amount of [1, 100, 5000]) {
            const shares = LMSR.sharesForAmount(q, 1000, '7.2.13', amount, scale);
            assert.ok(Number.isFinite(shares) && shares > 0, `${scale} ${amount}`);
            assert.ok(close(LMSR.tradeCost(q, 1000, '7.2.13', shares) * scale, amount, 1e-7), `${scale} ${amount}`);
            const after = Object.assign({}, q, { '7.2.13': q['7.2.13'] + shares });
            assert.ok(LMSR.sellProceeds(after, 1000, '7.2.13', shares, scale) <= amount * (1 + 1e-9), 'no round trip profit at any scale');
        }
    }
});

// ── Conservation of interest ─────────────────────────────────────────────────────────────

const holder = (key, holdings) => ({ key, holdings: Object.entries(holdings).map(([problem, shares]) => ({ problem, shares })) });

test('a solve pays p / (1 - p): a problem weighing 20% gives the rest +25%', () => {
    const q = LMSR.qForPrices({ a: 0.2, b: 0.5, c: 0.3 }, 1000);
    const s = LMSR.solve(q, 1000, 1, 'a');
    assert.ok(close(s.share, 0.2, 1e-12));
    assert.ok(close(s.rate, 0.25, 1e-12));
    assert.ok(close(s.scale, 0.8, 1e-12));
    assert.equal('a' in s.q, false);
});

test('a solve creates no value: a complete set is worth the same before and after', () => {
    const b = 1000;
    const q = emptyMarket();
    q['5.8.9'] = 1628.7;
    q['14.4.31'] = 2853.9;
    q['7.2.11'] = 2227.6;
    for (const scale of [1, 0.37]) {
        const set = Object.fromEntries(OUTCOMES.map((k) => [k, 10]));
        const before = LMSR.portfolioValue(q, b, set, scale);
        assert.ok(close(before, 10 * scale, 1e-9));
        for (const solvedId of ['5.8.9', '3.6.20']) {
            const s = LMSR.solve(q, b, scale, solvedId);
            const rest = Object.fromEntries(Object.keys(s.q).map((k) => [k, 10]));
            const after = LMSR.portfolioValue(s.q, b, rest, s.scale) + LMSR.interestOn(s, b, rest);
            assert.ok(close(after, before, 1e-9), `${solvedId} at scale ${scale}: ${before} -> ${after}`);
        }
    }
});

test('no price per share jumps at a solve, and the solved problem pays nothing', () => {
    const b = 1000;
    const q = emptyMarket();
    q['5.8.9'] = 1600;
    q['7.2.13'] = 900;
    const before = LMSR.prices(q, b);
    const s = LMSR.solve(q, b, 0.6, '5.8.9');
    const after = LMSR.prices(s.q, b);
    for (const k of Object.keys(after)) assert.ok(close(0.6 * before[k], s.scale * after[k], 1e-9), k);
    assert.equal(LMSR.interestOn(s, b, { '5.8.9': 500 }), 0, 'shares of the solved problem earn nothing');
    const settled = LP.settleSolve({ q, b, scale: 0.6, problem: '5.8.9', holders: [holder('u1', { '5.8.9': 500 }), holder('u2', { '7.2.13': 100 })] });
    assert.deepEqual(settled.payments.map((p) => p.key), ['u2']);
});

test('trading the solved problem just before its solve cannot raise anyone\'s interest', () => {
    const b = 1000;
    const q = emptyMarket();
    const mine = LMSR.sharesForAmount(q, b, '7.2.13', 200);
    q['7.2.13'] += mine;
    const total = (market) => {
        const s = LMSR.solve(market, b, 1, '5.8.9');
        return LMSR.interestOn(s, b, { '7.2.13': mine }) + LMSR.portfolioValue(s.q, b, { '7.2.13': mine }, s.scale);
    };
    const honest = total(q);
    // Up to ten times b, where 5.8.9 already holds 99.9% of the market; beyond that 1 - p runs into
    // the floor on the scale (js/lmsr.js MIN_SCALE) and floating point, not into the rule.
    for (const pump of [100, 2000, 10000]) {
        const pumped = Object.assign({}, q, { '5.8.9': q['5.8.9'] + pump });
        assert.ok(close(total(pumped), honest, 1e-7), `pumping 5.8.9 by ${pump} shares changes nothing for a 7.2.13 holder`);
    }
});

test('the closer to the end a problem is solved, the more it pays, and the one before last still wins', () => {
    const b = 1000;
    const X = '5.8.9';
    const others = OUTCOMES.filter((k) => k !== X);
    const back = (place) => {
        const q = emptyMarket();
        const shares = LMSR.sharesForAmount(q, b, X, 100);
        q[X] += shares;
        const order = others.slice(0, place - 1).concat([X], others.slice(place - 1));
        let market = q;
        let scale = 1;
        let got = 0;
        for (const id of order.slice(0, -1)) {
            if (id === X) return got;
            const s = LMSR.solve(market, b, scale, id);
            got += LMSR.interestOn(s, b, { [X]: shares });
            market = s.q;
            scale = s.scale;
        }
        return got + shares * scale;
    };
    const returns = Array.from({ length: 32 }, (_, i) => back(i + 1));
    assert.equal(returns[0], 0, 'solved first, the stake is lost');
    for (let i = 1; i < 32; i++) assert.ok(returns[i] > returns[i - 1], `place ${i + 1} pays more than place ${i}`);
    assert.ok(returns[9] < 100, 'solved tenth, still a loss');
    assert.ok(returns[30] > 200, `the one before last more than doubles (${returns[30].toFixed(0)})`);
    assert.ok(returns[31] > returns[30] * 1.5, 'the last one pays the most');
});

test('settleSolve pays each holder on what their shares fetch together, rounded down, split over positions', () => {
    const b = 1000;
    let q = emptyMarket();
    const amounts = LP.allocate(800, WEIGHTS);
    const demon = {};
    for (const problem of Object.keys(WEIGHTS)) {
        const shares = LMSR.sharesForAmount(q, b, problem, amounts[problem]);
        q = Object.assign({}, q, { [problem]: q[problem] + shares });
        demon[problem] = shares;
    }
    const s = LP.settleSolve({ q, b, problem: '7.2.13', holders: [holder('demon', demon), holder('nobody', {})] });
    assert.equal(s.payments.length, 1);
    const pay = s.payments[0];
    const rest = Object.assign({}, demon);
    delete rest['7.2.13'];
    const exact = LMSR.interestOn(LMSR.solve(q, b, 1, '7.2.13'), b, rest);
    assert.ok(pay.total <= exact + 1e-9 && pay.total > exact - 0.001 * Object.keys(rest).length, `${pay.total} vs ${exact}`);
    assert.ok(close(Object.values(pay.byProblem).reduce((a, x) => a + x, 0), pay.total, 1e-9));
    assert.equal('7.2.13' in pay.byProblem, false);
    for (const v of Object.values(pay.byProblem)) assert.ok(Number.isInteger(Math.round(v * 10000)) && v > 0);
    assert.throws(() => LP.settleSolve({ q: s.q, b, problem: '7.2.13', holders: [] }), /not open/);
});

test('even a problem holding almost the whole market can be solved without breaking the arithmetic', () => {
    const q = emptyMarket();
    q['5.8.9'] = 60000;
    const s = LMSR.solve(q, 1000, 1, '5.8.9');
    assert.ok(s.scale >= LMSR.MIN_SCALE && Number.isFinite(s.scale));
    const interest = LMSR.interestOn(s, 1000, { '7.2.13': 100 });
    assert.ok(Number.isFinite(interest) && interest >= 0);
    const shares = LMSR.sharesForAmount(s.q, 1000, '7.2.13', 1000, s.scale);
    assert.ok(Number.isFinite(shares) && shares > 0);
});

test('opening at given probabilities reproduces them', () => {
    const want = { a: 0.5, b: 0.3, c: 0.2 };
    const p = LMSR.prices(LMSR.qForPrices(want, 1000), 1000);
    for (const k of Object.keys(want)) assert.ok(close(p[k], want[k], 1e-12), k);
});

test('huge positions do not overflow', () => {
    const q = emptyMarket();
    q['7.2.13'] = 1e6;
    const p = LMSR.prices(q, 1000);
    assert.ok(close(p['7.2.13'], 1, 1e-12));
    assert.ok(Number.isFinite(LMSR.cost(q, 1000)));
    assert.ok(Number.isFinite(LMSR.sellProceeds(q, 1000, '7.2.13', 5000)));
});

// ── The opening board ────────────────────────────────────────────────────────────────────

test('the seed splits 800 ħ by weight into whole quanta', () => {
    const amounts = LP.allocate(800, WEIGHTS);
    assert.equal(Object.values(amounts).reduce((a, b) => a + b, 0), 800);
    assert.ok(Object.values(amounts).every(Number.isInteger));
    assert.equal(amounts['7.2.13'], 142, '800 × 0.177 = 141.6, the largest remainder rounds it up');
    assert.ok(amounts['7.2.13'] > amounts['8.2.32']);
    assert.deepEqual(LP.allocate(0, WEIGHTS), {});
    assert.deepEqual(LP.allocate(10, {}), {});
});

test('the replayed seed opens the board the plan showed', () => {
    const amounts = LP.allocate(800, WEIGHTS);
    const events = Object.keys(WEIGHTS).map((problem) => ({ type: 'buy', actor: 'demon', problem, amount: amounts[problem] }))
        .concat([
            { type: 'buy', actor: 'chat', problem: '5.8.9', amount: 100, source: 'chat:1962' },
            { type: 'buy', actor: 'chat', problem: '7.2.11', amount: 100, source: 'chat:1965' },
        ]);
    const { steps } = LP.replay(OUTCOMES, 1000, events);
    const last = steps[steps.length - 1].prices;
    const pct = (k) => Math.round(last[k] * 1000) / 10;
    assert.equal(pct('5.8.9'), 14.7);
    assert.equal(pct('7.2.11'), 10.7);
    assert.ok(pct('7.2.13') > 6 && pct('7.2.13') < 7.5);
    assert.ok(close(Object.values(last).reduce((a, b) => a + b, 0), 1));
    assert.throws(() => LP.replay(OUTCOMES, 1000, [{ type: 'buy', problem: '1.1.1', amount: 5 }]));
    const solved = LP.replay(OUTCOMES, 1000, [{ type: 'solve', problem: '3.6.20' }]);
    assert.equal(Object.keys(solved.steps[0].prices).length, 31);

    // A solve in the replay pays the demon and the chat bets their interest, and shrinks the scale.
    const withSolve = LP.replay(OUTCOMES, 1000, events.map((e) => Object.assign({ userId: e.actor === 'chat' ? e.source : undefined }, e)).concat([{ type: 'solve', problem: '5.8.9' }]));
    const step = withSolve.steps[withSolve.steps.length - 1];
    assert.ok(close(step.rate, last['5.8.9'] / (1 - last['5.8.9']), 1e-12));
    assert.ok(close(withSolve.scale, 1 - last['5.8.9'], 1e-12));
    const keys = step.payments.map((p) => p.key).sort();
    assert.deepEqual(keys, ['chat:1965', 'demon'], 'Valter held only 5.8.9, so the solve pays him nothing');
});

// ── What counts as solved ────────────────────────────────────────────────────────────────

test('the /create-problem template is not a solution, in either language', () => {
    const index = read('index.js');
    const route = index.slice(index.indexOf('app.post("/create-problem"'), index.indexOf('// Record the creation in the contributions table'));
    for (const marker of LP.TEMPLATE_MARKERS) assert.ok(route.includes(marker), `${marker} is what /create-problem writes`);
    assert.equal(LP.isTemplatePost('### Условие\n\n$5.8.9.$ ...\n\n### Решение\n\n[Здесь должно быть ваше решение]\n'), true);
    assert.equal(LP.isTemplatePost('### Statement\n\n### Solution\n\n[Your solution should be placed here]\n'), true);
    assert.equal(LP.isTemplatePost(''), true);
    assert.equal(LP.isTemplatePost('   \n'), true);
    assert.equal(LP.isTemplatePost(null), true);
    assert.equal(LP.isTemplatePost('### Решение\n\nИз закона сохранения энергии $mv^2/2 = mgh$.\n'), false);
    // An upload of scans is a solution even with no text around it.
    assert.equal(LP.isTemplatePost('![](../../img/5.8.9/1.jpg)'), false);
});

test('a post with nothing written in it is not a solution, whatever template it came from', () => {
    // What knocked 5.8.9 out of the market on 2026-09-15, forty minutes after it opened.
    const junk = '### Условие\n\n$5.8.9.$ [Вставьте условие задачи]\n\n### Решение\n\nasd\n\n#### Ответ\n\n[Вставьте краткий ответ или результат в рамке]';
    assert.equal(LP.isTemplatePost(junk), true);
    assert.equal(LP.isTemplatePost('### Statement\n\n$6.3.10.$ [Insert the problem statement]\n\n### Solution\n\n#### Answer\n\n[Insert a concise answer or boxed result]'), true);
    // A statement copied in is still not a solution.
    assert.equal(LP.isTemplatePost('### Условие\n\n$6.3.14.$ Найдите напряженность электрического поля между тремя пластинами, если средняя пластина заземлена.\n\n### Решение\n\n\n\n#### Ответ\n\n[Вставьте краткий ответ или результат в рамке]'), true);
    assert.equal(LP.hasWrittenSolution(null), false);
});

// ── Must never block a real person (what counts as solved) ─────────────────────────────

test('every kind of real solution on the site counts, placeholders and all', () => {
    const real = {
        'a scan upload that kept the answer placeholder (6.3.14)': '### Условие\n\n$6.3.14.$ Найдите напряженность поля.\n\n### Решение\n\n![К задаче $6.3.14$ |980x4080, 31%](../../img/6.3.14/scan-0.png)\n\n\n\n#### Ответ\n\n[Вставьте краткий ответ или результат в рамке]',
        'text under the statement placeholder (5.9.26)': '### Условие\n\n$5.9.26.$ [Вставьте условие задачи]\n\n### Решение\n\nРассмотрим такой вариант цикла, где после высыхания воды мы заливаем новую воду.\n\n#### Ответ\n\n[Вставьте краткий ответ или результат в рамке]',
        'sub-headings inside the solution (11.4.1)': '### Условие\n\nТекст.\n\n### Решение\n\n#### Закон изменения тока\n\nТок растёт линейно, $i = \\mathscr E t / L$.\n\n#### Ответ: $i=\\dfrac{\\mathscr Et}{L}$',
        'a scan placed before the statement, with an empty solution section (13.4.7)': '![For problem $13.4.7$|2548x3488, 50%](../../img/13.4.7/1.jpg)### Statement\n\n$13.4.7.$ A beam of light falls on a plate.\n\n### Solution\n\n\n\n#### Answer\n\n$I\'=\\frac{1-k}{1+k} I_0$',
        'a heading with a colon and two spaces (8.3.38)': '###  Условие:\n\nТекст.\n\n###  Решение:\n\n#### Решение для случая a:\n\n$U = IR$\n\n#### Ответ: $2$ и $100$',
        'a formula alone': '### Решение\n\n$v = \\sqrt{2gh}$',
        'a paragraph with no formula': 'Скорость не зависит от массы тела, поэтому оба тела упадут одновременно.',
        'English with no headings at all': 'The block slides down with constant acceleration g sin(alpha), since friction is absent.',
    };
    for (const [what, text] of Object.entries(real)) assert.equal(LP.isTemplatePost(text), false, what);
});

test('problem ids are the book numbering and nothing else', () => {
    for (const id of ['5.8.9', '14.4.31', '1.1.1']) assert.equal(LP.isProblemId(id), true, id);
    for (const id of ['5.8', '5.8.9.1', ' 5.8.9', '5.8.9 ', '05.8.9a', '__proto__', '', null, 5.89, '1.1.1234']) {
        assert.equal(LP.isProblemId(id), false, String(id));
    }
});

// ── Trades ───────────────────────────────────────────────────────────────────────────────

test('validateTrade: buys in whole quanta within the balance', () => {
    const open = new Set(['5.8.9', '7.2.13']);
    const ok = (input, ctx) => LP.validateTrade(input, Object.assign({ open, balance: 1000, held: 0 }, ctx));
    assert.deepEqual(ok({ problem: '5.8.9', side: 'buy', amount: 100 }), { ok: true, value: { problem: '5.8.9', side: 'buy', amount: 100 } });
    assert.equal(ok({ problem: '5.8.9', side: 'buy', amount: '250' }).value.amount, 250);
    assert.equal(ok({ problem: '5.8.9', side: 'buy', amount: 1000 }).ok, true);
    assert.equal(ok({ problem: '5.8.9', side: 'buy', amount: 1001 }).error, 'insufficient');
    for (const amount of [0, -1, 10.5, '10.5', '1e3', 'abc', null, undefined, NaN, Infinity, '', ' ', [100], { v: 1 }]) {
        assert.equal(ok({ problem: '5.8.9', side: 'buy', amount }).error, 'amount', JSON.stringify(amount));
    }
    assert.equal(ok({ problem: '3.6.20', side: 'buy', amount: 10 }).error, 'closed', 'a solved problem');
    assert.equal(ok({ problem: '9.9.9.9', side: 'buy', amount: 10 }).error, 'problem');
    assert.equal(ok({ problem: '5.8.9', side: 'short', amount: 10 }).error, 'side');
    // 1000 ħ minus a sale's rounding still buys 1000.
    assert.equal(ok({ problem: '5.8.9', side: 'buy', amount: 1000 }, { balance: 999.9999995 }).ok, true);
});

test('validateTrade: sells only what is held', () => {
    const open = new Set(['5.8.9']);
    const v = (input, held) => LP.validateTrade(Object.assign({ problem: '5.8.9', side: 'sell' }, input), { open, balance: 0, held });
    assert.equal(v({ shares: 'all' }, 886.5).value.shares, 886.5);
    assert.equal(v({ shares: 100 }, 886.5).value.shares, 100);
    assert.equal(v({ shares: '443.25' }, 886.5).value.shares, 443.25);
    assert.equal(v({ shares: 886.5000001 }, 886.5).value.shares, 886.5, 'a speck over is rounding, it sells all');
    assert.equal(v({ shares: 900 }, 886.5).error, 'not_held');
    assert.equal(v({ shares: 'all' }, 0).error, 'not_held');
    for (const shares of [0, -5, 'x', null, NaN]) assert.equal(v({ shares }, 10).error, 'shares', String(shares));
});

// ── Deciding and paying ──────────────────────────────────────────────────────────────────

test('marketStep: decide at one left, pay only after 72 hours, and undo a decision', () => {
    const now = Date.parse('2027-06-01T12:00:00Z');
    assert.equal(LP.marketStep({ openCount: 32, now }), 'open');
    assert.equal(LP.marketStep({ openCount: 1, now }), 'decide');
    assert.equal(LP.marketStep({ openCount: 1, decidedAt: new Date(now - 71 * 3600e3), now }), 'wait');
    assert.equal(LP.marketStep({ openCount: 1, decidedAt: new Date(now - 72 * 3600e3), now }), 'pay');
    assert.equal(LP.marketStep({ openCount: 2, decidedAt: new Date(now - 100 * 3600e3), now }), 'undecide');
    assert.equal(LP.marketStep({ openCount: 1, decidedAt: new Date(0), resolvedAt: new Date(now), now }), 'resolved');
    assert.equal(LP.marketStep({ openCount: 0, now }), 'wait', 'never pays with nothing left');
});

test('eliminationsFor: in the order solved, and never the last one standing', () => {
    const open = ['5.8.9', '7.2.13', '6.6.27'];
    const solved = [
        { problem: '7.2.13', solvedAt: '2026-10-02T10:00:00Z' },
        { problem: '5.8.9', solvedAt: '2026-10-01T10:00:00Z' },
        { problem: '1.1.1', solvedAt: '2026-10-01T09:00:00Z' },
    ];
    assert.deepEqual(LP.eliminationsFor(open, solved).map((s) => s.problem), ['5.8.9', '7.2.13']);
    const all = open.map((problem, i) => ({ problem, solvedAt: `2026-10-0${i + 1}T00:00:00Z` }));
    assert.deepEqual(LP.eliminationsFor(open, all).map((s) => s.problem), ['5.8.9', '7.2.13'], 'the one solved last stays');
    assert.deepEqual(LP.eliminationsFor(['5.8.9'], [{ problem: '5.8.9', solvedAt: '2026-10-01' }]), []);
});

test('a fresh buy shows zero profit, not a paper gain', () => {
    const q = emptyMarket();
    const shares = LMSR.sharesForAmount(q, 1000, '5.8.9', 100);
    const after = Object.assign({}, q, { '5.8.9': shares });
    const value = LP.positionValue(after, 1000, '5.8.9', shares, 'open');
    assert.ok(Math.abs(LP.profitOf({ spent: 100, received: 0, value })) < 1e-9);
    assert.ok(shares * LMSR.priceOf(after, 1000, '5.8.9') > 100, 'shares × price would have claimed a gain');
    assert.equal(LP.positionValue(after, 1000, '5.8.9', shares, 'solved'), 0);
    assert.equal(LP.positionValue(after, 1000, '1.1.1', 10, 'open'), 0);
});

test('a spread of bets is valued as sold together, and a complete set is worth exactly its shares', () => {
    const b = 1000;
    let q = emptyMarket();
    const set = {};
    for (const k of OUTCOMES) { q[k] += 50; set[k] = 50; }
    assert.ok(close(LMSR.portfolioValue(q, b, set), 50, 1e-9), 'one share of everything always pays exactly 1 ħ');
    // The demon's ten bets: valued one at a time they look like a loss the market would not
    // actually take; valued together they are worth what they cost with nothing in between.
    q = emptyMarket();
    const holdings = [];
    const amounts = LP.allocate(800, WEIGHTS);
    for (const problem of Object.keys(WEIGHTS)) {
        const shares = LMSR.sharesForAmount(q, b, problem, amounts[problem]);
        q = Object.assign({}, q, { [problem]: q[problem] + shares });
        holdings.push({ problem, shares, status: 'open' });
    }
    const together = LP.portfolioValueOf(q, b, holdings);
    const apart = holdings.reduce((acc, h) => acc + LP.positionValue(q, b, h.problem, h.shares, 'open'), 0);
    assert.ok(close(together, 800, 1e-9), `together ${together}`);
    assert.ok(apart < together - 1, `apart ${apart} undervalues`);
    assert.equal(LP.portfolioValueOf(q, b, [{ problem: '7.2.13', shares: 100, status: 'solved' }]), 0);
});

test('chartSeries keeps the first and last point and fills solved problems with zero', () => {
    const ticks = Array.from({ length: 1000 }, (_, i) => ({
        created_at: new Date(Date.UTC(2026, 8, 15) + i * 60000).toISOString(),
        prices: i < 500 ? { a: 0.5, b: 0.5 } : { a: 1 },
    }));
    const chart = LP.chartSeries(ticks, ['a', 'b'], 240);
    assert.equal(chart.t.length, 240);
    assert.equal(chart.t[0], Date.parse(ticks[0].created_at));
    assert.equal(chart.t[239], Date.parse(ticks[999].created_at));
    assert.equal(chart.series[1].p[239], 0);
    assert.equal(LP.chartSeries(ticks.slice(0, 3), ['a']).t.length, 3);
});

// ── Premium reactions ────────────────────────────────────────────────────────────────────

test('premium reactions: priced, trophies, the one nobody gets, and Libra season', () => {
    const prem = Reactions.CUSTOM.filter((e) => Reactions.isPremium(e.id)).map((e) => e.id);
    assert.deepEqual(prem, [':kvant:', ':errata:', ':ammeter:', ':dino:', ':cyborgs:', ':libra:', ':laplace:', ':perpetuum:', ':n2000:', ':last:']);
    assert.equal(Reactions.isPremium(':jedi:'), false);
    assert.equal(Reactions.isPremium('\u{1F44D}'), false);

    const inSeason = new Date('2026-10-01T12:00:00Z');
    assert.deepEqual(Reactions.purchaseCheck(':kvant:', { balance: 1200, now: inSeason }), { ok: true, price: 1200 });
    assert.equal(Reactions.purchaseCheck(':laplace:', { balance: 1999.99, now: inSeason }).error, 'insufficient');
    assert.equal(Reactions.purchaseCheck(':kvant:', { owned: [':kvant:'], balance: 5000 }).error, 'owned');
    assert.equal(Reactions.purchaseCheck(':n2000:', { balance: 1e9 }).error, 'trophy');
    assert.equal(Reactions.purchaseCheck(':perpetuum:', { balance: 1e12 }).error, 'never');
    assert.equal(Reactions.purchaseCheck(':libra:', { balance: 5000, now: inSeason }).ok, true);
    assert.equal(Reactions.purchaseCheck(':libra:', { balance: 5000, now: new Date('2026-09-22T23:59:59Z') }).error, 'off_season');
    assert.equal(Reactions.purchaseCheck(':libra:', { balance: 5000, now: new Date('2026-10-23T23:59:59Z') }).ok, true, 'the last day counts');
    assert.equal(Reactions.purchaseCheck(':libra:', { balance: 5000, now: new Date('2026-10-24T00:00:00Z') }).error, 'off_season');
    assert.equal(Reactions.purchaseCheck(':jedi:', { balance: 1000 }).error, 'not_premium');
    assert.equal(Reactions.purchaseCheck('__proto__', { balance: 1000 }).error, 'unknown');
});

test('a premium reaction is locked for anyone who does not own it', () => {
    assert.equal(Reactions.reactionAction(':kvant:', false), 'locked');
    assert.equal(Reactions.reactionAction(':kvant:', false, new Set([':dino:'])), 'locked');
    assert.equal(Reactions.reactionAction(':kvant:', false, new Set([':kvant:'])), 'add');
    assert.equal(Reactions.reactionAction(':kvant:', false, [':kvant:']), 'add');
    assert.equal(Reactions.reactionAction(':kvant:', false, true), 'add');
    assert.equal(Reactions.reactionAction(':jedi:', false), 'add', 'free emoji need nothing');
    assert.equal(Reactions.reactionAction(':n2000:', false, [':n2000:']), 'add');
});

test('the picker offers what you own or could buy today, never a trophy you do not have', () => {
    const autumn = new Date('2026-10-01T00:00:00Z');
    const winter = new Date('2026-12-01T00:00:00Z');
    const free = Reactions.pickerIds({ now: winter });
    assert.deepEqual(free.slice(0, 18), Reactions.pickerIds().slice(0, 18));
    assert.ok(free.includes(':kvant:') && free.includes(':laplace:'));
    assert.ok(!free.includes(':libra:'), 'out of season');
    assert.ok(!free.includes(':perpetuum:') && !free.includes(':n2000:') && !free.includes(':last:'));
    assert.ok(Reactions.pickerIds({ now: autumn }).includes(':libra:'));
    const owner = Reactions.pickerIds({ now: winter, owned: new Set([':libra:', ':n2000:']) });
    assert.ok(owner.includes(':libra:') && owner.includes(':n2000:'), 'owners always see theirs');
    assert.ok(owner.length <= 30, 'five rows of six at most');
});

test('the coin, its reverse and the demon follow the emoji drawing rules', () => {
    const { assertSvgArt } = require('../scripts/lib/svg-art');
    const dir = path.join(ROOT, 'img', 'apps', 'last-problem');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['coin-back.svg', 'coin.svg', 'demon.svg']);
    for (const file of fs.readdirSync(dir)) assertSvgArt(fs.readFileSync(path.join(dir, file), 'utf8'), `img/apps/last-problem/${file}`);
});

// ── Wiring ───────────────────────────────────────────────────────────────────────────────

test('the app is mounted before the solution catch-all, and every write is guarded', () => {
    const index = read('index.js');
    const mount = index.indexOf("app.use('/:lang(en|ru)/apps/last-problem'");
    assert.ok(mount > 0, 'mounted');
    assert.ok(mount > index.indexOf('app.use(i18n.init)'), 'after i18n.init');
    assert.ok(mount < index.indexOf('app.get("/:lang/:name"'), 'before /:lang/:name');
    assert.match(index, /app\.use\('\/api\/last-problem', lastProblemApi\)/);

    const mod = read('lastProblem.js');
    const posts = [...mod.matchAll(/api\.post\('([^']+)'([^\n]*)/g)];
    assert.ok(posts.length >= 4);
    for (const [, route, rest] of posts) {
        assert.match(rest, /writeLimiter, guardWrite/, `${route} is rate limited, signed-in only and same-site only`);
    }
    assert.match(mod, /res\.render\('apps\/last_problem'/);
    assert.doesNotMatch(mod, /\busername:\s*req\.session/, 'no render local named username (main_site_header trap)');
});

test('both reaction endpoints refuse a premium reaction nobody bought', () => {
    const messages = read('messages.js');
    const react = messages.slice(messages.indexOf("router.post('/:msgId(\\\\d+)/react'"), messages.indexOf("router.post('/:msgId(\\\\d+)/pin'"));
    assert.match(react, /ownsReaction\(/);
    assert.match(react, /'locked'/);
    const index = read('index.js');
    const comments = index.slice(index.indexOf('app.post("/api/solutions/comments/:commentId/reactions"'), index.indexOf('// Add comment to solution'));
    assert.match(comments, /ownsReaction\(/);
    assert.match(comments, /"locked"/);
});

test('migration 054 only creates tables, and its rollback removes premium reactions first', () => {
    const up = read('sql', 'migrations', '054_last_problem.sql').replace(/^--.*$/gm, '');
    assert.doesNotMatch(up, /\bALTER TABLE\b|\bDROP\b|\bBEGIN\b|\bCOMMIT\b/i);
    for (const table of ['quanta_wallets', 'quanta_ledger', 'lp_market', 'lp_outcomes', 'lp_ticks', 'lp_positions', 'reaction_unlocks']) {
        assert.match(up, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), table);
    }
    assert.match(up, /balance\s+NUMERIC\(14, 4\) NOT NULL DEFAULT 0 CHECK \(balance >= 0\)/);
    const down = read('sql', 'rollback', '054_last_problem_rollback.sql').replace(/^--.*$/gm, '');
    for (const e of Reactions.CUSTOM.filter((x) => Reactions.isPremium(x.id))) {
        assert.ok(down.includes(`'${e.id}'`), `${e.id} is cleaned up on rollback`);
    }
    assert.ok(down.indexOf('DELETE FROM message_reactions') < down.indexOf('DROP TABLE IF EXISTS reaction_unlocks'));
});

test('migration 055 only adds columns with defaults, and nothing that existed changes', () => {
    const up = read('sql', 'migrations', '055_last_problem_interest.sql').replace(/^--.*$/gm, '');
    assert.doesNotMatch(up, /\bDROP\b|\bUPDATE\b|\bDELETE\b|\bBEGIN\b|\bCOMMIT\b|CREATE TABLE/i);
    const adds = [...up.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) ([^;]+);/g)];
    assert.deepEqual(adds.map((m) => `${m[1]}.${m[2]}`).sort(), ['lp_market.demon_interest', 'lp_market.scale', 'lp_positions.interest', 'lp_ticks.rate']);
    for (const m of adds) {
        if (m[2] !== 'rate') assert.match(m[3], /NOT NULL DEFAULT/, `${m[2]} has a default, so existing rows need nothing`);
    }
    assert.match(up, /scale DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK \(scale > 0\)/);
    const down = read('sql', 'rollback', '055_last_problem_interest_rollback.sql').replace(/^--.*$/gm, '');
    for (const m of adds) assert.ok(down.includes(`DROP COLUMN IF EXISTS ${m[2]}`), m[2]);
});

test('a solve pays everyone in one transaction, one ledger row per position, and chat bets stop being refundable', () => {
    const mod = read('lastProblem.js');
    const elim = mod.slice(mod.indexOf('async function eliminate('), mod.indexOf('async function stepMarket('));
    assert.match(elim, /inTransaction\(/);
    assert.match(elim, /LP\.settleSolve\(/);
    assert.match(elim, /'interest', `solved:\$\{tickId\}:\$\{k\}`/);
    assert.match(elim, /UPDATE lp_market SET scale = \$1/);
    assert.ok(elim.indexOf('UPDATE lp_market SET scale') < elim.indexOf('return { ok: true'), 'the scale moves inside the transaction');
    const trade = mod.slice(mod.indexOf('async function executeTrade('), mod.indexOf('async function cancelChatBet('));
    assert.match(trade, /sharesForAmount\(q, b, v\.problem, v\.amount, scale\)/);
    assert.match(trade, /sellProceeds\(q, b, v\.problem, shares, scale\)/);
    const cancel = mod.slice(mod.indexOf('async function cancelChatBet('), mod.indexOf('async function unlockReaction('));
    assert.match(cancel, /\$\{NO_SOLVE_SINCE\}/);
    const pay = mod.slice(mod.indexOf('async function payOut('), mod.indexOf('async function awardTrophy('));
    assert.match(pay, /num\(h\.shares\) \* scale/);
});

test('the copy has both languages, and no dollar signs, dashes or colons', () => {
    const shape = (o) => Object.keys(o).sort();
    assert.deepEqual(shape(COPY.ru), shape(COPY.en));
    const walk = (value, where) => {
        if (typeof value === 'string') {
            assert.doesNotMatch(value, /\$/, `${where} uses $`);
            assert.doesNotMatch(value, /[—–]/, `${where} has a dash`);
            // The owner's rule for this app: no colons anywhere in what it says (a time is written 13.40).
            assert.doesNotMatch(value, /:/, `${where} has a colon`);
        } else if (typeof value === 'function') {
            walk(value('5.8.9', 100), where);
        } else if (value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) walk(v, `${where}.${k}`);
        }
    };
    walk(COPY.ru, 'ru');
    walk(COPY.en, 'en');
    assert.equal(JSON.parse(JSON.stringify(clientCopy('ru'))).notify, undefined, 'the browser gets no functions');
});

// ── Must never block a real person ───────────────────────────────────────────────────────

test('anyone with a single quantum can buy, and anyone holding shares can sell at a zero balance', () => {
    const open = new Set(OUTCOMES);
    for (const problem of OUTCOMES) {
        assert.equal(LP.validateTrade({ problem, side: 'buy', amount: 1 }, { open, balance: 1 }).ok, true, problem);
        assert.equal(LP.validateTrade({ problem, side: 'sell', shares: 'all' }, { open, balance: 0, held: 3 }).ok, true, problem);
    }
});

test('a premium reaction someone left can always be taken back, bought or not', () => {
    for (const e of Reactions.CUSTOM.filter((x) => Reactions.isPremium(x.id))) {
        assert.equal(Reactions.reactionAction(e.id, true), 'remove', e.id);
        assert.equal(Reactions.reactionAction(e.id, true, []), 'remove', e.id);
        assert.ok(Reactions.glyphHTML(e.id, Reactions.emojiUrls(), 'ru').startsWith('<img'), `${e.id} renders for everyone`);
    }
});

test('the starting grant alone buys nothing: a reaction has to be won', () => {
    const priced = Reactions.CUSTOM.filter((e) => Number.isFinite(e.price));
    for (const e of priced) {
        assert.ok(e.price > LP.START_BALANCE, `${e.id} costs ${e.price}, which the starting ${LP.START_BALANCE} ħ could buy`);
        assert.equal(Reactions.purchaseCheck(e.id, { balance: LP.START_BALANCE, now: new Date('2026-10-01T00:00:00Z') }).error, 'insufficient', e.id);
    }
});
