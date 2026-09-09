#!/usr/bin/env python3
"""Extract every problem statement and every figure from the 3rd edition (pdf/savchenko.pdf).

    python3 scripts/book3/extract.py [--work DIR]

This edition is a pdfTeX file, not a scan: the text layer is exact, and every figure is a
300 dpi bitmap with its caption ("К задаче 1.4.4") drawn inside the bitmap. Both facts are
load-bearing. The text layer means a statement can be checked against the book word for
word; the captions mean a figure can be attributed by reading it rather than by guessing
from its position on the page.

Why not pdftotext: statements wrap around inset figures, and a problem number in prose
("решите задачу 5.8.3") is indistinguishable from a header in plain text. pdftohtml -xml
keeps fonts and positions, so a header is "a bold (CMBX10) run that looks like N.N.N",
the ♦ has-figure mark is a CMSY10 run on the same line, the ∗ star is a superscript run,
and page numbers are the CMR8 run at the foot of the page.

Outputs, under --work (default src/database/book3):
    problems.json    {"1.4.1": {"text", "starred", "has_figure", "page", "fig_items"}, ...}
    images.json      one entry per bitmap: page, index, bbox, file, and the ♦ items that
                     sit on that page (candidates for the caption reader to confirm)
    images/*.png     the bitmaps, polarity corrected (pdfimages emits them inverted)
"""
import argparse
import html
import json
import os
import re
import subprocess
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PDF = os.path.join(ROOT, 'pdf', 'savchenko.pdf')
FIRST, LAST = 9, 279          # the problems part; answers begin on 280

NUM = re.compile(r'^(\d{1,2})\.(\d{1,2})\.(\d{1,3})\.?$')
SUB = re.compile(r'^[абвгде]$')


def valid_problems():
    out = []
    with open(os.path.join(ROOT, 'src', 'database', 'sections.csv'), encoding='utf-8-sig') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            ref, _title, maximum = line.rsplit(',', 2)
            for i in range(1, int(maximum) + 1):
                out.append(f'{ref}.{i}')
    return out


def run(cmd):
    return subprocess.run(cmd, capture_output=True, check=True).stdout


def parse_xml(xml):
    """pdftohtml -xml is regular enough to parse with regexes; a real XML parser chokes on
    the stray <b>/<i> it sometimes leaves unclosed."""
    fonts = {}
    for m in re.finditer(r'<fontspec id="(\d+)" size="(\d+)" family="([^"]+)"', xml):
        fonts[m.group(1)] = (m.group(3).split('+')[-1], int(m.group(2)))
    pages = []
    for pm in re.finditer(r'<page number="(\d+)"[^>]*height="(\d+)" width="(\d+)">(.*?)</page>', xml, re.S):
        page = {'n': int(pm.group(1)), 'h': int(pm.group(2)), 'w': int(pm.group(3)), 'texts': [], 'images': []}
        body = pm.group(4)
        for im in re.finditer(r'<image top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)"', body):
            page['images'].append({'top': int(im.group(1)), 'left': int(im.group(2)),
                                   'width': int(im.group(3)), 'height': int(im.group(4))})
        for tm in re.finditer(r'<text top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)" font="(\d+)">(.*?)</text>', body, re.S):
            txt = html.unescape(re.sub(r'<[^>]+>', '', tm.group(6)))
            fam, size = fonts.get(tm.group(5), ('?', 0))
            txt = symbol_glyph(fam, txt)
            page['texts'].append({'top': int(tm.group(1)), 'left': int(tm.group(2)), 'width': int(tm.group(3)),
                                  'height': int(tm.group(4)), 'font': fam, 'size': size, 'text': txt})
        pages.append(page)
    return pages


# The text layer names some symbol-font glyphs by their ASCII slot rather than by meaning:
# in CMSY a superscript "0" is a prime, "6" (followed by a CMR "=") is ≠, "k" is ∥; in
# CMEX "p" and "r" are radical signs. Left as digits and letters they would be checked as
# digits and letters, and a model that typesets them correctly would be rejected.
SYMBOL_GLYPHS = {
    ('CMSY', '0'): '′', ('CMSY', '00'): '″', ('CMSY', '6'): '≠', ('CMSY', 'k'): '∥',
    ('CMEX', 'p'): '√', ('CMEX', 'r'): '√',
}


