# CLAUDE.md — Savchenko Solutions

## What This Is
SavchenkoSolutions.com is a collaborative platform for peer-reviewed solutions to Savchenko's Problems in Physics, one of the hardest physics problem collections in the post-Soviet world. 1,516 solutions, 72 contributors from 18 countries, 150,000+ users from 150+ countries. All content free under Creative Commons CC BY-SA 4.0.

## Front-End Assets
All render-critical third-party libraries are **self-hosted**, not loaded from a CDN
(see "What NOT to Do"). No page depends on an external origin to render.
- `css/vendor/` — Bootstrap 5.3.3, Bootstrap Icons, Font Awesome 6.4.0 + 4.7.0,
  CodeMirror 5.65.10 CSS, and `fonts/` (Inter, Roboto, STIX Two Math, Noto Serif,
  JetBrains Mono — all subsets incl. Cyrillic, generated from the Google Fonts API).
- `js/vendor/` — Bootstrap JS, Popper, Chart.js, D3, marked, html2canvas, jQuery,
  CodeMirror JS + modes/addons.
- MathJax 3 is served from the installed `mathjax-full` package at `/vendor/mathjax/`
  (mounted in `index.js` and `sandbox/sandbox-app.js`); keep that dependency installed.
- The sandbox app serves `/css`, `/js`, `/img` from the main app's directories — it is a
  separate Express app on its own subdomain and would otherwise 404 on shared assets.

## Tech Stack
- **Runtime:** Node.js
- **Framework:** Express.js 4.21.1
- **Templates:** EJS with express-ejs-layouts
- **Database:** PostgreSQL (AWS RDS) via `pg` module
- **Sessions:** PostgreSQL via connect-pg-simple
- **Auth:** Custom bcrypt + express-session (no Passport in practice)
- **CSS:** Bootstrap 5.3.3 (self-hosted, `css/vendor/`) + custom CSS files
- **Math:** MathJax 3 (self-hosted at `/vendor/mathjax/`); solution pages render LaTeX to SVG server-side (`mathRender.js`)
- **Editor:** CodeMirror 5.65.10 (edit page only)
- **No SPA framework. No TypeScript. No bundler.** One build step only: `npm run build:css`.

## Architecture
Monolithic server-side rendered Express app. All pages are EJS templates. Client-side JS handles search, form validation, CodeMirror, and Chart.js. Entry point is `index.js` (~2200 lines). A separate sandbox app runs on port 4000 (`sandbox/sandbox-app.js`).

## File Structure
```
index.js                          # Main Express app (all routes)
utils.js                          # Markdown parsing, XSS validation
post.js                           # Solution rendering + view tracking
upload.js                         # Upload router
contributions.js                  # Contribution display
contributorsUserMetricsApi.js     # Leaderboard and user stats API
userProfile.js                    # User profile rendering
unsolved.js                       # Unsolved problems display
sitemap.js                        # Sitemap XML generation
parents.js                        # Chapter/section data

views/                            # EJS templates (39 files)
posts/en/                         # English solution markdown files
posts/ru/                         # Russian solution markdown files
css/                              # Stylesheets
js/                               # Client-side JavaScript
img/                              # Images (per-problem subdirectories)
locales/en.json, ru.json          # i18n translations
src/database/                     # CSV data (chapters.csv, sections.csv)
pdf/                              # Textbook PDFs
```

## Database Tables (key ones)
Counts measured 2026-07-31. 61 tables in total; `sql/migrations/` only creates the ones
added after the GitHub-Pages migration, so `users`, `contributions`, `solution_comments`,
`solution_reports` and friends have no `CREATE TABLE` anywhere in the repo.
- `users` — 964 accounts, but only 118 ever seen online and **94 have ever contributed**
- `contributions` — 8,137 edits; 2,157 of them (27%) have `user_id = NULL`, from the era
  when anyone could edit anonymously
- `github_contributions` — 11,493 edits (pre-migration, from GitHub Pages era)
- `solution_comments` — 318 comments, **61% of them written by two people**
- `solution_likes` — 742 likes/dislikes
- `solution_reports` — 63 reports, **62 still pending**, mean age 245 days. Admin UI at
  `/admin/reports`; also surfaced on `/admin/feedback`
