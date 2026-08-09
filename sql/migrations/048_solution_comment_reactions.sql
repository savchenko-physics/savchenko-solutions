-- Reactions on solution-page comments (the "Обсуждение" thread).
--
-- Same shape as message_reactions (migration 018) and the same six-emoji vocabulary
-- (ALLOWED_REACTIONS in brainstorm.js), so a reaction means the same thing wherever
-- someone leaves one on this site.
--
-- The UNIQUE constraint is what makes the toggle safe: a double-click or a retried
-- request cannot leave the same person counted twice for the same emoji.

CREATE TABLE IF NOT EXISTS solution_comment_reactions (
    id SERIAL PRIMARY KEY,
    comment_id INTEGER NOT NULL REFERENCES solution_comments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji VARCHAR(8) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(comment_id, user_id, emoji)
);

-- The thread reads every reaction for a page's comments in one query, keyed by comment.
CREATE INDEX IF NOT EXISTS idx_solution_comment_reactions_comment_id
    ON solution_comment_reactions(comment_id);
