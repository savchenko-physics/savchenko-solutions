-- File attachments on messages (documents/PDFs, not just images).
-- Images continue to use image_url; other files use these columns.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_url  VARCHAR(500);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name VARCHAR(255);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_size BIGINT;
