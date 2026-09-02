#!/usr/bin/env node
/**
 * Build a local side-by-side preview of every problem: the book's own page region on the
 * left (scripts/book3/preview-crops.py), the site's rendering on the right — the Russian
 * statement exactly as lib/statementRender.js would produce it (marked + MathJax SVG), the
 * attributed figures, and the English statement underneath.
 *
 *   python3 scripts/book3/preview-crops.py     # once, ~1 min
 *   node scripts/book3/preview.js
 *   xdg-open src/database/book3/preview/index.html
 *
 * One page per chapter (14) plus an index. Keys: j / k or → / ← move between problems,
 * f toggles the English, and each card links to the live page. Nothing here touches the
 * database or the site — it is a reading aid for checking the corpus against the book.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const W = path.join(ROOT, 'src/database/book3');
const OUT = path.join(W, 'preview');
const { parseMarkdown, transformImageMarkdown } = require(path.join(ROOT, 'utils'));
const { renderMathInHtml, getMathCss } = require(path.join(ROOT, 'mathRender'));
const { englishStatements, repairMath, applyOneOffs } = require(path.join(ROOT, 'scripts', 'build-statements'));

const read = (f) => JSON.parse(fs.readFileSync(path.join(W, f), 'utf8'));
const problems = read('problems.json');
const statements = read('statements_ru.json');
const figures = read('figures.json');
const enFixes = fs.existsSync(path.join(W, 'en_fixes.json')) ? read('en_fixes.json') : {};
const en = englishStatements();
const chapters = {};
try {
    for (const line of fs.readFileSync(path.join(ROOT, 'src/ru/database/chapters.csv'), 'utf8').replace(/^﻿/, '').split('\n')) {
        const parts = line.trim().split(',');
        if (/^\d+$/.test(parts[0])) chapters[parts[0]] = (parts[1] || '').replace(/^"|"$/g, '');
    }
} catch { /* titles are decoration */ }

