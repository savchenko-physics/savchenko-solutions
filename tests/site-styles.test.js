// One head for every page: views/default/site_styles.ejs is the only place that links the
// site's stylesheets.
//
// Before September 2026 each template linked its own mix: bundle.css with a Date.now() query
// (so never cached), design-system.css and main_page.css directly, the css-latex stylesheet
// that set body { max-width: 80ch } and serif headings, an unversioned fonts.css, login.css,
// or nothing at all. Pages that should have matched did not — /global-search rendered its
// header broken, the login page was unstyled once css-latex went — and a stylesheet edit never
// reached every page. Now a page includes site_styles once, before its own <style>, and passes
// what it needs (maths, prose preloads, icons) as data.
//
// This file discovers the pages the app actually renders (res.render() in the route files, the
// two dynamic renders in index.js, and everything they include), and checks:
//   1. each page reaches site_styles exactly once, before its first <style>;
//   2. no live template links a site stylesheet itself, or cache-busts with Date.now();
//   3. the retired stylesheets are unreachable, and css/bundle.css is exactly buildBundle();
//   4. the site's CSS uses no @layer and no nesting (old WebViews drop such blocks whole);
//   5. every live template compiles.
// Not covered: what the page looks like. That is scripts/qa/type_audit.py in a real browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const { buildBundle, SOURCES } = require('../scripts/build-css');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');
const PARTIAL = path.join(VIEWS, 'default', 'site_styles.ejs');
const SIGNATURE = 'site_styles — the only place that emits';

// Renders whose template name is a variable (index.js): the homepage and the guidelines.
const DYNAMIC = ['eng_page', 'community_guidelines_en', 'community_guidelines_ru'];

// The app's own modules: index.js and everything it requires, transitively. Standalone scripts
// at the root (markdownParser.js, profile.js) render templates too, but no route reaches them.
function routeFiles() {
    const seen = new Set();
    const visit = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
            let target = path.resolve(path.dirname(file), m[1]);
            if (!target.endsWith('.js') && fs.existsSync(`${target}.js`)) target += '.js';
            if (target.endsWith('.js') && fs.existsSync(target) && !target.includes('node_modules')) visit(target);
        }
    };
    visit(path.join(ROOT, 'index.js'));
    return [...seen];
}

