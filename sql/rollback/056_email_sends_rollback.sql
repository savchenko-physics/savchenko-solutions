-- Rollback for 056_email_sends.sql. Only after the code that writes it is gone: email.js logs
-- every send here and counts these rows before sending, though it fails open if the table is
-- unreadable, so a missing table degrades to "no limits", not to "no mail".
DROP TABLE IF EXISTS email_sends;
DELETE FROM applied_migrations WHERE name = '056_email_sends.sql';
