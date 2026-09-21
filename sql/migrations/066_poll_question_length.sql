-- The bubble quiz's English statement is 310 characters (2026-09-21); a question may be 500.
ALTER TABLE polls ALTER COLUMN question TYPE VARCHAR(500);
