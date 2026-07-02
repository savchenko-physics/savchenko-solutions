# SavchenkoSolutions.com — Growth to 1M Monthly Users

## Strategic Analysis

**Current state:** 150k users, 9.7k monthly active, 90% from search (people Googling specific Savchenko problems). The platform is a destination for one textbook. To reach 1M monthly users, you need to become the destination for physics olympiad preparation worldwide.

**What AoPS did right:** They started with one textbook (The Art of Problem Solving), built a community forum around it, then expanded into courses, competitions, and a full curriculum. Their forum drives 60%+ of traffic because it ranks for millions of long-tail math queries.

**What Beyond Curriculum did right:** They launched many small projects (tournaments, blogs, scoreboard, Q&A) rather than one big product. Each project serves a different audience and cross-pollinates users.

**The key insight:** Savchenko Solutions should become the AoPS of physics. The Savchenko problem set is your flagship (like AoPS's original textbook), but you need three additional pillars: a problem bank beyond Savchenko, a community forum, and editorial content.

## Architecture: The Hub Model

```
savchenkosolutions.com/                    ← Savchenko problems (existing, untouched)
savchenkosolutions.com/bank/               ← Physics Problem Bank (IPhO, national olympiads)
savchenkosolutions.com/discuss/            ← Forum
savchenkosolutions.com/blog/               ← Articles, interviews, guides
savchenkosolutions.com/tools/              ← Formula sheets, calculators, unit converter
savchenkosolutions.com/compete/            ← Weekly challenges, tournaments
savchenkosolutions.com/paths/              ← Guided study paths
```

Each pillar is a separate section with its own URL prefix, its own navigation, but shared user accounts and the same design system. The Savchenko core at `/en/` and `/ru/` stays exactly as it is.

---

## Pillar 1: Physics Problem Bank (/bank/)

**What:** A searchable, tagged database of physics problems from sources beyond Savchenko.

**Sources (all public domain or with permission):**
- IPhO problems (1967-present, ~800 problems, solutions available on ipho.org)
- APhO problems (Asian Physics Olympiad)
- EuPhO problems (European Physics Olympiad)
- National olympiad problems from: Russia (ВсОШ), Kazakhstan, Uzbekistan, Belarus (already have via BelPhO), Iran, India (INPhO), USA (USAPhO), UK (BPhO)
- Jaan Kalda's handouts (publicly available, widely used for IPhO prep)
- Problems from Irodov (another famous post-Soviet collection)
- User-submitted original problems

**Database model:**
```sql
CREATE TABLE bank_problems (
  id SERIAL PRIMARY KEY,
  source VARCHAR(100) NOT NULL,      -- 'IPhO 2024', 'USAPhO 2023', 'Irodov', 'User'
  source_year INTEGER,
  problem_number VARCHAR(50),
  title TEXT,
  statement_en TEXT,
  statement_ru TEXT,
  solution_en TEXT,
  solution_ru TEXT,
  difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 10),
  topics TEXT[],                      -- ['mechanics', 'kinematics', 'projectile']
  tags TEXT[],                        -- ['IPhO-level', 'graph-analysis', 'estimation']
  submitted_by INTEGER REFERENCES users(id),
  reviewed BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE bank_problem_attempts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  problem_id INTEGER REFERENCES bank_problems(id),
  status VARCHAR(20) CHECK (status IN ('attempted', 'solved', 'gave_up')),
  time_spent_seconds INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Key features:**
- Search by topic, difficulty, source, year
- Filter: "Show me all IPhO problems about electrostatics, difficulty 7+"
- Each problem page: statement, collapsible solution (click to reveal), discussion thread
- Personal progress tracking: mark as attempted/solved
- Difficulty voted by users (like Codeforces problem ratings)
- "Random problem" button with difficulty filter
- "Problem of the Day" on the home page

**Why this grows users:** People Google "IPhO 2024 solutions" and "USAPhO problems with solutions" in massive numbers. Each problem page is an SEO entry point. If you index 2,000+ olympiad problems, each ranking for its own search query, you capture a huge long-tail audience.

---

## Pillar 2: Discussion Forum (/discuss/)

**What:** A threaded discussion forum specifically for physics olympiad preparation, modeled on AoPS forums.

**Database model:**
```sql
CREATE TABLE forum_categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  slug VARCHAR(100) UNIQUE,
  description TEXT,
  sort_order INTEGER
);

