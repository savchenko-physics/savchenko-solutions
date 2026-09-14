#!/usr/bin/env python3
"""
type_audit.py — rendered typography / layout audit for savchenkosolutions.com.

Why this exists. The 2026-09 typography unification replaced 39 font stacks, 110 font sizes and
291 colours with one token system across ~68 templates. Source-level tests can say that a
declaration uses a token; only a real browser can say what a reader actually sees: which font
drew the glyphs, whether a phone scrolls sideways, whether a formula went missing. This script
renders every page type in headless Chrome and records exactly that, so the old site and the
new one can be compared page by page.

    python3 scripts/qa/type_audit.py run  --base https://savchenkosolutions.com --name live-before
    python3 scripts/qa/type_audit.py login --base http://127.0.0.1:3000          # local rig only
    python3 scripts/qa/type_audit.py run  --base http://127.0.0.1:3000 --name local-new --auth
    python3 scripts/qa/type_audit.py compare --a local-old --b local-new

Output goes to ~/ss-typeset-qa/runs/<name>/ (never into the repo): one JSON per page and
viewport, screenshots, and for `compare` a contact sheet per page plus index.html.

The user agent carries "savchenko-type-audit monitoring", which botgate serves normally but
does not count (botgate.js COUNT_NOTHING), and analytics hosts are blocked, so a run against
the live site does not pollute Metrica or GA.

Needs Python Playwright + Pillow and /usr/bin/google-chrome. No npm dependency.
"""
import argparse
import asyncio
import html
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

OUT = Path.home() / 'ss-typeset-qa' / 'runs'
PAGES = Path(__file__).with_name('pages.json')
STATE = Path.home() / 'ss-typeset-qa' / 'rig' / 'storage_state.json'
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/151.0.0.0 Safari/537.36 savchenko-type-audit monitoring')
UA_MOBILE = ('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
             'Chrome/151.0.0.0 Mobile Safari/537.36 savchenko-type-audit monitoring')
BLOCK = re.compile(r'googletagmanager|google-analytics|mc\.yandex|yandex\.ru/metrika|doubleclick')
SCALE = {12, 13, 14, 16, 18, 20, 24, 28, 32, 40}
VIEWPORTS = {
    'm': dict(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True, user_agent=UA_MOBILE),
    'd': dict(viewport={'width': 1366, 'height': 900}, device_scale_factor=1, user_agent=UA),
}

