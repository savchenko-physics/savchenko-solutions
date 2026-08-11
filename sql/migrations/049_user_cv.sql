-- A contributor's CV, uploaded from their own settings page.
--
-- The profile is already a public record of what someone has done here; attaching the
-- document they would send an admissions committee makes that record usable as a
-- credential rather than only as a leaderboard entry. Stored as a path, not a blob —
-- the file lives under uploads/cv and is served by express.static.
ALTER TABLE users ADD COLUMN IF NOT EXISTS cv_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cv_uploaded_at TIMESTAMPTZ;
