#!/usr/bin/env python3
"""
build-fonts.py — the site's four type families as self-hosted, content-hashed WOFF2.

Why this exists. By September 2026 the site named 39 different font stacks: Roboto on 36
templates, the visitor's system font on 21, Inter on 7, an undeclared Lato on the editor, and
Latin Modern for solutions. A reader crossing from the homepage to a solution changed typeface
three times, weight 600 rendered as 700 because Roboto had no 600 file, and every italic was
synthesised. The typography unification replaces all of it with four roles:

  SS Text     New Computer Modern Book — the Computer Modern that Savchenko's 3rd edition is
              set in (with its Cyrillic), matching the server-rendered TeX formulas glyph for
              glyph. Statements, solutions, prose, knowledge-page titles, problem numbers.
  SS Sans     IBM Plex Sans — the interface.
  SS Mono     IBM Plex Mono — code, the citation block, the editor.
  SS Display  CMU Sans Serif Demi Condensed — the book's title-page face; wordmark and big titles.
  SS Wordmark the same face cut down to the glyphs of the two locale titles, small enough to preload.
  SS Symbols  a handful of symbols from New Computer Modern Math that Plex lacks (∗, ▶ …).

Inputs (nothing is fetched at runtime; the IBM archives are downloaded once by hand):
  --texlive DIR       TeX Live fonts root (default /usr/share/texlive/texmf-dist/fonts/opentype)
  --plex-sans-zip Z   ibm-plex-sans.zip from github.com/IBM/plex releases (@ibm/plex-sans@1.1.0)
  --plex-mono-zip Z   ibm-plex-mono.zip (@ibm/plex-mono@2.5.0)

Licensing, which decides how each family is cut:
  * IBM Plex is OFL with the Reserved Font Name "Plex". A subset is a modified version, which
    may not keep that name, so Plex is NOT subset here: IBM's own split WOFF2 files are copied
    byte for byte (only the file name gains a content hash) with IBM's unicode-ranges.
  * New Computer Modern is under the GUST Font License (LPPL): modified files must be renamed.
    Subsets get new file names, internal names "SS Text …", and a notice file.
  * CM Unicode is OFL without a reserved name; subsets are renamed anyway, with the licence.

Outputs:
  css/vendor/fonts/h/*.woff2 + LICENSE-*.txt   hashed files, served with a one-year immutable cache
  css/vendor/fonts/site-fonts.css              @font-face rules (relative url(h/…)) + fallback faces
  lib/siteFonts.json                           faces, ranges, bytes, preload lists

Re-run after changing a character set or a font; scripts/build-css.js inlines site-fonts.css
into css/bundle.css, and tests/site-fonts.test.js checks that the three outputs agree.
Needs fontTools with brotli (pip install --user fonttools brotli).
"""
import argparse
import hashlib
import io
import json
import os
import re
import sys
import zipfile

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'css', 'vendor', 'fonts', 'h')
CSS_OUT = os.path.join(ROOT, 'css', 'vendor', 'fonts', 'site-fonts.css')
JSON_OUT = os.path.join(ROOT, 'lib', 'siteFonts.json')
URL_PREFIX = '/css/vendor/fonts/h/'

# Our own subsets (New Computer Modern, CMU). Non-overlapping, in the order the browser should
# consider them. Digits and punctuation live in latin, so a Russian page always needs latin too.
RANGES = {
    'latin': 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, '
             'U+2000-206F, U+20AC, U+2122, U+2190-2199, U+2212, U+2215, U+2217, U+221E, U+2248, U+2260, U+2264-2265, U+FEFF, U+FFFD',
    # European names and Vietnamese; not IPA or the rarer extension blocks, which tripled the file.
    'latin-ext': 'U+0100-0130, U+0132-0151, U+0154-024F, U+0259, U+1E9E, U+1EA0-1EF9, U+20A0-20AB, U+20AD-20B3, U+20B5-20C0, U+2113',
    'cyrillic': 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116',
    'cyrillic-ext': 'U+0460-048F, U+0492-04AF, U+04B2-052F, U+1C80-1C88, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F',
    'greek': 'U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF',
}
# Deliberately not kept: smcp, c2sc, onum, frac, sups, subs — nothing on the site uses them, and
# small caps alone add a quarter to every subset (NewCM Book latin 35 KB → 28 KB without them).
LAYOUT_FEATURES = ['kern', 'liga', 'clig', 'calt', 'ccmp', 'locl', 'mark', 'mkmk', 'rlig', 'lnum', 'tnum', 'case']