- `feedback_items` / `feedback_votes` / `poll_answers` — the suggestion box, the public
  board and the one-question poll (migration 042). All three accept anonymous writes
- `messages` / `conversations` — user-to-user DMs and the site-wide announcement channel
  (conversation 5, all users). Above 25 members a conversation is treated as an announcement
  channel and does not fan out one notification per member (`notifications.js:75`)
- `page_views` / `recent_views` — view tracking
- `user_preferences` — privacy and notification settings (**only 19 rows for 964 users**)
- `user_activities` — activity log (follows, likes, stars, comments)
- `starred_solutions` — bookmarked problems
- `special_contributions` — flagged edits (blocked IPs, emoji content)
- `problem_statements` (4,046) / `problem_difficulty` (2,023) — see Content Structure
- `session` — Express session store

## Security — open issues
1. **No CSRF protection anywhere.** Zero occurrences of `csrf` outside `node_modules`. The
   only mitigation is the session cookie's `sameSite: 'lax'` (`index.js:121`).
2. **`apiLimiter` is a no-op.** `index.js:146` sets `max: Number.MAX_SAFE_INTEGER`, so
   mounting it on `/api/` at `:191` protects nothing. Any new public endpoint must bring its
   own limiter (see `feedback.js`).
3. **`editSaveLimiter` collapses every signed-out visitor into one bucket** —
   `keyGenerator: (req) => String(req.session?.userId ?? 'anonymous')` (`index.js:182`). Same
   pattern in `brainstorm.js:168`. Key on `ipKeyGenerator(req.ip)` instead; a bare `req.ip`
   is also wrong, because one IPv6 client owns a whole /64.
4. **`express.static(path.join(__dirname, "src"))`** still exposes the Python source
   directory publicly.

### Fixed since this list was first written — do not "re-fix" these
Anonymous edit / upload / create-problem are all `checkAuthenticated` now (`index.js:2852`,
`upload.js:29`, `index.js:1652`). `SESSION_SECRET` throws on startup if unset
(`index.js:84`). Rate limiting exists (`express-rate-limit`, six limiters at
`index.js:130-186`). Password reset and email verification both ship (migrations 003, 015,
035). The report queue has an admin UI (`admin.js:140-215`) — the real problem is that
**62 of 63 reports are still pending at a mean age of 245 days**, which is a closure
problem, not a UI one; the `/admin/feedback` tab surfaces the backlog. The IP blocklist
moved to the `blocked_ips` table (migration 002).

## Known Technical Debt
- Dual Bootstrap: Bootstrap 5.3.3 AND Bootstrap 3.0.0 (local `/css/bootstrap.css`) loaded simultaneously (both self-hosted; neither is a CDN)
- jQuery 1.10.1 still loaded on every page (nothing requires it)
- **`npm run build:css` is a required step, not an optional one.** `main_site_header_head.ejs`
  loads `/css/bundle.css`, which `scripts/build-css.js` concatenates from `design-system.css`
  + `main_page.css` + `solutions.css`. Editing `design-system.css` without rebuilding ships
  invisible CSS. Some pages (`404.ejs`, `solution_post.ejs`, `views/feedback/*`) link the
  source files directly instead — an inconsistency worth resolving.
- Search scans filesystem on every query (no search index)
- **`views/default/modern_footer.ejs` is included by 43 templates but NOT by nine of them,
  including `solution_post.ejs`** — the most-visited page type on the site. Only
  `views/default/main_site_header.ejs` is genuinely on every page, so anything that must
  appear site-wide belongs there.
- Dead templates, zero includes: `modern_header.ejs`, `header_mobile.ejs`, `footer_en.ejs`,
  `footer_ru.ejs`, `eng_page_old.ejs`, `profile.ejs`. `header.ejs` is a one-line alias for
  `main_site_header.ejs`.
- **Dead `en.json` / `ru.json` at the repo root**, unrelated to `locales/*.json` and loaded by
  nothing. Edit only the files in `locales/` — they are tab-indented, and `updateFiles: false`
  (`index.js:2522`) means hand edits are safe.
