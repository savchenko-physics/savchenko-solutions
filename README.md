# Savchenko Solutions

The collection of physics problems edited by **O.Y. Savchenko** has been a cornerstone resource for physics olympiad preparation in post-Soviet countries for over 30 years. Despite its widespread use, no complete solution manual for this collection has ever been created — until now.

## About the Project

This project is a **non-profit, collaborative effort** aimed at creating the first comprehensive solution manual for Savchenko's collection. It features contributions from [different authors](https://savchenkosolutions.com/about#team) working together to make these solutions accessible.

- **Current Progress**: Over **1,516 solutions** out of 2,023 problems have been published.
- **Contributors**: 72 contributors from 18 countries.
- **Users**: 150,000+ users from 150+ countries.
- **Languages**: Russian and English.
- **License**: Creative Commons CC BY-SA 4.0.
- **Launch Year**: 2023.

## Features

- **Solution Browser** — 14 chapters, 78 sections, chapter grid with progress bars
- **Problem Bank** — curated problems from external sources, difficulty ratings, user attempts
- **Blog** — articles and guides with Markdown + LaTeX support
- **Discussion Forum** — threaded topics organized by category with voting
- **Weekly Challenges** — timed problem challenges with leaderboards
- **Study Paths** — guided problem sequences with progress tracking
- **Tools** — formula sheets, unit converter, physical constants, LaTeX reference
- **Contributor Rankings** — leaderboard, heatmap, country map
- **Admin Dashboard** — reports, flagged edits, user management, analytics
- **Notifications** — in-app notification system
- **Bilingual** — full English / Russian i18n throughout

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js 4.21
- **Templates**: EJS with express-ejs-layouts
- **Database**: PostgreSQL (AWS RDS) via `pg`
- **Auth**: bcrypt + express-session (PostgreSQL session store)
- **CSS**: Bootstrap 5.3 (CDN) + custom design system
- **Math**: MathJax 2.7 (CDN)
- **Search**: FlexSearch (in-memory index)
- **Editor**: CodeMirror 5.65 (edit page)

No SPA framework. No TypeScript. No bundler.

## Setup

```bash
# 1. Clone and install
git clone https://github.com/savchenko-physics/savchenko-solutions.git
cd savchenko-solutions
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your PostgreSQL credentials:
#   PG_USER, PG_HOST, PG_DATABASE, PG_PASSWORD, PG_PORT
#   SESSION_SECRET (random string)

# 3. Run database migrations
npm run migrate

# 4. Build CSS bundle
npm run build:css

# 5. Start the app
npm start          # production (port 3000)
npm run dev        # development with --watch
npm run sandbox    # sandbox app (port 4000)
```

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `start` | `node index.js` | Start production server |
| `dev` | `node --watch index.js` | Start with auto-reload |
| `sandbox` | `node sandbox/sandbox-app.js` | Start sandbox on port 4000 |
| `build:css` | `node scripts/build-css.js` | Bundle CSS files |
| `build` | `npm run build:css` | Alias for build:css |
| `migrate` | `node scripts/run-migrations.js` | Apply pending SQL migrations |

## Routes

### Main App (index.js) — ~70 routes
Core solution browsing, authentication, user profiles, contributions, search, sitemap.

### Routers

| Mount | File | Routes | Description |
|-------|------|--------|-------------|
| `/admin` | admin.js | 19 | Reports, flagged edits, users, blocked IPs, stats, challenges |
| `/bank` | bank.js | 11 | Problem bank browse, submit, attempt, difficulty, comments |
| `/blog` | blog.js | 9 | Blog posts, tags, comments, CRUD |
| `/discuss` | forum.js | 8 | Forum topics, replies, voting, marking solutions |
| `/paths` | paths.js | 5 | Study paths, progress tracking |
| `/tools` | tools.js | 5 | Formulas, units, constants, LaTeX reference |
| `/compete` | challenges.js | 4 | Weekly challenges, submissions, leaderboard |
| `/` | upload.js | 4 | Solution upload, validation |

**Total: ~135 routes**

## Database Migrations

Migrations live in `sql/migrations/` and are tracked in an `applied_migrations` table. Run `npm run migrate` to apply all pending migrations in order.

| File | Description |
|------|-------------|
| 001 | User settings and profile columns |
| 002 | Admin tables (reports, flagged edits, blocked IPs) |
| 003 | Password reset tokens |
| 004 | Blog (posts, tags, comments) |
| 005 | Problem bank (problems, sources, attempts, difficulty) |
| 006 | Forum (categories, topics, posts, votes) |
| 007 | Challenges and study paths |
| 008 | Notifications |

## File Structure

```
index.js                 # Main Express app (~2200 lines, all core routes)
admin.js                 # Admin dashboard router
bank.js                  # Problem bank router
blog.js                  # Blog router
forum.js                 # Forum router
challenges.js            # Challenges router
paths.js                 # Study paths router
tools.js                 # Tools router
notifications.js         # Notification helpers
upload.js                # Upload router
utils.js                 # Markdown, XSS, auto-linking
post.js                  # Solution rendering + view tracking
userProfile.js           # User profile rendering
searchIndex.js           # FlexSearch index builder
unsolved.js              # Unsolved problems display
sitemap.js               # Sitemap XML generation
parents.js               # Chapter/section data

views/                   # 53 EJS templates
  default/               # Shared partials (header, footer, head)
  admin/                 # Admin dashboard
  bank/                  # Problem bank
  blog/                  # Blog
  challenges/            # Challenges
  forum/                 # Forum
  paths/                 # Study paths
  tools/                 # Tools

posts/en/                # English solution markdown files
posts/ru/                # Russian solution markdown files
css/                     # 34 stylesheets
js/                      # Client-side scripts
img/                     # Images (per-problem subdirectories)
sql/migrations/          # 8 SQL migration files
scripts/                 # Build and migration scripts
locales/                 # en.json, ru.json (i18n)
pdf/                     # Textbook PDFs
```

## How to Contribute

<div align="center">
  <a href="https://youtu.be/d-x7Lk-mfTs">
    <img src="https://github.com/user-attachments/assets/69bf0ec9-6371-4fa6-9ade-3f6e6ac04584" alt="Collaborative Solutions for Physics Problems: Way to Change Physics Olympiad Preparation" style="width:50%; height:auto;">
  </a>
</div>

### Solutions
Visit the [study guide](https://savchenkosolutions.com/study-guide) to learn how to write and submit solutions. Solutions use Markdown with LaTeX math (`$...$` inline, `$$...$$` display) and a custom image syntax: `![alt|WxH,scale%](../../img/folder/file)`.

### Code
1. Fork the repository and create a feature branch.
2. Follow the coding standards in `CLAUDE.md` (vanilla JS, parameterized SQL, EJS escaping).
3. Test locally with `node index.js` on port 3000.
4. Document any database changes as a new migration in `sql/migrations/`.
5. Open a pull request with a clear description of the change.

### Reporting Issues
Open an issue on GitHub or email [aliaksandr@melnichenka.com](mailto:aliaksandr@melnichenka.com).

## License

Content is licensed under [Creative Commons CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