NEWCM = [  # (source file, css style, css weight, key)
    ('public/newcomputermodern/NewCM10-Book.otf', 'normal', 400, '400'),
    ('public/newcomputermodern/NewCM10-BookItalic.otf', 'italic', 400, '400i'),
    ('public/newcomputermodern/NewCM10-Bold.otf', 'normal', 700, '700'),
    ('public/newcomputermodern/NewCM10-BoldItalic.otf', 'italic', 700, '700i'),
]
CMU_SSDC = 'public/cm-unicode/cmunssdc.otf'
NEWCM_MATH = 'public/newcomputermodern/NewCMMath-Book.otf'
# SS Symbols — the few symbols the site's text uses that IBM Plex lacks, cut from New Computer
# Modern Math so they match the formulas: Savchenko's ∗ above all (565 problems carry it, in the
# finder, the grids and the methodology), and the disclosure triangles of the section navigation.
# Without it those glyphs came from whatever the visitor's system had (Noto Sans Math, DejaVu).
# Every stack names SS Symbols second; its unicode-range is exactly these characters, so the file
# (a few KB) is only fetched by a page that shows one of them. Glyphs Plex has are dropped at
# build time, so the interface keeps Plex's own wherever it can.
SYMBOLS = '∗⋆★☆▶◀▸◂▾▴▲▼△▽◆◇■□●○∈∉∋∝∼≃≅≪≫⋅∘∇⊥∥∠⟨⟩⟶⟵⟹⇒⇐⇔↦'
PLEX_SANS = [('Regular', 'normal', 400, '400'), ('Italic', 'italic', 400, '400i'), ('SemiBold', 'normal', 600, '600')]
PLEX_MONO = [('Regular', 'normal', 400, '400')]
PLEX_SUBSETS = ['Latin1', 'Latin2', 'Latin3', 'Cyrillic', 'Greek', 'Pi']

GUST_NOTICE = """New Computer Modern (NewCM10 Book, BookItalic, Bold, BoldItalic)
(C) 2019-2020 Antonis Tsolomitis. Released under the GUST Font License, which is legally
equivalent to the LaTeX Project Public License 1.3c: http://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt

New Computer Modern Math (NewCMMath-Book), same author and licence.

The files named ss-text-*.woff2 and ss-symbols-*.woff2 in this directory are MODIFIED versions:
subsets for savchenkosolutions.com made by scripts/build-fonts.py, renamed (files and internal
names "SS Text", "SS Symbols") as the licence requires. The original fonts are in TeX Live's
newcomputermodern package.
"""


def parse_ranges(spec):
    out = set()
    for part in spec.split(','):
        part = part.strip().upper().replace('U+', '')
        if not part:
            continue
        if '-' in part:
            a, b = part.split('-')
            out.update(range(int(a, 16), int(b, 16) + 1))
        else:
            out.add(int(part, 16))
    return out


def hashed_name(stem, data):
    return f"{stem}.{hashlib.sha256(data).hexdigest()[:10]}.woff2"


def rename(font, family, style_name, ps):
    name = font['name']
    for rec in list(name.names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22):
            name.removeNames(nameID=rec.nameID)
    for nid, value in ((1, family), (2, style_name), (3, f"{ps};savchenkosolutions"), (4, f"{family} {style_name}"), (6, ps)):
        name.setName(value, nid, 3, 1, 0x409)
        name.setName(value, nid, 1, 0, 0)
    if 'CFF ' in font:
        cff = font['CFF '].cff
        cff.fontNames = [ps]
        top = cff.topDictIndex[0]
        for attr, val in (('FullName', f"{family} {style_name}"), ('FamilyName', family)):
            if hasattr(top, attr):
                setattr(top, attr, val)


