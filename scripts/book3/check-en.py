#!/usr/bin/env python3
"""Cross-check every English statement against the verified Russian original.

    python3 scripts/book3/check-en.py --endpoint http://127.0.0.1:18524/v1 [--limit N]

The English corpus (src/database/main.tex) was OCR'd from the printed translation, and
scripts/build-statements.js already repairs the 41 defects found by reading it against the
Russian. This asks the model to do that reading for all 2,023: it sees the Russian text as
the book prints it and the English as the site stores it, and reports only differences
that change the problem — a number, an exponent, a unit, a subscript, a missing or added
condition. Wording is not its business.

Output: src/database/book3/en_check.jsonl (cached, resumable) and a printed list of the
flagged problems. Nothing is changed automatically: every flag is a suggestion for a human
to confirm and, if real, to add to ONE_OFFS in scripts/build-statements.js.
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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from typeset import chat, english_from_tex  # noqa: E402

SYSTEM = """You compare an English translation of a physics problem with the Russian original.
The Russian is authoritative (it is the printed book; its mathematics is flattened plain
text: v1 means v_1, 108 next to a unit may mean 10^8, 30◦ is 30 degrees). The English was
recovered by OCR and may carry defects.

Report ONLY differences that change the problem: a different number, exponent, unit or
subscript; a physical quantity, condition, sub-question (а/б/в) or sentence that is missing
or added; a wrong symbol (alpha vs alpha_3). Do NOT report wording, word order, style,
notation format, or LaTeX conventions.

Answer with JSON only:
{"ok": true|false, "issues": [{"where": "<short quote from the English>", "russian": "<the
Russian counterpart>", "problem": "<one line>"}], "severity": "none|minor|major"}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--endpoint', default=os.environ.get('QWEN_ENDPOINT', 'http://127.0.0.1:18524/v1'))
    ap.add_argument('--model', default=None)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--workers', type=int, default=8)
    args = ap.parse_args()
    book = json.load(open(os.path.join(W, 'problems.json'), encoding='utf-8'))
    en = english_from_tex()
    out_path = os.path.join(W, 'en_check.jsonl')
    done = {}
    if os.path.exists(out_path):
        for line in open(out_path, encoding='utf-8'):
            try:
                rec = json.loads(line)
                done[rec['name']] = rec
            except json.JSONDecodeError:
                pass
    todo = [n for n in book if n not in done and n in en]
    if args.limit:
        todo = todo[:args.limit]
    print(f'  problems: {len(book)}, checked: {len(done)}, to check: {len(todo)}')
    if todo:
        if not args.model:
            with urllib.request.urlopen(args.endpoint.rstrip('/') + '/models', timeout=30) as r:
                args.model = json.load(r)['data'][0]['id']

        def work(name):
            msgs = [{'role': 'system', 'content': SYSTEM},
                    {'role': 'user', 'content': f'Russian (authoritative):\n{book[name]["text"]}\n\nEnglish (to check):\n{en[name]}'}]
            try:
                text, usage = chat(args.endpoint, args.model, msgs, max_tokens=1500)
                m = re.search(r'\{.*\}', text, re.S)
                parsed = json.loads(m.group(0)) if m else None
                return {'name': name, 'result': parsed, 'raw': None if parsed else text[:300]}
            except Exception as e:  # noqa: BLE001
                return {'name': name, 'result': None, 'error': str(e)[:200]}

        t0 = time.time()
        with open(out_path, 'a', encoding='utf-8') as fh, ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(work, n): n for n in todo}
            for i, fut in enumerate(as_completed(futs), 1):
                rec = fut.result()
                done[rec['name']] = rec
                fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
                fh.flush()
                if i % 50 == 0 or i == len(todo):
                    print(f'  {i}/{len(todo)}  {time.time() - t0:.0f}s')
    flagged = [(n, r['result']) for n, r in done.items() if r.get('result') and not r['result'].get('ok', True)]
    major = [(n, r) for n, r in flagged if r.get('severity') == 'major']
    print(f'\n  flagged: {len(flagged)} (major {len(major)}), unparsed: {sum(1 for r in done.values() if not r.get("result"))}')
    for n, r in sorted(major, key=lambda x: [int(i) for i in x[0].split('.')]):
        for iss in r.get('issues', [])[:2]:
            print(f'  {n:9s} {str(iss.get("problem", ""))[:110]}')


if __name__ == '__main__':
    main()
