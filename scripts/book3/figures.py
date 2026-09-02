#!/usr/bin/env python3
"""Attribute every figure bitmap of the 3rd edition to its problem by reading its caption.

    python3 scripts/book3/figures.py --ocr        # phase 1: OCR every bitmap (cached in ocr.json)
    python3 scripts/book3/figures.py --map        # phase 2: split, attribute, cross-check, cut
    python3 scripts/book3/figures.py --write      # phase 3: write img/<problem>/statement.png + figures.json

The book draws "К задаче 1.4.4" inside every figure, so attribution reads the figure rather
than guessing from its position — the guess is what put 8.3.4's circuit diagram under 8.3.3
on the site. Where one bitmap holds two figures side by side (their captions read as
"К задаче 1.4.1 К задаче 1.4.2"), the bitmap is split at the white gutter between them.

Cross-checks, all reported: every ♦-marked problem must receive exactly the number of
figures the book marks (one, or one per ♦-marked lettered part); no figure may name a
problem the book does not mark ♦; and a figure must sit on the page of its problem or the
page after (a statement that ends a page carries its figure over).
"""
import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W = os.path.join(ROOT, 'src', 'database', 'book3')
IMG = os.path.join(W, 'images')

CAPTION = re.compile(r'[Кк]\s*задач[а-я]*\s*((?:\d{1,2}\s*[.,]\s*\d{1,2}\s*[.,]\s*\d{1,3}\s*[,и\s]*)+)')


def _tess(path, psm):
    return subprocess.run(['tesseract', path, '-', '-l', 'rus', '--psm', str(psm)],
                          capture_output=True).stdout.decode('utf-8', 'replace')


def ocr(path):
    """Page-segmentation mode 6 reads most captions; wide multi-panel figures and small
    ones sometimes need sparse mode (11) or a single-block mode, and a few only read
    when the drawing above the caption is cropped away. Returns the first text that
    contains a caption, else the mode-6 text."""
    first = _tess(path, 6)
    if captions_in(first):
        return first
    for psm in (11, 4, 3, 12):
        t = _tess(path, psm)
        if captions_in(t):
            return t
    im = Image.open(path).convert('L')
    strip = im.crop((0, int(im.height * 0.7), im.width, im.height))
    tmp = path + '.strip.png'
    strip.save(tmp)
    try:
        for psm in (6, 11, 7):
            t = _tess(tmp, psm)
            if captions_in(t):
                return t
    finally:
        os.remove(tmp)
    return first


def captions_in(text):
    """Problem numbers named by 'К задаче N' / 'К задачам N, M' captions, in reading order."""
    t = text.replace('l', '1').replace('I', '1').replace('|', '1').replace('О', '0').replace('O', '0').replace('о', '0')
    found = []
    for m in CAPTION.finditer(t):
        for n in re.findall(r'\d{1,2}\s*[.,]\s*\d{1,2}\s*[.,]\s*\d{1,3}', m.group(1)):
            found.append(re.sub(r'\s*[.,]\s*', '.', n))
    return found


def resolve(names, page, problems):
    """Map OCR'd numbers onto real ♦-marked problems on this page or its neighbours. A
    caption that reads "10.1.109" is "10.1.10" with a stray digit; "14.5.25" does not exist.
    Anything that cannot be matched within one edit is kept as read and reported."""
    marked_near = [n for n, p in problems.items() if p['has_figure'] and abs(p['page'] - page) <= 1]
    out = []
    for n in names:
        if n in problems and problems[n]['has_figure'] and abs(problems[n]['page'] - page) <= 1:
            out.append(n)
            continue
        cands = [m for m in marked_near if n.startswith(m) or m.startswith(n) or edits(n, m) <= 1]
        if len(cands) == 1:
            out.append(cands[0])
        else:
            out.append(n)
    return out


def edits(a, b):
    if abs(len(a) - len(b)) > 1:
        return 2
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b))
    s, l = (a, b) if len(a) < len(b) else (b, a)
    for i in range(len(l)):
        if l[:i] + l[i + 1:] == s:
            return 1
    return 2


