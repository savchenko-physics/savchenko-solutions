# Prompt 12: Discussion Forum

ultrathink

Read CLAUDE.md first. Then read prompts/database_structure.txt.

Build a discussion forum at /discuss/. This is the long-term growth engine — every thread becomes an indexed page that ranks for unique physics queries.

## Task 1: Database

Create sql/migrations/006_forum.sql:

```sql
CREATE TABLE forum_categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE forum_topics (
  id SERIAL PRIMARY KEY,
  category_id INTEGER REFERENCES forum_categories(id),
  user_id INTEGER REFERENCES users(id) NOT NULL,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
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
  topic_id INTEGER REFERENCES forum_topics(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  content TEXT NOT NULL,
  is_solution BOOLEAN DEFAULT false,
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  is_edited BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE forum_post_votes (
  user_id INTEGER REFERENCES users(id),
  post_id INTEGER REFERENCES forum_posts(id),
  vote INTEGER CHECK (vote IN (-1, 1)),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX idx_forum_topics_category ON forum_topics(category_id);
CREATE INDEX idx_forum_topics_last_reply ON forum_topics(last_reply_at DESC NULLS LAST);
CREATE INDEX idx_forum_posts_topic ON forum_posts(topic_id, created_at);
CREATE INDEX idx_forum_topics_slug ON forum_topics(slug);

INSERT INTO forum_categories (name, slug, description, sort_order) VALUES
  ('Problem Discussion', 'problems', 'Ask for help on specific physics problems', 1),
  ('IPhO Preparation', 'ipho-prep', 'Strategies, resources, and country-specific advice for IPhO', 2),
  ('Savchenko Problems', 'savchenko', 'Discussion about Savchenko problem set and solutions', 3),
  ('University & Careers', 'university', 'Physics programs, applications, research opportunities', 4),
  ('Platform Feedback', 'feedback', 'Bugs, feature requests, suggestions', 5),
  ('General Discussion', 'general', 'Everything else physics-related', 6);
```

## Task 2: Forum Router

Create forum.js Express router. Mount at /discuss in index.js.

Routes:
- GET /discuss — forum home: category list with topic counts and latest activity
- GET /discuss/:categorySlug — topic list for a category, paginated (20/page), sorted by last_reply_at
- GET /discuss/:categorySlug/:topicId-:topicSlug — single topic with all replies
- GET /discuss/new — new topic form (auth required)
- POST /discuss — create topic + first post (auth)
- POST /discuss/:topicId/reply — add reply (auth)
- POST /discuss/posts/:postId/vote — upvote/downvote (auth)
- POST /discuss/:topicId/solution/:postId — mark reply as solution (auth, topic author only)

## Task 3: Forum Home (views/forum/index.ejs)

- Title: "Discussion" (28px)
- "New Topic" button (top-right, primary style, requires login)
- Category list as rows:
  - Category name (linked, 16px, 600 weight)
  - Description (13px, #6c757d)
  - Topic count + post count
  - Latest topic: title (linked), author, relative time

## Task 4: Category/Topic List (views/forum/category.ejs)

- Breadcrumb: Discussion > Category Name
- "New Topic" button
- Pinned topics first (highlighted with pin icon)
- Each topic row:
  - Title (linked, 15px, 500 weight)
  - Author avatar (24px) + username
  - Reply count + view count (right side)
  - Last reply: username + relative time
  - If has accepted solution: green checkmark badge
- Pagination

## Task 5: Topic Page (views/forum/topic.ejs)

- Breadcrumb: Discussion > Category > Topic Title
- First post (the question): full width, author info on left (avatar, username, reputation score, join date), content on right
- Replies below, each with:
  - Author info on left
  - Content on right (MathJax rendered)
  - Upvote/downvote buttons + score
  - "Reply" button
  - If marked as solution: green "Accepted Solution" banner
- Reply form at bottom: CodeMirror textarea with LaTeX support and live preview
- Topic author can mark any reply as "solution" (only one)

Auto-linking: any text matching pattern #X.X.X (like #1.1.1) automatically becomes a link to /en/X.X.X (Savchenko problem). Any text matching @username becomes a link to /user/username.

## Task 6: User Reputation

Add a computed reputation score to users, derived from forum activity:
- +10 per upvote received on forum posts
- +25 per accepted solution
- +5 per Savchenko solution contributed
- +1 per forum reply

Don't store this in a column — compute it on the fly for display (or cache it). Show it on the forum next to usernames:
- 0-99: "New Member" (gray)
- 100-499: "Active" (blue)
- 500-999: "Expert" (#1a1a2e)
- 1000+: "Master" (gold)

## Task 7: Navigation + SEO

- Add "Discuss" to navbar and footer
- Each topic page: `<title>[Topic Title] - Discussion | Savchenko Solutions</title>`
- noindex for new topics page and reply forms
- Sitemap: add published topics to sitemap generation

Verify: /discuss shows categories, topics list paginated, topic pages render with MathJax, upvote/downvote works, solution marking works, auto-linking #1.1.1 and @username works, reputation displays correctly.
