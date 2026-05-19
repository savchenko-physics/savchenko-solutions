-- Add image attachment support for messages

ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url VARCHAR(500);