function renderedPages() {
    const names = new Set(DYNAMIC);
    for (const file of routeFiles()) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/\.render\(\s*["'`]([\w/.-]+)["'`]/g)) names.add(m[1].replace(/\.ejs$/, ''));
    }
    return [...names].map((n) => path.join(VIEWS, `${n}.ejs`)).filter((p) => fs.existsSync(p)).sort();
}

function resolveInclude(fromFile, name) {
    const withExt = name.endsWith('.ejs') ? name : `${name}.ejs`;
    const rel = path.join(path.dirname(fromFile), withExt);
    if (fs.existsSync(rel)) return rel;
    const abs = path.join(VIEWS, withExt);
    return fs.existsSync(abs) ? abs : null;
}

// Inline every static include (and `${lang}` ones, as 'en'), depth-first, so positions in the
// result are the order a browser sees.
function expand(file, seen = []) {
    if (seen.includes(file) || seen.length > 12) return '';
    const src = fs.readFileSync(file, 'utf8');
    return src.replace(/<%-\s*include\(\s*(["'`])([^"'`]+)\1[^%]*%>/g, (all, q, name) => {
        const target = resolveInclude(file, name.replace(/\$\{\s*lang\s*\}/g, 'en'));
        return target ? expand(target, seen.concat(file)) : all;
    });
}

function liveTemplates() {
    const out = new Set();
    const visit = (file) => {
        if (out.has(file)) return;
        out.add(file);
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/include\(\s*(["'`])([^"'`]+)\1/g)) {
            const target = resolveInclude(file, m[2].replace(/\$\{\s*lang\s*\}/g, 'en'));
            if (target) visit(target);
            const ru = resolveInclude(file, m[2].replace(/\$\{\s*lang\s*\}/g, 'ru'));
            if (ru) visit(ru);
        }
    };
    renderedPages().forEach(visit);
    return [...out].sort();
}

const rel = (p) => path.relative(ROOT, p);

// ── 1. One head per page ────────────────────────────────────────────────────────────────

test('the route files still render the pages this test knows about', () => {
    const pages = renderedPages();
    assert.ok(pages.length >= 66, `only ${pages.length} rendered templates found`);
    const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    assert.match(index, /const working_page = isMobile \? "eng_page" : "eng_page";/);
    assert.match(index, /'community_guidelines_ru' : 'community_guidelines_en'/);
});

test('every rendered page reaches site_styles exactly once, before its first <style>', () => {
    const problems = [];
    for (const page of renderedPages()) {
        const text = expand(page);
        const count = text.split(SIGNATURE).length - 1;
        if (count !== 1) { problems.push(`${rel(page)}: site_styles ×${count}`); continue; }
        const at = text.indexOf(SIGNATURE);
        const style = text.search(/<style\b/i);
        if (style >= 0 && style < at) problems.push(`${rel(page)}: a <style> comes before site_styles`);
    }
    assert.deepEqual(problems, []);
});

// ── 2. Nobody links site CSS by hand ────────────────────────────────────────────────────

test('no live template links a site stylesheet itself or cache-busts with Date.now()', () => {
    const forbidden = /(?:bundle\.css|design-system\.css|main_page\.css|css-latex\/|solutions\.css|login\.css|vendor\/fonts\/fonts\.css|bootstrap\.min\.css|codemirror\.min\.css|fontawesome\d?\/css|bootstrap-icons\.min\.css|\/css\/mathjax\.css)/;
    const offenders = [];
    for (const file of liveTemplates()) {
        if (file === PARTIAL) continue;
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/<link\b[^>]*>/gi)) {
            if (/stylesheet/i.test(m[0]) && forbidden.test(m[0])) offenders.push(`${rel(file)}: ${m[0].slice(0, 90)}`);
        }
        for (const m of src.matchAll(/(?:href|src)=["'][^"']*Date\.now\(\)[^"']*["']/g)) offenders.push(`${rel(file)}: ${m[0].slice(0, 90)}`);
    }
    assert.deepEqual(offenders, []);
});

// ── 3. Retired stylesheets, and the bundle ──────────────────────────────────────────────

test('css-latex, login.css and solutions.css are unreachable from live pages and the bundle', () => {
    assert.deepEqual(SOURCES, ['design-system.css', 'main_page.css']);
    for (const file of liveTemplates()) {
        const src = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(src, /css-latex|\/css\/login\.css|solutions\.css/, rel(file));
    }
});

test('css/bundle.css is exactly what scripts/build-css.js builds (run npm run build:css)', () => {
    const committed = fs.readFileSync(path.join(ROOT, 'css', 'bundle.css'), 'utf8');
    assert.ok(committed === buildBundle(), 'css/bundle.css is stale: a source changed without npm run build:css');
});

// ── 4. CSS every browser can read ───────────────────────────────────────────────────────

function nestingProblems(css) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    const problems = [];
    if (/@layer\b/.test(text)) problems.push('@layer');
    const stack = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            const prelude = text.slice(start, i).trim();
            const parent = stack[stack.length - 1];
            if (parent !== undefined && !/^@(media|supports|document|container)\b/.test(parent) && !/^@(keyframes|-webkit-keyframes)/.test(parent)) {
                problems.push(`nested "${prelude.slice(0, 40)}" inside "${parent.slice(0, 40)}"`);
            }
            stack.push(prelude);
            start = i + 1;
        } else if (text[i] === '}') {
            stack.pop();
            start = i + 1;
        } else if (text[i] === ';' && (stack.length === 0 || !/^@/.test(stack[stack.length - 1]))) {
            start = i + 1;
        }
    }
    return problems;
}

test('the nesting check catches nesting and passes media queries and keyframes', () => {
    assert.deepEqual(nestingProblems('@media (min-width: 768px) { .a { color: red; } }'), []);
    assert.deepEqual(nestingProblems('@keyframes x { 0% { opacity: 0; } 100% { opacity: 1; } }'), []);
    assert.equal(nestingProblems('.a { color: red; .b { color: blue; } }').length, 1);
    assert.equal(nestingProblems('@layer base { a { color: red; } }').length >= 1, true);
});

test('design-system.css and main_page.css use no @layer and no nesting', () => {
    for (const f of SOURCES) {
        assert.deepEqual(nestingProblems(fs.readFileSync(path.join(ROOT, 'css', f), 'utf8')), [], f);
    }
});

// ── 5. Must never serve a broken page ───────────────────────────────────────────────────

test('every live template compiles', () => {
    const failures = [];
    const templates = liveTemplates();
    assert.ok(templates.length >= 75, `only ${templates.length} live templates`);
    for (const file of templates) {
        try {
            ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file, views: [VIEWS] });
        } catch (err) {
            failures.push(`${rel(file)}: ${String(err.message).split('\n')[0]}`);
        }
    }
    assert.deepEqual(failures, []);
});

test('site_styles renders the documented links in cascade order', () => {
    const render = (ssStyles, lang = 'ru') => ejs.render(fs.readFileSync(PARTIAL, 'utf8'), {
        ssStyles, lang, asset: (p) => `${p}?v=abc`, mathCssVersion: '0123456789',
        siteFonts: { preload: { ru: ['/r.woff2'], en: ['/e.woff2'], proseRu: ['/pr.woff2'], proseEn: ['/pe.woff2'] } },
    }, { filename: PARTIAL });
    const full = render({ math: true, prose: true, icons: ['fa6', 'bi'], codemirror: true });
    const order = ['/r.woff2', '/pr.woff2', 'bootstrap.min.css', 'codemirror.min.css', 'fontawesome6', 'bootstrap-icons', '/css/bundle.css?v=abc', '/css/mathjax.css?v=0123456789'];
    let last = -1;
    for (const needle of order) {
        const at = full.indexOf(needle);
        assert.ok(at > last, `${needle} out of order`);
        last = at;
    }
    const bare = render({ bootstrap: false }, 'en');
    assert.doesNotMatch(bare, /bootstrap\.min\.css|mathjax\.css|\/pr\.woff2/);
    assert.match(bare, /\/e\.woff2/);
    assert.match(bare, /\/css\/bundle\.css\?v=abc/);
});
