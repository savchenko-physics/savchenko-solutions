# CLAUDE.md — Savchenko Solutions

## What This Is
SavchenkoSolutions.com is a collaborative platform for peer-reviewed solutions to Savchenko's Problems in Physics, one of the hardest physics problem collections in the post-Soviet world. 1,516 solutions, 72 contributors from 18 countries, 150,000+ users from 150+ countries. All content free under Creative Commons CC BY-SA 4.0.

## Tech Stack
- **Runtime:** Node.js
- **Framework:** Express.js 4.21.1
- **Templates:** EJS with express-ejs-layouts
- **Database:** PostgreSQL (AWS RDS) via `pg` module
- **Sessions:** PostgreSQL via connect-pg-simple
- **Auth:** Custom bcrypt + express-session (no Passport in practice)
- **CSS:** Bootstrap 5.3.3 (CDN) + custom CSS files
- **Math:** MathJax 2.7.7 (CDN, upgrading to 3.x)
- **Editor:** CodeMirror 5.65.10 (edit page only)
- **No SPA framework. No TypeScript. No bundler. No build step.**

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
- `users` — 710 registered users
- `contributions` — 6,311 edits (post-migration)
- `github_contributions` — 11,493 edits (pre-migration, from GitHub Pages era)
- `solution_comments` — 89 threaded comments
- `solution_likes` — 325 likes/dislikes
- `solution_reports` — 51 pending reports (NO admin UI to review them)
- `page_views` / `recent_views` — view tracking
- `user_preferences` — privacy and notification settings
- `user_activities` — activity log (follows, likes, stars, comments)
- `starred_solutions` — bookmarked problems
- `special_contributions` — flagged edits (blocked IPs, emoji content)
- `session` — Express session store

## Critical Security Issues (fix these FIRST)
1. **Anyone can edit any solution without logging in.** `POST /:lang/save/:name` has no auth check.
2. **Anyone can upload solutions without logging in.** `POST /api/upload` has no auth check.
3. **Anyone can create problems without logging in.** `POST /create-problem` has no auth check.
4. **No rate limiting** on any endpoint (login, registration, API, search).
5. **Weak session secret fallback** — defaults to "your_secret_key" if env var missing.
6. **No CSRF protection.**
7. **No password reset flow.**
8. **No email verification on registration.**
9. **51 unreviewed reports** sitting in the database with no admin UI.
10. **Hardcoded IP blocklist** (13 IPs in source code instead of database).

## Known Technical Debt
- Dual Bootstrap: Bootstrap 5.3.3 (CDN) AND Bootstrap 3.0.0 (local `/css/bootstrap.css`) loaded simultaneously
- jQuery 1.10.1 still loaded on every page (nothing requires it)
- No build step: no minification, no bundling, no CSS concatenation
- MathJax 2.7.7 is slow; should upgrade to MathJax 3.x
- Search scans filesystem on every query (no search index)
- Multiple overlapping header templates: main_site_header.ejs, modern_header.ejs, header.ejs, header_mobile.ejs
- Legacy templates still exist: eng_page_old.ejs, profile.ejs
- `express.static(path.join(__dirname, "src"))` exposes Python source directory publicly
- Instagram field deprecated but column still in database
- Windows path separators in image paths (`\\` instead of `/`)

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
- 14 chapters, 78 sections, 2,023 total problems
- Problem naming: `chapter.section.problem` (e.g., 1.1.1, 14.5.24)
- Solutions stored as markdown files in `posts/en/` and `posts/ru/`
- Custom markdown image syntax: `![alt|WxH,scale%](../../img/folder/file)`
- LaTeX inline: `$...$`, display: `$$...$$`

## What NOT to Do
- Do NOT introduce TypeScript, React, Vue, Next.js, or any SPA framework.
- Do NOT add new npm dependencies unless absolutely necessary. Check if vanilla JS or an existing dependency can do the job.
- Do NOT modify the database schema without documenting the migration in `sql/migrations/`.
- Do NOT expose internal IPs, emails, or database credentials in client-side code.
- Do NOT use `res.send()` for HTML pages. Use `res.render()` with EJS templates.
- Do NOT add social media features (stories, reels, feeds). This is an academic tool.
- Do NOT add AI features (chatbots, auto-generated solutions). Every solution must be human-written.

## Testing
- No test framework is currently set up. When adding one, use Jest.
- At minimum, test: authentication middleware, API endpoints, input validation.
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