# In-page probe. Visible text outside formulas/sub/sup; the numbers a reader experiences.
PROBE = r"""
() => {
  const W = window.innerWidth;
  const isVis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0; };
  const fam = {}, size = {}, weight = {}, color = {};
  let chars = 0, minSize = 1e9, minSample = '';
  const marked = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || el.closest('mjx-container, svg, script, style, noscript, sub, sup, template, [hidden], .visually-hidden, .sr-only, canvas')) continue;
    if (!isVis(el)) continue;
    const cs = getComputedStyle(el);
    const k = t.length; chars += k;
    const f = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    const s = Math.round(parseFloat(cs.fontSize) * 100) / 100;
    fam[f] = (fam[f] || 0) + k; size[s] = (size[s] || 0) + k;
    weight[cs.fontWeight] = (weight[cs.fontWeight] || 0) + k; color[cs.color] = (color[cs.color] || 0) + k;
    if (k >= 2 && s < minSize) { minSize = s; minSample = t.slice(0, 40); }
    if (marked.length < 260 && !el.hasAttribute('data-qa-t')) { el.setAttribute('data-qa-t', marked.length); marked.push(el); }
  }
  const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=submit]):not([type=button]), textarea, select')]
    .filter(isVis).map(el => ({ sel: (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0,2).join('.') : '')), fs: parseFloat(getComputedStyle(el).fontSize) }));
  const sw = document.documentElement.scrollWidth;
  const offenders = [];
  if (sw > W + 1) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.right > W + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') {
        let p = el.parentElement, clipped = false;
        while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'hidden' || o === 'scroll' || o === 'clip') { clipped = true; break; } p = p.parentElement; }
        if (!clipped) offenders.push({ el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''), right: Math.round(r.right) });
      }
      if (offenders.length > 400) break;
    }
    offenders.sort((a, b) => b.right - a.right);
  }
  const main = document.querySelector('.ss-prose, .content-body, article, main') || document.body;
  const captions = [...document.querySelectorAll('figure')].filter(f => f.querySelector('img[src*="statement"]')).map(f => (f.querySelector('figcaption')?.textContent || '').trim()).filter(Boolean);
  // Prose: size, alignment, median characters per line over up to 12 paragraphs.
  let prose = null;
  const ps = [...document.querySelectorAll('.ss-prose p, .content-body p')].filter(p => isVis(p) && p.textContent.trim().length > 60).slice(0, 12);
  if (ps.length) {
    const cs = getComputedStyle(ps[0]); const perLine = [];
    for (const p of ps) {
      const range = document.createRange(); range.selectNodeContents(p);
      const tops = new Set([...range.getClientRects()].map(r => Math.round(r.top)));
      const lines = Math.max(1, [...tops].length);
      if (lines >= 2) perLine.push(p.textContent.replace(/\s+/g, ' ').trim().length / lines);
    }
    prose = { fontSize: parseFloat(cs.fontSize), lineHeight: cs.lineHeight, textAlign: cs.textAlign, fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, ''), hyphens: cs.hyphens,
              medianCharsPerLine: perLine.length ? perLine.sort((a, b) => a - b)[Math.floor(perLine.length / 2)] : null };
  }
  const loaded = []; document.fonts.forEach(f => { if (f.status === 'loaded') loaded.push(f.family.replace(/["']/g, '') + ' ' + f.weight + (f.style !== 'normal' ? ' ' + f.style : '')); });
  const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(1000 * v / Math.max(chars, 1)) / 10]);
  return {
    title: document.title, chars, families: top(fam), sizes: top(size), weights: top(weight), colors: top(color),
    minSize: minSize === 1e9 ? null : minSize, minSample, inputs, overflowPx: Math.max(0, sw - W), offenders: offenders.slice(0, 8),
    formulas: document.querySelectorAll('mjx-container').length,
    bookNumbers: document.querySelectorAll('.ss-problem .ss-num').length,
    captionFormulas: [...document.querySelectorAll('figure')].filter(f => f.querySelector('img[src*="statement"]')).reduce((k, f) => k + f.querySelectorAll('figcaption mjx-container').length, 0),
    images: main.querySelectorAll('img').length,
    textLen: (main.innerText || '').replace(/\s+/g, ' ').trim().length,
    statementCaptions: captions, prose, fontsLoaded: [...new Set(loaded)].sort(),
    cls: window.__qaCLS || 0, marked: marked.length,
  };
}
"""

CLS_INIT = """
window.__qaCLS = 0;
try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__qaCLS += e.value; })
      .observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
"""


def load_pages(where_live, auth):
    pages = json.loads(PAGES.read_text())['pages']
    out = []
    for p in pages:
        if where_live and p.get('live', True) is False:
            continue
        if not where_live and p.get('local', True) is False:
            continue
        if p.get('auth') and not auth:
            continue
        out.append(p)
    return out


async def platform_fonts(cdp, count):
    """Real fonts that drew the text of marked elements (catches glyph fallback)."""
    fonts = {}
    try:
        doc = await cdp.send('DOM.getDocument', {'depth': -1})
        res = await cdp.send('DOM.querySelectorAll', {'nodeId': doc['root']['nodeId'], 'selector': '[data-qa-t]'})
        for node_id in res['nodeIds'][:count]:
            try:
                pf = await cdp.send('CSS.getPlatformFontsForNode', {'nodeId': node_id})
            except Exception:
                continue
            for f in pf.get('fonts', []):
                key = ('web:' if f.get('isCustomFont') else 'sys:') + f.get('familyName', '?')
                fonts[key] = fonts.get(key, 0) + f.get('glyphCount', 0)
    except Exception as e:  # never fail a run over the probe
        fonts['error'] = str(e)[:80]
    return dict(sorted(fonts.items(), key=lambda kv: -kv[1]))