# Bitmaps whose captions tesseract could not read, or misread, each checked by eye
# against the page. Numbers are in left-to-right order of the figures in the bitmap.
#   p153-2   the book prints 6.1.17's drawing a second time beside 6.1.19, still captioned
#            "К задаче 6.1.17" — attributed by position, as a reader would.
#   p202-0   9.1.3 and p273-0 14.3.28 are captioned in the book but their headers carry
#            no ♦ — the book's own inconsistency; the caption wins.
#   p274-0   "К задачам 14.4.1 и 14.4.11": one figure shared by two problems.
OVERRIDES = {
    'p009-0.png': ['1.1.1'],
    'p022-0.png': ['1.5.1', '1.5.2', '1.5.3'],
    'p022-1.png': ['1.5.5', '1.5.7'],
    'p023-0.png': ['1.5.8', '1.5.9'],
    'p023-1.png': ['1.5.10', '1.5.12', '1.5.13'],
    'p024-2.png': ['1.5.19'],
    'p048-0.png': ['2.4.18'],
    'p101-0.png': ['3.8.10', '3.8.11'],
    'p111-3.png': ['4.2.16'],
    'p117-1.png': ['4.5.4', '4.5.5'],
    'p153-2.png': ['6.1.19'],
    'p157-1.png': ['6.3.10', '6.3.11'],
    'p158-0.png': ['6.3.15'],
    'p202-0.png': ['9.1.3', '9.1.4', '9.1.6'],
    'p210-0.png': ['9.3.20', '9.3.22'],
    'p214-1.png': ['10.1.9', '10.1.10'],
    'p219-1.png': ['10.2.9', '10.2.10'],
    'p222-0.png': ['11.1.10', '11.1.12'],
    'p226-1.png': ['11.2.9', '11.2.10'],
    'p227-0.png': ['11.2.11', '11.2.12'],
    'p235-1.png': ['11.5.11', '11.5.12'],
    'p242-1.png': ['12.1.10', '12.1.11'],
    'p248-2.png': ['12.2.10'],
    'p251-0.png': ['13.1.10', '13.1.12'],
    'p258-0.png': ['13.4.4', '13.4.5'],
    'p273-0.png': ['14.3.27', '14.3.28'],
    'p274-0.png': ['14.4.1', '14.4.11'],
    'p279-0.png': ['14.5.23'],
}


def column_gaps(im, min_gap):
    """x-spans of white gutters running the full height of the image."""
    w, h = im.size
    px = im.load()
    dark = [any(px[x, y] < 128 for y in range(0, h, 2)) for x in range(w)]
    gaps, start = [], None
    for x, d in enumerate(dark + [True]):
        if not d and start is None:
            start = x
        elif d and start is not None:
            if x - start >= min_gap and start > 0 and x < w:
                gaps.append((start, x))
            start = None
    return gaps


def split_by_gutters(im, min_gap=45):
    gaps = column_gaps(im, min_gap)
    w, h = im.size
    cuts = [0] + [(a + b) // 2 for a, b in gaps] + [w]
    return [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1)]


