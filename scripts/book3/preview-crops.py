#!/usr/bin/env python3
"""Cut every problem's region out of the 3rd-edition page images, for the side-by-side preview.

    python3 scripts/book3/preview-crops.py

Pages are rendered with pdftoppm at 108 dpi, which is exactly the coordinate scale of the
pdftohtml -xml output extract.py parsed (zoom 1.5 x 72 dpi), so a problem's region is the
strip from its header line down to the next header (problems.json: page/top/end_page/end_top).
A problem that runs over a page break is stitched from the strips of each page.

Output: src/database/book3/preview/crops/<problem>.png
"""
import json
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W = os.path.join(ROOT, 'src', 'database', 'book3')
PDF = os.path.join(ROOT, 'pdf', 'savchenko-3rd-ed.pdf')
OUT = os.path.join(W, 'preview', 'crops')
FIRST, LAST = 9, 279
DPI = 108
TEXT_TOP, TEXT_BOTTOM = 60, 892   # the text block of a page, in 108 dpi pixels


def main():
    problems = json.load(open(os.path.join(W, 'problems.json'), encoding='utf-8'))
    # A figure inset beside a short problem runs on below its last line, into the next
    # problem's strip; the crop is extended to the bottom of any bitmap that starts in it.
    images = json.load(open(os.path.join(W, 'images.json'), encoding='utf-8'))
    by_page = {}
    for e in images:
        by_page.setdefault(e['page'], []).append(e['bbox'])   # [left, top, width, height]
    os.makedirs(OUT, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='book3-pages-')
    try:
        subprocess.run(['pdftoppm', '-r', str(DPI), '-f', str(FIRST), '-l', str(LAST), '-png', PDF,
                        os.path.join(tmp, 'p')], check=True)
        pages = {}
        for f in os.listdir(tmp):
            if f.endswith('.png'):
                pages[int(f[2:-4])] = os.path.join(tmp, f)
        cache = {}

        def page_image(n):
            if n not in cache:
                cache[n] = Image.open(pages[n]).convert('L')
            return cache[n]

        for name, p in problems.items():
            strips = []
            for n in range(p['page'], p['end_page'] + 1):
                im = page_image(n)
                y0 = max(0, p['top'] - 10) if n == p['page'] else TEXT_TOP
                y1 = (p['end_top'] - 4) if n == p['end_page'] else TEXT_BOTTOM
                strip_end = y1
                for (_l, t, _w, h) in by_page.get(n, []):
                    if t < strip_end and t + h > y0:   # the bitmap overlaps the problem's own strip
                        y1 = max(y1, min(t + h + 8, TEXT_BOTTOM))
                if y1 - y0 < 12:
                    continue
                strips.append(im.crop((40, y0, im.width - 30, y1)))
            if not strips:
                continue
            h = sum(s.height for s in strips) + 6 * (len(strips) - 1)
            w = max(s.width for s in strips)
            out = Image.new('L', (w, h), 255)
            y = 0
            for i, s in enumerate(strips):
                if i:
                    ImageDraw.Draw(out).line([(0, y - 3), (w, y - 3)], fill=170, width=1)
                out.paste(s, (0, y))
                y += s.height + 6
            out.save(os.path.join(OUT, f'{name}.png'), optimize=True)
        print(f'  crops written: {len(os.listdir(OUT))} -> {OUT}')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