async def audit_page(browser, base, page_def, vp, run_dir, auth, delay_fonts):
    ctx_args = dict(VIEWPORTS[vp])
    ctx_args.update(locale='ru-RU', extra_http_headers={'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'}, service_workers='block')
    if page_def.get('auth') and auth and STATE.exists():
        ctx_args['storage_state'] = str(STATE)
    ctx = await browser.new_context(**ctx_args)
    await ctx.add_init_script(CLS_INIT)
    host = urlparse(base).hostname
    net = {'fontBytes': 0, 'fontRequests': 0, 'fonts': [], 'thirdParty': [], 'errors4xx5xx': []}
    console_errors = []

    async def route(route):
        url = route.request.url
        if BLOCK.search(url):
            return await route.abort()
        if delay_fonts and re.search(r'\.(woff2?|ttf|otf)(\?|$)', url):
            await asyncio.sleep(1.2)
        await route.continue_()
    await ctx.route('**/*', route)
    page = await ctx.new_page()
    page.on('console', lambda m: console_errors.append(m.text[:200]) if m.type == 'error' else None)

    async def on_response(resp):
        try:
            u = resp.url
            h = urlparse(u).hostname or ''
            if h and h not in (host, 'localhost', '127.0.0.1') and not u.startswith('data:'):
                net['thirdParty'].append(u[:120])
            if resp.status >= 400 and h in (host, 'localhost', '127.0.0.1'):
                net['errors4xx5xx'].append(f"{resp.status} {u[:120]}")
            if re.search(r'\.(woff2?|ttf|otf)(\?|$)', u):
                body = await resp.body()
                net['fontBytes'] += len(body)
                net['fontRequests'] += 1
                net['fonts'].append(u.split('/')[-1][:80])
        except Exception:
            pass
    page.on('response', lambda r: asyncio.ensure_future(on_response(r)))

    rec = {'id': page_def['id'], 'path': page_def['path'], 'vp': vp, 'kind': page_def.get('kind')}
    t0 = time.time()
    try:
        resp = await page.goto(base + page_def['path'], wait_until='load', timeout=60000)
        rec['status'] = resp.status if resp else None
        try:
            await page.wait_for_load_state('networkidle', timeout=8000)
        except Exception:
            pass
        await page.evaluate('document.fonts.ready.then(() => true)')
        await page.wait_for_timeout(600)
        await page.add_style_tag(content='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}')
        rec.update(await page.evaluate(PROBE))
        cdp = await ctx.new_cdp_session(page)
        await cdp.send('DOM.enable')
        await cdp.send('CSS.enable')
        rec['platformFonts'] = await platform_fonts(cdp, rec.get('marked', 0))
        shot = run_dir / f"{page_def['id']}_{vp}.png"
        if vp == 'm':
            await page.screenshot(path=str(shot), full_page=True, clip={'x': 0, 'y': 0, 'width': 390, 'height': 844 * 3})
        else:
            h = await page.evaluate('Math.min(document.documentElement.scrollHeight, 6000)')
            await page.screenshot(path=str(shot), full_page=True, clip={'x': 0, 'y': 0, 'width': 1366, 'height': max(900, h)})
        rec['shot'] = shot.name
    except Exception as e:
        rec['error'] = str(e)[:300]
    await page.wait_for_timeout(200)
    rec['net'] = net
    rec['consoleErrors'] = console_errors[:20]
    rec['seconds'] = round(time.time() - t0, 1)
    await ctx.close()
    return rec


async def cmd_run(args):
    from playwright.async_api import async_playwright
    live = not re.search(r'127\.0\.0\.1|localhost', args.base)
    pages = load_pages(live, args.auth)
    if args.only:
        rx = re.compile(args.only)
        pages = [p for p in pages if rx.search(p['id'])]
    run_dir = OUT / args.name
    run_dir.mkdir(parents=True, exist_ok=True)
    results = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True)
        for p in pages:
            for vp in args.viewports:
                rec = await audit_page(browser, args.base, p, vp, run_dir, args.auth, args.delay_fonts)
                results.append(rec)
                (run_dir / f"{p['id']}_{vp}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1))
                fams = ','.join(f for f, _ in rec.get('families', [])[:4])
                print(f"{rec.get('status')} {p['id']:<22} {vp} ovf={rec.get('overflowPx')} fam={len(rec.get('families', []))}[{fams}] "
                      f"sizes={len(rec.get('sizes', []))} min={rec.get('minSize')} fonts={rec['net']['fontBytes']//1024}KB/{rec['net']['fontRequests']} "
                      f"mjx={rec.get('formulas')} err={rec.get('error', '')[:60]}", flush=True)
        await browser.close()
    (run_dir / 'summary.json').write_text(json.dumps(results, ensure_ascii=False, indent=1))
    print('wrote', run_dir)


async def cmd_login(args):
    from playwright.async_api import async_playwright
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True)
        ctx = await browser.new_context(user_agent=UA, locale='ru-RU', extra_http_headers={'Accept-Language': 'ru-RU,ru;q=0.9'})
        page = await ctx.new_page()
        await page.goto(args.base + '/ru/login')
        await page.fill('input[name=username]', args.user)
        await page.fill('input[name=password]', args.password)
        await asyncio.gather(page.wait_for_load_state('load'), page.press('input[name=password]', 'Enter'))
        await page.wait_for_timeout(1500)
        print('after login url:', page.url)
        await ctx.storage_state(path=str(STATE))
        await browser.close()
    print('saved', STATE)


