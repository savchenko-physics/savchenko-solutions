#!/usr/bin/env python3
"""The demon's forecast for «Последняя задача» (lastProblem.js): which of the problems still open
will be solved soon, which will be left last, and what the market's weights would be if it priced
them fairly under conservation of interest. Writes data/lp-forecast.json, which the app reads for
the chance shown under each problem, and which scripts/last-problem-demon.js trades towards.

    node scripts/last-problem-research.js > research.json      (on the server, read-only)
    python3 scripts/last-problem-forecast.py research.json     (here; needs numpy)

The model, as on 15 Sep and refit on 18 Sep: a weekly discrete-time hazard. For every problem still
unsolved at the start of a week, the log-odds of it being solved that week are a week effect (the
site's pace that week) plus features of the problem: estimated solving time, difficulty, ∗, length
of the statement, a figure, its position in the section, how much of the section is solved, its
neighbours, and solves in the same section and chapter over the last 14 days. Fit by penalised
Newton steps; checked on the weeks after 20 July, which the check's fit does not see (within-week
AUC, 0.725 on 18 Sep).

The forecast runs the open problems forward day by day. The pace is the one that reproduces the
last 14 days (the birth-year challenge and the market's first days, about 15 times the year's
average per unsolved problem), easing to the year's average over the following four weeks.

Fair weights: in a market that stood still, a share of problem j returns the interest of every
solve while j is open, plus its value back if j is the last, where a solve of i pays
w_i / (sum of the weights still open). The fair weights are the ones at which that expected return
is the same for every problem, so no bet is better than another; found by iterating over the
simulated orders.
"""
import argparse
import csv
import datetime as dt
import json
import math
import os

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


def load(path):
    D = json.load(open(path, encoding='utf-8'))
    now = dt.datetime.fromisoformat(D['now'].replace('Z', '+00:00'))
    sections = []
    with open(os.path.join(ROOT, 'src', 'database', 'sections.csv'), encoding='utf-8-sig') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            first, last = line.index(','), line.rindex(',')
            sections.append((line[:first], int(line[last + 1:])))
    problems, meta = [], {}
    for sec, n in sections:
        for i in range(1, n + 1):
            pid = f'{sec}.{i}'
            problems.append(pid)
            meta[pid] = {'sec': sec, 'chap': sec.split('.')[0], 'idx': i, 'size': n}

    def ts(s):
        if not s:
            return None
        t = dt.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
        return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)

    market = {m['problem_name']: m for m in D['market']}
    first = {r['problem_name']: ts(r['t']) for r in D['first']}
    posts = set(D['posts'])
    solved_at = {}
    for p in problems:
        if p in market:   # the market's own rule for its outcomes (a template post is not a solve)
            solved_at[p] = ts(market[p]['solved_at']) if market[p]['status'] != 'open' else None
        elif p in first:
            solved_at[p] = first[p]
        elif p in posts:  # solved before any edit was logged
            solved_at[p] = dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc)
        else:
            solved_at[p] = None
    diff = {r['problem_name']: r for r in D['diff']}
    st_len, st_fig = {}, {}
    for r in D['st']:
        if r['lang'] == 'ru':
            st_len[r['problem_name']] = r['len'] or 0
            st_fig[r['problem_name']] = 1.0 if (r['figs'] or 0) > 0 else 0.0
    return now, problems, meta, solved_at, diff, st_len, st_fig, market


def zscore(values):
    a = np.array(values, dtype=float)
    m, s = np.nanmean(a), np.nanstd(a) or 1.0
    a = (a - m) / s
    a[np.isnan(a)] = 0.0
    return a


