-- ============================================================
-- Migration 0045: Calendar feed subscriptions (Subscribe to Public Calendars)
-- Bubaly could already one-shot import an ICS URL, but the subscription itself
-- lived in the browser's localStorage — so it never synced across devices,
-- never auto-refreshed, and re-importing duplicated every event. This makes
-- "Subscribe to Public Calendars (URL)" 100% server-side:
--   • calendar_feeds persists each subscription per family (RLS-scoped)
--   • calendar_events gains feed_id (cascade) + external_uid for upsert dedup
--   • a partial unique index lets re-syncs UPDATE in place instead of duplicating
-- Why Bubaly's is superior: cross-device subscriptions, nightly auto-refresh,
-- and idempotent dedup so a public calendar can change and we mirror it cleanly.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.calendar_feeds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id      uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name           text NOT NULL,
  url            text NOT NULL,
  color          text NOT NULL DEFAULT 'blue',
  -- 'ok' | 'error' | 'pending' — surfaced in the UI with the last message.
  last_status    text NOT NULL DEFAULT 'pending',
  last_error     text,
  last_synced_at timestamptz,
  event_count    integer NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_feeds_family ON public.calendar_feeds(family_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.calendar_feeds;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.calendar_feeds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Link imported events back to their feed (cascade delete) and stamp the source
-- iCalendar UID so re-syncs can upsert rather than duplicate.
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS feed_id uuid REFERENCES public.calendar_feeds(id) ON DELETE CASCADE;
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS external_uid text;

-- One row per (feed, source UID): the upsert conflict target for idempotent sync.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_calendar_events_feed_uid
  ON public.calendar_events(feed_id, external_uid)
  WHERE feed_id IS NOT NULL AND external_uid IS NOT NULL;

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.calendar_feeds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage calendar_feeds" ON public.calendar_feeds;
CREATE POLICY "Members can manage calendar_feeds" ON public.calendar_feeds
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
