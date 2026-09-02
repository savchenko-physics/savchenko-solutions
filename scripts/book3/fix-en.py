#!/usr/bin/env python3
"""Propose minimal corrections to English statements that check-en.py flagged as major.

    python3 scripts/book3/fix-en.py --endpoint http://127.0.0.1:18524/v1 [--limit N]

Two model calls per problem, deliberately separated:
  1. the editor sees the Russian original, the English as stored and the flagged issues,
     and returns the English with the smallest change that removes the discrepancy;
  2. the judge sees the Russian, the old English and the proposal, and answers whether the
     proposal is strictly closer to the Russian and changes nothing else.
A proposal is kept only if the judge agrees, the digit string is unchanged (a number is
never "corrected" here — a wrong number is reported for a human), the Latin symbol
sequence is unchanged, and at most a quarter of the words differ.

Output: src/database/book3/en_fixes.json  { name: { text, issues, judge } } — applied by
scripts/build-statements.js with source 'tex+llm' — and en_fixes_report.md for review.
"""
import argparse
import difflib
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
from typeset import chat, english_from_tex, latin, digits  # noqa: E402

EDITOR = """You fix an English translation of a physics problem against the Russian original.
Change ONLY what the listed issues require: the smallest edit that makes the English say
what the Russian says. Keep every other word, the LaTeX notation, the numbers and the
symbols exactly as they are. Do not restyle, do not translate afresh, do not add
explanations. Return only the corrected English statement."""

JUDGE = """Compare two English versions of a physics problem with the Russian original.
Answer JSON only: {"better": true|false, "reason": "<one line>"}
"better" is true only if the NEW version is strictly closer to the Russian in meaning
AND changes nothing beyond what that correction needs (same numbers, same symbols, same
sentences otherwise)."""


def wordset(s):
    return re.findall(r"[A-Za-z][A-Za-z'\-]*", s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--endpoint', default=os.environ.get('QWEN_ENDPOINT', 'http://127.0.0.1:18524/v1'))
    ap.add_argument('--model', default=None)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--workers', type=int, default=6)
    args = ap.parse_args()
    book = json.load(open(os.path.join(W, 'problems.json'), encoding='utf-8'))
    en = english_from_tex()
    flagged = {}
    for line in open(os.path.join(W, 'en_check.jsonl'), encoding='utf-8'):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        r = rec.get('result')
        if r and not r.get('ok', True) and r.get('severity') == 'major' and r.get('issues'):
            flagged[rec['name']] = r['issues']
    out_path = os.path.join(W, 'en_fixes.json')
    fixes = json.load(open(out_path, encoding='utf-8')) if os.path.exists(out_path) else {}
    rejected_path = os.path.join(W, 'en_fixes_rejected.json')
    rejected = json.load(open(rejected_path, encoding='utf-8')) if os.path.exists(rejected_path) else {}
    todo = [n for n in flagged if n not in fixes and n not in rejected and n in en]
    if args.limit:
        todo = todo[:args.limit]
    print(f'  major flags: {len(flagged)}, fixed: {len(fixes)}, rejected: {len(rejected)}, to do: {len(todo)}')
    if todo:
        if not args.model:
            with urllib.request.urlopen(args.endpoint.rstrip('/') + '/models', timeout=30) as r:
                args.model = json.load(r)['data'][0]['id']

        def work(name):
            old = en[name]
            issues = '\n'.join(f'- {i.get("problem", "")} (English: "{i.get("where", "")}"; Russian: "{i.get("russian", "")}")'
                               for i in flagged[name])
            try:
                new, _ = chat(args.endpoint, args.model, [
                    {'role': 'system', 'content': EDITOR},
                    {'role': 'user', 'content': f'Russian original:\n{book[name]["text"]}\n\nEnglish as stored:\n{old}\n\nIssues to fix:\n{issues}'}],
                    max_tokens=2000)
                new = new.strip().strip('`')
                why = None
                if not new or len(new) < 20:
                    why = 'empty'
                elif digits(new) != digits(old):
                    why = f'digits changed {digits(old)} -> {digits(new)}'
                elif latin(new, True) != latin(old, True) and not any('symbol' in str(i).lower() or 'subscript' in str(i).lower() for i in flagged[name]):
                    why = 'Latin symbols changed'
                else:
                    a, b = wordset(old), wordset(new)
                    ratio = difflib.SequenceMatcher(None, a, b).ratio()
                    if ratio < 0.75:
                        why = f'too much rewritten (similarity {ratio:.2f})'
                if why:
                    return name, None, {'why': why, 'proposal': new}
                verdict, _ = chat(args.endpoint, args.model, [
                    {'role': 'system', 'content': JUDGE},
                    {'role': 'user', 'content': f'Russian:\n{book[name]["text"]}\n\nOLD English:\n{old}\n\nNEW English:\n{new}'}],
                    max_tokens=300)
                m = re.search(r'\{.*\}', verdict, re.S)
                j = json.loads(m.group(0)) if m else {'better': False, 'reason': 'unparsed'}
                if not j.get('better'):
                    return name, None, {'why': f'judge: {j.get("reason", "")}', 'proposal': new}
                return name, {'text': new, 'issues': flagged[name], 'judge': j.get('reason', '')}, None
            except Exception as e:  # noqa: BLE001
                return name, None, {'why': f'error {str(e)[:120]}'}

        t0 = time.time()
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(work, n): n for n in todo}
            for i, fut in enumerate(as_completed(futs), 1):
                name, fix, rej = fut.result()
                if fix:
                    fixes[name] = fix
                else:
                    rejected[name] = rej
                if i % 20 == 0 or i == len(todo):
                    json.dump(fixes, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
                    json.dump(rejected, open(rejected_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
                    print(f'  {i}/{len(todo)}  fixed {len(fixes)}  rejected {len(rejected)}  {time.time() - t0:.0f}s')
    json.dump(fixes, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(rejected, open(rejected_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    # ── report ───────────────────────────────────────────────────────────────────────
    lines = ['# English statement corrections proposed by scripts/book3/fix-en.py', '',
             f'{len(fixes)} accepted, {len(rejected)} rejected. Each entry: the flagged issue, then a word diff (old → new).', '']
    for name in sorted(fixes, key=lambda x: [int(i) for i in x.split('.')]):
        f = fixes[name]
        lines.append(f'## {name}')
        for i in f['issues'][:3]:
            lines.append(f'- issue: {i.get("problem", "")}')
        lines.append(f'- judge: {f["judge"]}')
        a, b = en[name].split(), f['text'].split()
        diff = [t for t in difflib.ndiff(a, b) if t[:1] in '+-']
        lines.append('- diff: ' + ' '.join(diff)[:600])
        lines.append('')
    open(os.path.join(W, 'en_fixes_report.md'), 'w', encoding='utf-8').write('\n'.join(lines))
    print(f'  accepted {len(fixes)}, rejected {len(rejected)} -> en_fixes.json, en_fixes_report.md')


if __name__ == '__main__':
    main()