def cut(src_path, codepoints, family, style_name, ps, license_text=None):
    # recalcTimestamp=False: the head table keeps the source date, so a rebuild with the same inputs
    # produces the same bytes and the same hashed names (a new name costs every reader a download).
    font = TTFont(src_path, recalcTimestamp=False)
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = LAYOUT_FEATURES
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.notdef_outline = True
    options.hinting = True
    options.glyph_names = False
    sub = subset.Subsetter(options)
    cmap = font.getBestCmap()
    wanted = sorted(cp for cp in codepoints if cp in cmap)
    if not wanted:
        return None, []
    sub.populate(unicodes=wanted)
    sub.subset(font)
    rename(font, family, style_name, ps)
    if license_text and not font['name'].getDebugName(13):
        font['name'].setName(license_text, 13, 3, 1, 0x409)
    buf = io.BytesIO()
    font.flavor = 'woff2'
    font.save(buf)
    return buf.getvalue(), wanted


def write_file(stem, data, produced):
    fname = hashed_name(stem, data)
    with open(os.path.join(OUT_DIR, fname), 'wb') as fh:
        fh.write(data)
    produced.add(fname)
    return fname


def plex_ranges(zf, prefix, style):
    css = zf.read(f"{prefix}/fonts/split/woff2/{style}.css").decode('utf-8')
    out = {}
    for block in re.findall(r'@font-face\s*\{(.*?)\}', css, re.S):
        m_file = re.search(r'url\("([^"]+\.woff2)"\)', block)
        m_range = re.search(r'unicode-range:\s*([^;}\n]+)', block)
        if m_file and m_range:
            out[m_file.group(1)] = m_range.group(1).strip()
    return out


