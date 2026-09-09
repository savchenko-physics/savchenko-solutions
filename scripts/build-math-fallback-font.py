#!/usr/bin/env python3
"""
build-math-fallback-font.py — web-font subsets and a metrics table for the glyphs that
MathJax's TeX font does not have.

Why this exists. Solution pages and problem statements render their LaTeX to SVG on the
server (mathRender.js). MathJax's TeX font has no Cyrillic, and units and subscripts sit
inside the maths in nearly every Russian solution (`$10\\,кОм$`, `$v_{ср}$`), so those
letters are emitted as SVG <text> in a fallback font. In a browser MathJax measures that
text; on the server the lite adaptor can only guess 0.6 em per character, in whatever serif
the visitor happens to have. Wide fonts (DejaVu Serif on Linux) overflowed the guessed box,
and on a page without MathJax's stylesheet the overflow was clipped: 8.3.3's "10 кОм" lost
half of its "м" on /ru/upload (2026-09-02).

The fix is to stop guessing. The fallback is pinned to a self-hosted Computer Modern
Unicode (CMU Serif) — the same design as MathJax's TeX font, whose Latin advance widths it
matches to the unit — and measured from that font's own advance widths, so the Cyrillic
comes out in the typeface of the book itself, spaced exactly.

Input: the four CMU Serif faces from TeX Live's cm-unicode package (or --src DIR).
Output:
  css/vendor/fonts/files/cmun{rm,ti,bx,bi}-math.woff2   the subsets (Cyrillic block plus
                                                         the few other symbols site maths
                                                         falls back for: µ ² ³ ¹ № ‰ «»)
  css/vendor/fonts/files/cmu-OFL.txt                     their licence (SIL OFL 1.1)
  lib/mathFallbackFont.json                              family, files, unicode-range, and
                                                         per-code-point advance widths (em)

mathRender.js reads the JSON: it sets the family on every fallback <text>, sizes it 1:1 with
the TeX glyphs, takes widths from the table, and emits the @font-face rules into
/css/mathjax.css. Re-run only to change the character set or the font. Needs fontTools with
brotli (pip install --user fonttools brotli).
"""
import argparse
import json
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXLIVE = '/usr/share/texlive/texmf-dist/fonts/opentype/public/cm-unicode'
FONT_DIR = os.path.join(ROOT, 'css', 'vendor', 'fonts', 'files')
TABLE = os.path.join(ROOT, 'lib', 'mathFallbackFont.json')
FAMILY = 'CMU Serif'

# MathJax variant → (source face, css font-style, css font-weight, output file).
STYLES = {
    'normal':      ('cmunrm.otf', 'normal', 400, 'cmunrm-math.woff2'),
    'italic':      ('cmunti.otf', 'italic', 400, 'cmunti-math.woff2'),
    'bold':        ('cmunbx.otf', 'normal', 700, 'cmunbx-math.woff2'),
    'bold-italic': ('cmunbi.otf', 'italic', 700, 'cmunbi-math.woff2'),
}

# The Cyrillic block, and the handful of other characters that actually reach the fallback
# in site maths (inventoried by rendering every post and statement): µ ² ³ ¹, the Unicode
# super/subscripts, № ‰ and guillemets. Latin, Greek and digits are in the TeX font already
# and never reach the fallback, so they are not shipped.
WANTED = (
    set(range(0x0400, 0x0500))
    | {0x00AB, 0x00B2, 0x00B3, 0x00B5, 0x00B9, 0x00BB, 0x2030, 0x2116}
    | set(range(0x2070, 0x20A0))
)
# Without every one of these the table is useless; refuse to write a partial one.
REQUIRED = set(range(0x0410, 0x0450)) | {0x0401, 0x0451}

# The licence text is name ID 13 of the fonts themselves (TeX Live ships no OFL.txt), so it
# is copied from there, together with the notice the OFL asks to keep with the fonts.
OFL_NOTE = (
    'Computer Modern Unicode (CMU Serif) 0.7.0 by Andrey V. Panov, subset for\n'
    'savchenkosolutions.com by scripts/build-math-fallback-font.py.\n'
    'Some glyphs are copied from Blue Sky fonts released by AMS.\n\n'
)


