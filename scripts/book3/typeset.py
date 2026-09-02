#!/usr/bin/env python3
"""Typeset the mathematics in the 3rd-edition Russian statements with a local LLM.

    python3 scripts/book3/typeset.py --endpoint http://127.0.0.1:18438/v1 [--limit N] [--only 1.4.6,...]
    python3 scripts/book3/typeset.py --dry-run           # show what would be sent

Input   src/database/book3/problems.json   (scripts/book3/extract.py — exact book text,
                                            mathematics flattened by the text layer)
        src/database/book3/md_ru.json      (the site's human-typeset statements, reference)
        src/database/book3/md_en.json + src/database/main.tex English (reference)
Output  src/database/book3/typeset_ru.jsonl  one line per attempt; the last accepted line
                                            per problem wins (safe to re-run, resumes)

The model is asked to change notation and nothing else. Every answer is checked against the
book before it is accepted, on four invariants that a notation-only change cannot break:
the sequence of Cyrillic words, the string of all digits, the sequence of Latin symbol
letters outside LaTeX commands, and the sequence of Greek letters. A rejected answer is
retried once with the reason; a second rejection leaves the problem for the raw book text
(flagged needs_review) — a flattened formula is honest, a rewritten statement is not.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W = os.path.join(ROOT, 'src', 'database', 'book3')

SYSTEM = r"""Вы переносите условия задач по физике из книги в LaTeX-разметку сайта. Текст взят из
текстового слоя PDF: все слова точны, но математика «расплющена» — индексы, степени и
греческие буквы стоят как обычный текст (v1, 108, tA, ω0t, 10−18, 30◦).

Ваша задача — вернуть тот же текст, в котором математика набрана по правилам сайта:
- Каждое математическое выражение, каждая переменная и каждое число с единицей — в одинарных
  долларах: $v$, $m_1$, $10$ м/с, $30^\circ$, $R = 0{,}1$ м, $\alpha$.
- Греческие буквы — команды: α -> \alpha, ω -> \omega, ϕ -> \varphi, φ -> \varphi, Ω -> \Omega,
  ∆ -> \Delta, τ -> \tau, ρ -> \rho, ε -> \varepsilon, μ -> \mu, ν -> \nu, λ -> \lambda.
- Индексы: v1 -> $v_1$, tA -> $t_A$, ω0 -> $\omega_0$, Eизл -> $E_\text{изл}$, Vк -> $V_\text{к}$.
- Степени: 108 (в смысле 10 в 8-й) -> $10^{8}$, 10−18 -> $10^{-18}$, 2−N -> $2^{-N}$,
  но 100 В остаётся $100$ В. Умножение: · -> \cdot.
- Функции: sin -> \sin, cos -> \cos, ln -> \ln, exp -> \exp, arcsin -> \arcsin; tg, ctg, arctg,
  arcctg -> \operatorname{tg}, \operatorname{ctg}, \operatorname{arctg}, \operatorname{arcctg}
  (команд \tg и \ctg на сайте нет — они дали бы ошибку).
- Дроби: a/b можно оставить как $a/b$ или записать $\frac{a}{b}$; корни: √x -> $\sqrt{x}$.
- Градусы: 30◦ -> $30^\circ$. Минус − -> -. Знаки ≤ ≥ -> \le \ge. Векторы ~v -> $\vec v$.
- Десятичная запятая сохраняется: 0,5 -> $0{,}5$.
- Формула, которая в книге стоит отдельной строкой, набирается в $$ ... $$ на отдельной строке.
- Пункты а. б. в. остаются в начале своих строк. Сноска вида ∗) -> $^{*)}$.
- Единицы измерения (м, с, кг, В, Ом, Дж, К, Гц...) остаются обычным русским текстом
  вне долларов; внутри формул — \text{м}.

Менять НИЧЕГО больше нельзя. Не переводите, не перефразируйте, не сокращайте, не исправляйте
физику и опечатки, ничего не добавляйте и не убирайте. Каждое русское слово должно вернуться
ровно тем же, в том же порядке — включая короткие слова рядом с формулами («равна», «вида»,
«по закону»). Все цифры должны сохраниться. Если в абзаце нет математики — верните его как есть.

