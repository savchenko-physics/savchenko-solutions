#!/usr/bin/env python3
"""Font Awesome, only the glyphs the solution page uses.

The solution page (the most visited page of the site) loaded Font Awesome whole for twenty
icons: 23 KB of CSS and a 150 KB font, 173 KB against a 46 KB page, and the font arrived last
because the CSS had to be parsed first (2026-09-19). This writes a font with just those
glyphs (about 3 KB) and a stylesheet with just their rules, both under css/vendor/fontawesome6/,
which views/default/site_styles.ejs serves for `icons: 'fa6-subset'`.

    python3 scripts/build-fa-subset.py

Reads every `fa-<name>` class in the templates listed in TEMPLATES (and their scripts in JS),
looks each up in all.min.css, subsets fa-solid-900.woff2 with pyftsubset (fonttools) and
writes subset.css + fa-solid-900-subset.woff2. Re-run after adding an icon to one of those
templates; tests/site-styles.test.js checks the stylesheet covers what the templates use.
Reproducible: the same inputs give the same files.
"""
import re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FA = ROOT / 'css/vendor/fontawesome6'
TEMPLATES = [
    'views/solution_post.ejs',
    'views/default/main_site_header.ejs',
    'views/default/modern_footer.ejs',
]
JS = ['js/reactions.js', 'js/apps/launcher.js', 'js/tex-highlight.js', 'js/solution-structure.js']

def classes_in(text):
    return set(re.findall(r'\bfa-([a-z0-9][a-z0-9-]*)', text))

css = (FA / 'css/all.min.css').read_text()
rules = {}  # class name -> codepoint
for m in re.finditer(r'((?:\.fa-[a-z0-9-]+:before,?)+)\{content:"\\([0-9a-f]+)"\}', css):
    for cls in re.findall(r'\.fa-([a-z0-9-]+):before', m.group(1)):
        rules[cls] = m.group(2)

used = set()
for f in TEMPLATES + JS:
    p = ROOT / f
    if p.exists():
        used |= classes_in(p.read_text())
# layout modifiers, not glyphs
icons = sorted(c for c in used if c in rules)
missing = sorted(c for c in used if c not in rules and not re.match(r'^(fw|lg|xs|sm|xl|2x|3x|spin|pulse|solid|regular|brands|\d+x)$', c))
if missing:
    print('not glyphs (ignored):', ' '.join(missing), file=sys.stderr)

codepoints = sorted({rules[c] for c in icons})
out_font = FA / 'webfonts/fa-solid-900-subset.woff2'
subprocess.run([
    'pyftsubset', str(FA / 'webfonts/fa-solid-900.woff2'),
    '--unicodes=' + ','.join('U+' + cp for cp in codepoints),
    '--flavor=woff2', '--no-hinting', '--desubroutinize',
    '--output-file=' + str(out_font),
], check=True)

# All the aliases of each glyph, so a template may use either spelling (fa-edit, fa-pen-to-square).
by_cp = {}
for cls, cp in rules.items():
    if cp in codepoints:
        by_cp.setdefault(cp, []).append(cls)
lines = [
    '/* Font Awesome 6 Free (solid), only the glyphs the solution page and the header use. */',
    '/* Built by scripts/build-fa-subset.py from all.min.css and fa-solid-900.woff2; do not edit. */',
    '@font-face{font-family:"Font Awesome 6 Free";font-style:normal;font-weight:900;font-display:block;'
    'src:url(../webfonts/fa-solid-900-subset.woff2) format("woff2")}',
    '.fa,.fa-solid,.fas{-moz-osx-font-smoothing:grayscale;-webkit-font-smoothing:antialiased;display:var(--fa-display,inline-block);'
    'font-style:normal;font-variant:normal;line-height:1;text-rendering:auto;font-family:"Font Awesome 6 Free";font-weight:900}',
    '.fa-fw{text-align:center;width:1.25em}',
]
for cp in codepoints:
    sel = ','.join('.fa-%s:before' % c for c in sorted(by_cp[cp]))
    lines.append('%s{content:"\\%s"}' % (sel, cp))
(FA / 'css/subset.css').write_text('\n'.join(lines) + '\n')
print('%d icons, %d glyphs, font %d bytes, css %d bytes' % (len(icons), len(codepoints), out_font.stat().st_size, (FA / 'css/subset.css').stat().st_size))
print(' '.join(icons))