def symbol_glyph(fam, txt):
    key = ('CMSY' if fam.startswith(('CMSY', 'CMBSY')) else 'CMEX' if fam.startswith('CMEX') else fam, txt.strip())
    return SYMBOL_GLYPHS.get(key, txt)


def lines_of(page):
    """Group runs into lines in reading order.

    Base-size runs (the 10pt text, size 15 in pdftohtml units) define the lines. Sub- and
    superscript runs are set in 7pt (size 10) and sit 3-5 units above or below the base
    line, so grouping purely by `top` split every index off its symbol ("t > t > t ... A B C"
    for t_A > t_B > t_C). Small runs are instead attached to whichever base line they
    overlap vertically, and land back inline once the line is sorted by `left`.

    Lines made only of small runs are footnotes ("∗) Условным знаком ...") and are dropped,
    as is anything at the foot of the page: the page number and the printer's signature
    mark ("5∗") both sit below 885.
    """
    runs = [r for r in page['texts'] if r['top'] <= 885 and r['text'].strip()]
    # Accents (the ~ of a vector, a bar, a dot) are full-size runs set a few units above
    # their letter; letting them found a line of their own is what stole 14.3.7's ∗.
    ACCENT = {'~', '¯', '˙', 'ˆ', '˜', '→', '→'}
    base = sorted([r for r in runs if r['size'] >= 13 and r['text'].strip() not in ACCENT], key=lambda t: (t['top'], t['left']))
    small = [r for r in runs if r['size'] < 13 or r['text'].strip() in ACCENT]
    lines = []
    for r in base:
        if lines and abs(r['top'] - lines[-1]['top']) <= 3:
            lines[-1]['runs'].append(r)
        else:
            lines.append({'top': r['top'], 'bottom': r['top'] + r['height'], 'runs': [r]})
    dropped = []
    for r in small:
        mid = r['top'] + r['height'] / 2
        best, best_d = None, 1e9
        for ln in lines:
            # inside the line's vertical extent, with a little slack for superscripts
            if ln['top'] - 6 <= mid <= ln['bottom'] + 4:
                # A superscript sits ~3 units above its base line's top, a subscript ~4
                # below; the neighbouring lines are 15 away. Nearest top wins — a centre
                # distance let 14.3.7's ∗ drift onto the line above.
                d = abs(ln['top'] - r['top'])
                if d < best_d:
                    best, best_d = ln, d
        if best is not None:
            best['runs'].append(r)
        else:
            dropped.append(r)
    for ln in lines:
        ln['runs'].sort(key=lambda t: t['left'])
    page['_dropped_small'] = dropped
    return lines


def line_text(runs):
    out = ''
    prev_end = None
    runs = [r for i, r in enumerate(runs) if not (r['text'].strip() == '=' and i and runs[i - 1]['text'].strip() == '≠')]
    for r in runs:
        gap = None if prev_end is None else r['left'] - prev_end
        # A superscript ∗ or a subscript index sits tight against its base.
        if prev_end is not None and gap > 2:
            out += ' '
        out += r['text']
        prev_end = r['left'] + r['width']
    return out.strip()


HEADING_FONTS = {'cmccsc10', 'cmcbx12', 'CMBSY10', 'cmcbx10', 'CMBX12'}


