-- Zoom conferences + per-click access logging (no LTI required).
-- Additive only. Safe to run on a live database.
--
-- Apply with one of:
--   psql "$POSTGRES_URL_NON_POOLING" -f supabase/migrations/20260924120000_zoom_conference_access_logs.sql
--   or paste into the Supabase SQL editor.

BEGIN;

-- 1. Allow 'zoom' as a video provider (existing rows unchanged).
ALTER TABLE public.video_conferences DROP CONSTRAINT IF EXISTS video_conferences_video_provider_check;
ALTER TABLE public.video_conferences
  ADD CONSTRAINT video_conferences_video_provider_check
  CHECK (video_provider::text = ANY (ARRAY['8x8vc', 'google_meet', 'bigbluebutton', 'zoom']));

-- 2. Access log for external providers. One row per join action; the
--    heartbeat and leave calls update last_seen_at / ended_at on that row.
CREATE TABLE IF NOT EXISTS public.conference_access_logs (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  conference_id uuid NOT NULL REFERENCES public.video_conferences(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  course_id     uuid,
  event         varchar(32) NOT NULL CHECK (event IN ('page_view', 'join_click', 'join_redirect', 'leave')),
  role          varchar(32),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  ended_at      timestamptz,
  ip            varchar(64),
  user_agent    text,
  device_type   varchar(32),
  browser       varchar(64),
  os            varchar(64),
  referrer      text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS conference_access_logs_conf_time_idx
  ON public.conference_access_logs (conference_id, occurred_at);
CREATE INDEX IF NOT EXISTS conference_access_logs_user_idx
  ON public.conference_access_logs (user_id);

-- 3. Lock the table down. The API writes and reads it with the service
--    role, which bypasses RLS; with no policies, the anon/authenticated
--    keys cannot touch it.
ALTER TABLE public.conference_access_logs ENABLE ROW LEVEL SECURITY;

COMMIT;
