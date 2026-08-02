#!/usr/bin/env python3
"""
build-recommendations-pdf.py — downloadable edition of the catalog.

Why a PDF at all: on this site the two most-clicked outbound links by a wide
margin are savchenko.pdf (2,220 clicks) and savchenko_en.pdf (1,550). This
audience downloads things. A directory they can keep beats one they have to
revisit.

Built from data/recommendations.json ONLY — the same vetted artifact the website
serves, so the pseudoscience entries, the non-STEM cut, and the 1,423 private
invite links can no more reach the PDF than they can reach the page.

Usage: python3 scripts/build-recommendations-pdf.py
Output: public/physics-telegram-catalog.pdf
"""

import json
import os
import sys
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph,
                                Spacer, Table, TableStyle)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CATALOG = os.path.join(ROOT, 'data', 'recommendations.json')
# Served from pdf/, alongside savchenko.pdf — the existing convention here.
OUT = os.path.join(ROOT, 'pdf', 'physics-telegram-catalog.pdf')

# A Cyrillic-capable font is mandatory — most of this catalog is Russian.
FONT_CANDIDATES = [
    ('DejaVuSans', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
    ('DejaVuSans', '/usr/share/fonts/TTF/DejaVuSans.ttf'),
    ('LiberationSans', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'),
]
BOLD_CANDIDATES = [
    ('DejaVuSans-Bold', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'),
    ('DejaVuSans-Bold', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf'),
    ('LiberationSans-Bold', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'),
]

NAVY = colors.HexColor('#1a1a2e')
GREY = colors.HexColor('#6c757d')
LINK = colors.HexColor('#0000FF')  # classic hyperlink blue
RULE = colors.HexColor('#dee2e6')


def register_fonts():
    regular = bold = None
    for name, path in FONT_CANDIDATES:
        if os.path.exists(path):
            pdfmetrics.registerFont(TTFont(name, path)); regular = name; break
    for name, path in BOLD_CANDIDATES:
        if os.path.exists(path):
            pdfmetrics.registerFont(TTFont(name, path)); bold = name; break
    if not regular:
        sys.exit('no Cyrillic-capable TTF found; install fonts-dejavu')
    return regular, bold or regular


def esc(s):
    return (str(s or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def main():
    if not os.path.exists(CATALOG):
        sys.exit(f'missing {CATALOG} — run scripts/build-recommendations.js first')
    with open(CATALOG, encoding='utf-8') as fh:
        cat = json.load(fh)

    regular, bold = register_fonts()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    st_title = ParagraphStyle('t', fontName=bold, fontSize=19, leading=23, textColor=NAVY, spaceAfter=4)
    st_lede = ParagraphStyle('l', fontName=regular, fontSize=9.5, leading=14, textColor=GREY, spaceAfter=3)
    st_h2 = ParagraphStyle('h2', fontName=bold, fontSize=12.5, leading=16, textColor=NAVY,
                           spaceBefore=13, spaceAfter=5)
    st_name = ParagraphStyle('n', fontName=bold, fontSize=9, leading=11.5, textColor=NAVY)
    st_sum = ParagraphStyle('s', fontName=regular, fontSize=8, leading=10.5,
                            textColor=colors.HexColor('#2d2d2d'),
                            linkUnderline=1, underlineColor=LINK)
    st_meta = ParagraphStyle('m', fontName=regular, fontSize=7.5, leading=9.5, textColor=GREY)

    doc = BaseDocTemplate(OUT, pagesize=A4,
                          leftMargin=16 * mm, rightMargin=16 * mm,
                          topMargin=15 * mm, bottomMargin=16 * mm,
                          title='Каталог физических Telegram-каналов и сайтов',
                          author='savchenkosolutions.com')
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='f')

    def footer(canvas, d):
        canvas.saveState()
        canvas.setFont(regular, 7.5)
        canvas.setFillColor(GREY)
        label = 'savchenkosolutions.com/recommendations'
        canvas.setFillColor(LINK)
        canvas.drawString(d.leftMargin, 10 * mm, label)
        # drawString paints text only; the clickable region has to be registered
        # separately as a rectangle over exactly that text.
        w = canvas.stringWidth(label, regular, 7.5)
        canvas.linkURL('https://savchenkosolutions.com/recommendations',
                       (d.leftMargin, 10 * mm - 1.5, d.leftMargin + w, 10 * mm + 7),
                       relative=0, thickness=0)
        canvas.setFillColor(GREY)
        canvas.drawRightString(A4[0] - d.rightMargin, 10 * mm, str(canvas.getPageNumber()))
        canvas.restoreState()

    doc.addPageTemplates([PageTemplate(id='all', frames=[frame], onPage=footer)])

    tg = cat.get('telegram', {}).get('entries', [])
    web = cat.get('websites', {}).get('entries', [])
    diag = cat.get('diagnostics', {}) or {}

    story = []
    story.append(Paragraph('Физика в Telegram и в сети', st_title))
    story.append(Paragraph(
        f"Каталог из {len(tg)} Telegram-каналов и {len(web)} сайтов по олимпиадной физике. "
        f"Составлен обходом {200434:,} узлов Telegram и {1299403:,} веб-страниц; "
        f"порядок внутри раздела — PageRank по графу взаимных ссылок, "
        f"а не по числу подписчиков.".replace(',', ' '), st_lede))
    story.append(Paragraph(
        f"Срез от {esc(cat.get('generated', ''))}. Полная версия с фильтрами по языку, "
        f'уровню и теме — <a href="https://savchenkosolutions.com/recommendations" color="#0000FF">savchenkosolutions.com/recommendations</a>', st_lede))
    story.append(Spacer(1, 5))

    rubrics = {r['id']: r for r in cat.get('rubrics', [])}
    order = [r for r in cat.get('rubrics', []) if r.get('class') == 'core'] \
        + [r for r in cat.get('rubrics', []) if r.get('class') != 'core']

    for r in order:
        rows = [e for e in tg + web if e.get('rubric') == r['id']]
        if not rows:
            continue
        story.append(Paragraph(f"{esc(r.get('ru') or r.get('en'))} &nbsp;<font size=9 color='#8c959f'>{len(rows)}</font>", st_h2))
        data = []
        for i, e in enumerate(rows, 1):
            # Real PDF link annotations, not merely coloured text: a directory
            # whose entries cannot be clicked is a list of things to retype.
            href = esc(e['url'])
            shown = esc(e['url'].replace('https://', '').replace('http://', ''))
            summary = esc((e.get('summaryRu') or e.get('summaryEn') or '')[:150])
            subs = f" · {e['subscribers']:,}".replace(',', ' ') + ' подп.' if e.get('subscribers') else ''
            url_link = f'<a href="{href}" color="#0000FF">{shown}</a>'
            meta = (f"{url_link}<font color='#6c757d'> · "
                    f"ссылаются: {e.get('inRefs', 0)}{subs}</font>")
            data.append([
                Paragraph(f"{i}.", st_meta),
                Paragraph(f'<a href="{href}" color="#0000FF">{esc(e.get("title"))}</a>'
                          f"<br/><font size=8>{summary}</font>"
                          f"<br/><font size=7.5>{meta}</font>", st_sum),
            ])
        t = Table(data, colWidths=[8 * mm, doc.width - 8 * mm], hAlign='LEFT')
        t.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LINEBELOW', (0, 0), (-1, -2), 0.25, RULE),
        ]))
        story.append(t)

    story.append(Paragraph('Как это построено', st_h2))
    story.append(Paragraph(
        "Обход Telegram прошёл по 200 434 узлам; после проверки осталось 728 каналов, "
        "из которых опубликовано "
        f"{diag.get('kept', len(tg))}. Описание каждого канала построено по выборке записей "
        "за всю его историю (всего 1 578 436 сообщений, 455 МБ текста), а не по последним постам. "
        "Разделы не заданы заранее — они выведены кластеризацией того, для чего каналы "
        "используются на самом деле, и раздел попадал в каталог только если набирал "
        "достаточно участников.", st_sum))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "Исключены: псевдонаука (включая канал на 20 300 подписчиков, предсказывающий "
        "землетрясения по расположению планет), вакансии, гранты, личные блоги и всё, "
        "что не является наукой. Приватные ссылки-приглашения не публикуются. "
        "Оценки получены языковой моделью, а не размечены людьми.", st_sum))

    doc.build(story)
    size = os.path.getsize(OUT) / 1e6
    print(f'wrote {OUT} ({len(tg)} telegram + {len(web)} websites, {size:.2f} MB)')


if __name__ == '__main__':
    main()
