-- Delete rules for every foreign key that references public.lessons.
-- Fixes: deleting a lesson failed with 23503 ("still referenced from table
-- quizzes") because the FK used the default NO ACTION rule.
--
-- Policy:
--   * KEEP tables (assessments and resources with value of their own) are
--     DETACHED: lesson_id becomes NULL, the row and its student data survive.
--   * Every other referencing table (progress, notes, discussions, tracking,
--     XP, AI tutor rows, ...) is DELETED with the lesson via CASCADE.
--
-- Idempotent and additive. Safe to run on a live database. Any table added
-- later with a lesson FK can be covered by running this file again.
--
-- Apply with one of:
--   psql "$POSTGRES_URL_NON_POOLING" -f supabase/migrations/20260924130000_lessons_fk_delete_rules.sql
--   or paste into the Supabase SQL editor.

BEGIN;

DO $$
DECLARE
  keep_tables text[] := ARRAY[
    'quizzes', 'assignments', 'surveys', 'video_conferences',
    'resource_links', 'scorm_packages'
  ];
  r record;
  base_def text;
  wanted   text;
  col_nullable boolean;
BEGIN
  FOR r IN
    SELECT
      con.oid,
      con.conname,
      nsp.nspname     AS schema_name,
      cls.relname     AS table_name,
      con.confdeltype AS current_action,
      (SELECT att.attname
         FROM pg_attribute att
        WHERE att.attrelid = con.conrelid
          AND att.attnum   = con.conkey[1]) AS fk_column,
      array_length(con.conkey, 1) AS fk_arity
    FROM pg_constraint con
    JOIN pg_class      cls ON cls.oid = con.conrelid
    JOIN pg_namespace  nsp ON nsp.oid = cls.relnamespace
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.lessons'::regclass
  LOOP
    IF r.table_name = ANY (keep_tables) THEN
      wanted := 'n';  -- SET NULL
    ELSE
      wanted := 'c';  -- CASCADE
    END IF;

    IF r.current_action = wanted THEN
      RAISE NOTICE 'lessons FK %.% (%): already %', r.table_name, r.fk_column, r.conname,
        CASE wanted WHEN 'n' THEN 'SET NULL' ELSE 'CASCADE' END;
      CONTINUE;
    END IF;

    -- SET NULL needs a nullable column. Composite keys cannot be set null
    -- sensibly, so fall back to CASCADE for those.
    IF wanted = 'n' THEN
      IF r.fk_arity > 1 THEN
        RAISE NOTICE 'lessons FK % is composite; using CASCADE instead of SET NULL', r.conname;
        wanted := 'c';
      ELSE
        SELECT NOT att.attnotnull INTO col_nullable
          FROM pg_attribute att
         WHERE att.attrelid = format('%I.%I', r.schema_name, r.table_name)::regclass
           AND att.attname  = r.fk_column;
        IF NOT col_nullable THEN
          EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I DROP NOT NULL',
                         r.schema_name, r.table_name, r.fk_column);
          RAISE NOTICE 'lessons FK %.%: dropped NOT NULL so SET NULL can apply',
            r.table_name, r.fk_column;
        END IF;
      END IF;
    END IF;

    -- Rebuild the constraint with the same columns/target but the new rule.
    base_def := pg_get_constraintdef(r.oid);
    base_def := regexp_replace(base_def, '\s+ON DELETE\s+(NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)', '', 'gi');
    base_def := regexp_replace(base_def, '\s+ON UPDATE\s+(NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)', '', 'gi');
    base_def := regexp_replace(base_def, '\s+(NOT\s+)?DEFERRABLE(\s+INITIALLY\s+(DEFERRED|IMMEDIATE))?', '', 'gi');
    base_def := regexp_replace(base_def, '\s+NOT\s+VALID', '', 'gi');

    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.schema_name, r.table_name, r.conname);
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s ON DELETE %s',
                   r.schema_name, r.table_name, r.conname, base_def,
                   CASE wanted WHEN 'n' THEN 'SET NULL' ELSE 'CASCADE' END);

    RAISE NOTICE 'lessons FK %.% (%): now ON DELETE %', r.table_name, r.fk_column, r.conname,
      CASE wanted WHEN 'n' THEN 'SET NULL' ELSE 'CASCADE' END;
  END LOOP;
END
$$;

COMMIT;

-- Verify (read-only): every FK into lessons and its delete rule.
SELECT cls.relname AS table_name,
       con.conname,
       CASE con.confdeltype
         WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
         WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
         WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
 WHERE con.contype = 'f' AND con.confrelid = 'public.lessons'::regclass
 ORDER BY 1;
