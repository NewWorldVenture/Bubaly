-- ============================================================================
-- Migration 0072: Weekend Planner — local event source feeds
-- ----------------------------------------------------------------------------
-- Beyond the keyed nationwide providers (Ticketmaster, SeatGeek), families can
-- register reliable LOCAL sources as standards-based calendar/RSS feeds — a city
-- events calendar, library, parks & rec, school district, museum, etc. The
-- discovery crawler fetches each active feed, parses upcoming items in the
-- window, and merges them with provider results. Family-scoped RLS.
-- ============================================================================

DO $$ BEGIN CREATE TYPE weekend_feed_kind AS ENUM ('ics','rss'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.weekend_feeds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  label           text NOT NULL,
  url             text NOT NULL,
  kind            weekend_feed_kind NOT NULL DEFAULT 'ics',
  is_active       boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_status     text,                 -- 'ok' | error message
  last_count      integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, url)
);
CREATE INDEX IF NOT EXISTS idx_weekend_feeds_family ON public.weekend_feeds (family_id, is_active);

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['weekend_feeds'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ============================================================================
-- Done! Family-curated local event feeds for the Weekend Planner crawler.
-- ============================================================================
