#!/usr/bin/env python3
"""Second, independent reading of every figure caption with the vision model.

    python3 scripts/book3/verify-figures.py --endpoint http://127.0.0.1:18524/v1 [--limit N]

For each figure file written by scripts/book3/figures.py --write, the model is shown the
image and asked which problem number(s) its caption names. Its answer is compared with the
attribution; disagreements are listed for a human to look at. Results are cached in
src/database/book3/vision_captions.jsonl, so re-runs only ask about new files.

This is the check that would have caught the site's 8.3.3/8.3.4 mix-up: a figure is
attributed by what is printed on it, and two different readers must agree.
"""
import argparse
import base64
import json
import os
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W = os.path.join(ROOT, 'src', 'database', 'book3')

PROMPT = ('Это рисунок из задачника по физике. Внизу рисунка напечатана подпись вида '
          '«К задаче 1.4.6» или «К задачам 14.4.1 и 14.4.11». Перепиши номера задач из подписи '
          'точно так, как они напечатаны. Ответ — только JSON-список строк, например ["1.4.6"]. '
          'Если подписи нет — [].')


def ask(endpoint, model, path):
    b64 = base64.b64encode(open(path, 'rb').read()).decode('ascii')
    body = {'model': model, 'max_tokens': 200, 'temperature': 0.0,
            'chat_template_kwargs': {'enable_thinking': False},
            'messages': [{'role': 'user', 'content': [
                {'type': 'text', 'text': PROMPT},
                {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{b64}'}}]}]}
    req = urllib.request.Request(endpoint.rstrip('/') + '/chat/completions',
                                 data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.load(r)
    text = (d['choices'][0]['message'].get('content') or '').strip()
    m = re.search(r'\[.*?\]', text, re.S)
    names = []
    if m:
        try:
            names = [str(x) for x in json.loads(m.group(0))]
        except json.JSONDecodeError:
            pass
    if not names:
        names = re.findall(r'\d{1,2}\.\d{1,2}\.\d{1,3}', text)
    return text, names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--endpoint', default=os.environ.get('QWEN_ENDPOINT', 'http://127.0.0.1:18524/v1'))
    ap.add_argument('--model', default=None)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--workers', type=int, default=6)
    args = ap.parse_args()
    figures = json.load(open(os.path.join(W, 'figures.json'), encoding='utf-8'))
    cache_path = os.path.join(W, 'vision_captions.jsonl')
    seen = {}
    if os.path.exists(cache_path):
        for line in open(cache_path, encoding='utf-8'):
            try:
                rec = json.loads(line)
                seen[rec['file']] = rec
            except json.JSONDecodeError:
                pass
    todo = [(name, f) for name, files in figures.items() for f in files if f not in seen]
    if args.limit:
        todo = todo[:args.limit]
    print(f'  figures: {sum(len(v) for v in figures.values())}, cached: {len(seen)}, to ask: {len(todo)}')
    if todo:
        if not args.model:
            with urllib.request.urlopen(args.endpoint.rstrip('/') + '/models', timeout=30) as r:
                args.model = json.load(r)['data'][0]['id']
        t0 = time.time()
        with open(cache_path, 'a', encoding='utf-8') as fh, ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(ask, args.endpoint, args.model, os.path.join(ROOT, f.lstrip('/'))): (n, f) for n, f in todo}
            for i, fut in enumerate(as_completed(futs), 1):
                n, f = futs[fut]
                try:
                    text, names = fut.result()
                    rec = {'file': f, 'problem': n, 'read': names, 'raw': text[:200]}
                except Exception as e:  # noqa: BLE001
                    rec = {'file': f, 'problem': n, 'read': None, 'error': str(e)[:200]}
                seen[f] = rec
                fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
                fh.flush()
                if i % 50 == 0 or i == len(todo):
                    print(f'  {i}/{len(todo)}  {time.time() - t0:.0f}s')
    # ── compare ──────────────────────────────────────────────────────────────────────
    agree = disagree = unread = 0
    for name, files in figures.items():
        for f in files:
            rec = seen.get(f)
            if not rec or rec.get('read') is None:
                unread += 1
                continue
            read = [re.sub(r'\s', '', x) for x in rec['read']]
            if name in read or (not read and name == '1.1.1'):
                agree += 1
            else:
                disagree += 1
                print(f'  DISAGREE {name:9s} {f:32s} model read {read}  ({rec.get("raw", "")[:60]!r})')
    print(f'\n  agree {agree}, disagree {disagree}, unread {unread}')


if __name__ == '__main__':
    main()
