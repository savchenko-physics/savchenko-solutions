# Prompt 11: Physics Problem Bank

ultrathink

Read CLAUDE.md first. Then read prompts/database_structure.txt.

Build a physics problem bank at /bank/ that aggregates olympiad problems from multiple sources beyond Savchenko. This is the highest-growth feature — each problem page is a new SEO entry point.

## Task 1: Database

Create sql/migrations/005_problem_bank.sql:

```sql
CREATE TABLE bank_sources (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  url VARCHAR(255),
  country VARCHAR(100),
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE bank_problems (
  id SERIAL PRIMARY KEY,
  source_id INTEGER REFERENCES bank_sources(id),
  year INTEGER,
  problem_number VARCHAR(50),
  title VARCHAR(255),
  statement_en TEXT,
  statement_ru TEXT,
  solution_en TEXT,
  solution_ru TEXT,
  difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 10),
  topics TEXT[] DEFAULT '{}',
  submitted_by INTEGER REFERENCES users(id),
  reviewed BOOLEAN DEFAULT false,
  reviewed_by INTEGER REFERENCES users(id),
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE bank_attempts (
  user_id INTEGER REFERENCES users(id),
  problem_id INTEGER REFERENCES bank_problems(id),
  status VARCHAR(20) CHECK (status IN ('attempted', 'solved', 'gave_up')),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, problem_id)
);

CREATE TABLE bank_difficulty_votes (
  user_id INTEGER REFERENCES users(id),
  problem_id INTEGER REFERENCES bank_problems(id),
  difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 10),
  PRIMARY KEY (user_id, problem_id)
);

CREATE TABLE bank_comments (
  id SERIAL PRIMARY KEY,
  problem_id INTEGER REFERENCES bank_problems(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  content TEXT NOT NULL,
  parent_id INTEGER REFERENCES bank_comments(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_bank_problems_source ON bank_problems(source_id);
CREATE INDEX idx_bank_problems_topics ON bank_problems USING GIN(topics);
CREATE INDEX idx_bank_problems_difficulty ON bank_problems(difficulty);
CREATE INDEX idx_bank_problems_year ON bank_problems(year DESC);

INSERT INTO bank_sources (name, slug, description, country, sort_order) VALUES
  ('International Physics Olympiad', 'ipho', 'Problems from the International Physics Olympiad (1967-present)', 'International', 1),
  ('Asian Physics Olympiad', 'apho', 'Problems from the Asian Physics Olympiad', 'International', 2),
  ('European Physics Olympiad', 'eupho', 'Problems from the European Physics Olympiad', 'International', 3),
  ('USAPhO', 'usapho', 'USA Physics Olympiad problems', 'United States', 4),
  ('BPhO', 'bpho', 'British Physics Olympiad problems', 'United Kingdom', 5),
  ('Irodov', 'irodov', 'Problems in General Physics by I.E. Irodov', 'Russia', 6),
  ('User Submitted', 'user', 'Community-contributed original problems', 'International', 99);
```

## Task 2: Bank Router

Create bank.js Express router. Mount at /bank in index.js.

Routes:
- GET /bank — landing page with source list, stats, featured problems, search
- GET /bank/source/:slug — problems filtered by source (e.g., /bank/source/ipho)
- GET /bank/topic/:topic — problems filtered by topic
- GET /bank/problem/:id — single problem page
- GET /bank/random — redirect to a random problem (with optional ?difficulty=5&topic=mechanics filters)
- GET /bank/submit — submit a new problem (auth required)
- POST /bank/submit — create problem
- POST /bank/problem/:id/attempt — mark as attempted/solved/gave_up (auth)
- POST /bank/problem/:id/difficulty — vote on difficulty (auth)
- POST /bank/problem/:id/comments — add comment (auth)
- GET /bank/api/search — JSON search within bank

## Task 3: Bank Landing Page (views/bank/index.ejs)

- Title: "Physics Problem Bank" (28px)
- Subtitle: "X problems from Y sources. Filter by topic, difficulty, or competition."
- Search bar: search by keyword, topic, or problem number
- Filter row: difficulty slider (1-10), source dropdown, topic pills (mechanics, thermodynamics, electrostatics, optics, relativity, etc.)
- "Random Problem" button (big, centered, fun)
- Source cards: grid showing each source with problem count and country flag
- "Problem of the Day": highlight one random problem, changes daily (cache the selection for 24h)

## Task 4: Problem Page (views/bank/problem.ejs)

Two-part layout:
- Problem statement (always visible)
- Solution (hidden behind a "Show Solution" button — clicking reveals it with a slide animation)

Sidebar:
- Source + year
- Difficulty bar (1-10, colored: 1-3 green, 4-6 yellow, 7-10 red)
- "Rate Difficulty" slider (logged-in users)
- Topics as clickable pills (link to /bank/topic/:topic)
- Progress buttons: "I attempted this" / "I solved this" (logged-in users)
- Related problems: 3 problems with similar topics

Comments section below solution (same design as solution page).

SEO:
```html
<title>IPhO 2024 Problem 1 — [Topic] | Physics Problem Bank | Savchenko Solutions</title>
<meta name="description" content="Solution to IPhO 2024 Problem 1. Difficulty: 8/10. Topics: mechanics, rotational dynamics.">
```

## Task 5: Problem Submission (views/bank/submit.ejs)

Form for submitting new problems:
- Source selection (dropdown from bank_sources, or "Other" with text input)
- Year (number input)
- Problem number (text)
- Statement (CodeMirror with LaTeX, EN and RU tabs)
- Solution (CodeMirror with LaTeX, EN and RU tabs)
- Topics (tag input with autocomplete from existing topics)
- Difficulty estimate
- Image upload for diagrams

Submitted problems go to reviewed=false. Admin approves them via the admin dashboard.

## Task 6: Link to Bank from Navigation

- Add "Problem Bank" link to the navbar (desktop and mobile)
- On the home page, add a callout below the Savchenko chapters: "Looking for more problems? Browse our Problem Bank with X problems from IPhO, USAPhO, Irodov, and more." with link to /bank
- On the Savchenko solution pages, if a problem is related to a bank problem by topic, show a "Related from Problem Bank" link in the sidebar

Verify: /bank renders with source list, /bank/problem/:id shows statement+hidden solution, random problem works, difficulty voting works, topic filtering works, problem submission works for logged-in users.
