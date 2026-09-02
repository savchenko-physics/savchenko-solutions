#!/usr/bin/env python3
"""Assemble the final Russian statements from the book, the site's markdown and the model.

    python3 scripts/book3/assemble.py                  # everything, book text where nothing better
    python3 scripts/book3/assemble.py --only-verified  # only rows that need no model: matching
                                                       # markdown, prose-only book text — the rest is
                                                       # left out so build-statements.js keeps the
                                                       # row it has until typeset.py has run

Reads   problems.json      exact 3rd-edition text (scripts/book3/extract.py)
        md_ru.json         the site's markdown statements (scripts/book3/dump-md.js)
        compare_md.json    which of those match the book word for word (compare.py)
        typeset_ru.jsonl   model-typeset book text that passed the invariants (typeset.py)
        render_errors.json optional: problem names whose candidate text fails to render
Writes  statements_ru.json { name: { text, source, needs_review } }, consumed by
        scripts/build-statements.js

Precedence, per problem:
  1. the site's markdown, when its Cyrillic words and digits equal the book's — human
     typesetting that has been live for years, now proven to say what the book says;
  2. the model's typesetting of the book text, when it passed every invariant;
  3. the book text as extracted. Flagged needs_review when it contains mathematics the
     text layer flattened; plain prose needs nothing.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W = os.path.join(ROOT, 'src', 'database', 'book3')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from typeset import has_maths, acceptable  # noqa: E402

IMG = re.compile(r'[ \t]*!\[[^\]]*\]\([^)]*\)[ \t]*\n?')


def load(name, default):
    p = os.path.join(W, name)
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else default


def main():
    only_verified = '--only-verified' in sys.argv
    book = load('problems.json', None)
    md = load('md_ru.json', {})
    kinds = load('compare_md.json', {})
    bad_render = set(load('render_errors.json', []))
    identical = set(kinds.get('identical', []))
    typeset = {}
    p = os.path.join(W, 'typeset_ru.jsonl')
    if os.path.exists(p):
        for line in open(p, encoding='utf-8'):
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get('accepted') and rec['name'] in book and acceptable(book[rec['name']]['text'], rec['text']) is None:
                typeset[rec['name']] = rec['text']

    out, counts = {}, {}
    for name, entry in book.items():
        if name in identical and name not in bad_render:
            text = IMG.sub('', md[name]['text']).strip()
            src, review = 'md', False
        elif name in typeset and name not in bad_render:
            text, src, review = typeset[name], 'book3+llm', False
        else:
            text, src = entry['text'], 'book3'
            review = has_maths(text)
            if only_verified and review:
                continue
        out[name] = {'text': text, 'source': src, 'needs_review': review}
        counts[src] = counts.get(src, 0) + 1
    json.dump(out, open(os.path.join(W, 'statements_ru.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'  statements : {len(out)}')
    print(f'  by source  : {counts}')
    print(f'  needs_review: {sum(1 for v in out.values() if v["needs_review"])}')


if __name__ == '__main__':
    main()