// Same display size the site gives a book figure (lib/statementRender.js): 0.42 x the
// bitmap's pixel width, clamped to 140-560px, read from the PNG header.
function figureWidth(src) {
    try {
        const fd = fs.openSync(path.join(ROOT, src.replace(/^\//, '')), 'r');
        const head = Buffer.alloc(300);
        const n = fs.readSync(fd, head, 0, 300, 0);
        fs.closeSync(fd);
        if (head.toString('ascii', 1, 4) === 'PNG') return Math.max(140, Math.min(560, Math.round(head.readUInt32BE(16) * 0.42)));
        const m = head.toString('utf8', 0, n).match(/<svg[^>]*\swidth="(\d+)"/);
        if (m) return Number(m[1]);
    } catch { /* unsized */ }
    return null;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const render = (md) => renderMathInHtml(parseMarkdown(transformImageMarkdown(md)))
    .replace(/(src|srcset)="\.\.\/\.\.\/img\//g, '$1="../../../../img/');

const byChapter = {};
for (const name of Object.keys(problems)) {
    const ch = name.split('.')[0];
    (byChapter[ch] = byChapter[ch] || []).push(name);
}
fs.mkdirSync(OUT, { recursive: true });

const CSS = `
body { margin: 0; background: #fff; color: #2d2d2d; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.top { position: sticky; top: 0; background: #1a1a2e; color: #fff; padding: 8px 16px; font-size: 13px; display: flex; gap: 16px; align-items: center; z-index: 2; }
.top a { color: #fff; }
.top .hint { color: #b8c0cc; margin-left: auto; }
.problem { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding: 14px 16px; border-bottom: 1px solid #dee2e6; scroll-margin-top: 44px; }
.problem.current { background: #f8f9fa; }
.book img { max-width: 100%; border: 1px solid #dee2e6; }
.head { grid-column: 1 / -1; display: flex; gap: 10px; align-items: baseline; font-family: Inter, sans-serif; font-size: 15px; }
.head .n { font-weight: 700; color: #1a5276; }
.head .n a { color: inherit; text-decoration: none; }
.badge { font-size: 11px; padding: 2px 7px; border-radius: 4px; border: 1px solid #dee2e6; color: #6c757d; background: #f8f9fa; }
.badge.review { border-color: #c0392b; color: #c0392b; }
.badge.llm { border-color: #1a5276; color: #1a5276; }
.badge.fig { border-color: #27ae60; color: #27ae60; }
.site .ru { font-family: "Latin Modern Roman", "STIX Two Math", Georgia, serif; font-size: 15px; line-height: 1.6; }
.site .ru p { margin: 0 0 8px; }
.site figure { margin: 8px 0 0; }
.site .en { font-size: 13px; color: #6c757d; margin-top: 10px; border-top: 1px dashed #dee2e6; padding-top: 8px; line-height: 1.5; }
body.no-en .site .en { display: none; }
.idx { max-width: 900px; margin: 30px auto; font-size: 15px; line-height: 1.8; }
.idx a { color: #1a5276; }
mjx-container[display="true"] { display: block; margin: 4px 0; }
`;

const JS = `
(function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll('.problem'));
  var cur = -1;
  function go(i){ if(i<0||i>=cards.length) return; if(cur>=0) cards[cur].classList.remove('current'); cur=i; cards[cur].classList.add('current'); cards[cur].scrollIntoView({block:'start'}); history.replaceState(null,'','#'+cards[cur].id); }
  document.addEventListener('keydown', function(e){
    if (e.target.tagName==='INPUT') return;
    if (e.key==='j'||e.key==='ArrowRight'){ e.preventDefault(); go(cur+1); }
    else if (e.key==='k'||e.key==='ArrowLeft'){ e.preventDefault(); go(cur-1); }
    else if (e.key==='f'){ document.body.classList.toggle('no-en'); }
  });
  if (location.hash){ var i=cards.findIndex(function(c){return '#'+c.id===location.hash;}); if(i>=0) go(i); }
})();`;

let total = 0;
const chapterNums = Object.keys(byChapter).sort((a, b) => a - b);
for (const ch of chapterNums) {
    const names = byChapter[ch];
    const cards = names.map((name) => {
        const p = problems[name];
        const s = statements[name];
        const figs = figures[name] || [];
        const badges = [
            p.starred ? '<span class="badge">∗ starred</span>' : '',
            p.has_figure ? '<span class="badge fig">♦ figure in book</span>' : '',
            `<span class="badge ${s.source.endsWith('llm') ? 'llm' : ''}">${esc(s.source)}</span>`,
            s.needs_review ? '<span class="badge review">needs review</span>' : '',
            (p.has_figure && !figs.length) || (!p.has_figure && figs.length) ? `<span class="badge review">${figs.length} figure file(s) vs book</span>` : '',
        ].join(' ');
        let ruHtml = render(s.text);
        if (!/<img/i.test(ruHtml)) {
            ruHtml += figs.map((src) => { const w = figureWidth(src); return `<figure class="statement-figure"><img src="../../../..${src}" alt="К задаче ${esc(name)}" loading="lazy"${w ? ` width="${w}"` : ''} /></figure>`; }).join('');
        }
        const enText = enFixes[name] ? enFixes[name].text : (en.get(name) ? en.get(name).text : '');
        const enHtml = enText ? render(enText) : '<i>(no English)</i>';
        total++;
        return `<section class="problem" id="p-${name}">
  <div class="head"><span class="n"><a href="https://savchenkosolutions.com/ru/${name}" target="_blank">${name}</a></span> <span class="badge">стр. ${p.page}${p.end_page !== p.page ? `–${p.end_page}` : ''}</span> ${badges}</div>
  <div class="book"><img src="crops/${name}.png" alt="book ${name}" loading="lazy" /></div>
  <div class="site"><div class="ru">${ruHtml}</div><div class="en">${enFixes[name] ? '<span class="badge llm">tex+llm</span> ' : ''}${enHtml}</div></div>
</section>`;
    }).join('\n');
    const prev = chapterNums[chapterNums.indexOf(ch) - 1];
    const next = chapterNums[chapterNums.indexOf(ch) + 1];
    const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Глава ${ch} — preview</title>
<style>${CSS}${getMathCss()}</style></head><body>
<div class="top"><a href="index.html">Оглавление</a> ${prev ? `<a href="ch${prev}.html">← глава ${prev}</a>` : ''} <b>Глава ${ch}. ${esc(chapters[ch] || '')}</b> (${names.length}) ${next ? `<a href="ch${next}.html">глава ${next} →</a>` : ''}<span class="hint">j / k — следующая / предыдущая, f — скрыть английский. Слева книга, справа сайт.</span></div>
${cards}
<script>${JS}</script></body></html>`;
    fs.writeFileSync(path.join(OUT, `ch${ch}.html`), html);
}
const counts = { llm: 0, review: 0, md: 0, raw: 0 };
for (const s of Object.values(statements)) {
    if (s.needs_review) counts.review++;
    if (s.source === 'md') counts.md++; else if (s.source.endsWith('llm')) counts.llm++; else counts.raw++;
}
const index = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Savchenko 3rd ed. — side-by-side preview</title><style>${CSS}</style></head><body>
<div class="idx"><h2>Книга и сайт рядом: ${total} задач</h2>
<p>Слева — фрагмент страницы 3-го издания, справа — то, что показывает сайт (условие, формулы, рисунки, английский перевод). Источники условий: markdown, совпавший с книгой — ${counts.md}; набрано моделью по тексту книги — ${counts.llm}; сырой текст книги — ${counts.raw}, из них требуют проверки — ${counts.review}.</p>
<ol>${chapterNums.map((ch) => `<li><a href="ch${ch}.html">Глава ${ch}. ${esc(chapters[ch] || '')}</a> — ${byChapter[ch].length} задач</li>`).join('')}</ol>
<p>Требуют проверки: ${Object.keys(statements).filter((n) => statements[n].needs_review).map((n) => `<a href="ch${n.split('.')[0]}.html#p-${n}">${n}</a>`).join(', ')}</p>
</div></body></html>`;
fs.writeFileSync(path.join(OUT, 'index.html'), index);
console.log(`  ${total} problems in ${chapterNums.length} chapter pages -> ${OUT}/index.html`);
