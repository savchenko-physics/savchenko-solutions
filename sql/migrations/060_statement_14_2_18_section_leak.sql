-- 14.2.18's Russian statement, typeset from the scanned page, ends with the heading of the
-- next section ("§ 14.3. Преобразование электрического и магнитного полей∗)"), which the
-- page's text layer put after the last problem of 14.2 (seen in its preview, 2026-09-20).
-- The only statement with a section sign in it.
UPDATE problem_statements
   SET statement_tex = regexp_replace(statement_tex, '\s*§\s*14\.3\..*$', '')
 WHERE problem_name = '14.2.18' AND lang = 'ru' AND statement_tex ~ '§\s*14\.3\.';
