-- Forwarded messages: records the ORIGINAL author so a "Forwarded from X"
-- label can be shown. Preserves the origin across forward chains.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_user_id INTEGER
    REFERENCES users(id) ON DELETE SET NULL;
