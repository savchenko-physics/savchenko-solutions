-- Migration 009: Optimize forum categories
-- Consolidate 6 empty categories into 4 based on actual community activity patterns.
-- "Problem Discussion" + "Savchenko Problems" merged into "Solution Discussion" (80%+ of comment activity).
-- "IPhO Preparation" broadened to "Physics & Olympiads" (covers textbook refs, general physics, olympiad prep).
-- "University & Careers" removed (zero community activity).
-- "Platform Feedback" and "General Discussion" retained.

-- Remove all existing categories (forum has 0 topics, safe to truncate)
DELETE FROM forum_categories;

-- Insert optimized categories
INSERT INTO forum_categories (name, slug, description, sort_order) VALUES
  ('Solution Discussion', 'solutions', 'Discuss specific solutions — corrections, alternative approaches, missing steps', 1),
  ('Physics & Olympiads', 'physics', 'Physics concepts, textbook references, olympiad preparation strategies', 2),
  ('Platform Feedback', 'feedback', 'Bug reports, feature requests, suggestions for the site', 3),
  ('General Discussion', 'general', 'Everything else — introductions, study tips, off-topic', 4);
