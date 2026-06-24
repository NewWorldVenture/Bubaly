-- ============================================================
-- Migration 0047: Event RSVPs (accept / decline / maybe)
-- Members can RSVP to family calendar events, and the organizer sees the tally.
-- A Free-tier differentiator — clicking an event now opens a detail view where
-- everyone can respond. Family-scoped RLS; one RSVP per member per event.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE rsvp_status AS ENUM ('accepted', 'declined', 'maybe');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.event_rsvps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES public.calendar_events(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  status       rsvp_status NOT NULL DEFAULT 'accepted',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_rsvps_once UNIQUE (event_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON public.event_rsvps(event_id);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_family ON public.event_rsvps(family_id);

DROP TRIGGER IF EXISTS trg_event_rsvps_updated_at ON public.event_rsvps;
CREATE TRIGGER trg_event_rsvps_updated_at BEFORE UPDATE ON public.event_rsvps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.event_rsvps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage event_rsvps" ON public.event_rsvps;
CREATE POLICY "Members can manage event_rsvps" ON public.event_rsvps
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Family members can RSVP to calendar events.
-- ============================================================