def is_section_heading(runs):
    """Chapter titles and "§ 1.4. ..." lines. A problem header line is never all bold."""
    fams = {r['font'] for r in runs}
    if any(r['text'].strip() == '§' for r in runs):
        return True
    if fams and fams <= HEADING_FONTS | {'CMR10', 'CMR8'}:
        joined = line_text(runs)
        return not NUM.match(joined.split()[0]) if joined else True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', default=os.path.join(ROOT, 'src', 'database', 'book3'))
    args = ap.parse_args()
    work = args.work
    imgdir = os.path.join(work, 'images')
    os.makedirs(imgdir, exist_ok=True)

    # pdftohtml writes every page image next to its output even in -xml mode (and -i,
    # which suppresses them, also drops the <image> elements the mapping needs), so it
    # is pointed at a scratch directory rather than left to litter pdf/.
    import shutil
    import tempfile
    tmpdir = tempfile.mkdtemp(prefix='book3-xml-')
    try:
        run(['pdftohtml', '-xml', '-f', str(FIRST), '-l', str(LAST), PDF, os.path.join(tmpdir, 'book')])
        xml = open(os.path.join(tmpdir, 'book.xml'), encoding='utf-8', errors='replace').read()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    pages = parse_xml(xml)
    valid = valid_problems()
    valid_set = set(valid)

    problems = {}
    order = []
    current = None
    images = []
    stats = defaultdict(int)

    for page in pages:
        lines = lines_of(page)
        diamond_items = []   # (top, key) — key is a problem name or "name/б"
        for ln in lines:
            runs = ln['runs']
            texts = [r['text'].strip() for r in runs]
            has_diamond = any(t == '♦' for t in texts) and runs[0]['text'].strip() == '♦'
            body_runs = [r for r in runs if r['text'].strip() != '♦']
            if not body_runs:
                # a lone ♦ whose number sits on the next line (happens once, 2.8.19)
                if has_diamond:
                    diamond_items.append((ln['top'], None))
                continue
            first = body_runs[0]
            head = NUM.match(first['text'].strip())
            if head and first['font'] == 'CMBX10':
                name = f'{head.group(1)}.{head.group(2)}.{head.group(3)}'
                if name not in valid_set:
                    stats['header_not_in_csv'] += 1
                    print(f'  ! header {name} on page {page["n"]} is not a valid problem number', file=sys.stderr)
                elif name in problems:
                    stats['duplicate_header'] += 1
                    print(f'  ! duplicate header {name} on page {page["n"]}', file=sys.stderr)
                else:
                    # ∗ right after the number, before the period: "1.4.6" "∗" "."
                    starred = False
                    rest = body_runs[1:]
                    while rest and rest[0]['text'].strip() in ('∗', '*', '.'):
                        if rest[0]['text'].strip() in ('∗', '*'):
                            starred = True
                        rest = rest[1:]
                    pending_diamond = has_diamond or (diamond_items and diamond_items[-1][1] is None)
                    if diamond_items and diamond_items[-1][1] is None:
                        diamond_items[-1] = (diamond_items[-1][0], name)
                    elif has_diamond:
                        diamond_items.append((ln['top'], name))
                    current = name
                    order.append(name)
                    problems[name] = {'text_lines': [(line_text(rest), False)], 'starred': starred,
                                      'has_figure': bool(pending_diamond), 'page': page['n'], 'top': ln['top'],
                                      'fig_items': []}
                    if pending_diamond:
                        problems[name]['fig_items'].append('main')
                    continue
            if is_section_heading(runs):
                continue
            if current is None:
                continue
            txt = line_text(body_runs)
            if has_diamond:
                # "♦ б." — a lettered part with its own figure
                sub = SUB.match(texts[1]) if len(texts) > 1 else None
                key = f'{current}/{texts[1]}' if sub else f'{current}/?'
                diamond_items.append((ln['top'], key))
                problems[current]['has_figure'] = True
                problems[current]['fig_items'].append(texts[1] if sub else '?')
            col_left = 78 if page['n'] % 2 else 65
            col_right = col_left + 553
            l, r = body_runs[0]['left'], body_runs[-1]['left'] + body_runs[-1]['width']
            centered = abs((l + r) / 2 - (col_left + col_right) / 2) < 40 and r < col_right - 25 and l > col_left + 25
            problems[current]['text_lines'].append((txt, centered))

        for i, im in enumerate(page['images']):
            images.append({'page': page['n'], 'index': i, 'bbox': [im['left'], im['top'], im['width'], im['height']],
                           'diamond_items_on_page': [k for _, k in diamond_items]})

    # ── the bitmaps ──────────────────────────────────────────────────────────────────
    # pdfimages numbers images globally; with -p the page is in the name too. Its order
    # within a page is content-stream order, the same order pdftohtml lists them in.
    tmp = os.path.join(work, '_raw')
    os.makedirs(tmp, exist_ok=True)
    for f in os.listdir(tmp):
        os.remove(os.path.join(tmp, f))
    run(['pdfimages', '-png', '-p', '-f', str(FIRST), '-l', str(LAST), PDF, os.path.join(tmp, 'im')])
    raw = sorted(os.listdir(tmp))
    by_page = defaultdict(list)
    for f in raw:
        m = re.match(r'im-(\d+)-(\d+)\.png', f)
        if m:
            by_page[int(m.group(1))].append(f)
    from PIL import Image, ImageOps
    for entry in images:
        files = by_page.get(entry['page'], [])
        if entry['index'] >= len(files):
            print(f'  ! page {entry["page"]}: xml lists image {entry["index"]} but pdfimages gave {len(files)}', file=sys.stderr)
            stats['image_count_mismatch'] += 1
            continue
        src = os.path.join(tmp, files[entry['index']])
        im = Image.open(src).convert('L')
        # Stencil masks come out white-on-black; the book is black-on-white.
        if sum(im.getdata()) / (im.width * im.height) < 128:
            im = ImageOps.invert(im)
        entry['file'] = f'p{entry["page"]:03d}-{entry["index"]}.png'
        entry['px'] = [im.width, im.height]
        im.save(os.path.join(imgdir, entry['file']), optimize=True)
    for f in os.listdir(tmp):
        os.remove(os.path.join(tmp, f))
    os.rmdir(tmp)

    # ── text assembly ────────────────────────────────────────────────────────────────
    # A line that ends in a hyphen was broken by TeX; join it to the next without a space.
    # Every other line break is a column edge, not a sentence edge — except lettered parts
    # (а. б. в.) and displayed equations, which the book sets on their own line, and the
    # line of prose that resumes after a displayed equation.
    ITEM = re.compile(r'^[абвгде][∗*]?\.\s')
    for name, p in problems.items():
        lines = [l for l in p.pop('text_lines') if l[0]]
        out, kinds = [], []
        for txt, centered in lines:
            kind = 'item' if ITEM.match(txt) else ('display' if is_display_line(txt, centered) else 'text')
            if out and kinds[-1] in ('text', 'item') and kind == 'text' and out[-1].endswith('-') and re.match(r'^[а-яё]', txt):
                out[-1] = out[-1][:-1] + txt
            elif out and kinds[-1] in ('text', 'item') and kind == 'text':
                out[-1] = out[-1] + ' ' + txt
            else:
                out.append(txt)
                kinds.append(kind)
        text = '\n'.join(out).strip()
        # The book's TeX types a few units in Latin letters that look identical to the
        # Cyrillic ones: "1 c" for a second, "400 H" for newtons, "300 K" for kelvin (28
        # times). A typesetting model quietly corrects them and then fails the word-for-word
        # check, so they are corrected here, once, where it is visible. Only after a number,
        # only these three letters, and never when a digit follows (a formula's index).
        text = re.sub(r'(?<=\d) (c|H|K)(?=[,.;:)»?!]|\s+[^\d\s]|$)',
                      lambda m: ' ' + {'c': 'с', 'H': 'Н', 'K': 'К'}[m.group(1)], text)
        p['text'] = text

    # Where each problem ends on the page: the next problem's header, or the foot of the
    # last page it occupies. scripts/book3/preview-crops.py cuts the page images with this.
    for a, b in zip(order, order[1:]):
        problems[a]['end_page'], problems[a]['end_top'] = problems[b]['page'], problems[b]['top']
    if order:
        problems[order[-1]]['end_page'], problems[order[-1]]['end_top'] = problems[order[-1]]['page'], 885

    missing = [n for n in valid if n not in problems]
    ordered = {n: problems[n] for n in valid if n in problems}
    with open(os.path.join(work, 'problems.json'), 'w', encoding='utf-8') as fh:
        json.dump(ordered, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(work, 'images.json'), 'w', encoding='utf-8') as fh:
        json.dump(images, fh, ensure_ascii=False, indent=1)

    print(f'  problems extracted : {len(problems)} of {len(valid)}')
    print(f'  starred (∗)        : {sum(1 for p in problems.values() if p["starred"])}')
    print(f'  with figure (♦)    : {sum(1 for p in problems.values() if p["has_figure"])}')
    print(f'  figure items       : {sum(len(p["fig_items"]) for p in problems.values())}')
    print(f'  bitmaps            : {len(images)}')
    if missing:
        print(f'  MISSING {len(missing)}: {missing[:20]}')
    if stats:
        print(f'  anomalies          : {dict(stats)}')
    print(f'  -> {work}/problems.json, images.json, images/')


def is_display_line(l, centered):
    """A displayed equation: set on its own centred line, mostly symbols, few Cyrillic words."""
    words = re.findall(r'[а-яА-ЯёЁ]{2,}', l)
    return centered and len(words) <= 3


if __name__ == '__main__':
    main()
