-- Brainstorm Room — per-problem brainstorm channel.
--
-- SCOPE: unified by problem_name ONLY. All interface languages share ONE room
-- per problem (decision recorded in BRAINSTORM_DESIGN_NOTES.md §13). The existing
-- solution_comments / solution_likes systems remain scoped by (problem_name,
-- language) and are NOT touched here.
--
-- This migration is additive and non-destructive: it only CREATEs new tables /
-- indexes and ADDs one nullable-with-default column to user_preferences.
-- Reverse with sql/rollback/026_brainstorm_rollback.sql (kept out of the
-- migrations dir so the forward-only runner never auto-applies it).

-- ─── Messages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brainstorm_messages (
    id              SERIAL PRIMARY KEY,
    problem_name    VARCHAR(50)  NOT NULL,               -- e.g. '7.3.6' (the room key)
    language        VARCHAR(5),                          -- language the message was WRITTEN in;
                                                         -- a display tag only, NEVER a scope key
    user_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT         NOT NULL,
    parent_id       INTEGER      REFERENCES brainstorm_messages(id) ON DELETE SET NULL,
    is_pinned       BOOLEAN      NOT NULL DEFAULT FALSE, -- curator highlight (admins + verified users)
    is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE, -- soft delete (matches solution_comments)
    reaction_count  INTEGER      NOT NULL DEFAULT 0,     -- denormalized popularity, kept in sync on toggle
    narrative_role  VARCHAR(20),                         -- Phase-5 detective hook (NULL for now)
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Chronological room view + poll (newest-first pagination), scoped by problem only.
CREATE INDEX IF NOT EXISTS idx_brainstorm_messages_problem_created
    ON brainstorm_messages (problem_name, created_at DESC);

-- Hot rotating top-N block: pinned first, then most-reacted. Lets the top-N query
-- be served from the index without a GROUP BY on the most-visited page.
CREATE INDEX IF NOT EXISTS idx_brainstorm_messages_problem_popular
    ON brainstorm_messages (problem_name, reaction_count DESC, created_at DESC);

-- ─── Reactions (mirror of message_reactions; popularity primitive) ───────────
CREATE TABLE IF NOT EXISTS brainstorm_reactions (
    id          SERIAL PRIMARY KEY,
    message_id  INTEGER NOT NULL REFERENCES brainstorm_messages(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       VARCHAR(8) NOT NULL,                     -- reuses the chat ALLOWED_REACTIONS set
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_brainstorm_reactions_message
    ON brainstorm_reactions (message_id);

-- ─── Structured wiki-style cross-links (descriptive text + queryable target) ──
CREATE TABLE IF NOT EXISTS brainstorm_message_links (
    id                   SERIAL PRIMARY KEY,
    message_id           INTEGER NOT NULL REFERENCES brainstorm_messages(id) ON DELETE CASCADE,
    target_problem_name  VARCHAR(50) NOT NULL,           -- the referenced problem, e.g. '2.4.44'
    target_language      VARCHAR(5),                     -- nullable: links are language-agnostic
    link_text            VARCHAR(255) NOT NULL,          -- the descriptive words shown (wiki-style)
    created_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_brainstorm_links_message
    ON brainstorm_message_links (message_id);
-- Phase-5 hook: reverse cross-reference graph ("which problems link to X").
CREATE INDEX IF NOT EXISTS idx_brainstorm_links_target
    ON brainstorm_message_links (target_problem_name);

-- ─── Logged-in quiet-mode preference ─────────────────────────────────────────
-- 'rotate' (animated, default) | 'static' (single top message, no motion) | 'hidden'
ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS brainstorm_display_mode VARCHAR(10) NOT NULL DEFAULT 'rotate';