- `express.static(path.join(__dirname, "src"))` exposes Python source directory publicly
- Instagram field deprecated but column still in database
- Windows path separators in image paths (`\\` instead of `/`)
- Features shipped with essentially zero usage, worth knowing before building another one:
  `bank_*` tables (0 rows across the whole problem bank), `bank_difficulty_votes` (0),
  `votes` (4), `user_interests` (4, three from one person), `user_preferences` (19 rows for
  964 users). Anything gated behind sign-in on this site collects nothing.

## Design System
All new UI must follow these rules:

### Colors
- Primary navy: #1a1a2e
- Text: #2d2d2d (never pure black)
- Secondary text: #6c757d
- Links: #1a5276 (hover: #0d3b54)
- Borders: #dee2e6
- Card backgrounds: #f8f9fa
- Page background: #ffffff
- Success: #27ae60
- Error: #c0392b

### Typography
- Headings: Inter, weight 600
- Body: system font stack (-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
- Solution content: Latin Modern Roman (already loaded)
- Code: JetBrains Mono

### Rules
- No gradients anywhere
- No shadows heavier than `0 1px 3px rgba(0,0,0,0.08)`
- No border-radius larger than 8px
- No emojis in the UI
- No "Built with love" or similar filler copy
- Inputs: 40px height, border 1px solid #dee2e6, border-radius 6px
- Buttons primary: background #1a1a2e, text #ffffff, border-radius 6px
- The site should feel like arXiv meets GitHub. Academic, clean, no-nonsense.

## Coding Standards

### JavaScript
- Vanilla JS only. No jQuery for new code.
- Use `const` and `let`, never `var`.
- Use template literals for string interpolation.
- Use async/await, not callbacks or raw promises.
- All database queries must use parameterized queries (`$1`, `$2`). Never concatenate user input into SQL.

### Express Routes
- All POST routes that modify data MUST check `req.session.userId`. If not authenticated, return 401 or redirect to login.
- Use `try/catch` around all database operations.
- Return proper HTTP status codes (200, 201, 400, 401, 404, 500).
- Flash messages for user-facing errors, JSON for API errors.

### EJS Templates
- Use `<%- include() %>` for shared partials.
- Escape all user-generated content with `<%= %>` (not `<%- %>`).
- Keep logic minimal in templates. Compute values in the route handler.

### CSS
- New styles go in `css/design-system.css` using CSS custom properties.
- Use Bootstrap 5 utility classes where possible.
- No inline styles in EJS templates.
- Mobile-first: write base styles for mobile, use `@media (min-width: 768px)` for desktop.

### Database
- All queries use the `pool` object from `pg`.
- Use `RETURNING *` on INSERT/UPDATE when you need the result.
- Use transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) for multi-step operations.
- Index any column used in WHERE clauses on large tables.

## Content Structure
- 14 chapters, 77 sections, 2,023 total problems (the third column of
  `src/database/sections.csv` is authoritative and sums to exactly 2,023)
- Problem statements live in the `problem_statements` table, 4,046 rows — one per problem
  per language, built by `scripts/build-statements.js`. Savchenko's own `∗` harder-problem
  marker is the `starred` column, 565 of 2,023, and is the only independent difficulty
  ground truth the project has: never feed it to a scoring model.
- **The 3rd edition is the reference for Russian statements and for every figure.**
  `pdf/savchenko-3rd-ed.pdf` is a pdfTeX file (exact text layer, figures as 300 dpi bitmaps
  with "К задаче N" drawn inside them), not a scan. `scripts/book3/` turns it into
  `src/database/book3/`: `extract.py` (text, ∗, ♦ = has-figure, from fonts and positions),
  `figures.py` (attributes every bitmap by OCR-reading its caption, writes
  `img/<problem>/statement.png` and `figures.json`), `vectorize.py` (traces those bitmaps
  with potrace into `statement.svg` — transparent, a few KB, crisp at any zoom; the SVG's
  own width/height attributes carry the display size; `figures.json` points at the SVGs,
  the PNGs stay as the trace source and as what `posts/` still embeds), `compare.py` /
  `assemble.py` (the site's
  markdown is kept only where its Cyrillic words and digits equal the book's; otherwise the
  book text, model-typeset by `typeset.py` under invariants that reject any changed word,
  digit, Latin or Greek symbol), `render-check.js` (MathJax must render every statement).
  `build-statements.js` prefers these files when present. A problem the book does not mark
  ♦ gets no figure even if a `statement.png` exists — that fallback is how 8.3.3 showed
  8.3.4's circuit. Do not hand-edit `figures.json`; fix `OVERRIDES` in `figures.py`.
