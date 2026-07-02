-- Migration 006: Discussion Forum
-- Creates tables for a threaded discussion forum with categories, topics, posts, and voting

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
  ('Solution Discussion', 'solutions', 'Discuss specific solutions — corrections, alternative approaches, missing steps', 1),
  ('Physics & Olympiads', 'physics', 'Physics concepts, textbook references, olympiad preparation strategies', 2),
  ('Platform Feedback', 'feedback', 'Bug reports, feature requests, suggestions for the site', 3),
  ('General Discussion', 'general', 'Everything else — introductions, study tips, off-topic', 4);