CREATE TABLE forum_topics (
  id SERIAL PRIMARY KEY,
  category_id INTEGER REFERENCES forum_categories(id),
  user_id INTEGER REFERENCES users(id),
  title VARCHAR(255),
  slug VARCHAR(255),
  is_pinned BOOLEAN DEFAULT false,
  is_locked BOOLEAN DEFAULT false,
  view_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  last_reply_at TIMESTAMP,
  last_reply_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE forum_posts (
  id SERIAL PRIMARY KEY,
  topic_id INTEGER REFERENCES forum_topics(id),
  user_id INTEGER REFERENCES users(id),
  content TEXT NOT NULL,
  is_solution BOOLEAN DEFAULT false,   -- marked as accepted answer
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE forum_post_votes (
  user_id INTEGER REFERENCES users(id),
  post_id INTEGER REFERENCES forum_posts(id),
  vote INTEGER CHECK (vote IN (-1, 1)),
  PRIMARY KEY (user_id, post_id)
);
```

**Categories:**
1. Problem Discussion (ask for help on specific problems)
2. IPhO Preparation (strategies, resources, country-specific advice)
3. University Advice (applications, research, for physics students)
4. Platform Feedback (bugs, feature requests)
5. Off-Topic (general discussion)

**Key features:**
- Full LaTeX support in all posts (MathJax)
- Upvote/downvote on replies (like Stack Exchange)
- "Mark as solution" for the topic author
- User reputation system: earn points from upvotes, best answers, contributions
- Search within forum
- Link to Savchenko problems or Bank problems inline: typing `#1.1.1` auto-links to the solution page

**Why this grows users:** AoPS forums get millions of monthly visits because each thread is a unique piece of indexed content. A question like "How to solve projectile motion problems with air resistance?" becomes a permanent SEO asset. The forum creates a flywheel: questions attract answers, answers attract readers, readers ask questions.

---

## Pillar 3: Blog (/blog/)

**What:** Long-form articles about physics, olympiad preparation, and the community.

**Content types:**
1. **Interviews** with IPhO medalists, physics professors, and contributors (you already have the Andrei Kotsevich interview on BelPhO)
2. **Topic deep-dives**: "Everything You Need to Know About Rotational Dynamics for IPhO" — comprehensive guides that link to dozens of problems
3. **Problem-solving strategies**: "5 Techniques for Solving Thermodynamics Problems" with worked examples
4. **News**: IPhO results, new problem sets released, platform updates
5. **Community stories**: spotlight on contributors (like Evgeny's story)

**Database model:**
```sql
CREATE TABLE blog_posts (
  id SERIAL PRIMARY KEY,
  author_id INTEGER REFERENCES users(id),
  title VARCHAR(255),
  slug VARCHAR(255) UNIQUE,
  content TEXT,
  excerpt TEXT,
  cover_image VARCHAR(255),
  language VARCHAR(5) DEFAULT 'en',
  tags TEXT[],
  is_published BOOLEAN DEFAULT false,
  published_at TIMESTAMP,
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE blog_comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES blog_posts(id),
  user_id INTEGER REFERENCES users(id),
  content TEXT,
  parent_id INTEGER REFERENCES blog_comments(id),
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Key features:**
- Markdown + LaTeX editor for writing posts
- Only verified users or admins can publish (quality control)
- Comments with LaTeX support
- Tags for categorization and SEO
- RSS feed
- Share buttons (minimal: copy link only)

**Why this grows users:** Blog posts rank for broad queries like "physics olympiad preparation guide" and "how to prepare for IPhO." Each post is a top-of-funnel entry point that introduces readers to the problem bank and Savchenko solutions. Beyond Curriculum's blog has been running since 2019 and is their primary brand-building tool.

---

## Pillar 4: Tools (/tools/)

**What:** Free utilities that physics students use daily.

**Tools to build:**
1. **Interactive Formula Sheet** — all key physics formulas organized by topic, with LaTeX rendering, searchable. Not a PDF — an interactive web page where you can click to expand derivations.
2. **Unit Converter** — physics-specific: convert between CGS and SI, energy units (eV, J, erg, cal), etc.
3. **Physical Constants Reference** — searchable table of CODATA constants with copy-to-clipboard.
4. **Dimensional Analysis Calculator** — input a formula, verify dimensions.
5. **LaTeX Equation Editor** — live preview, common physics templates, copy LaTeX or rendered image.

**Why this grows users:** Tools get bookmarked. A student who uses your formula sheet daily visits your site 30 times a month. These pages also rank for queries like "physics formula sheet" and "unit converter physics" which have enormous search volume. They're low-effort to build and high-value for retention.

---

## Pillar 5: Weekly Challenges (/compete/)

**What:** A new physics problem every week, with a leaderboard.

**How it works:**
1. Every Monday, a new problem is posted (difficulty 6-8 out of 10)
2. Users submit solutions before Sunday midnight
3. Solutions are reviewed (by verified contributors or admin)
4. Monday: the new problem is posted + the previous week's solution is revealed
5. Leaderboard tracks: problems solved, streaks, total score

**Database model:**
```sql
CREATE TABLE challenges (
  id SERIAL PRIMARY KEY,
  problem_statement TEXT,
  solution TEXT,
  difficulty INTEGER,
  week_start DATE,
  week_end DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE challenge_submissions (
  id SERIAL PRIMARY KEY,
  challenge_id INTEGER REFERENCES challenges(id),
  user_id INTEGER REFERENCES users(id),
  content TEXT,
  is_correct BOOLEAN,
  reviewed_by INTEGER REFERENCES users(id),
  submitted_at TIMESTAMP DEFAULT NOW()
);
```

**Why this grows users:** Recurring engagement. Students come back every week. The leaderboard creates competition. This is exactly what Codeforces does — regular contests keep the community alive between major competitions.

---

## Pillar 6: Study Paths (/paths/)

**What:** Curated sequences of problems that build skills progressively.

**Example paths:**
- "IPhO Preparation: Mechanics" — 40 problems, starting easy, ending at IPhO difficulty
- "Savchenko Starter Set" — 20 problems across all chapters for beginners
- "Thermodynamics Mastery" — 30 problems from Savchenko + Bank + IPhO
- "From Zero to National Olympiad" — 100 problems building from basics to competition level

**Database model:**
```sql
CREATE TABLE study_paths (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255),
  description TEXT,
  author_id INTEGER REFERENCES users(id),
  difficulty_start INTEGER,
  difficulty_end INTEGER,
  estimated_hours INTEGER,
  is_published BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE path_problems (
  id SERIAL PRIMARY KEY,
  path_id INTEGER REFERENCES study_paths(id),
  problem_type VARCHAR(20), -- 'savchenko', 'bank', 'challenge'
  problem_ref VARCHAR(50),  -- '1.1.1' for savchenko, bank problem ID, etc.
  sort_order INTEGER,
  notes TEXT                -- author's note: "Focus on energy conservation here"
);

CREATE TABLE user_path_progress (
  user_id INTEGER REFERENCES users(id),
  path_id INTEGER REFERENCES study_paths(id),
  problem_ref VARCHAR(50),
  status VARCHAR(20) CHECK (status IN ('not_started', 'attempted', 'solved')),
  completed_at TIMESTAMP,
  PRIMARY KEY (user_id, path_id, problem_ref)
);
```

**Why this grows users:** Students don't know where to start. Paths solve the "what should I study next?" problem. Each path is also a landing page that ranks for queries like "IPhO mechanics preparation" and "physics olympiad problem set."

---

## Growth Projections

| Feature | New Monthly Users | SEO Pages Created | Effort |
|---------|------------------|-------------------|--------|
| Problem Bank (2,000 problems) | +200k | 2,000 | High |
| Forum (after 6 months of posts) | +300k | 10,000+ | Medium |
| Blog (2 posts/week for 6 months) | +100k | 50+ | Low |
| Tools (5 tools) | +150k | 5 | Low |
| Weekly Challenges | +50k | 52/year | Low |
| Study Paths (10 paths) | +50k | 10 | Medium |
| **Total potential** | **+850k** | **12,000+** | |

Combined with existing 150k users = potentially 1M monthly users within 12-18 months.

---

## Implementation Priority

1. **Blog** (weeks 1-2) — lowest effort, immediate SEO value, can start writing content immediately
2. **Tools** (weeks 2-3) — formula sheet and LaTeX editor are quick wins with high retention value
3. **Problem Bank** (weeks 3-8) — the biggest growth lever, start with IPhO problems (public domain)
4. **Forum** (weeks 6-10) — requires critical mass of users first, launch after bank is populated
5. **Weekly Challenges** (week 8+) — start once there's an active community
6. **Study Paths** (week 10+) — requires bank to be populated first
