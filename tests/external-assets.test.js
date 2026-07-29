// Guards against reintroducing third-party asset origins.
//
// Why this exists: every stylesheet and script loaded from someone else's domain is a
// single point of failure. A corporate/ISP web filter that blocks that one hostname
// leaves the whole site unstyled — this happened with cdn.jsdelivr.net, which is blocked
// by filters that classify it as a malware-distribution host. Bootstrap was loaded from
// it on every page, so the entire site rendered as unstyled HTML for affected users.
//
// All render-critical libraries are now self-hosted under css/vendor and js/vendor, and
// MathJax is served from the mathjax-full package at /vendor/mathjax. If you need a new
// front-end library, vendor it into those directories instead of pointing at a CDN.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'deploy-backups', 'posts', 'img', 'pdf']);

// Origins that are deliberately third-party and cannot be self-hosted. None of these are
// render-critical: they load asynchronously and the page is fully usable without them.
const ALLOWED_HOSTS = new Set([
  'www.googletagmanager.com', // analytics, injected async by js/analytics.js
  'mc.yandex.ru',             // analytics, injected async by js/analytics.js
]);

// The site's own origins — canonical/alternate links point here and are not assets.
const OWN_HOSTS = new Set([
  'savchenkosolutions.com',
  'www.savchenkosolutions.com',
  'sandbox.savchenkosolutions.com',
]);

// Legacy GitHub-Pages-era stylesheets. They carry scraped Wikipedia background-image URLs,
// but no rendered route references them, so no visitor ever loads them. Kept out of the
// reachability check deliberately; delete the files and this entry together.
const LEGACY_CSS_DIR = path.join('css', 'css-latex');

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), exts, out);
    } else if (exts.includes(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };
const rel = (f) => path.relative(ROOT, f);

// Only <script src> and asset-bearing <link> tags count. <a href>, <iframe src> and
// rel="canonical"/"alternate" are navigation or metadata, not resources the renderer blocks on.
const ASSET_REL = /\b(stylesheet|preload|prefetch|modulepreload|preconnect|dns-prefetch)\b/i;

function externalAssetUrls(html) {
  const urls = [];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = /\bsrc=["'](https?:\/\/[^"']+)["']/i.exec(m[0]);
    if (src) urls.push(src[1]);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel=["']([^"']+)["']/i.exec(m[0]);
    const href = /\bhref=["'](https?:\/\/[^"']+)["']/i.exec(m[0]);
    if (rel && href && ASSET_REL.test(rel[1])) urls.push(href[1]);
  }
  return urls;
}

test('templates load no third-party scripts or stylesheets', () => {
  const offenders = [];
  for (const f of walk(ROOT, ['.ejs', '.html'])) {
    for (const url of externalAssetUrls(fs.readFileSync(f, 'utf8'))) {
      const host = hostOf(url);
      if (host && !ALLOWED_HOSTS.has(host) && !OWN_HOSTS.has(host)) {
        offenders.push(`${rel(f)} -> ${url}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    `Third-party asset(s) found. Vendor them into css/vendor or js/vendor instead:\n  ${offenders.join('\n  ')}`);
});

// Only checks stylesheets a page can actually reach, so dead legacy CSS does not fail the
// build — but the moment a template starts referencing one, it comes under the same rule.
test('reachable stylesheets contain no third-party url() or @import', () => {
  const referenced = new Set();
  for (const f of walk(ROOT, ['.ejs', '.html'])) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/["'](\/?[\w./-]*\.css)["']/g)) {
      const p = path.join(ROOT, m[1].replace(/^\//, ''));
      if (!fs.existsSync(p)) continue;
      if (p.includes(`${path.sep}vendor${path.sep}`)) continue;
      if (rel(p).startsWith(LEGACY_CSS_DIR)) continue;
      referenced.add(p);
    }
  }
  // css/bundle.css is generated from these by scripts/build-css.js.
  for (const n of ['design-system.css', 'main_page.css', 'solutions.css']) {
    const p = path.join(ROOT, 'css', n);
    if (fs.existsSync(p)) referenced.add(p);
  }

  const offenders = [];
  for (const f of referenced) {
    const css = fs.readFileSync(f, 'utf8');
    for (const m of css.matchAll(/url\(\s*["']?(https?:\/\/[^)"']+)/gi)) {
      const host = hostOf(m[1]);
      if (host && !ALLOWED_HOSTS.has(host)) offenders.push(`${rel(f)} -> ${m[1]}`);
    }
    for (const m of css.matchAll(/@import\s+["'](https?:\/\/[^"']+)["']/gi)) {
      offenders.push(`${rel(f)} -> @import ${m[1]}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `Third-party asset(s) referenced from a reachable stylesheet:\n  ${offenders.join('\n  ')}`);
});

test('vendored stylesheets reference only local font files', () => {
  const vendorCss = walk(path.join(ROOT, 'css', 'vendor'), ['.css']);
  assert.ok(vendorCss.length > 0, 'expected vendored CSS under css/vendor');

  const offenders = [];
  for (const f of vendorCss) {
    const css = fs.readFileSync(f, 'utf8');
    for (const m of css.matchAll(/url\(\s*["']?(https?:\/\/[^)"']+)/gi)) {
      offenders.push(`${rel(f)} -> ${m[1]}`);
    }
    // Every local url() must resolve on disk, or the glyphs silently fall back.
    for (const m of css.matchAll(/url\(\s*["']?(?!https?:|data:)([^)"'?#]+)/gi)) {
      const target = path.resolve(path.dirname(f), m[1]);
      if (!fs.existsSync(target)) offenders.push(`${rel(f)} -> missing file ${m[1]}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `Broken or remote references in vendored CSS:\n  ${offenders.join('\n  ')}`);
});