def unicode_range(codepoints):
    """Compress a sorted set of code points into a CSS unicode-range value."""
    cps = sorted(codepoints)
    out, start, prev = [], cps[0], cps[0]
    for cp in cps[1:] + [None]:
        if cp is not None and cp == prev + 1:
            prev = cp
            continue
        out.append(f'U+{start:04X}' if start == prev else f'U+{start:04X}-{prev:04X}')
        if cp is not None:
            start = prev = cp
    return ', '.join(out)


def subset_font(src, wanted):
    font = TTFont(src)
    opts = subset.Options()
    opts.flavor = 'woff2'
    # Every fallback glyph is placed in its own <text>, so kerning and ligatures can never
    # apply; hints are dropped too. The credits and licence name records stay.
    opts.layout_features = []
    opts.drop_tables += ['GSUB', 'GPOS', 'GDEF', 'kern']
    opts.hinting = False
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14]
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=sorted(wanted))
    sub.subset(font)
    font.flavor = 'woff2'
    return font


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--src', default=TEXLIVE, help='directory with cmunrm/ti/bx/bi.otf')
    args = ap.parse_args()

    faces = {}
    for variant, (src_name, css_style, weight, out_name) in STYLES.items():
        src = os.path.join(args.src, src_name)
        if not os.path.exists(src):
            sys.exit(f'{src} not found — install TeX Live\'s cm-unicode or pass --src')
        font = subset_font(src, WANTED)
        cmap = font.getBestCmap()
        upem = font['head'].unitsPerEm
        hmtx = font['hmtx']
        widths = {cp: hmtx[name][0] / upem for cp, name in cmap.items()}
        missing = REQUIRED - set(widths)
        if missing:
            sys.exit(f'{src_name} lacks {[hex(c) for c in sorted(missing)]}')
        faces[variant] = (font, css_style, weight, out_name, widths)

    # One unicode-range for all four faces, so a bold letter never falls to a different
    # font than its regular neighbour.
    common = set.intersection(*(set(f[4]) for f in faces.values()))
    dropped = WANTED - common
    if dropped:
        print(f'not in every face, left out: {[hex(c) for c in sorted(dropped)]}')

    os.makedirs(FONT_DIR, exist_ok=True)
    table = {
        'family': FAMILY,
        'source': 'Computer Modern Unicode 0.7.0 (TeX Live cm-unicode), SIL OFL 1.1 — see cmu-OFL.txt',
        'builtBy': 'scripts/build-math-fallback-font.py',
        # px of the SVG's 1000-unit em at which the glyphs are 1:1 with MathJax's TeX font.
        'size': 1000,
        'unicodeRange': unicode_range(common),
        'styles': {},
    }
    licence = None
    for variant, (font, css_style, weight, out_name, widths) in faces.items():
        out = os.path.join(FONT_DIR, out_name)
        font.save(out)
        table['styles'][variant] = {
            'file': out_name,
            'style': css_style,
            'weight': weight,
            'widths': {str(cp): round(widths[cp], 4) for cp in sorted(common)},
        }
        if licence is None:
            for rec in font['name'].names:
                if rec.nameID == 13:
                    licence = str(rec)
        print(f'{out_name}: {len(common)} glyphs, {os.path.getsize(out) // 1024} KB')

    with open(os.path.join(FONT_DIR, 'cmu-OFL.txt'), 'w', encoding='utf-8') as fh:
        fh.write(OFL_NOTE + (licence or '') + '\n')
    with open(TABLE, 'w', encoding='utf-8') as fh:
        json.dump(table, fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    print(f'wrote {os.path.relpath(TABLE, ROOT)}: {table["unicodeRange"]}')

    # Sanity check against MathJax's TeX font (a .5, c .444, m .833 em): the two must agree
    # or the fallback would be visibly the wrong size next to Latin letters.
    roman = TTFont(os.path.join(args.src, 'cmunrm.otf'))
    cmap, hmtx, upem = roman.getBestCmap(), roman['hmtx'], roman['head'].unitsPerEm
    for ch, mj in (('a', .5), ('c', .444), ('m', .833)):
        w = hmtx[cmap[ord(ch)]][0] / upem
        assert abs(w - mj) < 0.002, f'CMU {ch} = {w} but MathJax has {mj}'
    print('Latin widths agree with MathJax\'s TeX font: size 1000 is 1:1')


if __name__ == '__main__':
    main()