def trim(im, margin=8):
    bbox = Image.eval(im, lambda v: 255 - v).getbbox()
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    x0, y0 = max(0, x0 - margin), max(0, y0 - margin)
    x1, y1 = min(im.width, x1 + margin), min(im.height, y1 + margin)
    return im.crop((x0, y0, x1, y1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ocr', action='store_true')
    ap.add_argument('--map', action='store_true')
    ap.add_argument('--write', action='store_true')
    args = ap.parse_args()

    images = json.load(open(os.path.join(W, 'images.json'), encoding='utf-8'))
    problems = json.load(open(os.path.join(W, 'problems.json'), encoding='utf-8'))
    ocr_path = os.path.join(W, 'ocr.json')
    ocr_cache = json.load(open(ocr_path, encoding='utf-8')) if os.path.exists(ocr_path) else {}

    if args.ocr:
        todo = [e for e in images if not captions_in(ocr_cache.get(e['file'], ''))]
        print(f'  bitmaps to OCR: {len(todo)}')
        with ThreadPoolExecutor(max_workers=6) as ex:
            for e, text in zip(todo, ex.map(lambda e: ocr(os.path.join(IMG, e['file'])), todo)):
                ocr_cache[e['file']] = text
        json.dump(ocr_cache, open(ocr_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        hist = Counter(len(captions_in(ocr_cache[e['file']])) for e in images)
        print(f'  captions per bitmap: {dict(sorted(hist.items()))}')
        for e in images:
            if not captions_in(ocr_cache[e['file']]):
                print(f'    no caption read: {e["file"]}  {e["px"]}  items on page {e["diamond_items_on_page"]}')

    if args.map or args.write:
        # ── phase 2: split multi-caption bitmaps, attribute, cross-check ──────────────
        pieces = []       # {file, page, crop, names}
        report = defaultdict(list)
        tmp = os.path.join(W, '_part.png')

        def span_names(im, x0, x1):
            im.crop((x0, 0, x1, im.height)).save(tmp)
            return resolve(captions_in(ocr(tmp)), e['page'], problems)

        for e in images:
            im = Image.open(os.path.join(IMG, e['file'])).convert('L')
            if e['file'] in OVERRIDES:
                names = list(OVERRIDES[e['file']])
            else:
                raw_names = captions_in(ocr_cache.get(e['file'], ''))
                names = resolve(raw_names, e['page'], problems)
                if names != raw_names:
                    report['ocr_corrected'].append((e['file'], raw_names, names))
            spans = split_by_gutters(im) if im.width >= 700 else [(0, im.width)]
            if len(spans) == 1 and len(names) <= 1:
                pieces.append({'file': e['file'], 'page': e['page'], 'crop': None, 'names': names})
                continue
            # Several gutters: OCR each span on its own — tesseract reads a narrow block far
            # better than a wide strip, which is how "К задаче 13.4.4  К задаче 13.4.5" came
            # back as one caption. Captionless spans fold into the captioned neighbour on
            # their left (a drawing whose caption sits under the next panel), or right for
            # a leading one.
            span_caps = [span_names(im, x0, x1) for (x0, x1) in spans]
            groups = []
            for (x0, x1), caps in zip(spans, span_caps):
                if caps or not groups:
                    groups.append({'x0': x0, 'x1': x1, 'names': caps})
                else:
                    groups[-1]['x1'] = x1
            if len(groups) > 1 and not groups[0]['names']:
                groups[1]['x0'] = groups[0]['x0']
                groups = groups[1:]
            flat = [n for g in groups for n in g['names']]
            if names and sorted(flat) != sorted(names):
                # Whole-image reading (or the override) disagrees with the per-span one.
                # Trust the names, and place them positionally if the shapes agree.
                if len(groups) == len(names):
                    for g, n in zip(groups, names):
                        g['names'] = [n]
                elif len(spans) == len(names):
                    groups = [{'x0': x0, 'x1': x1, 'names': [n]} for (x0, x1), n in zip(spans, names)]
                elif len(names) == 1:
                    groups = [{'x0': 0, 'x1': im.width, 'names': names}]
                else:
                    report['unsplit_multi'].append((e['file'], names, flat))
                    groups = [{'x0': 0, 'x1': im.width, 'names': names}]
            elif not names and flat:
                report['found_by_span'].append((e['file'], flat))
            for g in groups:
                crop = None if (g['x0'] == 0 and g['x1'] == im.width) else [g['x0'], 0, g['x1'], im.height]
                pieces.append({'file': e['file'], 'page': e['page'], 'crop': crop, 'names': g['names']})
        if os.path.exists(tmp):
            os.remove(tmp)

        # attribution: problem -> list of pieces (in book order)
        by_problem = defaultdict(list)
        for i, p in enumerate(pieces):
            if p.get('unsplit'):
                report['unsplit_multi'].append(p['file'])
            if not p['names']:
                report['no_caption'].append(p['file'])
            for n in p['names']:
                if n not in problems:
                    report['caption_not_a_problem'].append((p['file'], n))
                    continue
                pr = problems[n]
                if not pr['has_figure']:
                    report['caption_on_unmarked_problem'].append((p['file'], n))
                if p['page'] not in (pr['page'], pr['page'] + 1, pr['page'] - 1):
                    report['page_mismatch'].append((p['file'], n, pr['page']))
                by_problem[n].append(i)
        expected = {n: len(pr['fig_items']) for n, pr in problems.items() if pr['has_figure']}
        for n, k in expected.items():
            got = len(by_problem.get(n, []))
            if got == 0:
                report['marked_but_no_figure'].append((n, problems[n]['page']))
            elif got != k:
                report['count_differs'].append((n, k, got))
        print(f'  pieces                     : {len(pieces)}')
        print(f'  problems with a figure     : {len(by_problem)} (book marks {len(expected)})')
        for k, v in report.items():
            print(f'  {k:28s}: {len(v)}  {v[:6]}')
        json.dump({'pieces': pieces, 'by_problem': by_problem, 'report': report},
                  open(os.path.join(W, 'figure_map.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

        if args.write:
            figures = {}
            for n, idxs in sorted(by_problem.items(), key=lambda kv: [int(x) for x in kv[0].split('.')]):
                paths = []
                for j, i in enumerate(idxs):
                    p = pieces[i]
                    im = Image.open(os.path.join(IMG, p['file'])).convert('L')
                    if p['crop']:
                        im = im.crop(tuple(p['crop']))
                    im = trim(im)
                    d = os.path.join(ROOT, 'img', n)
                    os.makedirs(d, exist_ok=True)
                    fname = 'statement.png' if j == 0 else f'statement-{j + 1}.png'
                    im.save(os.path.join(d, fname), optimize=True)
                    paths.append(f'/img/{n}/{fname}')
                figures[n] = paths
            json.dump(figures, open(os.path.join(W, 'figures.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            print(f'  wrote {sum(len(v) for v in figures.values())} figure files for {len(figures)} problems -> figures.json')


if __name__ == '__main__':
    main()
