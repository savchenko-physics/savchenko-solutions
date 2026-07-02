# Prompt 13: Weekly Challenges + Study Paths

ultrathink

Read CLAUDE.md first. Then read prompts/database_structure.txt.

## Part A: Weekly Challenges (/compete/)

### Task 1: Database

Create sql/migrations/007_challenges_paths.sql:

```sql
CREATE TABLE challenges (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255),
  problem_statement TEXT NOT NULL,
  solution TEXT,
  difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 10),
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE challenge_submissions (
  id SERIAL PRIMARY KEY,
  challenge_id INTEGER REFERENCES challenges(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  content TEXT NOT NULL,
  is_correct BOOLEAN,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMP,
  submitted_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(challenge_id, user_id)
);

CREATE TABLE challenge_leaderboard (
  user_id INTEGER REFERENCES users(id) PRIMARY KEY,
  total_solved INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  total_score INTEGER DEFAULT 0
);

CREATE TABLE study_paths (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  author_id INTEGER REFERENCES users(id),
  difficulty_start INTEGER,
  difficulty_end INTEGER,
  estimated_hours INTEGER,
  problem_count INTEGER DEFAULT 0,
  is_published BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE path_problems (
  id SERIAL PRIMARY KEY,
  path_id INTEGER REFERENCES study_paths(id) ON DELETE CASCADE,
  problem_type VARCHAR(20) CHECK (problem_type IN ('savchenko', 'bank', 'challenge')),
  problem_ref VARCHAR(50) NOT NULL,
  sort_order INTEGER NOT NULL,
  notes TEXT
);

CREATE TABLE user_path_progress (
  user_id INTEGER REFERENCES users(id),
  path_id INTEGER REFERENCES study_paths(id),
  problem_ref VARCHAR(50),
  status VARCHAR(20) CHECK (status IN ('not_started', 'attempted', 'solved')) DEFAULT 'not_started',
  completed_at TIMESTAMP,
  PRIMARY KEY (user_id, path_id, problem_ref)
);
```

### Task 2: Challenges Router

Create challenges.js Express router. Mount at /compete in index.js.

Routes:
- GET /compete — current challenge + past challenges list + leaderboard
- GET /compete/:id — single challenge detail
- POST /compete/:id/submit — submit solution (auth required, only during active week)
- GET /compete/leaderboard — full leaderboard

### Task 3: Challenge Page (views/challenges/index.ejs)

Layout:
- Current active challenge in a prominent card at top:
  - "Challenge of the Week" heading
  - Problem statement (MathJax rendered)
  - Difficulty badge
  - Countdown timer: "X days, Y hours remaining"
  - "Submit Your Solution" button (links to submission form or login prompt)
  - Number of submissions so far
- Below: "Past Challenges" list (title, date, difficulty, number of correct solutions, "View Solution" link for expired ones)
- Right sidebar: Challenge Leaderboard (top 20, showing total solved and streak)

### Task 4: Submission Flow

- Submission form: CodeMirror with LaTeX support + image upload
- One submission per user per challenge (can update until deadline)
- After deadline: admin reviews submissions via admin dashboard (add a "Challenges" tab to existing admin)
- Correct submissions: add to challenge_leaderboard, increment streak if consecutive weeks

### Task 5: Home Page Integration

On the home page, in the right sidebar (above or below Top Authors), add:

```
Challenge of the Week
Problem: [first 100 chars]...
⏰ 3 days left
12 submissions so far
→ Try it
```

## Part B: Study Paths (/paths/)

### Task 6: Paths Router

Create paths.js Express router. Mount at /paths in index.js.

Routes:
- GET /paths — list all published paths
- GET /paths/:slug — single path with problem list and progress
- POST /paths/:slug/progress — update progress on a problem (auth)
- GET /paths/new — create new path (verified users or astrosander)
- POST /paths — create path

### Task 7: Path List Page (views/paths/index.ejs)

- Title: "Study Paths" (28px)
- Subtitle: "Guided sequences of problems to build your skills progressively"
- Each path card:
  - Title, description (2 lines)
  - Difficulty range: "Difficulty 3 → 8"
  - Problem count, estimated hours
  - Author name
  - If logged in: progress bar showing % completed
  - "Start" or "Continue" button

### Task 8: Path Detail Page (views/paths/show.ejs)

- Title, description, author, stats
- Progress bar (logged-in users)
- Problem list: numbered, each showing:
  - Problem reference (linked to Savchenko problem or bank problem)
  - Source label ("Savchenko" or "IPhO 2023" etc.)
  - Author's note/hint if provided
  - Status indicator: not started (gray circle), attempted (yellow circle), solved (green checkmark)
  - Click status to toggle (triggers POST /paths/:slug/progress)

### Task 9: Seed Study Paths

Create 5 initial paths (author_id=28):

1. "Savchenko Starter Set" — 20 easiest problems across chapters, difficulty 3-5
2. "Mechanics Mastery" — 30 mechanics problems (chapters 1-2) from easy to hard
3. "IPhO Preparation: Thermodynamics" — 25 problems mixing Savchenko ch.5 with bank problems
4. "From Zero to National Olympiad" — 50 problems building from basics to competition level
5. "The Hardest Savchenko Problems" — 20 notoriously difficult problems for advanced students

For each path, select real Savchenko problem numbers that match the theme. Use your knowledge of the problem set structure (chapters.csv, sections.csv) to pick appropriate problems.

### Task 10: Navigation

Add "Study Paths" to the study-guide page as a prominent link. Add "Paths" to footer quick links. On Savchenko solution pages, if the problem appears in any path, show "This problem is part of: [Path Name]" in the sidebar.

Verify: /compete shows current challenge with timer, /compete/:id allows submissions, leaderboard tracks scores, /paths lists paths, /paths/:slug shows problems with progress tracking, home page shows challenge widget.
