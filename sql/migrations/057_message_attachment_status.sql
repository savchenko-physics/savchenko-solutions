-- A video that browsers cannot decode is converted to H.264 after upload (lib/videoTranscode.js,
-- 2026-09-19). While that runs the message shows a download card; the state lives here so a
-- restart resumes the job: 'converting' becomes NULL when the playable file replaces the upload,
-- or 'failed' when nothing could be made of it (the card then stays).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_status VARCHAR(16);
