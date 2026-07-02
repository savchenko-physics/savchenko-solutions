# Prompt 9: Blog System

ultrathink

Read CLAUDE.md first. Then read prompts/database_structure.txt for the current database schema.

Build a complete blog system at /blog/.

## Task 1: Database

Create sql/migrations/004_blog.sql:
- blog_posts table: id, author_id (FK users), title, slug (unique), content (TEXT), excerpt, cover_image, language, tags (TEXT[]), is_published, published_at, view_count, created_at, updated_at
- blog_comments table: id, post_id (FK blog_posts ON DELETE CASCADE), user_id (FK users), content, parent_id (self-ref for threading), created_at
- Indexes on slug, published_at, tags (GIN), comments post_id

## Task 2: Router

Create blog.js Express router with routes:
- GET /blog — paginated list (10/page), newest first, only is_published=true
- GET /blog/tag/:tag — filter by tag
- GET /blog/:slug — single post with comments
- GET /blog/new — editor (require auth + is_verified_user or username=astrosander)
- POST /blog — create post
- GET /blog/:slug/edit — edit (author or astrosander only)
- POST /blog/:slug — update
- POST /blog/:slug/comments — add comment (auth required)

Slug: lowercase title, spaces to hyphens, strip special chars, max 100 chars, append -2 if duplicate.

## Task 3: List Page (views/blog/list.ejs)

- Title "Blog" (28px Inter 600)
- Tag filter pills from all unique tags across published posts
- Each post: title (linked, 20px, 600 weight), excerpt (200 chars stripped), author + date, tags as pills, view count
- Pagination: Previous / Next

## Task 4: Post Page (views/blog/post.ejs)

- Title (28px, 700), author info (40px avatar, name, date, reading time = wordcount/200), content with MathJax, tags, comments (same design as solution page), prev/next post links
- JSON-LD BlogPosting schema
- Canonical URL, meta description from excerpt

## Task 5: Editor (views/blog/editor.ejs)

- Title input, tags input (comma-separated), language selector, split-pane CodeMirror + live preview with MathJax
- "Save Draft" (is_published=false) and "Publish" (is_published=true, published_at=now) buttons
- Auto-save to localStorage every 30 seconds

## Task 6: Navigation + Home Page Widget

- Add "Blog" link to footer quick links and mobile menu
- On home page: "Latest from the Blog" section with 3 most recent posts (title, excerpt one-line, date), "View all →" link
- Fetch via GET /blog/api/posts?limit=3

## Task 7: Seed 3 Posts

Insert via migration (author_id=28):
1. "Welcome to the Savchenko Solutions Blog" — intro, what to expect
2. "How to Start Solving Savchenko Problems" — beginner guide, recommended order, tips
3. "The Story Behind Savchenko Solutions" — history, growth from 1 to 72 contributors, LEX 18 feature

Write real, substantive content for each (at least 500 words each). These are the first things visitors will read.

Mount router in index.js: app.use('/blog', blogRouter)

Verify: /blog lists posts, /blog/:slug renders with MathJax, only verified users can create, comments work, home page widget shows latest 3.
