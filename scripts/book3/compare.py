#!/usr/bin/env python3
"""Compare the site's Russian markdown statements with the 3rd edition, word for word.

    python3 scripts/book3/compare.py            # summary + the first divergences
    python3 scripts/book3/compare.py --all      # every mismatch

The comparison strips everything that is legitimately different between a typeset
statement and the book's text layer — LaTeX commands, $ delimiters, image markdown,
punctuation — and compares the sequence of Cyrillic words. That is the same invariant
scripts/repair-ru-latex.js enforces on model output, applied to human typing instead.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W = os.path.join(ROOT, 'src', 'database', 'book3')

IMG = re.compile(r'!\[[^\]]*\]\([^)]*\)')
TEX_CMD = re.compile(r'\\[A-Za-z]+')
TEXT_CMD = re.compile(r'\\(?:text|mathrm|mbox|operatorname)\{([^}]*)\}')


UNIT = re.compile(r'(?<=\d) (c|H|K)(?=[,.;:)»?!]|\s+[^\d\s]|$)')


def words(s):
    s = IMG.sub(' ', s)
    s = TEXT_CMD.sub(r' \1 ', s)
    s = re.sub(r'\\[,;:! ]|[$~]', ' ', s)          # thin spaces, ties, dollar signs
    s = TEX_CMD.sub(' ', s)
    s = re.sub(r'[ \t]+', ' ', s)
    # The same Latin-unit correction extract.py applies to the book ("300 K" -> "300 К"),
    # so a markdown "$300$ K" still counts as the same words.
    s = UNIT.sub(lambda m: ' ' + {'c': 'с', 'H': 'Н', 'K': 'К'}[m.group(1)], s)
    s = s.replace('ё', 'е').replace('Ё', 'Е')
    s = re.sub(r'(?<=[а-яА-Я])-\s*(?=[а-яА-Я])', '', s)     # hyphenation / compounds
    return [w.lower() for w in re.findall(r'[А-Яа-я]+', s)]


def digits(s):
    s = IMG.sub(' ', s)
    return ''.join(re.findall(r'\d', s))


def first_divergence(a, b):
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i, x, y
    return min(len(a), len(b)), (a[len(b)] if len(a) > len(b) else None), (b[len(a)] if len(b) > len(a) else None)


def main():
    book = json.load(open(os.path.join(W, 'problems.json'), encoding='utf-8'))
    md = json.load(open(os.path.join(W, 'md_ru.json'), encoding='utf-8'))
    show_all = '--all' in sys.argv
    kinds = {'identical': [], 'md_has_extra_tail': [], 'md_shorter': [], 'differ': [], 'digits_differ': []}
    for name, m in md.items():
        if name not in book:
            continue
        bw, mw = words(book[name]['text']), words(m['text'])
        if bw == mw:
            kind = 'identical'
        elif mw[:len(bw)] == bw:
            kind = 'md_has_extra_tail'
        elif bw[:len(mw)] == mw:
            kind = 'md_shorter'
        else:
            kind = 'differ'
        if kind == 'identical' and digits(book[name]['text']) != digits(IMG.sub(' ', m['text'])):
            kind = 'digits_differ'
        kinds[kind].append(name)
    total = sum(len(v) for v in kinds.values())
    print(f'  markdown statements compared : {total}')
    for k, v in kinds.items():
        print(f'  {k:20s}: {len(v)}')
    for k in ('md_has_extra_tail', 'md_shorter', 'differ', 'digits_differ'):
        print(f'\n── {k}')
        for name in (kinds[k] if show_all else kinds[k][:8]):
            bw, mw = words(book[name]['text']), words(md[name]['text'])
            i, x, y = first_divergence(bw, mw)
            ctx = ' '.join(bw[max(0, i - 3):i])
            print(f'  {name:9s} book {len(bw):3d} md {len(mw):3d} words | at {i}: …{ctx} [book: {x}] [md: {y}]')
    json.dump(kinds, open(os.path.join(W, 'compare_md.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
