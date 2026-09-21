-- A member can be kept from writing in one conversation for a while (an admin's call after
-- messages like Бека's in the Russian chat on 2026-09-21). They still read it. NULL or a past
-- time means they can write; lib/chatRestrictions.js decides, scripts/chat-restrict.js sets it.
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS posting_blocked_until TIMESTAMPTZ;
