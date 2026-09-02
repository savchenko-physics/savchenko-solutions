#!/usr/bin/env python3
"""Trace the book's figure bitmaps into SVG.

    python3 scripts/book3/vectorize.py            # every figure in figures.json
    python3 scripts/book3/vectorize.py --only 1.4.4,8.3.4

The 3rd edition stores each figure as a 300 dpi 1-bit bitmap (pdfimages -list: "stencil").
That is line art, and potrace turns it into smooth outlines that stay crisp at any zoom,
weigh a few kilobytes, and have a transparent background — which is what the old site's
statement images had (RGBA, transparent) and the 8-bit PNGs written by figures.py do not.

Per figure: img/<problem>/statement.svg next to the PNG (kept). The SVG's width/height
attributes carry the display size the site uses for the PNG (0.42 x pixel width, 140-560px),
so an <img> shows it at the same size; the viewBox keeps full 300 dpi geometry.
Afterwards figures.json points at the SVGs; run build-statements.js to update the table.
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import potrace
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W = os.path.join(ROOT, 'src', 'database', 'book3')


OPTTOLERANCE = 0.5
FMT = '{:.0f}'


def num(v):
    return FMT.format(v).replace('.0', '') if FMT == '{:.1f}' else FMT.format(v)


def display_width(px):
    return max(140, min(560, round(px * 0.42)))


def trace(png_path, svg_path):
    im = Image.open(png_path).convert('L')
    w, h = im.size
    # potracer's Bitmap treats nonzero as the *background*, the opposite of what its name
    # suggests — traced with ink = True the result is a black page with white strokes.
    ink = np.asarray(im) >= 128
    path = potrace.Bitmap(ink).trace(turdsize=1, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY,
                                     alphamax=1.0, opticurve=True, opttolerance=OPTTOLERANCE)
    parts = []
    for curve in path:
        s = curve.start_point
        d = [f'M{num(s.x)} {num(s.y)}']
        for seg in curve:
            e = seg.end_point
            if seg.is_corner:
                c = seg.c
                d.append(f'L{num(c.x)} {num(c.y)}L{num(e.x)} {num(e.y)}')
            else:
                c1, c2 = seg.c1, seg.c2
                d.append(f'C{num(c1.x)} {num(c1.y)} {num(c2.x)} {num(c2.y)} {num(e.x)} {num(e.y)}')
        d.append('Z')
        parts.append(''.join(d))
    dw = display_width(w)
    dh = round(h * dw / w)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{dw}" height="{dh}">'
           f'<path fill="#000" fill-rule="evenodd" d="{"".join(parts)}"/></svg>\n')
    with open(svg_path, 'w', encoding='utf-8') as fh:
        fh.write(svg)
    return os.path.getsize(svg_path), len(parts)


def job(args):
    png, svg = args
    try:
        size, n = trace(png, svg)
        return png, size, n, None
    except Exception as e:  # noqa: BLE001
        return png, 0, 0, str(e)[:120]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--workers', type=int, default=max(2, (os.cpu_count() or 4) - 1))
    ap.add_argument('--no-update', action='store_true', help='trace only; leave figures.json pointing at the PNGs')
    args = ap.parse_args()
    figures = json.load(open(os.path.join(W, 'figures.json'), encoding='utf-8'))
    names = args.only.split(',') if args.only else list(figures)
    tasks = []
    for n in names:
        for src in figures.get(n, []):
            png = os.path.join(ROOT, src.lstrip('/'))
            if png.endswith('.svg'):
                png = png[:-4] + '.png'
            tasks.append((png, png[:-4] + '.svg'))
    t0 = time.time()
    sizes, errors = [], []
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for i, (png, size, n, err) in enumerate(ex.map(job, tasks), 1):
            if err:
                errors.append((png, err))
            else:
                sizes.append(size)
            if i % 100 == 0 or i == len(tasks):
                print(f'  {i}/{len(tasks)}  {time.time() - t0:.0f}s', file=sys.stderr)
    sizes.sort()
    if sizes:
        print(f'  traced {len(sizes)} figures: SVG size KB median {sizes[len(sizes) // 2] / 1e3:.1f}, mean {sum(sizes) / len(sizes) / 1e3:.1f}, max {sizes[-1] / 1e3:.1f}')
    for png, err in errors[:10]:
        print(f'  ! {png}: {err}')
    if not args.no_update and not args.only and not errors:
        updated = {n: [s[:-4] + '.svg' if s.endswith('.png') else s for s in v] for n, v in figures.items()}
        json.dump(updated, open(os.path.join(W, 'figures.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print('  figures.json now points at the SVGs')


if __name__ == '__main__':
    main()
