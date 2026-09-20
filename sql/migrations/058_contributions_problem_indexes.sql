-- The solution page reads a problem's contributors three ways (its last editor, its
-- attribution, its edit history), and each read was a sequential scan of contributions
-- (9,194 rows, wide: every row carries the text it saved) and github_contributions (11,493):
-- 7–15 ms each on RDS against 2 ms for an index lookup (measured 2026-09-19). Neither table
-- had any index but its primary key. The same lookups serve /contributions/<problem> and the
-- profile pages.
CREATE INDEX IF NOT EXISTS contributions_problem_idx
    ON contributions (problem_name, language, edited_at DESC);
CREATE INDEX IF NOT EXISTS github_contributions_problem_idx
    ON github_contributions (problem_name, language, edited_at DESC);
