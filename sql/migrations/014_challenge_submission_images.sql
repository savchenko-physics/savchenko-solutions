-- 014_challenge_submission_images.sql
-- Add image_path column to challenge_submissions for handwritten solution photos

ALTER TABLE challenge_submissions ADD COLUMN IF NOT EXISTS image_path TEXT;
