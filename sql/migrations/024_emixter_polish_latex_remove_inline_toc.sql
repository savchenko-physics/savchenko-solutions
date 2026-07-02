-- Migration 024: Polish emixter interview post
--   1. Render bare formulas as inline LaTeX
--   2. Remove the manual "Содержание" section (moved to the sticky sidebar TOC)

BEGIN;

-- Note: standard_conforming_strings is ON by default since PG 9.1, so a single
-- backslash in a regular string literal stores as one literal backslash.
-- We use double-backslash here so the markdown parser, which treats a single
-- backslash before ASCII punctuation as an escape, will deliver a single
-- backslash to MathJax for control characters like \; \, \{ \}.

-- 1.a  v = 2 π r / T
UPDATE blog_posts
SET content = REPLACE(content, 'v=2*pi*r/T', '$v = 2\\pi r / T$')
WHERE slug = 'evgeniy-dubrovin-emixter';

-- 1.b  115 г/моль
UPDATE blog_posts
SET content = REPLACE(
    content,
    '115 г/моль',
    '$115\\;\\text{г/моль}$'
)
WHERE slug = 'evgeniy-dubrovin-emixter';

-- 2.  Remove the inline "Содержание" block (between two horizontal rules)
UPDATE blog_posts
SET content = REPLACE(
    content,
    E'\n---\n\n## Содержание\n\n- Возвращение к задачнику\n- Для кого он пишет решения\n- Соавтор платформы\n- Спор с книгой\n- Недоверие к искусственному интеллекту\n- Когда задача становится детективом\n- Физика как язык\n- Споры и дружба с igor\n- Что нельзя потерять платформе\n- О счастье, мечте и эпиграфе\n',
    E'\n'
)
WHERE slug = 'evgeniy-dubrovin-emixter';

COMMIT;