- Problem naming: `chapter.section.problem` (e.g., 1.1.1, 14.5.24)
- Solutions stored as markdown files in `posts/en/` and `posts/ru/`. **`posts/` on the
  server is the contributors' work and the only authoritative copy**: the site's editor
  writes it directly (a pre-edit copy goes to `posts-old/`, the saved text to
  `contributions.new_content`), and the repo's copy lags behind. Never rsync local posts to
  the server and never let a script rewrite them — the statements table is the place for
  generated text.
- Custom markdown image syntax: `![alt|WxH,scale%](../../img/folder/file)`
- LaTeX inline: `$...$`, display: `$$...$$`

## What NOT to Do
- Do NOT introduce TypeScript, React, Vue, Next.js, or any SPA framework.
- Do NOT add new npm dependencies unless absolutely necessary. Check if vanilla JS or an existing dependency can do the job.
- Do NOT modify the database schema without documenting the migration in `sql/migrations/`.
- Do NOT expose internal IPs, emails, or database credentials in client-side code.
- Do NOT use `res.send()` for HTML pages. Use `res.render()` with EJS templates.
- Do NOT add social media features (stories, reels, feeds). This is an academic tool.
- Do NOT add AI features (chatbots, auto-generated solutions). Every solution must be
  human-written. Two narrow exceptions exist, both about *metadata*, never content:
  `scripts/score-difficulty.js` rates human-written problems on the axes in
  `difficultyRubric.js`, and `scripts/repair-ru-latex.js` re-typesets the mathematics in
  the Russian statements recovered from the scanned book (notation only — the prose is
  checked word-for-word against the original and a changed statement is rejected).
  Neither writes physics. Anything that would author or complete a solution is still out.
- Do NOT load stylesheets, fonts, or scripts from any third-party origin (jsdelivr, cdnjs, unpkg, Google Fonts, code.jquery.com, …). Every such origin is a single point of failure: a corporate or ISP web filter that blocks that one hostname leaves the site unstyled or broken for everyone behind it. This actually happened — `cdn.jsdelivr.net` is blocked by filters that classify it as a malware-distribution host, and Bootstrap was loaded from it on every page. Vendor new libraries into `css/vendor/` or `js/vendor/` and reference them with an absolute local path. `npm test` enforces this (`tests/external-assets.test.js`).
- Analytics (`googletagmanager`, `mc.yandex.ru`) is the one allowed exception: it is injected asynchronously and the page is fully usable without it.

## Testing
- `npm test` runs `node --test tests/` — Node's built-in runner. **No Jest, no test
  dependency**, and adding one is not wanted; the rationale is written down at
  `tests/brainstorm.test.js:1-10`.
- Suites: `botgate.test.js`, `external-assets.test.js`, `statements.test.js`,
  `brainstorm.test.js`, `feedback.test.js`.
- There is **no test database**, so route handlers are not integration-tested. The house
  pattern is to export the pure decision logic from a module and test that
  (`parseProblemLinks`, `validateFeedback`), then say plainly in the file header what is left
  uncovered.
- Two conventions worth keeping: a prose header explaining which real incident the file
  guards against, and — for anything that can reject a user — a closing block of
  "must never block a real person" invariants built from real traffic
  (`botgate.test.js`, `feedback.test.js`).
- `external-assets.test.js` walks the whole tree and fails on any third-party asset origin,
  so it will catch a CDN reference in a new template automatically.
- Run the app locally with `node index.js` on port 3000.

## Deployment
- Manual: `node index.js` (port 3000) + `node sandbox/sandbox-app.js` (port 4000)
- Database: AWS RDS PostgreSQL
- No Docker, no CI/CD pipeline currently
- Static assets served directly by Express (no CDN)

## When Compacting Context
Always preserve:
- The security issues list above
- The design system colors and rules
- The file structure
- Which files are currently being edited
- Any test failure messages from the current session
- Architecture decisions made in this session