Для справки даётся набранная людьми версия этого условия с сайта (может содержать опечатки
или лишний текст — берите из неё только обозначения) и английский перевод с формулами.
Ответ: только исправленное русское условие, без пояснений, без кавычек, без ```."""

GREEK = {'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'ϵ': 'epsilon', 'ζ': 'zeta',
         'η': 'eta', 'θ': 'theta', 'ϑ': 'theta', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu', 'ν': 'nu', 'ξ': 'xi',
         'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau', 'υ': 'upsilon', 'φ': 'phi', 'ϕ': 'phi', 'χ': 'chi',
         'ψ': 'psi', 'ω': 'omega', 'µ': 'mu', '\u2126': 'Omega', 'Γ': 'Gamma', '∆': 'Delta', 'Δ': 'Delta', 'Θ': 'Theta', 'Λ': 'Lambda',
         'Ξ': 'Xi', 'Π': 'Pi', 'Σ': 'Sigma', 'Φ': 'Phi', 'Ψ': 'Psi', 'Ω': 'Omega'}
GREEK_ALIAS = {'varepsilon': 'epsilon', 'vartheta': 'theta', 'varphi': 'phi', 'varpi': 'pi', 'varrho': 'rho',
               'varsigma': 'sigma', 'phi': 'phi'}
FUNCS = ['arcsin', 'arccos', 'arctg', 'arcctg', 'sin', 'cos', 'tg', 'ctg', 'ln', 'lg', 'log', 'exp', 'const',
         'max', 'min', 'sh', 'ch', 'th']


def words(s):
    s = s.replace('ё', 'е').replace('Ё', 'Е')
    s = re.sub(r'\\(?:text|mathrm|mbox|operatorname)\{([^}]*)\}', r' \1 ', s)
    s = re.sub(r'\\[A-Za-z]+', ' ', s)
    s = re.sub(r'(?<=[а-яА-Я])-\s*(?=[а-яА-Я])', '', s)
    return [w.lower() for w in re.findall(r'[А-Яа-я]+', s)]


def digits(s):
    return ''.join(re.findall(r'\d', s))


def number_tokens(s):
    """Numbers as the reader sees them: '0,5', '10', '108', and lone index digits."""
    return re.findall(r'\d+(?:[.,]\d+)?', s)


def numbers_agree(book, out):
    """No digit may appear, vanish or change. The one tolerated difference is a swap of two
    adjacent digits: the text layer emits the sub- and superscript of ω₀² in arbitrary
    order ("ω20"), and the typeset \\omega_0^2 puts them the other way round."""
    b, o = digits(book), digits(out)
    if b == o:
        return True
    if len(b) != len(o):
        return False
    i = 0
    while i < len(b):
        if b[i] == o[i]:
            i += 1
        elif i + 1 < len(b) and b[i] == o[i + 1] and b[i + 1] == o[i]:
            i += 2
        else:
            return False
    return True


def latin(s, is_tex):
    """Sequence of Latin symbol letters. Commands, \\text{} payloads and function names are
    not symbols and are removed on the side that has them."""
    if is_tex:
        # \operatorname{tg} is a function (stripped on the book side too); \mathrm{H}_2\mathrm{O}
        # and \text{Al} are symbols the book writes in plain Latin, so their payload stays.
        s = re.sub(r'\\operatorname\{[^}]*\}', ' ', s)
        s = re.sub(r'\\(?:text|mathrm|mbox)\{([^}]*)\}', r' \1 ', s)
        s = re.sub(r'\\[A-Za-z]+', ' ', s)
        s = re.sub(r'(?<![A-Za-z])(' + '|'.join(FUNCS) + r')(?![A-Za-z])', ' ', s)
    else:
        s = re.sub(r'(?<![A-Za-z])(' + '|'.join(FUNCS) + r')(?![A-Za-z])', ' ', s)
        # The text layer sometimes glues a function to its argument or coefficient
        # ("Asint" for A sin t); the long names cannot be anything but functions.
        s = re.sub(r'(arcsin|arccos|arctg|arcctg|sin|cos|exp)(?=[A-Za-z]|$)', ' ', s)
    return re.findall(r'[A-Za-z]', s)


def greek(s, is_tex):
    out = []
    if is_tex:
        for m in re.finditer(r'\\([A-Za-z]+)|([α-ωΑ-Ω∆ϕϵϑ])', s):
            if m.group(1):
                g = GREEK_ALIAS.get(m.group(1), m.group(1))
                if g in GREEK.values():
                    out.append(g)
            else:
                out.append(GREEK[m.group(2)])
    else:
        out = [GREEK[c] for c in s if c in GREEK]
    return out


def acceptable(book, out):
    if not out or len(out) < 10:
        return 'empty or truncated'
    if out.count('$') % 2:
        return 'unbalanced $'
    if re.search(r'\\c?tg\b', out):
        return r'uses \tg or \ctg (undefined on the site)'
    if '```' in out:
        return 'contains a code fence'
    bw, ow = words(book), words(out)
    # Letters, not word boundaries: the text layer sometimes drops the space between two
    # words ("n-гоудара"), and a model that restores it has changed nothing the book says.
    if ''.join(bw) != ''.join(ow):
        i = next((i for i, (x, y) in enumerate(zip(bw, ow)) if x != y), min(len(bw), len(ow)))
        return f'Russian words changed ({len(bw)} -> {len(ow)}, first difference at word {i}: "{bw[i] if i < len(bw) else ""}" vs "{ow[i] if i < len(ow) else ""}")'
    if not numbers_agree(book, out):
        return f'digits changed ({digits(book)} -> {digits(out)})'
    if latin(book, False) != latin(out, True):
        return f'Latin symbols changed ({"".join(latin(book, False))} -> {"".join(latin(out, True))})'
    # As a multiset: the text layer occasionally attaches a Greek letter to the wrong
    # line (5.1.5's two κ landed a sentence later), and the reference lets the model put
    # it back where the book prints it.
    if sorted(greek(book, False)) != sorted(greek(out, True)):
        return f'Greek letters changed ({" ".join(greek(book, False))} -> {" ".join(greek(out, True))})'
    if has_maths(book) and '$' not in out and out.strip() != book.strip():
        return 'no maths markup produced'
    return None