class Panel:
    STATIC = ['log_est_minutes', 'est_missing', 'difficulty', 'star', 'log_statement_len', 'figure', 'position_in_section']
    DYNAMIC = ['section_solved_share', 'neighbours_solved', 'section_momentum_14d', 'chapter_momentum_14d']

    def __init__(self, now, problems, meta, solved_at, diff, st_len, st_fig):
        self.now, self.problems, self.meta = now, problems, meta
        self.pos = {p: k for k, p in enumerate(problems)}
        est = [diff.get(p, {}).get('est_minutes') for p in problems]
        self.static = np.column_stack([
            zscore([math.log(e) if (e is not None and e > 0) else np.nan for e in est]),
            np.array([1.0 if (e is None or e <= 0) else 0.0 for e in est]),
            zscore([diff.get(p, {}).get('calibrated') if diff.get(p, {}).get('calibrated') is not None else np.nan for p in problems]),
            np.array([1.0 if diff.get(p, {}).get('starred') else 0.0 for p in problems]),
            zscore([math.log(1 + st_len[p]) if st_len.get(p) else np.nan for p in problems]),
            np.array([st_fig.get(p, 0.0) for p in problems]),
            np.array([(meta[p]['idx'] - 1) / max(1, meta[p]['size'] - 1) for p in problems]),
        ])
        self.start = dt.datetime(2026, 1, 5, tzinfo=dt.timezone.utc)   # a Monday, 36 weeks of history
        self.solved_t = np.array([(solved_at[p] - self.start).total_seconds() / 86400 if solved_at[p] else 1e9 for p in problems])
        secs = sorted({meta[p]['sec'] for p in problems})
        chaps = sorted({meta[p]['chap'] for p in problems})
        self.p_sec = np.array([secs.index(meta[p]['sec']) for p in problems])
        self.p_chap = np.array([chaps.index(meta[p]['chap']) for p in problems])
        self.nsec, self.nchap = len(secs), len(chaps)
        self.sec_size = np.array([meta[p]['size'] for p in problems], dtype=float)
        self.prev_of = np.array([self.pos.get(f"{meta[p]['sec']}.{meta[p]['idx'] - 1}", -1) for p in problems])
        self.next_of = np.array([self.pos.get(f"{meta[p]['sec']}.{meta[p]['idx'] + 1}", -1) for p in problems])

    def dynamic(self, day, solved_t=None):
        t = self.solved_t if solved_t is None else solved_t
        solved = t < day
        recent = solved & (t >= day - 14)
        sec_solved = np.bincount(self.p_sec, weights=solved.astype(float), minlength=self.nsec)
        sec_recent = np.bincount(self.p_sec, weights=recent.astype(float), minlength=self.nsec)
        chap_recent = np.bincount(self.p_chap, weights=recent.astype(float), minlength=self.nchap)
        neigh = (np.where(self.prev_of >= 0, solved[np.maximum(self.prev_of, 0)], 1.0)
                 + np.where(self.next_of >= 0, solved[np.maximum(self.next_of, 0)], 1.0))
        return np.column_stack([sec_solved[self.p_sec] / self.sec_size, neigh,
                                np.log1p(sec_recent[self.p_sec]), np.log1p(chap_recent[self.p_chap])])

    def weeks(self):
        out, w = [], self.start
        while w < self.now:
            out.append(w)
            w += dt.timedelta(days=7)
        return out

    def rows(self):
        X, y, W = [], [], []
        for k, w in enumerate(self.weeks()):
            d0 = (w - self.start).total_seconds() / 86400
            at_risk = np.where(self.solved_t >= d0)[0]
            if not len(at_risk):
                continue
            Xd = self.dynamic(d0)
            for i in at_risk:
                X.append(np.concatenate([self.static[i], Xd[i]]))
                y.append(1.0 if self.solved_t[i] < d0 + 7 else 0.0)
                W.append(k)
        return np.array(X), np.array(y), np.array(W)


def fit(X, y, W, nweeks, lam=1.0, lam_week=0.05, iters=400):
    n, d = X.shape
    E = np.zeros((n, nweeks))
    E[np.arange(n), W] = 1.0
    A = np.hstack([E, X])
    theta = np.zeros(nweeks + d)
    theta[:nweeks] = -3.0
    pen = np.concatenate([np.full(nweeks, lam_week), np.full(d, lam)])
    for _ in range(iters):
        mu = 1 / (1 + np.exp(-(A @ theta)))
        g = A.T @ (y - mu) - pen * theta
        H = (A * (mu * (1 - mu) + 1e-9)[:, None]).T @ A + np.diag(pen)
        step = np.linalg.solve(H, g)
        # A week where most of the few problems at risk were solved makes plain Newton overshoot
        # and oscillate; a bounded step converges.
        big = np.max(np.abs(step))
        if big > 1.5:
            step *= 1.5 / big
        theta += step
        if big < 1e-7:
            break
    return theta[:nweeks], theta[nweeks:]


