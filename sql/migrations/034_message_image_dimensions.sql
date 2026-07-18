-- Image dimensions + a tiny blurred placeholder (LQIP data-URI) so chat images
-- reserve their exact box (no layout reflow) and fade in smoothly.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_width  INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_height INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_placeholder TEXT;