def violations(rec, other=None):
    """Threshold failures for a 'new' record; `other` is the same page/viewport in the old run."""
    v = []
    exp = 404 if rec['id'] == 'notfound' else 200
    if rec.get('error'):
        v.append('error: ' + rec['error'][:80])
    if rec.get('status') not in (exp, 302, 304):
        v.append(f"status {rec.get('status')}")
    if (rec.get('overflowPx') or 0) > 0:
        v.append(f"overflow {rec['overflowPx']}px ({(rec.get('offenders') or [{}])[0].get('el', '?')})")
    fams = [f for f, share in rec.get('families', []) if share >= 0.5]
    allowed = {'SS Text', 'SS Sans', 'SS Mono', 'SS Display', 'SS Wordmark', 'STIX Two Math', 'Font Awesome 6 Free', 'bootstrap-icons', 'FontAwesome'}
    odd = [f for f in fams if f not in allowed]
    if odd:
        v.append('families ' + ','.join(odd))
    # Text, interface and code faces; the wordmark and display face are the brand, counted apart.
    if len([f for f in fams if f.startswith('SS ') and f not in ('SS Display', 'SS Wordmark')]) > 3:
        v.append('more than 3 families')
    if rec.get('minSize') is not None and rec['minSize'] < 12:
        v.append(f"min size {rec['minSize']} ('{rec.get('minSample', '')[:20]}')")
    if rec['vp'] == 'm':
        small = [i for i in rec.get('inputs', []) if i['fs'] < 16]
        if small:
            v.append(f"inputs <16px: {small[0]['sel']} {small[0]['fs']}")
    off = sorted({float(s) for s, share in rec.get('sizes', []) if share >= 0.2} - SCALE)
    if off:
        v.append('sizes off scale ' + ','.join(str(s) for s in off[:6]))
    if len([s for s, share in rec.get('sizes', []) if share >= 0.2]) > 10:
        v.append('more than 10 sizes')
    sysfonts = {k: g for k, g in (rec.get('platformFonts') or {}).items() if k.startswith('sys:') and g > 3}
    if sysfonts:
        v.append('system fonts ' + ','.join(f"{k[4:]}({g})" for k, g in list(sysfonts.items())[:3]))
    if rec.get('statementCaptions'):
        v.append('statement caption shown: ' + rec['statementCaptions'][0][:30])
    if rec['net'].get('thirdParty'):
        v.append('third-party ' + rec['net']['thirdParty'][0][:60])
    if rec.get('kind') == 'solution' and rec.get('prose'):
        pr = rec['prose']
        want = 18 if rec['vp'] == 'm' else 20
        if round(pr['fontSize']) != want:
            v.append(f"prose {pr['fontSize']}px (want {want})")
    if rec.get('kind') == 'solution' and (rec.get('cls') or 0) > 0.02:
        v.append(f"CLS {rec['cls']:.3f}")
    if other and not other.get('error') and other.get('status') == rec.get('status') == 200:
        if rec.get('kind') == 'solution':
            # The book number ($2.1.32.$) is typeset as text now: count it as the formula it replaced.
            # Formulas inside the dropped duplicate "К задаче $N$" captions are not content.
            fn = lambda r: (r.get('formulas') or 0) + (r.get('bookNumbers') or 0) - (r.get('captionFormulas') or 0)
            if fn(rec) != fn(other):
                v.append(f"formulas {other.get('formulas')}→{rec.get('formulas')}+{rec.get('bookNumbers') or 0}")
            if rec.get('images') != other.get('images'):
                v.append(f"images {other.get('images')}→{rec.get('images')}")
            a, b = other.get('textLen') or 1, rec.get('textLen') or 1
            if abs(b - a) / a > 0.03:
                v.append(f"text length {a}→{b}")
        if rec['net']['fontBytes'] > max(other['net']['fontBytes'], 220 * 1024) and rec.get('kind') == 'solution':
            v.append(f"font bytes {other['net']['fontBytes']//1024}→{rec['net']['fontBytes']//1024}KB")
    return v