HAS_MATHS = re.compile(r'[α-ωΑ-Ω∆ϕ−·×≤≥∫√◦]|(?<![\\A-Za-zА-Яа-я0-9])[A-Za-z]\d?(?![A-Za-zА-Яа-я])|(?<![A-Za-zА-Яа-я])(sin|cos|tg|ctg|ln|lg|exp|arcsin|arctg)(?![A-Za-zА-Яа-я])|[A-Za-z]\s*=|\d')


def has_maths(s):
    return bool(HAS_MATHS.search(s))


def chat(endpoint, model, messages, max_tokens=4096, temperature=0.0):
    req = urllib.request.Request(
        endpoint.rstrip('/') + '/chat/completions',
        data=json.dumps({'model': model, 'messages': messages, 'max_tokens': max_tokens,
                         'temperature': temperature,
                         'chat_template_kwargs': {'enable_thinking': False}}).encode('utf-8'),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.load(r)
    m = d['choices'][0]['message']
    return (m.get('content') or '').strip(), d.get('usage', {})


def english_from_tex():
    """English statements straight from the Overleaf TeX (same parse as build-statements.js)."""
    tex = open(os.path.join(ROOT, 'src', 'database', 'main.tex'), encoding='utf-8').read()
    out = {}
    for m in re.finditer(r'\\begin\{enumerate\}\[label=(\d{1,2}\.\d{1,2})\.\\arabic\*\](.*?)\\end\{enumerate\}', tex, re.S):
        items = re.split(r'^[ \t]*\\item\b', m.group(2), flags=re.M)[1:]
        for i, raw in enumerate(items):
            t = re.sub(r'\\begin\{center\}.*?\\end\{center\}', ' ', raw, flags=re.S)
            t = re.sub(r'\\includegraphics(?:\[[^\]]*\])?\{[^}]+\}', ' ', t)
            t = re.sub(r'\\label\{[^}]*\}', ' ', t)
            out[f'{m.group(1)}.{i + 1}'] = re.sub(r'\s+', ' ', t).strip()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--endpoint', default=os.environ.get('QWEN_ENDPOINT', 'http://127.0.0.1:18524/v1'))
    ap.add_argument('--model', default=None)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--only', default='')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--redo', action='store_true', help='re-typeset problems that already have an accepted answer')
    ap.add_argument('--skip-identical', action='store_true',
                    help='leave out problems whose site markdown already matches the book word for word (compare.py)')
    args = ap.parse_args()

    book = json.load(open(os.path.join(W, 'problems.json'), encoding='utf-8'))
    md = json.load(open(os.path.join(W, 'md_ru.json'), encoding='utf-8'))
    en = english_from_tex()
    outpath = os.path.join(W, 'typeset_ru.jsonl')
    done = set()
    if os.path.exists(outpath) and not args.redo:
        for line in open(outpath, encoding='utf-8'):
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            # The book text can change (extract.py fixes); an answer accepted against an
            # older text counts only if it still passes against the current one.
            if rec.get('accepted') and rec['name'] in book and acceptable(book[rec['name']]['text'], rec['text']) is None:
                done.add(rec['name'])

    names = [n for n in book if n not in done and has_maths(book[n]['text'])]
    if args.skip_identical:
        cmp_path = os.path.join(W, 'compare_md.json')
        identical = set(json.load(open(cmp_path, encoding='utf-8')).get('identical', [])) if os.path.exists(cmp_path) else set()
        bad = set(json.load(open(os.path.join(W, 'render_errors.json'), encoding='utf-8'))) if os.path.exists(os.path.join(W, 'render_errors.json')) else set()
        names = [n for n in names if n not in identical or n in bad]
    if args.only:
        names = [n for n in args.only.split(',') if n in book]
    if args.limit:
        names = names[:args.limit]
    print(f'  problems with maths     : {sum(1 for n in book if has_maths(book[n]["text"]))}')
    print(f'  already accepted        : {len(done)}')
    print(f'  this run                : {len(names)}')
    if args.dry_run:
        for n in names[:3]:
            print(f'\n── {n}\n{book[n]["text"][:300]}')
        return
    if not names:
        return

    if not args.model:
        with urllib.request.urlopen(args.endpoint.rstrip('/') + '/models', timeout=30) as r:
            args.model = json.load(r)['data'][0]['id']
    print(f'  model                   : {args.model}\n')

    def work(name):
        text = book[name]['text']
        ref = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', md.get(name, {}).get('text', '')).strip()
        user = (f'Английский перевод (только для справки):\n{en.get(name) or "(нет)"}\n\n'
                f'Версия с сайта (только для обозначений):\n{ref or "(нет)"}\n\n'
                f'Условие из книги, которое нужно набрать:\n{text}')
        messages = [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': user}]
        attempts = []
        for attempt in range(3):
            try:
                out, usage = chat(args.endpoint, args.model, messages)
            except Exception as e:  # noqa: BLE001
                attempts.append({'error': str(e)[:200]})
                time.sleep(3)
                continue
            why = acceptable(text, out)
            attempts.append({'out': out, 'why': why, 'usage': usage})
            if why is None:
                return {'name': name, 'accepted': True, 'text': out, 'attempts': attempts}
            messages += [{'role': 'assistant', 'content': out},
                         {'role': 'user', 'content': f'Ответ отклонён: {why}. Верните ровно те же русские слова и цифры, что в условии из книги, меняя только запись математики.'}]
        return {'name': name, 'accepted': False, 'attempts': attempts}

    ok = bad = 0
    t0 = time.time()
    with open(outpath, 'a', encoding='utf-8') as fh, ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(work, n): n for n in names}
        for i, fut in enumerate(as_completed(futures), 1):
            rec = fut.result()
            fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
            fh.flush()
            if rec['accepted']:
                ok += 1
            else:
                bad += 1
                last = rec['attempts'][-1]
                print(f'  reject {rec["name"]}: {last.get("why") or last.get("error")}')
            if i % 25 == 0 or i == len(names):
                print(f'  {i}/{len(names)}  accepted {ok}  rejected {bad}  {time.time() - t0:.0f}s')
    print(f'\n  accepted {ok}, rejected {bad}')


if __name__ == '__main__':
    main()