def metrics(path):
    f = TTFont(path, lazy=True)
    upm = f['head'].unitsPerEm
    os2, hhea = f['OS/2'], f['hhea']
    # Weighted like the site's reading: about 70% of solution views are Russian.
    sample = ('Какую наибольшую разность потенциалов можно получить от источника тока, который имеет внутреннее '
              'сопротивление. Определите силу, действующую на вертикальную стенку со стороны клина, если на него '
              'положили груз массы. Угол при основании клина. Коэффициент трения между грузом и поверхностью клина. '
              'Determine the force acting on the vertical wall from the side of the wedge, if a weight of mass is '
              'placed on it. Angle at the base of the wedge 0123456789.')
    cmap, hmtx = f.getBestCmap(), f['hmtx']
    width = sum(hmtx[cmap[ord(c)]][0] for c in sample if ord(c) in cmap) / upm
    return {'xh': os2.sxHeight / upm, 'asc': hhea.ascent / upm, 'desc': -hhea.descent / upm, 'gap': hhea.lineGap / upm, 'width': width}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--texlive', default='/usr/share/texlive/texmf-dist/fonts/opentype')
    ap.add_argument('--plex-sans-zip', required=True)
    ap.add_argument('--plex-mono-zip', required=True)
    ap.add_argument('--locales', default=os.path.join(ROOT, 'locales'))
    args = ap.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    produced = set()
    faces = []

    # SS Text — New Computer Modern Book, our own subsets.
    for src, style, weight, key in NEWCM:
        path = os.path.join(args.texlive, src)
        style_name = {'400': 'Book', '400i': 'Book Italic', '700': 'Bold', '700i': 'Bold Italic'}[key]
        for sub_name, spec in RANGES.items():
            data, cps = cut(path, parse_ranges(spec), 'SS Text', style_name, f"SSText-{style_name.replace(' ', '')}",
                            'GUST Font License (LPPL 1.3c); modified subset, see LICENSE-NewCM.txt')
            if not data:
                continue
            fname = write_file(f"ss-text-{key}-{sub_name}", data, produced)
            faces.append({'family': 'SS Text', 'style': style, 'weight': weight, 'subset': sub_name,
                          'file': fname, 'bytes': len(data), 'unicodeRange': spec, 'glyphs': len(cps)})

    # SS Display — CMU Sans Serif Demi Condensed; registered at 600 so a UA-bold <h1> never fakes it.
    ssdc = os.path.join(args.texlive, CMU_SSDC)
    for sub_name in ('latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'):
        data, cps = cut(ssdc, parse_ranges(RANGES[sub_name]), 'SS Display', 'Demi Condensed', 'SSDisplay-DemiCondensed')
        if data:
            fname = write_file(f"ss-display-600-{sub_name}", data, produced)
            faces.append({'family': 'SS Display', 'style': 'normal', 'weight': 600, 'subset': sub_name,
                          'file': fname, 'bytes': len(data), 'unicodeRange': RANGES[sub_name], 'glyphs': len(cps)})

    # SS Wordmark — only the glyphs of the two locale titles, so the header can preload ~5 KB.
    titles = []
    for loc in ('en.json', 'ru.json'):
        with open(os.path.join(args.locales, loc), encoding='utf-8') as fh:
            titles.append(json.load(fh)['title'])
    chars = {ord(c) for c in ''.join(titles)} | {0x20}
    data, cps = cut(ssdc, chars, 'SS Wordmark', 'Demi Condensed', 'SSWordmark-DemiCondensed')
    wm_range = ', '.join(f"U+{cp:04X}" for cp in sorted(chars))
    fname = write_file('ss-wordmark-600', data, produced)
    faces.append({'family': 'SS Wordmark', 'style': 'normal', 'weight': 600, 'subset': 'titles',
                  'file': fname, 'bytes': len(data), 'unicodeRange': wm_range, 'glyphs': len(cps), 'titles': titles})

    # SS Symbols — see SYMBOLS above. One face registered across the whole weight range, so bold
    # text never gets a synthesised bold asterisk.
    with zipfile.ZipFile(args.plex_sans_zip) as zf:
        plex_cmap = set(TTFont(io.BytesIO(zf.read('ibm-plex-sans/fonts/complete/ttf/IBMPlexSans-Regular.ttf'))).getBestCmap())
    sym_cps = {ord(c) for c in SYMBOLS} - plex_cmap
    data, cps = cut(os.path.join(args.texlive, NEWCM_MATH), sym_cps, 'SS Symbols', 'Book', 'SSSymbols-Book',
                    'GUST Font License (LPPL 1.3c); modified subset, see LICENSE-NewCM.txt')
    fname = write_file('ss-symbols-400', data, produced)
    faces.append({'family': 'SS Symbols', 'style': 'normal', 'weight': '100 900', 'subset': 'symbols',
                  'file': fname, 'bytes': len(data), 'unicodeRange': ', '.join(f"U+{cp:04X}" for cp in cps), 'glyphs': len(cps)})

    # SS Sans / SS Mono — IBM's own split files, unmodified (OFL Reserved Font Name "Plex").
    for zpath, prefix, fam, styles, stem in ((args.plex_sans_zip, 'ibm-plex-sans', 'SS Sans', PLEX_SANS, 'IBMPlexSans'),
                                             (args.plex_mono_zip, 'ibm-plex-mono', 'SS Mono', PLEX_MONO, 'IBMPlexMono')):
        with zipfile.ZipFile(zpath) as zf:
            lic = zf.read(f"{prefix}/LICENSE.txt")
            with open(os.path.join(OUT_DIR, f"LICENSE-{stem}-OFL.txt"), 'wb') as fh:
                fh.write(lic)
            produced.add(f"LICENSE-{stem}-OFL.txt")
            for style_file, style, weight, key in styles:
                ranges = plex_ranges(zf, prefix, f"{stem}-{style_file}")
                for sub_name in PLEX_SUBSETS:
                    member = f"{stem}-{style_file}-{sub_name}.woff2"
                    if member not in ranges:
                        continue
                    data = zf.read(f"{prefix}/fonts/split/woff2/{member}")
                    short = 'sans' if fam == 'SS Sans' else 'mono'
                    fname = write_file(f"ss-{short}-{key}-{sub_name.lower()}", data, produced)
                    faces.append({'family': fam, 'style': style, 'weight': weight, 'subset': sub_name.lower(),
                                  'file': fname, 'bytes': len(data), 'unicodeRange': ranges[member], 'source': member})

    with open(os.path.join(OUT_DIR, 'LICENSE-NewCM.txt'), 'w', encoding='utf-8') as fh:
        fh.write(GUST_NOTICE)
    produced.add('LICENSE-NewCM.txt')
    cmu_notice = os.path.join(ROOT, 'css', 'vendor', 'fonts', 'files', 'cmu-OFL.txt')
    with open(cmu_notice, encoding='utf-8') as fh:
        notice = fh.read()
    with open(os.path.join(OUT_DIR, 'LICENSE-CMU-OFL.txt'), 'w', encoding='utf-8') as fh:
        fh.write('CMU Sans Serif Demi Condensed, subset and renamed "SS Display" / "SS Wordmark" for savchenkosolutions.com\n'
                 'by scripts/build-fonts.py.\n\n' + notice)
    produced.add('LICENSE-CMU-OFL.txt')

    # Remove stale hashed files from earlier builds.
    for f in os.listdir(OUT_DIR):
        if f not in produced:
            os.remove(os.path.join(OUT_DIR, f))

    # Fallback faces: a local system font scaled so the swap moves as little as possible. Metrics
    # come from the metric-compatible Liberation fonts (same advance widths as Times New Roman,
    # Arial and Courier New). All of them match average width, because what shifts on swap is the
    # line breaks. The serif once matched x-height instead (formulas are sized in ex), but Times at
    # that size set 7% more text per line than NewCM, and solution pages shifted by 0.11–0.33 CLS
    # when the font arrived 0.4 s late; matched by width they shift by 0.005–0.013, and formulas
    # being a little larger during the swap moves nothing measurable.
    lib = '/usr/share/fonts/truetype/liberation'
    ssdc = os.path.join(args.texlive, CMU_SSDC)
    newcm_m = metrics(os.path.join(args.texlive, NEWCM[0][0]))
    newcm_bold_m = metrics(os.path.join(args.texlive, NEWCM[2][0]))
    ssdc_m = metrics(ssdc)
    with zipfile.ZipFile(args.plex_sans_zip) as zf:
        plex_m = metrics(io.BytesIO(zf.read('ibm-plex-sans/fonts/complete/ttf/IBMPlexSans-Regular.ttf')))
        plex_semi_m = metrics(io.BytesIO(zf.read('ibm-plex-sans/fonts/complete/ttf/IBMPlexSans-SemiBold.ttf')))
    serif_m = metrics(os.path.join(lib, 'LiberationSerif-Regular.ttf'))
    serif_bold_m = metrics(os.path.join(lib, 'LiberationSerif-Bold.ttf'))
    sans_m = metrics(os.path.join(lib, 'LiberationSans-Regular.ttf'))
    sans_bold_m = metrics(os.path.join(lib, 'LiberationSans-Bold.ttf'))
    narrow = os.path.join(lib, 'LiberationSansNarrow-Regular.ttf')
    narrow_m = metrics(narrow) if os.path.exists(narrow) else sans_m

    def fallback(name, weight, locals_, target, base):
        adj = target['width'] / base['width']
        return {'family': name, 'weight': weight, 'local': locals_, 'sizeAdjust': round(adj * 100, 1),
                'ascent': round(target['asc'] / adj * 100, 1), 'descent': round(target['desc'] / adj * 100, 1), 'lineGap': 0}
    # The bold cuts get their own fallback: CM Bold is 10% wider than CM Book, and the problem
    # number and title (bold) reflowed the whole statement when only the regular face was matched.
    fallbacks = [
        fallback('SS Text Fallback', 400, ['Times New Roman', 'TimesNewRomanPSMT', 'Liberation Serif', 'Tinos'], newcm_m, serif_m),
        fallback('SS Text Fallback', 700, ['Times New Roman Bold', 'TimesNewRomanPS-BoldMT', 'Liberation Serif Bold', 'Tinos Bold'], newcm_bold_m, serif_bold_m),
        fallback('SS Sans Fallback', 400, ['Arial', 'ArialMT', 'Liberation Sans', 'Arimo', 'Helvetica'], plex_m, sans_m),
        fallback('SS Sans Fallback', 600, ['Arial Bold', 'Arial-BoldMT', 'Liberation Sans Bold', 'Arimo Bold', 'Helvetica Bold'], plex_semi_m, sans_bold_m),
        fallback('SS Display Fallback', 600, ['Arial Narrow', 'ArialNarrow', 'Liberation Sans Narrow'], ssdc_m, narrow_m),
        {'family': 'SS Mono Fallback', 'weight': 400, 'local': ['Courier New', 'CourierNewPSMT', 'Liberation Mono', 'Cousine'],
         'sizeAdjust': 100.0, 'ascent': round(1.025 * 100, 1), 'descent': round(0.275 * 100, 1), 'lineGap': 0},
    ]

    def url(file):
        return URL_PREFIX + file
    by = {(f['family'], f['weight'], f['style'], f['subset']): f for f in faces}
    preload = {
        'ru': [url(by[('SS Sans', 400, 'normal', 'latin1')]['file']), url(by[('SS Sans', 400, 'normal', 'cyrillic')]['file']),
               url(by[('SS Wordmark', 600, 'normal', 'titles')]['file'])],
        'en': [url(by[('SS Sans', 400, 'normal', 'latin1')]['file']), url(by[('SS Wordmark', 600, 'normal', 'titles')]['file'])],
        'proseRu': [url(by[('SS Text', 400, 'normal', 'latin')]['file']), url(by[('SS Text', 400, 'normal', 'cyrillic')]['file'])],
        'proseEn': [url(by[('SS Text', 400, 'normal', 'latin')]['file'])],
    }

    lines = ['/* Generated by scripts/build-fonts.py — do not edit. Four families (SS Text, SS Sans, SS Mono,',
             '   SS Display) plus the wordmark and symbol subsets and size-adjusted local fallbacks. Files are content-hashed',
             '   and served with a one-year immutable cache; licences are in h/LICENSE-*.txt. */']
    for f in faces:
        lines.append('@font-face {')
        lines.append(f"  font-family: '{f['family']}';")
        lines.append(f"  font-style: {f['style']};")
        lines.append(f"  font-weight: {f['weight']};")
        lines.append('  font-display: swap;')
        lines.append(f"  src: url(h/{f['file']}) format('woff2');")
        lines.append(f"  unicode-range: {f['unicodeRange']};")
        lines.append('}')
    for fb in fallbacks:
        srcs = ', '.join(f"local('{n}')" for n in fb['local'])
        for style in ('normal', 'italic'):
            lines.append('@font-face {')
            lines.append(f"  font-family: '{fb['family']}';")
            lines.append(f"  font-style: {style};")
            lines.append(f"  font-weight: {fb['weight']};")
            lines.append(f"  src: {srcs};")
            lines.append(f"  size-adjust: {fb['sizeAdjust']}%;")
            lines.append(f"  ascent-override: {fb['ascent']}%;")
            lines.append(f"  descent-override: {fb['descent']}%;")
            lines.append('  line-gap-override: 0%;')
            lines.append('}')
    with open(CSS_OUT, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines) + '\n')

    manifest = {'generatedBy': 'scripts/build-fonts.py', 'urlPrefix': URL_PREFIX, 'faces': faces,
                'fallbacks': fallbacks, 'preload': preload,
                'totalBytes': sum(f['bytes'] for f in faces)}
    with open(JSON_OUT, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    fams = {}
    for f in faces:
        fams.setdefault(f['family'], 0)
        fams[f['family']] += f['bytes']
    print(f"{len(faces)} faces, {manifest['totalBytes'] // 1024} KB total: " + ', '.join(f"{k} {v // 1024} KB" for k, v in fams.items()))
    print('fallbacks:', ', '.join(f"{fb['family']} {fb['weight']} {fb['sizeAdjust']}%" for fb in fallbacks))


if __name__ == '__main__':
    main()
