-- Allow 'interactive' as a lesson content_type so MyPD can natively hold
-- interactive content (converted Moodle H5P, and future authored interactives).
-- Additive and idempotent. Safe to run on a live database.

BEGIN;

ALTER TABLE public.lessons DROP CONSTRAINT IF EXISTS lessons_content_type_check;
ALTER TABLE public.lessons
  ADD CONSTRAINT lessons_content_type_check
  CHECK (content_type::text = ANY (ARRAY[
    'rich_text', 'video', 'scorm', 'quiz', 'assignment', 'interactive'
  ]::text[]));

COMMIT;