def auc_within_weeks(score, y, W):
    num = den = 0.0
    for k in np.unique(W):
        m = W == k
        pos, neg = score[m][y[m] == 1], score[m][y[m] == 0]
        if not len(pos) or not len(neg):
            continue
        for v in pos:
            num += (neg < v).sum() + 0.5 * (neg == v).sum()
        den += len(pos) * len(neg)
    return num / den if den else float('nan')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('research', help='JSON from scripts/last-problem-research.js')
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'lp-forecast.json'))
    ap.add_argument('--runs', type=int, default=6000)
    ap.add_argument('--seed', type=int, default=20260918)
    args = ap.parse_args()

    now, problems, meta, solved_at, diff, st_len, st_fig, market = load(args.research)
    panel = Panel(now, problems, meta, solved_at, diff, st_len, st_fig)
    X, y, W = panel.rows()
    weeks = panel.weeks()
    names = Panel.STATIC + Panel.DYNAMIC

    cut = next(k for k, w in enumerate(weeks) if w >= dt.datetime(2026, 7, 20, tzinfo=dt.timezone.utc))
    _, beta_check = fit(X[W < cut], y[W < cut], W[W < cut], cut)
    auc = auc_within_weeks(X[W >= cut] @ beta_check, y[W >= cut], W[W >= cut])
    alpha, beta = fit(X, y, W, len(weeks))
    print(f'{len(y)} problem-weeks, {int(y.sum())} first solutions, held-out within-week AUC {auc:.3f}')
    for n, b in zip(names, beta):
        print(f'  {n:24s} {b:+.3f} per sd  x{math.exp(b):.2f}')

    today = (now - panel.start).total_seconds() / 86400
    open_now = [p for p in problems if p in market and market[p]['status'] == 'open']
    open_idx = np.array([panel.pos[p] for p in open_now])
    n = len(open_now)

    def hazard(a, day, t, idx):
        Xd = np.column_stack([panel.static[idx], panel.dynamic(day, t)[idx]])
        pw = 1 / (1 + np.exp(-(a + Xd @ beta)))
        return 1 - (1 - pw) ** (1 / 7)

    # The near-term pace: the week effect at which the model expects exactly the solves of the
    # last 14 days among the problems at risk then.
    lo = today - 14
    actual = int(((panel.solved_t >= lo) & (panel.solved_t < today)).sum())

    def expected(a):
        return sum(hazard(a, lo + d, panel.solved_t, np.where(panel.solved_t >= lo + d)[0]).sum() for d in range(14))

    a_lo, a_hi = -10.0, 4.0
    for _ in range(40):
        mid = (a_lo + a_hi) / 2
        a_lo, a_hi = (mid, a_hi) if expected(mid) < actual else (a_lo, mid)
    alpha_recent = (a_lo + a_hi) / 2
    alpha_long = float(np.mean(alpha[:-1]))
    speedup = (1 / (1 + math.exp(-alpha_recent))) / (1 / (1 + math.exp(-alpha_long)))
    print(f'{actual} solves in the last 14 days: pace {alpha_recent:.2f} against the year\'s {alpha_long:.2f} (x{speedup:.1f})')

    def alpha_at(d):
        if d <= 14:
            return alpha_recent
        if d >= 42:
            return alpha_long
        w = (d - 14) / 28
        return (1 - w) * alpha_recent + w * alpha_long

    rng = np.random.default_rng(args.seed)
    orders = np.zeros((args.runs, n), dtype=np.int16)
    solve_day = np.full((args.runs, n), np.inf)
    for s in range(args.runs):
        t = panel.solved_t.copy()
        alive = list(range(n))
        seq = []
        for d in range(1500):
            if len(alive) <= 1:
                break
            h = hazard(alpha_at(d), today + d, t, open_idx[alive])
            hit = [alive[k] for k in np.where(rng.random(len(alive)) < h)[0]]
            rng.shuffle(hit)
            for j in hit:
                if len(alive) <= 1:
                    break
                alive.remove(j)
                seq.append(j)
                solve_day[s, j] = d + rng.random()
                t[open_idx[j]] = today + d + 0.5
        rest = alive[:]
        rng.shuffle(rest)
        orders[s] = seq + rest

    p7 = (solve_day <= 7).mean(0)
    p30 = (solve_day <= 30).mean(0)
    p_last = (orders[:, -1][:, None] == np.arange(n)[None, :]).mean(0)
    median_days = np.median(np.where(np.isinf(solve_day), 1e4, solve_day), 0)
    left = np.sort(solve_day[np.arange(args.runs), orders[:, -2]])

    def returns(e):
        G = np.zeros(n)
        for seq in orders:
            alive = np.ones(n, bool)
            total = e.sum()
            got = np.zeros(n)
            for i in seq[:-1]:
                alive[i] = False
                total -= e[i]
                got[alive] += e[i] / total
            got[seq[-1]] += 1.0
            G += got
        return G / len(orders)

    e = np.full(n, 1.0 / n)
    for _ in range(80):
        G = returns(e)
        ratio = G / G.mean()
        e = e * ratio ** 0.6
        e /= e.sum()
        if np.max(np.abs(ratio - 1)) < 0.005:
            break

    out = {
        'generated': now.isoformat().replace('+00:00', 'Z'),
        'model': {'problem_weeks': int(len(y)), 'first_solutions': int(y.sum()), 'heldout_auc': round(auc, 3),
                  'coefficients': {k: round(float(v), 3) for k, v in zip(names, beta)}},
        'pace': {'solves_last_14_days': actual, 'speedup_vs_year': round(speedup, 1)},
        'one_left_after_days': {'median': round(float(np.median(left)), 1), 'p10': round(float(np.percentile(left, 10)), 1)},
        'problems': [],
    }
    for j in np.argsort(-e):
        out['problems'].append({'problem': open_now[j], 'p7': round(float(p7[j]), 4), 'p30': round(float(p30[j]), 4),
                                'p_last': round(float(p_last[j]), 4), 'median_days': round(float(median_days[j]), 1),
                                'fair': round(float(e[j]), 5)})
        print(f"  {open_now[j]:8s} 7 days {p7[j]*100:5.1f}%  30 days {p30[j]*100:5.1f}%  last {p_last[j]*100:5.1f}%  fair weight {e[j]*100:5.1f}%")
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'written {args.out}')


if __name__ == '__main__':
    main()
