# Savchenko Solutions — Comprehensive Platform Audit

> **Purpose:** Exhaustive documentation of every feature, page, route, and user-facing functionality for planning a major redesign.  
> **Generated:** 2026-04-07  
> **Domain:** savchenkosolutions.com

---

## Table of Contents

1. [Tech Stack & Architecture](#1-tech-stack--architecture)
2. [File & Folder Structure](#2-file--folder-structure)
3. [Database Schema](#3-database-schema)
4. [Environment Variables](#4-environment-variables)
5. [Pages & Routes](#5-pages--routes)
   - [Home Page](#51-home-page)
   - [Problem/Solution Pages](#52-problemsolution-pages)
   - [Edit Problem Page](#53-edit-problem-page)
   - [Upload Page](#54-upload-page)
   - [Search](#55-search)
   - [Global Search Page](#56-global-search-page)
   - [Unsolved Problems Page](#57-unsolved-problems-page)
   - [Study Guide Page](#58-study-guide-page)
   - [About Pages](#59-about-pages)
   - [Summit Page](#510-summit-page)
   - [Contributors/Leaderboard Page](#511-contributorsleaderboard-page)
   - [User Profile Page](#512-user-profile-page)
   - [User Settings Page](#513-user-settings-page)
   - [Login Page](#514-login-page)
   - [Registration Page](#515-registration-page)
   - [Contribution History Pages](#516-contribution-history-pages)
   - [File List Page](#517-file-list-page)
   - [Review Submission Page](#518-review-submission-page)
   - [404 Error Page](#519-404-error-page)
   - [Sandbox (Separate App)](#520-sandbox-separate-app)
6. [API Endpoints](#6-api-endpoints)
7. [Authentication & Session Management](#7-authentication--session-management)
8. [Internationalization (i18n)](#8-internationalization-i18n)
9. [Navigation Structure](#9-navigation-structure)
10. [Client-Side Libraries & Third-Party Services](#10-client-side-libraries--third-party-services)
11. [SEO](#11-seo)
12. [Analytics & Tracking](#12-analytics--tracking)
13. [Security Measures](#13-security-measures)
14. [Performance & Caching](#14-performance--caching)
15. [Static Assets & Build Process](#15-static-assets--build-process)
16. [Deployment](#16-deployment)
17. [Known Issues, Bugs & Missing Features](#17-known-issues-bugs--missing-features)

---

## 1. Tech Stack & Architecture

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js |
| **Framework** | Express.js v4.21.1 |
| **Template Engine** | EJS v3.1.10 (with express-ejs-layouts v2.5.1) |
| **Database** | PostgreSQL (AWS RDS) via `pg` v8.13.1 |
| **Session Store** | PostgreSQL via `connect-pg-simple` v10.0.0 |
| **Auth** | Custom (bcrypt v5.1.1 + express-session v1.18.1); Passport.js v0.7.0 declared but primarily manual session auth |
| **i18n** | `i18n` v0.15.1 (EN/RU) |
| **Markdown** | `marked` v14.1.4 + `gray-matter` for frontmatter |
| **HTML Sanitization** | `sanitize-html` v2.17.2 |
| **Image Processing** | Sharp v0.33.5 |
| **File Upload** | Multer v1.4.5-lts.1 + express-fileupload v1.5.1 |
| **Date Handling** | date-fns v4.1.0 |
| **YAML** | js-yaml v4.1.0 |
| **CSS Framework** | Bootstrap 5.3.3 (CDN) + custom CSS |
| **Math Rendering** | MathJax 2.7.7 (CDN) |
| **Code Editor** | CodeMirror 5.65.10 (CDN, edit page only) |
| **Syntax Highlighting** | PrismJS 1.21.0 (local) |
| **Diffing** | Google diff-match-patch (local) |
| **Charts** | Chart.js (CDN) |
| **Icons** | Bootstrap Icons 1.9.1 + Font Awesome 6.4.0 (CDN) |
| **jQuery** | v1.10.1 (local, legacy) |

**Architecture:** Monolithic server-side rendered Express app. All pages are EJS templates rendered on the server. Client-side JS handles search autocomplete, form validation, CodeMirror editing, and Chart.js visualizations. No SPA framework, no bundler, no build step.

**Two servers run concurrently:**
- Main app: `index.js` on port 3000
- Sandbox app: `sandbox/sandbox-app.js` on port 4000

---

## 2. File & Folder Structure

```
savchenko-solutions/
├── index.js                     # Main Express app (~2200 lines)
├── package.json                 # Dependencies (no scripts defined)
├── .env                         # Environment variables
├── .gitignore
├── README.md
│
├── # Core modules
├── utils.js                     # Markdown parsing, XSS validation, LaTeX-to-text
├── markdownParser.js            # Markdown rendering with gray-matter
├── post.js                      # Solution rendering + view tracking
├── upload.js                    # Upload router module
├── contributions.js             # Contribution display logic
├── contributions_list.js        # Contribution list rendering
├── contributorsUserMetricsApi.js# API: leaderboard, heatmaps, user stats
├── userProfile.js               # User profile rendering
├── unsolved.js                  # Unsolved problems display
├── file-list.js                 # File directory listing
├── sitemap.js                   # Sitemap XML generation (runs at startup)
├── parents.js                   # Chapter/section data and organization
├── profile.js                   # Profile-related utilities
│
├── views/                       # EJS templates (39 files)
│   ├── default/                 # Shared partials
│   │   ├── main_site_header.ejs
│   │   ├── main_site_header_head.ejs
│   │   ├── main_site_footer_scripts.ejs
│   │   ├── main_site_search_script.ejs
│   │   ├── modern_header.ejs
│   │   ├── modern_footer.ejs
│   │   ├── head_en.ejs / head_ru.ejs
│   │   ├── header.ejs / header_mobile.ejs
│   │   └── footer_en.ejs / footer_ru.ejs
│   ├── eng_page.ejs             # Home page
│   ├── solution_post.ejs        # Problem solution display
│   ├── post.ejs                 # Alternative solution display
│   ├── edit_post.ejs            # CodeMirror editor
│   ├── upload_page.ejs          # Upload form
│   ├── search.ejs               # Global search page
│   ├── search_results.ejs       # Search results
│   ├── unsolved.ejs             # Unsolved problems
│   ├── contributors_ranking.ejs # Leaderboard
│   ├── user_profile.ejs         # Public user profile
│   ├── user_settings.ejs        # User settings (tabs)
│   ├── login.ejs                # Login form
│   ├── register.ejs             # Registration form
│   ├── profile.ejs              # User dashboard (legacy)
│   ├── contribution.ejs         # Contribution diff view
│   ├── contributions_list.ejs   # Contribution history list
│   ├── review_submission.ejs    # "Submitted for review" confirmation
│   ├── about_en.ejs / about_ru.ejs
│   ├── study-guide.ejs
│   ├── summit.ejs
│   ├── file_list.ejs
│   ├── eng_page_old.ejs         # Legacy home page
│   └── 404.ejs
│
├── posts/                       # Markdown solution files
│   ├── en/                      # English solutions (e.g., 1.1.1.md)
│   └── ru/                      # Russian solutions
├── posts-old/                   # Archived/backup solution files
│
├── css/                         # Stylesheets
│   ├── design-system.css        # CSS custom properties / design tokens
│   ├── main_page.css            # Home page styles
│   ├── style.css                # Solution page styles
│   ├── general.css              # Problem container layout
│   ├── StyleMobile.css          # Mobile responsive overrides
│   ├── fonts.css                # @font-face declarations
│   ├── user_profile.css         # Profile page styles
│   ├── banner-styles.css        # Banner component
│   ├── bootstrap.css            # Bootstrap v3.0.0 (legacy)
│   ├── metro-bootstrap.css      # Metro-style UI extensions
│   └── css-latex/               # LaTeX-inspired academic styling
│       ├── style.css            # Latin Modern Roman fonts, dark mode
│       ├── login.css            # Auth form styles
│       ├── collapsible.css      # FAQ accordions
│       ├── header_mobile.css    # Mobile header
│       └── prism/               # PrismJS syntax highlighting
│           ├── prism.js
│           └── prism.css
│
├── js/                          # Client-side JavaScript
│   ├── jquery-1.10.1.min.js     # jQuery (legacy)
│   ├── bootstrap-affix.js       # Bootstrap sticky plugin
│   └── bootstrap-scrollspy.js   # Bootstrap scroll spy
│
├── public/                      # Static public assets
│   ├── robots.txt
│   ├── sitemap.xml              # Generated at startup
│   ├── sitemap_1.xml
│   ├── sitemap_recent.xml
│   ├── diff_match_patch.js      # Google diff library
│   ├── style.css                # Minimal public styles
│   └── fonts/                   # Web fonts (WOFF2, WOFF, TTF)
│
├── img/                         # Images
│   ├── {problem_number}/        # Per-problem images (e.g., img/1.1.1/)
│   ├── profile_images/          # User profile pictures
│   ├── uploads/                 # General uploads
│   └── *.svg                    # Logos, icons, UI graphics
│
├── locales/                     # i18n translation files
│   ├── en.json
│   └── ru.json
│
├── sql/migrations/              # Database migrations
│   └── 001_settings_profile_columns.sql
│
├── scripts/                     # Migration runner scripts
│   └── apply-migration-001.js
│
├── lib/                         # Utility libraries
│   └── countries.js             # Country list for dropdown
│
├── src/                         # Python utilities
│   ├── database/                # CSV data files (chapters.csv, sections.csv)
│   └── *.py                     # Data processing scripts
│
├── data/                        # Data files
├── en/                          # Static English content
├── theory/                      # Theory/reference materials
├── ru/theory/                   # Russian theory materials
├── pdf/                         # PDF textbook files
│   ├── savchenko.pdf            # Russian PDF
│   └── savchenko_en.pdf         # English PDF
│
├── sandbox/                     # Sandbox application (port 4000)
│   ├── sandbox-app.js           # Sandbox Express server
│   ├── db.js                    # Sandbox DB connection
│   ├── views/                   # Sandbox EJS templates
│   │   ├── layout.ejs
│   │   ├── index.ejs
│   │   ├── partials/header.ejs, footer.ejs
│   │   └── sandbox/sandbox-list.ejs, sandbox-new.ejs, sandbox-show.ejs
│   └── public/                  # Sandbox static assets
│
└── main.py, change-md.py        # Python utility scripts
```

---

## 3. Database Schema

**Database:** PostgreSQL on AWS RDS  
**Database name:** `savchenko`

### Core Tables

#### `users`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| username | VARCHAR UNIQUE | 2-32 chars, pattern: `[a-zA-Z0-9._-]` |
| email | VARCHAR UNIQUE | |
| password | VARCHAR | bcrypt hash (10 rounds) |
| full_name | VARCHAR | |
| bio | VARCHAR | Max 300 chars |
| profile_picture | VARCHAR | Path to uploaded image |
| country_location | VARCHAR | |
| institution | VARCHAR | |
| github | VARCHAR | GitHub profile URL |
| linkedin | VARCHAR | LinkedIn profile URL |
| personal_website | VARCHAR | |
| instagram | VARCHAR | **Deprecated** — set to NULL on profile update |
| is_verified_user | BOOLEAN | Verified badge for leaderboard |
| created_at | TIMESTAMP | |
| pending_email | VARCHAR | For email change flow |
| email_change_token | VARCHAR | 32-byte hex token |
| email_change_expires | TIMESTAMP | Token expiry (24 hours) |

#### `user_preferences`
| Column | Type | Notes |
|--------|------|-------|
| user_id | FK → users | |
| public_profile | BOOLEAN | |
| show_online_status | BOOLEAN | |
| email_notifications | BOOLEAN | |
| privacy_level | VARCHAR | |
| show_country_on_leaderboard | BOOLEAN | Default TRUE |
| updated_at | TIMESTAMP | |

#### `contributions`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| user_id | FK → users (nullable) | NULL for anonymous |
| problem_name | VARCHAR | e.g. "1.1.1" |
| language | VARCHAR | 'en' or 'ru' |
| original_content | TEXT | Before edit |
| new_content | TEXT | After edit |
| ip_address | VARCHAR | For anonymous tracking |
| content_changed | BOOLEAN | |
| full_name | VARCHAR | For anonymous submissions |
| edited_at | TIMESTAMP | |
| coauthors | JSON | Array of co-authors |
| invisible | BOOLEAN | Soft-delete/hide flag |

#### `github_contributions`
Same structure as `contributions` plus: `caption`, `commit` (git metadata)

#### `special_contributions`
Review queue for blocked IPs or emoji-containing edits. Same fields as contributions.

#### `solution_comments`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| user_id | FK → users | |
| problem_name | VARCHAR | |
| language | VARCHAR | |
| content | TEXT | |
| parent_id | FK → self (nullable) | Threading support |
| is_deleted | BOOLEAN | Soft delete |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

#### `solution_likes`
| Column | Type | Notes |
|--------|------|-------|
| user_id | FK → users | |
| problem_name | VARCHAR | |
| language | VARCHAR | |
| is_like | BOOLEAN | true=like, false=dislike |

#### `starred_solutions`
| Column | Type | Notes |
|--------|------|-------|
| user_id | FK → users | |
| problem_name | VARCHAR | |
| language | VARCHAR | |

#### `solution_reports`
| Column | Type | Notes |
|--------|------|-------|
| user_id | FK → users (nullable) | |
| problem_name | VARCHAR | |
| language | VARCHAR | |
| reason | TEXT | |
| ip_address | VARCHAR | |
| created_at | TIMESTAMP | |

#### `user_follows`
| Column | Type | Notes |
|--------|------|-------|
| follower_id | FK → users | |
| following_id | FK → users | |

#### `user_activities`
| Column | Type | Notes |
|--------|------|-------|
| user_id | FK → users | |
| activity_type | VARCHAR | 'follow', 'unfollow', 'like', 'dislike', 'star', 'comment' |
| target_user_id | FK → users | For follow actions |
| target_problem | VARCHAR | |
| target_language | VARCHAR | |
| metadata | JSON | |

#### `page_views` / `page_views_old` / `recent_views`
View tracking per problem. `recent_views` tracks IP + problem to deduplicate within short windows.

#### `session`
Express-session store (managed by connect-pg-simple): `sid`, `sess`, `expire`

#### Sandbox tables: `solutions`, `comments`, `votes`
Separate tables for the sandbox feature on port 4000.

---

## 4. Environment Variables

| Variable | Purpose | Default/Fallback |
|----------|---------|-----------------|
| `PG_USER` | PostgreSQL username | — |
| `PG_HOST` | PostgreSQL host | — |
| `PG_DATABASE` | Database name | — |
| `PG_PASSWORD` | Database password | — |
| `PG_PORT` | Database port | 5432 |
| `PG_SSL_REJECT_UNAUTHORIZED` | SSL verification | false |
| `SESSION_SECRET` | Session encryption key | `"your_secret_key"` **(weak default)** |
| `NODE_ENV` | Environment mode | — |
| `SANDBOX_PORT` | Sandbox server port | 4000 |

---

## 5. Pages & Routes

### 5.1 Home Page

**URLs:** `/`, `/en`, `/en/`, `/ru`, `/ru/`  
**Template:** `eng_page.ejs`  
**Rendering:** Server-side  

**UI Elements:**
- Hero section with tagline and introduction text (translated via i18n)
- Statistics counters (total solutions, contributors count, etc.) from `getSolutionProgressStats()`
- Recent contributions list (last 10) showing problem name, editor name, "View Changes" link
- Top authors section from `getTopAuthors()`
- Platform update announcement with feedback link
- Problem statements PDF download links (EN/RU)
- Full chapter/section table of contents with problem links
- "See all..." link for contributions

**Database Queries:**
- Recent contributions: last 10 from `contributions` + `github_contributions` where `invisible = false` and `content_changed = true`
- Top authors: aggregated contributor counts
- Solution progress stats: total problems vs solved

**User Actions:**
- Click any problem link → navigates to `/{lang}/{problem_name}`
- Click chapter/section anchors → scrolls to section
- Click "View Changes" on contribution → `/{lang}/contributions/{problem_name}`
- Download PDF textbook
- Language switch (EN↔RU)

**Logged-in vs Logged-out:** No difference in content. Navbar shows user avatar/menu (logged-in) or login button (logged-out).

**Mobile:** Responsive via Bootstrap grid. Hero section stacks. Table of contents becomes scrollable.

---

### 5.2 Problem/Solution Pages

**URLs:** `/:lang/:name` (e.g., `/en/1.1.1`, `/ru/3.2.5`)  
**Template:** `solution_post.ejs` (rendered via `post.js` → `renderPost()`)  
**Rendering:** Server-side with client-side MathJax rendering

**How content is loaded:**
1. Reads `posts/{lang}/{name}.md` from filesystem
2. Parses YAML frontmatter (title, author, date, etc.)
3. Converts markdown to HTML via `marked` with custom renderer
4. Transforms image markdown syntax (custom `![alt|WxH,scale%](../../img/...)` format)
5. Sanitizes output via `sanitize-html`
6. MathJax renders LaTeX client-side after page load

**UI Elements:**
- Breadcrumb navigation (Chapter → Section → Problem)
- Problem title and number
- Solution content (rendered markdown with LaTeX math, images, embedded YouTube videos)
- Contributor attribution section (fetched via `/api/contributors/{problemRef}`)
- Social interaction bar:
  - Like button (thumbs up + count)
  - Dislike button (thumbs down + count)
  - Star/bookmark button (star + count)
  - Comment count
  - Report button
  - View count
- Comments section (threaded, fetched via API)
- Edit button → navigates to `/{lang}/edit/{name}`
- Upload button → navigates to `/{lang}/upload`
- Page view counter

**Database Queries (on page load):**
- `page_views`: INSERT or UPDATE view count for problem
- `recent_views`: Check if IP already viewed recently (dedup)
- Stats fetched client-side via `/api/solutions/{name}/{lang}/stats`
- Comments fetched client-side via `/api/solutions/{name}/{lang}/comments`
- Contributors fetched via `/api/contributors/{problemRef}`

**LaTeX Rendering:**
- MathJax 2.7.7 with TeX input → HTML-CSS output
- Inline math: `$...$` or `\(...\)`
- Display math: `$$...$$` or `\[...\]`
- Processes elements with class `tex2jax`

**Image Handling:**
- Custom markdown syntax: `![alt|WxH,scale%](../../img/folder/file)`
- Transformed to `<figure><img>` with lazy loading
- Images served from `/img/{problem_name}/` static directory
- Scale percentage maps to pixel width (600px * scale%)

**Comments (Client-Side):**
- Fetched via `GET /api/solutions/:problemName/:language/comments`
- Threaded via `parent_id`
- Shows author username, profile picture, timestamp
- Add comment requires login
- Replies supported (nested)

**Likes/Dislikes (Client-Side):**
- `POST /api/solutions/:problemName/:language/like` with `{isLike: boolean}`
- Toggle behavior: like → unlike, like → dislike, etc.
- Logged in `user_activities`

**Starring (Client-Side):**
- `POST /api/solutions/:problemName/:language/star`
- Toggle star/unstar
- Logged in `user_activities`

**Reporting:**
- `POST /api/report-solution` with `{problemName, language, reason}`
- Stored in `solution_reports` table
- No moderation UI exists to review reports

**Logged-in vs Logged-out:**
- Logged-out: Can view everything, cannot like/dislike/star/comment/report
- Logged-in: Full interaction capabilities

**Redirects:**
- Bare problem number URLs (e.g., `/1.1.1`) redirect to `/en/1.1.1`
- Chapter numbers (e.g., `/5`) redirect to `/ru/#5`

---

### 5.3 Edit Problem Page

**URLs:** `/:lang/edit/:name` (e.g., `/en/edit/1.1.1`)  
**Template:** `edit_post.ejs`  
**Rendering:** Server-side + heavy client-side (CodeMirror + MathJax live preview)

**UI Elements:**
- Split-pane editor (50/50):
  - Left: CodeMirror editor (markdown + LaTeX mode)
  - Right: Live preview (rendered markdown + MathJax)
- Resizable divider between panes
- Save button
- Image upload functionality

**Libraries loaded:**
- CodeMirror 5.65.10 (markdown + stex modes, bracket matching, active line)
- Marked.js 4.3.0 (client-side preview rendering)
- MathJax 2.7.7 (live math rendering in preview)

**On Save (`POST /:lang/save/:name`):**
1. Validates content via `validateSolutionMarkdownContent()` (XSS checks)
2. Checks against blocked IP list (13 hardcoded IPs)
3. Detects emoji → sends to `special_contributions` review queue
4. Creates backup in `posts-old/` with timestamp and IP
5. Saves new content to `posts/{lang}/{name}.md`
6. Records in `contributions` table
7. If blocked/flagged → renders `review_submission.ejs` instead

**Authentication:** No authentication required to edit! Anyone can edit. Edits tracked by IP for anonymous users, by user_id for logged-in users.

**Admin/Verified:** No special permissions for editing.

**SEO:** `<meta name="robots" content="noindex, nofollow">` — edit pages excluded from indexing.

---

### 5.4 Upload Page

**URLs:** `/upload`, `/:lang/upload`  
**Template:** `upload_page.ejs`  
**Rendering:** Server-side form + heavy client-side JS

**UI Elements:**
- Problem number input (format: `chapter.section.problem`)
- Real-time problem validation (debounced 750ms):
  - `GET /api/verify-problem/{name}?language={lang}` — checks if already exists
  - `GET /api/validate-limits/{chapter}/{section}/{problem}` — validates against chapter/section structure
- Solution method radio buttons:
  - **LaTeX/Markdown** — textarea with LaTeX preview
  - **Upload Scans/Photos** — drag-and-drop zone
- Language selection (EN/RU)
- User information (full name) — shown for anonymous users
- Drag-and-drop file upload zone:
  - Accepts image/* only (JPEG, PNG, GIF, SVG)
  - Per-file limit: 5MB
  - Total limit: 20MB
  - Up to 20 files
  - Image preview grid with fade-out animation
- Image preview modal (Bootstrap Modal):
  - Navigation (prev/next + arrow keys)
  - Zoom (1.5x on click)
  - Image counter
  - Escape to close
- Optional illustrations upload
- Submit button

**On Submit (`POST /api/upload`):**
1. Validates problem format and limits
2. Processes images with Sharp
3. Creates markdown file in `posts/{lang}/{name}.md`
4. Stores images in `img/{problemName}/`
5. Records in `contributions` table
6. Returns redirect URL to new problem page

**URL Hash Support:** `#1.2.3` pre-fills the problem number on page load.

**Authentication:** Not required. Anonymous uploads tracked by IP + full name.

---

### 5.5 Search

**URL:** `/search?q={query}&lang={lang}` (API endpoint)  
**Response:** JSON `{results: [...]}`  
**Rendering:** Client-side (called from header search bar)

**How search works:**
1. Scans `posts/{lang}/` directories for `.md` files
2. Matches against filename AND file content
3. Converts LaTeX to plaintext for comparison
4. Returns max 10 results

**Ranking:**
- Filename matches ranked higher than content matches
- Exact filename match in user's language = "high" confidence
- Other matches = "medium" confidence
- User's language results appear first

**Result format:**
```json
{
  "lang": "en",
  "name": "1.1.1",
  "relativePath": "/en/1.1.1",
  "snippet": "...matching text...",
  "isFileNameMatch": true,
  "confidence": "high"
}
```

**No pre-built search index** — real-time filesystem search on every query.

**Header search bar behavior:**
- Live results dropdown as user types
- Debounced input
- Shows confidence indicator (star for high confidence)
- "No results" state with CTA to upload or use advanced search
- Click outside to dismiss

---

### 5.6 Global Search Page

**URLs:** `/global-search?search={query}&lang={lang}`  
**Template:** `search.ejs`  
**Rendering:** Server-side

**UI Elements:**
- Search input field
- Results list with:
  - Problem name/link
  - Snippet preview
  - Line number
  - Confidence indicator
  - Language badge
- Language filter

---

### 5.7 Unsolved Problems Page

**URLs:** `/unsolved`, `/:lang/unsolved`  
**Template:** `unsolved.ejs`  
**Rendering:** Server-side + client-side (Chart.js)

**UI Elements:**
- Overall progress statistics:
  - Total problems count
  - Current language solutions count
  - Other language solutions count
  - Total unique solutions across languages
- Animated counter values (requestAnimationFrame)
- Per-section breakdown:
  - Chapter/section header
  - Pie chart (Chart.js) showing solved vs unsolved
  - List of unsolved problem numbers as links
  - "Exists in other language" indicator

**Data source:** `getSolutionProgressStats()` — compares filesystem problem files against known chapter/section structure from CSV data.

**User Actions:**
- Click unsolved problem → navigate to upload or create page
- Filter by chapter/section (visual grouping)

---

### 5.8 Study Guide Page

**URLs:** `/study-guide`, `/:lang/study-guide`  
**Template:** `study-guide.ejs`  
**Rendering:** Server-side

Study materials and recommended resources for physics problem-solving.

---

### 5.9 About Pages

**URLs:** `/about` (English), `/ru/about` (Russian), `/en/about` → redirects to `/about#description`  
**Templates:** `about_en.ejs`, `about_ru.ejs`  
**Rendering:** Server-side

**UI Elements:**
- Project description and mission statement
- Core team section with member details
- Acknowledgments section
- "How to contribute" guide links
- Team photo with caption

---

### 5.10 Summit Page

**URLs:** `/summit`, `/ru/summit`  
**Template:** `summit.ejs`  
**Rendering:** Server-side

Event/summit information page.

---

### 5.11 Contributors/Leaderboard Page

**URLs:** `/contributors`, `/:lang/contributors`  
**Template:** `contributors_ranking.ejs`  
**Rendering:** Server-side template + client-side data loading via API

**API Endpoints Called:**
- `GET /api/contributors/stats` — global statistics
- `GET /api/contributors/leaderboard?page=&limit=&sortBy=&sortOrder=` — paginated leaderboard
- `GET /api/contributors/map` — contributors by country
- `GET /api/contributors/heatmap` — activity heatmap (last 12 months)

**Leaderboard Columns:**
- Rank
- Username (linked to profile)
- Full name
- Profile picture
- Country + flag emoji
- Unique solutions count
- Score (calculated as: `ROUND(19 * LN(unique_solutions * SQRT(total_edits)))`)
- Joined date
- Last active date
- Verified badge (for `is_verified_user = true`)

**Global Stats Displayed:**
- Total contributors
- Total solutions
- Countries represented
- Languages count

**Caching:** All endpoints cached with `Cache-Control: public, max-age=3600` (1 hour TTL) and in-memory cache.

---

### 5.12 User Profile Page

**URLs:** `/user/:username`  
**Template:** `user_profile.ejs` (rendered via `userProfile.js` → `getUserProfile()`)  
**Rendering:** Server-side template + client-side API calls for stats

**UI Elements:**
- Profile header:
  - Profile picture (default: `Default_placeholder.svg`)
  - Full name
  - Username
  - Bio
  - Country + flag
  - Institution
  - Social links (GitHub, LinkedIn, website)
  - Verified badge (if `is_verified_user`)
  - Follow/Unfollow button (for other users' profiles)
- Statistics section (loaded via APIs):
  - Solutions count
  - Edits count
  - Translations count
  - Likes received
  - Collaborators (up to 12)
  - First/last contribution dates
- Activity heatmap (`GET /api/user/:username/heatmap`) — 12 months
- Radar chart (`GET /api/user/:username/radar`) — category breakdown
- Timeline (`GET /api/user/:username/timeline`) — monthly contributions
- Contributions list (`GET /api/user/:username/contributions`)
- Sankey diagram (`GET /api/user/:username/sankey`) — chapter→section→problem flow

**Special: Admin user "astrosander"** gets additional platform overview stats.

**Follow/Unfollow:**
- `POST /api/follow/:userId`
- Toggles follow state
- Logged in `user_activities`
- Requires authentication

---

### 5.13 User Settings Page

**URLs:** `/settings`, `/:lang/settings`  
**Template:** `user_settings.ejs`  
**Rendering:** Server-side  
**Auth Required:** Yes (`checkAuthenticated`)

**Tab-based interface with 4 tabs:**

#### Profile Tab (`POST /:lang/settings/profile`)
- Full name (text)
- Username (2-32 chars, pattern: `[a-zA-Z0-9._-]`) with real-time availability check via `GET /:lang/api/username-available`
- Country/Location (dropdown from countries list)
- Institution/School
- Bio (textarea, max 300 chars with character counter)
- Profile picture upload (JPG, PNG, GIF, WebP — max 5MB)
- Social links: GitHub URL, LinkedIn URL, Personal website

#### Privacy Tab (`POST /:lang/settings/privacy`)
- Public profile toggle
- Email notifications toggle
- Show country on leaderboard toggle
- Stored in `user_preferences` table (UPSERT)

#### Password Tab (`POST /:lang/settings/password`)
- Current password (verified via bcrypt)
- New password (min 8 characters)
- Confirm new password

#### Account Tab
- Current email display (read-only with lock icon)
- Email change request (`POST /:lang/settings/account/email`):
  - New email + password verification
  - Generates 32-byte hex token (valid 24 hours)
  - Sends confirmation link (logged to console in non-production — **email sending not fully implemented**)
  - Confirmation: `GET /:lang/settings/confirm-email?token=...`
- Account deletion (`POST /:lang/settings/account/delete`):
  - Requires password confirmation
  - Hard deletes from `users` table
  - Destroys session

---

### 5.14 Login Page

**URLs:** `/login`, `/en/login`, `/ru/login`  
**Template:** `login.ejs`  
**Auth:** `checkNotAuthenticated` (redirects to profile if already logged in)

**Form Fields:**
- Username (text, required)
- Password (password, required) with eye toggle
- Submit button
- Link to registration page

**On Submit (`POST /login`):**
1. Queries `users` table by username
2. Compares password via bcrypt
3. Sets session: `userId`, `username`, `lang`
4. Redirects to `/{lang}/profile`
5. On failure: redirects back with error message

**Validation:** Server-side only. No client-side validation beyond required fields.

---

### 5.15 Registration Page

**URLs:** `/register`, `/en/register`, `/ru/register`  
**Template:** `register.ejs`  
**Auth:** `checkNotAuthenticated`

**Form Fields:**
- Username (text, required)
- Full name (text, required)
- Email (email, required)
- Password (password, required) with eye toggle
- Password confirmation (password, required) with eye toggle
- Submit button
- Link to login page

**Client-side Validation:**
- Password and confirmation must match

**On Submit (`POST /register`):**
1. Validates all fields present
2. Checks passwords match
3. Hashes password via bcrypt (10 rounds)
4. Inserts into `users` table
5. Handles unique constraint violation (error 23505) for duplicate username/email
6. Redirects to login with success message

**No email verification** after registration. Account is immediately active.

---

### 5.16 Contribution History Pages

**View Contribution Diff:**
- **URL:** `/:lang/contributions/:problemName` (when problemName has specific format)
- **Template:** `contribution.ejs`
- Shows side-by-side diff of original vs new content
- Uses `diff_match_patch.js` for diff computation

**View Contributions List:**
- **URL:** `/:lang/contributions/:problemName` (list format)
- **Template:** `contributions_list.ejs`
- Lists all edits for a problem with timestamps, editors, change indicators

---

### 5.17 File List Page

**URL:** `/file-list`  
**Template:** `file_list.ejs` (rendered via `file-list.js`)

Lists old post files from `posts-old/` directory with metadata (version, IP, size, dates).

---

### 5.18 Review Submission Page

**Template:** `review_submission.ejs`  
**Not a direct URL** — rendered when an edit is flagged for review (blocked IP or emoji content).

Displays confirmation message: "Your edits have been successfully submitted for review!"

---

### 5.19 404 Error Page

**Template:** `404.ejs`

**UI Elements:**
- Large "404" display
- "This page disappeared into a black hole" heading
- Hint message with link back to home page
- Team image
- `<meta name="robots" content="noindex">`

---

### 5.20 Sandbox (Separate App)

**Port:** 4000 (or auto-increment if busy)  
**Entry:** `sandbox/sandbox-app.js`  
**Database:** Same PostgreSQL, separate tables (`solutions`, `comments`, `votes`)

**Routes:**

| URL | Method | Description |
|-----|--------|-------------|
| `/`, `/sandbox`, `/:lang/sandbox` | GET | List all solutions |
| `/sandbox/new`, `/:lang/sandbox/new` | GET | New solution form |
| `/sandbox` | POST | Submit solution |
| `/sandbox/:id`, `/:lang/sandbox/:id` | GET | View solution with comments and votes |
| `/sandbox/:id/comment` | POST | Add comment (auth required) |
| `/sandbox/:id/vote` | POST | Vote up/down (auth required) |
| `/api/upload` | POST | Upload solution with files |
| `/api/verify-problem/:name` | GET | Check if problem exists |
| `/api/validate-limits/:ch/:sec/:prob` | GET | Validate problem number |

**Features:** Solution submission (LaTeX or scans), threaded comments, upvote/downvote system, file uploads with image validation.

---

## 6. API Endpoints

### Social Interactions
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/follow/:userId` | POST | Yes | Follow/unfollow user |
| `/api/solutions/:name/:lang/like` | POST | Yes | Like/dislike solution |
| `/api/solutions/:name/:lang/star` | POST | Yes | Star/unstar solution |
| `/api/solutions/:name/:lang/stats` | GET | No | Get solution stats (likes, dislikes, stars, comments) |
| `/api/solutions/:name/:lang/comments` | GET | No | Get comments (threaded) |
| `/api/solutions/:name/:lang/comments` | POST | Yes | Add comment |
| `/api/report-solution` | POST | No* | Report a solution |

### Contributors & Stats
| Endpoint | Method | Auth | Cache | Description |
|----------|--------|------|-------|-------------|
| `/api/contributors/stats` | GET | No | 1hr | Global stats |
| `/api/contributors/leaderboard` | GET | No | 1hr | Paginated leaderboard |
| `/api/contributors/map` | GET | No | 1hr | Contributors by country |
| `/api/contributors/heatmap` | GET | No | 1hr | Activity heatmap (12mo) |
| `/api/user/:username/stats` | GET | No | 1hr | User profile stats |
| `/api/user/:username/heatmap` | GET | No | 1hr | User activity calendar |
| `/api/user/:username/radar` | GET | No | 1hr | Category breakdown |
| `/api/user/:username/timeline` | GET | No | 1hr | Monthly timeline |
| `/api/user/:username/contributions` | GET | No | 1hr | Contribution list |
| `/api/user/:username/sankey` | GET | No | 1hr | Sankey diagram data |

### Content Management
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/upload` | POST | No | Upload solution (main app) |
| `/api/verify-problem/:id` | GET | No | Check if problem exists |
| `/api/validate-limits/:ch/:sec/:prob` | GET | No | Validate problem number |
| `/api/contributions/:id` | GET | Yes | User's contributions (paginated) |
| `/api/contributors/:problemRef` | GET | No | Contributors for a problem |
| `/api/page-views/:name` | GET | No | Page view data |
| `/upload-image/:name` | POST | No | Upload image for problem |
| `/img/:name` | GET | No | List images in directory |

### User Management
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/:lang/api/username-available` | GET | Yes | Check username availability |
| `/search` | GET | No | Search (JSON results) |
| `/create-problem` | POST | No | Create new problem file |

---

## 7. Authentication & Session Management

### Session Configuration
```javascript
{
  store: PostgreSQL (connect-pg-simple),
  secret: process.env.SESSION_SECRET || "your_secret_key",
  cookie: {
    secure: NODE_ENV === 'production',
    maxAge: 365 days,
    httpOnly: true,
    sameSite: 'lax'
  }
}
```

### Session Data Stored
- `userId` — user's database ID
- `username` — display username
- `lang` — current language preference

### Auth Middleware
- `checkAuthenticated`: Verifies `req.session.userId` exists → redirects to login if not
- `checkNotAuthenticated`: Prevents logged-in users from accessing login/register → redirects to profile

### Password Handling
- Hashing: bcrypt with 10 salt rounds
- Comparison: `bcrypt.compare()` for login and settings changes
- Minimum length: 8 characters (enforced on password change, not on registration)

### Password Reset
**Not implemented.** There is no "forgot password" flow. Users must contact admin.

### Email Change Flow
1. User submits new email + current password
2. System generates 32-byte crypto token, stores in `pending_email`, `email_change_token`, `email_change_expires` (24hr)
3. Confirmation URL logged to console (email sending not implemented in production)
4. User visits confirmation URL → email updated

---

## 8. Internationalization (i18n)

**Library:** `i18n` v0.15.1  
**Languages:** English (`en`), Russian (`ru`)  
**Locale files:** `locales/en.json`, `locales/ru.json`

### How it works
- Language determined by URL prefix: `/:lang/...` (e.g., `/en/1.1.1`, `/ru/1.1.1`)
- Stored in session (`req.session.lang`) and cookie (`lang`)
- Default locale: English
- Template usage: `<%= __('key.path') %>` for translated strings
- `updateFiles: false` — locale files are not auto-updated

### What is translated
- All UI text (navigation, buttons, labels, messages, error messages)
- Static content (about pages have separate templates: `about_en.ejs`, `about_ru.ejs`)
- Head sections have language-specific includes: `head_en.ejs`, `head_ru.ejs`
- Footer has language-specific includes

### What is NOT translated
- Solution content (solutions exist as separate files per language)
- User-generated content (comments, bios)
- Some error messages fall back to English

### Language Switching
- Toggle link in navbar: `/{other_lang}/{current_path}`
- Mobile: toggle in hamburger menu
- Flag images (40x40px circular) for visual identification

---

## 9. Navigation Structure

### Desktop Navbar
```
[Logo + Site Title] [Search Bar] [Language Toggle] [Upload Button] [User Menu / Login]
```

### User Menu (logged-in dropdown):
- Profile → `/user/{username}`
- Settings → `/{lang}/settings`
- Logout → `/logout`

### Footer (modern_footer.ejs)
```
About                    Quick Links              Community
├── Social links         ├── Home                 ├── Discord
│   GitHub               ├── About                ├── Help
│   Discord              ├── Study Guide          ├── Report Issues
│   Twitter              ├── Unsolved             └── Suggest Features
│   LinkedIn             └── Settings/Login

[Platform Stats: Solutions | Contributors | Students | Availability]
[Newsletter Subscription Form]
[Copyright | Privacy | Terms | Contact]
```

### Main site pages accessible from navigation:
- Home: `/`, `/en`, `/ru`
- About: `/{lang}/about`
- Study Guide: `/{lang}/study-guide`
- Unsolved: `/{lang}/unsolved`
- Upload: `/{lang}/upload`
- Contributors: `/{lang}/contributors`
- Settings: `/{lang}/settings`

---

## 10. Client-Side Libraries & Third-Party Services

### CDN-loaded Libraries
| Library | Version | Used On | Purpose |
|---------|---------|---------|---------|
| Bootstrap CSS/JS | 5.3.3 | All pages | Layout, components, responsive grid |
| Bootstrap Icons | 1.9.1 | All pages | Icon font |
| Font Awesome | 6.4.0 | All pages | Additional icons |
| MathJax | 2.7.7 | Solution, edit, contribution pages | LaTeX math rendering |
| CodeMirror | 5.65.10 | Edit page only | Markdown/LaTeX editor |
| Marked.js | 4.3.0 | Edit page only | Client-side markdown preview |
| Chart.js | latest | Unsolved page, profile page | Pie charts, visualizations |
| Popper.js | 2.11.8 | All pages | Tooltip/popover positioning |
| Google Fonts | — | All pages | Roboto, Inter, JetBrains Mono |

### Local Libraries
| Library | Location | Purpose |
|---------|----------|---------|
| jQuery 1.10.1 | `/js/jquery-1.10.1.min.js` | DOM manipulation (legacy) |
| Bootstrap Affix | `/js/bootstrap-affix.js` | Sticky navigation |
| Bootstrap ScrollSpy | `/js/bootstrap-scrollspy.js` | Active nav highlighting |
| PrismJS 1.21.0 | `/css/css-latex/prism/prism.js` | Syntax highlighting |
| diff_match_patch | `/public/diff_match_patch.js` | Text diffing |

### Fonts
- **Roboto** (Google Fonts) — primary sans-serif
- **Inter** (Google Fonts) — modern header/footer
- **JetBrains Mono** (Google Fonts) — code blocks
- **Latin Modern Roman** (local WOFF2/WOFF) — LaTeX-inspired academic text
- **GothamPro** (local, multiple formats) — legacy custom font
- **PT Sans** (local/Google) — alternative sans-serif

---

## 11. SEO

### Meta Tags (standardized across pages)
```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="content-language" content="{lang}">
<meta name="keywords" content="{dynamic}">
<meta name="description" content="{dynamic}">
<meta name="author" content="Aliaksandr Melnichenka">
<meta name="date" content="YYYY-MM" scheme="YYYY-MM">
```

### Open Graph Tags
```html
<meta property="og:title" content="{page_title}">
<meta property="og:image" content="https://savchenkosolutions.com/img/logo.png">
<meta property="og:description" content="{description}">
```

### Favicons
```html
<link rel="icon" type="image/svg+xml" href="/img/logo.svg">
<link rel="icon" type="image/png" href="/img/logo.png">
<link rel="apple-touch-icon" href="/img/logo.png">
```

### robots.txt
- **Blocks AI bots:** GPTBot, CCBot, anthropic-ai, cohere-ai, ChatGPT-User
- **Blocks SEO crawlers:** semrushbot, ahrefsbot, blexbot, seo spider, mauibot
- **Blocks for all bots:** edit pages, admin, auth, search, session, user-api-key
- **Googlebot:** Allowed with some restrictions (no admin, auth, edit pages)
- **Sitemap:** `https://savchenkosolutions.com/sitemap.xml`

### Sitemaps
Generated at server startup by `sitemap.js`:
- `sitemap.xml` — index pointing to sub-sitemaps
- `sitemap_1.xml` — all problem pages
- `sitemap_recent.xml` — recently modified pages (last 3 days)
- Includes `<lastmod>` dates from file modification times

### Noindex Pages
- Edit pages: `<meta name="robots" content="noindex, nofollow">`
- 404 page: `<meta name="robots" content="noindex">`

### Structured Data
**Not implemented.** No JSON-LD, no Schema.org markup.

---

## 12. Analytics & Tracking

### Yandex Metrica
- Verification meta tag: `<meta name="yandex-verification" content="6cfda41f74038368">`
- Present in head sections of most pages
- No visible Yandex Metrica tracking script found in templates (may be injected elsewhere)

### Google Analytics
**Not found** in any template or script.

### Internal Page View Tracking
- `page_views` table tracks per-problem view counts
- `recent_views` table tracks recent IP+problem pairs for deduplication
- Incremented on each solution page visit
- View count displayed on solution pages

### User Activity Logging
- `user_activities` table logs: follows, unfollows, likes, dislikes, stars, comments
- Used for profile activity feeds and statistics

---

## 13. Security Measures

### Implemented
| Measure | Implementation |
|---------|---------------|
| **Password hashing** | bcrypt, 10 salt rounds |
| **Session security** | httpOnly cookies, sameSite=lax, secure in production |
| **XSS prevention** | `sanitize-html` on all markdown output; `validateSolutionMarkdownContent()` blocks script, object, embed, link, meta, base, style tags, javascript:/vbscript: URLs, data:text/html, inline event handlers |
| **SQL injection** | Parameterized queries throughout (`$1`, `$2`, etc.) |
| **Path traversal** | `isValidSolutionProblemName()` validates problem names match `/^\d+\.\d+\.\d+$/` |
| **File upload validation** | MIME type checking, extension validation, size limits (5MB per file, 20MB total) |
| **IP blocking** | 13 hardcoded IPs trigger content review queue |
| **Content review** | Emoji detection + blocked IP → `special_contributions` table |

### NOT Implemented
| Missing Measure | Risk |
|----------------|------|
| **CSRF tokens** | Partially mitigated by sameSite=lax cookies, but no explicit CSRF tokens |
| **Rate limiting** | No rate limiting on any endpoint (login, registration, API, search) |
| **Password complexity** | Only 8-char minimum on password change; no rules on registration |
| **Account lockout** | No brute-force protection on login |
| **Content Security Policy** | No CSP headers |
| **CORS** | No explicit CORS configuration (single-domain assumed) |
| **2FA/MFA** | Not available |
| **Email verification** | Registration doesn't verify email |
| **Admin authentication** | No admin-specific auth; admin features are hardcoded to username "astrosander" |

### Security Concerns
1. **Weak session secret default:** Falls back to `"your_secret_key"` if env var missing
2. **No authentication required for editing solutions** — anyone can edit any problem
3. **No authentication required for uploading solutions** — anyone can upload
4. **No authentication required for creating problems** (`/create-problem`)
5. **Hardcoded IP blocklist** instead of database-managed
6. **Review queue has no UI** — flagged content sits in `special_contributions` with no admin interface

---

## 14. Performance & Caching

### Server-Side Caching
- **Contributors API:** In-memory cache with 1-hour TTL + `Cache-Control: public, max-age=3600` headers
- **User stats API:** In-memory cache per user with 1-hour TTL
- **No other caching** — solution pages rendered fresh each time

### CDN
- **No CDN** for site content (static files served directly by Express)
- Third-party libraries loaded from CDN (jsdelivr, cdnjs, Google Fonts)

### Image Optimization
- **Sharp** used for processing uploaded images (metadata extraction)
- **Lazy loading:** `loading="lazy"` attribute on solution images
- No image compression/resizing pipeline for existing images
- No WebP conversion

### Database
- Connection pooling via `pg` Pool
- No query caching
- No database indexes documented (may exist via migrations)

### Client-Side
- No bundling or minification
- No service workers
- No PWA features
- Multiple CSS files loaded per page (no concatenation)
- jQuery + Bootstrap loaded on every page even if not used

---

## 15. Static Assets & Build Process

### Asset Locations
| Type | Location | Served As |
|------|----------|-----------|
| CSS | `/css/` | `/css/*` |
| JS | `/js/` | `/js/*` |
| Public | `/public/` | `/*` |
| Images | `/img/` | `/img/*` |
| Fonts | `/public/fonts/`, `/css/fonts/` | Via CSS @font-face |
| PDFs | `/pdf/` | `/en/savchenko_en.pdf`, `/savchenko.pdf` |
| Posts | `/posts/` | Processed by markdown parser |
| Theory | `/theory/`, `/ru/theory/` | Static HTML |

### Build Process
**None.** No webpack, no Vite, no Rollup, no Gulp, no minification, no bundling, no compilation step. All assets are served as-is. `package.json` has no scripts defined.

### CSS Architecture
Mix of:
- Bootstrap 5.3.3 (CDN) — primary framework
- Bootstrap 3.0.0 (local `/css/bootstrap.css`) — **legacy duplicate**
- Custom CSS files (design-system.css, main_page.css, style.css, etc.)
- LaTeX-inspired CSS (`/css/css-latex/style.css`)
- Metro-bootstrap (local, large file) — appears partially used

### Dark Mode
- LaTeX CSS supports dark mode via `.latex-dark` class and `@media (prefers-color-scheme: dark)`
- **No global dark mode toggle** — only affects LaTeX-styled content
- Rest of site has no dark mode support

### Responsive Design
- Bootstrap 5 grid system
- Custom breakpoints: 480px, 576px, 768px, 991.98px, 1204px
- `StyleMobile.css` — hides nav at ≤768px, adjusts video containers
- `header_mobile.css` — mobile header with hamburger menu
- Solution images: `width: min(scalePercentage, 100vw)`

---

## 16. Deployment

### Current Setup
- **No Dockerfile, docker-compose, or CI/CD pipeline**
- Manual deployment: `node index.js` (port 3000) + `node sandbox/sandbox-app.js` (port 4000)
- Database: AWS RDS PostgreSQL (external managed service)
- Upload script: `upload.bat` (Windows batch file for deployment)

### Server Startup
```javascript
// Main server
app.listen(3000);

// Sandbox server (with port fallback)
const startServer = (port) => {
    app.listen(port).on('error', (err) => {
        if (err.code === 'EADDRINUSE') startServer(port + 1);
    });
};
startServer(4000);
```

### No scheduled jobs or cron tasks
- Sitemap generation runs once at startup via `setInterval` with 1-second delay (essentially a startup task, not recurring)

---

## 17. Known Issues, Bugs & Missing Features

### Critical Issues
1. **No admin dashboard** — Reports in `solution_reports`, flagged content in `special_contributions`, user verification — all must be managed directly in the database
2. **No password reset flow** — Users who forget their password have no self-service recovery option
3. **No email verification on registration** — Accounts created with invalid emails work fine
4. **Email change confirmation not fully implemented** — Token URLs logged to console, actual email sending not coded for production
5. **No rate limiting anywhere** — Login, registration, API endpoints all vulnerable to abuse
6. **Weak default session secret** — Falls back to `"your_secret_key"` if `SESSION_SECRET` env var is missing

### Architectural Issues
7. **Monolithic `index.js`** — ~2200+ lines with all routes, middleware, and logic in one file
8. **Dual Bootstrap versions** — Bootstrap 5.3.3 (CDN) AND Bootstrap 3.0.0 (local) loaded, causing potential conflicts
9. **No build process** — No minification, bundling, or optimization of assets
10. **No search index** — Real-time filesystem scanning on every search query (doesn't scale)
11. **Legacy jQuery 1.10.1** — Very old version still loaded
12. **Two separate Express apps** — Main (port 3000) and sandbox (port 4000) share a database but run independently
13. **No package.json scripts** — No `start`, `test`, `build`, or `dev` scripts defined

### Feature Gaps
14. **No moderation UI** — Content reports, flagged contributions, and user verification require direct DB access
15. **No 2FA/MFA** — Only username + password authentication
16. **No CSRF tokens** — Relies solely on sameSite cookies
17. **No structured data/JSON-LD** — Missing Schema.org markup for educational content
18. **No Google Analytics** — Only Yandex Metrica verification tag (no tracking script visible)
19. **Newsletter subscription form** — Present in footer but appears non-functional (simulated success only)
20. **No notification system** — Users cannot be notified of comments, likes, or follows
21. **No solution versioning/history UI** — Contributions tracked in DB but no user-friendly diff viewer beyond contribution pages
22. **Sandbox app appears underdeveloped** — Separate server on port 4000, unclear integration with main app

### UI/UX Issues
23. **Inconsistent header implementations** — `main_site_header.ejs`, `modern_header.ejs`, `header.ejs`, `header_mobile.ejs` — multiple overlapping header templates
24. **Legacy templates** — `eng_page_old.ejs`, `profile.ejs` (old dashboard) still exist alongside newer versions
25. **`instagram` field** — Deprecated (set to NULL on every profile update) but column still in database
26. **Dark mode partial** — Only LaTeX content areas support dark mode, not the full site
27. **Solution images use backslashes** — `src="..\\..\\img\\..."` in `transformImageMarkdown()` — Windows path separators in HTML

### Security Concerns
28. **Anyone can edit any solution** — No authentication required for `POST /:lang/save/:name`
29. **Anyone can upload solutions** — No authentication required for upload endpoints
30. **Anyone can create problems** — `POST /create-problem` has no auth check
31. **Hardcoded IP blocklist** — 13 IPs in source code instead of database
32. **No Content Security Policy headers**

---

## Appendix: Static File Serving Configuration

```javascript
app.use(express.static(path.join(__dirname, "posts")));
app.use("/img", express.static(path.join(__dirname, "img")));
app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/en", express.static(path.join(__dirname, "en")));
app.use("/theory", express.static(path.join(__dirname, "theory")));
app.use("/ru/theory", express.static(path.join(__dirname, "ru", "theory")));
app.use(express.static(path.join(__dirname, "src")));
app.use("/en/savchenko_en.pdf", express.static(...));
app.use("/savchenko.pdf", express.static(...));
app.use("/js", express.static(path.join(__dirname, "js")));
app.use(express.static(path.join(__dirname, "public")));
```

**Note:** `express.static(path.join(__dirname, "src"))` exposes the Python source/utility directory publicly.

---

## Appendix: Global Middleware Stack

1. `bodyParser.urlencoded({ extended: true })` + `bodyParser.json()`
2. `express-session` with PostgreSQL store
3. `express-flash` for flash messages
4. `i18n.init` for internationalization
5. **Custom user context middleware:** Queries `users` table for profile picture on every request if session exists
6. Passport initialization (declared but not actively used for auth — manual session handling)
7. Static file serving (multiple `express.static` mounts)

---

*End of audit document.*
