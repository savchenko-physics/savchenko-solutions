-- Four Russian statements opened with a stray dollar the builder left when it stripped
-- "$1.1.9. а.$" down to "а.$": marked set the whole first sentence as maths, italic with its
-- spaces gone (the preview of 1.1.9, 2026-09-20). The letter of the sub-item stays, the
-- dollar goes; a lone star marker goes whole, the starred column carries it. Only rows whose
-- dollars do not pair up are touched. scripts/build-statements.js no longer produces this.
UPDATE problem_statements
   SET statement_tex = regexp_replace(statement_tex, '^\s*([а-яa-z])\s*\.\s*\$\s*', '\1. ')
 WHERE (length(statement_tex) - length(replace(statement_tex, '$', ''))) % 2 = 1
   AND statement_tex ~ '^\s*[а-яa-z]\s*\.\s*\$';
UPDATE problem_statements
   SET statement_tex = regexp_replace(statement_tex, '^\s*(\*\s*\.?|\^\s*\*)\s*\$\s*', '')
 WHERE (length(statement_tex) - length(replace(statement_tex, '$', ''))) % 2 = 1
   AND statement_tex ~ '^\s*(\*\s*\.?|\^\s*\*)\s*\$';
