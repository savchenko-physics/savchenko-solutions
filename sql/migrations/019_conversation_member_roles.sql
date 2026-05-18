-- Add role column to conversation_members for group chat admin rights

ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'member';