def cmd_compare(args):
    from PIL import Image, ImageDraw
    A, B = OUT / args.a, OUT / args.b
    sheets = OUT / f"compare-{args.a}-vs-{args.b}"
    sheets.mkdir(parents=True, exist_ok=True)
    rows = []
    ids = sorted({p.name.rsplit('_', 1)[0] for p in B.glob('*_m.json')} | {p.name.rsplit('_', 1)[0] for p in B.glob('*_d.json')})
    order = [p['id'] for p in json.loads(PAGES.read_text())['pages']]
    ids.sort(key=lambda i: order.index(i) if i in order else 999)
    for pid in ids:
        recs = {}
        for run, d in (('a', A), ('b', B)):
            for vp in ('m', 'd'):
                f = d / f"{pid}_{vp}.json"
                recs[run + vp] = json.loads(f.read_text()) if f.exists() else None
        viol = []
        for vp in ('m', 'd'):
            if recs['b' + vp]:
                viol += [f"[{vp}] {x}" for x in violations(recs['b' + vp], recs.get('a' + vp))]
        # contact sheet: a-m | b-m | a-d | b-d, each scaled to fixed width
        tiles = []
        for key, width in (('am', 300), ('bm', 300), ('ad', 520), ('bd', 520)):
            r = recs.get(key)
            src = (A if key[0] == 'a' else B) / (r.get('shot') or '') if r and r.get('shot') else None
            if src and src.exists():
                im = Image.open(src).convert('RGB')
                im = im.resize((width, int(im.height * width / im.width)))
                im = im.crop((0, 0, width, min(im.height, 1400)))
            else:
                im = Image.new('RGB', (width, 200), (240, 240, 240))
            tiles.append(im)
        h = max(t.height for t in tiles) + 34
        sheet = Image.new('RGB', (sum(t.width for t in tiles) + 8 * 3, h), (255, 255, 255) if not viol else (255, 235, 235))
        x = 0
        d = ImageDraw.Draw(sheet)
        for label, t in zip((args.a + ' mobile', args.b + ' mobile', args.a + ' desktop', args.b + ' desktop'), tiles):
            sheet.paste(t, (x, 30))
            d.text((x + 4, 8), label, fill=(0, 0, 0))
            x += t.width + 8
        sheet.save(sheets / f"{pid}.jpg", quality=80)

        def brief(r):
            if not r:
                return '—'
            return (f"{r.get('status')} · fam {len([1 for _, s in r.get('families', []) if s >= 0.5])} · sizes {len([1 for _, s in r.get('sizes', []) if s >= 0.2])} · "
                    f"min {r.get('minSize')} · ovf {r.get('overflowPx')} · fonts {r['net']['fontBytes']//1024}KB · mjx {r.get('formulas')}")
        rows.append((pid, viol, brief(recs['am']), brief(recs['bm']), brief(recs['ad']), brief(recs['bd'])))
    fails = sum(1 for r in rows if r[1])
    parts = [f"<meta charset=utf-8><title>{html.escape(args.a)} vs {html.escape(args.b)}</title>",
             "<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse}td{border-top:1px solid #ddd;padding:6px;vertical-align:top}"
             ".bad{color:#b00020}.ok{color:#1e8449}img{max-width:100%}</style>",
             f"<h1>{html.escape(args.a)} vs {html.escape(args.b)} — {len(rows)} pages, {fails} with violations</h1><table>"]
    for pid, viol, am, bm, ad, bd in rows:
        cls = 'bad' if viol else 'ok'
        parts.append(f"<tr><td><b>{html.escape(pid)}</b><br><span class={cls}>{'<br>'.join(html.escape(x) for x in viol) or 'pass'}</span>"
                     f"<br><small>A m: {html.escape(am)}<br>B m: {html.escape(bm)}<br>A d: {html.escape(ad)}<br>B d: {html.escape(bd)}</small></td>"
                     f"<td><a href='{html.escape(pid)}.jpg'><img src='{html.escape(pid)}.jpg' width=900></a></td></tr>")
    parts.append('</table>')
    (sheets / 'index.html').write_text('\n'.join(parts))
    for pid, viol, *_ in rows:
        if viol:
            print(f"FAIL {pid}: " + ' | '.join(viol))
    print(f"{len(rows)} pages, {fails} with violations → {sheets / 'index.html'}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('run')
    r.add_argument('--base', required=True)
    r.add_argument('--name', required=True)
    r.add_argument('--auth', action='store_true')
    r.add_argument('--only')
    r.add_argument('--viewports', default='md')
    r.add_argument('--delay-fonts', action='store_true')
    lg = sub.add_parser('login')
    lg.add_argument('--base', default='http://127.0.0.1:3000')
    lg.add_argument('--user', default='astrosander')
    lg.add_argument('--password', default='localtest')
    c = sub.add_parser('compare')
    c.add_argument('--a', required=True)
    c.add_argument('--b', required=True)
    args = ap.parse_args()
    if args.cmd == 'run':
        asyncio.run(cmd_run(args))
    elif args.cmd == 'login':
        asyncio.run(cmd_login(args))
    else:
        cmd_compare(args)


if __name__ == '__main__':
    main()
