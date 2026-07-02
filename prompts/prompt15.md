# Prompt 15: Performance, SEO, and Sitemap Updates

ultrathink

Read CLAUDE.md first. Then read sitemap.js and all head template files (views/default/main_site_header_head.ejs, head_en.ejs, head_ru.ejs).

This prompt optimizes site performance and ensures all new pages are properly indexed.

## Task 1: MathJax Upgrade to v3

Replace MathJax 2.7.7 with MathJax 3.x across the entire site.

In all templates that load MathJax, replace the old script tags with:

```html
<script>
MathJax = {
  tex: {
    inlineMath: [['$', '$'], ['\\(', '\\)']],
    displayMath: [['$$', '$$'], ['\\[', '\\]']],
    processEscapes: true
  },
  options: {
    skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
  }
};
</script>
<script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
```

Update any JavaScript that calls MathJax.Hub.Queue or MathJax.Hub.Typeset to use MathJax 3 API:
- Old: `MathJax.Hub.Queue(["Typeset", MathJax.Hub, element])`
- New: `MathJax.typesetPromise([element])`

Search the entire codebase for MathJax.Hub references and update all of them.

Also update the edit page live preview to use MathJax 3 rendering.

## Task 2: CSS Cleanup

Audit all CSS files. Remove or consolidate:

1. Delete css/metro-bootstrap.css if no metro-bootstrap class names are found in any template (search for metro-specific classes)
2. Delete css/bootstrap.css (Bootstrap 3.0.0 local) — verify it was removed in prompt 1, if not remove now
3. Consolidate css/general.css, css/style.css, and css/StyleMobile.css into a single css/solutions.css (they all style the solution page)
4. Remove any @font-face declarations for fonts not used (GothamPro, PT Sans if not actively referenced)
5. Add css/design-system.css to every page that doesn't already include it

Create a minified bundle: concatenate design-system.css + main_page.css + solutions.css into css/bundle.css. Serve this single file instead of multiple CSS files on every page. Use a simple Node.js script to generate it:

```javascript
// scripts/build-css.js
const fs = require('fs');
const files = ['css/design-system.css', 'css/main_page.css', 'css/solutions.css'];
const output = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
fs.writeFileSync('css/bundle.css', output);
console.log('CSS bundle created');
```

Add to package.json scripts: `"build:css": "node scripts/build-css.js"`

## Task 3: Image Optimization

Add WebP conversion for uploaded images. When an image is uploaded via Sharp:

```javascript
await sharp(inputPath)
  .webp({ quality: 85 })
  .toFile(outputPath.replace(/\.(jpg|jpeg|png)$/i, '.webp'));
```

In the image markdown transformer, generate `<picture>` tags:
```html
<picture>
  <source srcset="/img/1.1.1/diagram.webp" type="image/webp">
  <img src="/img/1.1.1/diagram.png" alt="..." loading="lazy">
</picture>
```

Only apply to new uploads. Don't batch-convert existing images (that can be a separate task).

## Task 4: Sitemap Updates

Update sitemap.js to include all new pages:

1. Blog posts: /blog/:slug (only is_published=true)
2. Bank problems: /bank/problem/:id
3. Forum topics: /discuss/:categorySlug/:topicId-:topicSlug
4. Study paths: /paths/:slug
5. Tool pages: /tools, /tools/formulas, /tools/units, /tools/constants, /tools/latex
6. Challenge pages: /compete (but not individual submissions)
7. Static pages: /about, /study-guide, /unsolved, /contributors, /blog, /bank, /discuss, /compete, /paths

Set appropriate changefreq and priority:
- Home page: daily, 1.0
- Solution pages: weekly, 0.8
- Blog posts: monthly, 0.7
- Bank problems: monthly, 0.7
- Forum topics: weekly, 0.5
- Tools: monthly, 0.6
- Paths: monthly, 0.6

Split into sub-sitemaps if total URLs exceed 10,000:
- sitemap_solutions.xml — all Savchenko solution pages
- sitemap_bank.xml — all bank problem pages
- sitemap_forum.xml — all forum topics
- sitemap_blog.xml — all blog posts
- sitemap_static.xml — all other pages

## Task 5: Structured Data for New Pages

Add JSON-LD to:

Blog posts: BlogPosting schema (already specified in prompt 9)
Forum topics: DiscussionForumPosting schema
Bank problems: Article with educationalLevel
Tools: WebApplication schema
Study paths: Course schema

## Task 6: Cache Static Assets

Add cache headers for static files in index.js:

```javascript
app.use('/css', express.static(path.join(__dirname, 'css'), { maxAge: '7d' }));
app.use('/js', express.static(path.join(__dirname, 'js'), { maxAge: '7d' }));
app.use('/img', express.static(path.join(__dirname, 'img'), { maxAge: '30d' }));
```

Add cache-busting via query string version: in templates, reference CSS as `/css/bundle.css?v=<%= Date.now() %>` (or use a build-time version hash).

## Task 7: Compression

Add gzip compression:

```
npm install compression
```

In index.js, add as the first middleware:
```javascript
const compression = require('compression');
app.use(compression());
```

This reduces response sizes by 60-80% for HTML, CSS, and JS.

## Task 8: Google Analytics

Add Google Analytics 4 tracking to the main head template. Use the measurement ID from the existing GA property (the user mentioned they have GA set up for savchenkosolutions.com).

Add the GA script tag to main_site_header_head.ejs:
```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

Replace G-XXXXXXXXXX with a placeholder and add a comment: "Replace with actual GA4 measurement ID"

Verify: MathJax 3 renders correctly on solution pages and edit page preview, CSS bundle loads, images have WebP sources, sitemap includes all new page types, compression is active (check response headers for Content-Encoding: gzip), cache headers are set.
