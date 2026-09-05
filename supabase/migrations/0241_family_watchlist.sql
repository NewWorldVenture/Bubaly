-- ============================================================
-- Migration 0241: Family Watchlist — "Don't know what to watch" (TODO-0408)
--   watchlist_titles — movies / shows the family wants to (or did) watch, with
--                      kind, genres, age rating + minimum age, runtime, service.
--   watchlist_votes  — one vote per member per title (love / up / down).
--   watch_sessions   — movie nights: what was watched, by whom, rating.
-- Family-owned data: members read/write their own family's rows (RLS).
-- Additive + idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.watchlist_titles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title         text NOT NULL,
  kind          text NOT NULL DEFAULT 'movie' CHECK (kind IN ('movie','show','documentary','kids','special')),
  year          integer CHECK (year IS NULL OR year BETWEEN 1900 AND 2100),
  genres        text[] NOT NULL DEFAULT '{}',
  age_rating    text,
  min_age       integer NOT NULL DEFAULT 0 CHECK (min_age BETWEEN 0 AND 21),
  runtime_min   integer CHECK (runtime_min IS NULL OR runtime_min BETWEEN 1 AND 1440),
  service       text NOT NULL DEFAULT 'other'
                CHECK (service IN ('netflix','disney','prime','hulu','max','apple','peacock','paramount','youtube','library','theater','other')),
  status        text NOT NULL DEFAULT 'want' CHECK (status IN ('want','watching','watched','skipped')),
  priority      integer NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  added_by      uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  external_url  text,
  poster_path   text,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_watchlist_titles_family_status ON public.watchlist_titles (family_id, status, priority);

CREATE TABLE IF NOT EXISTS public.watchlist_votes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title_id      uuid NOT NULL REFERENCES public.watchlist_titles(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  vote          text NOT NULL DEFAULT 'up' CHECK (vote IN ('love','up','down')),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (title_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_votes_family_title ON public.watchlist_votes (family_id, title_id);

CREATE TABLE IF NOT EXISTS public.watch_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title_id      uuid REFERENCES public.watchlist_titles(id) ON DELETE SET NULL,
  title_name    text NOT NULL,
  watched_on    date NOT NULL DEFAULT CURRENT_DATE,
  member_ids    uuid[] NOT NULL DEFAULT '{}',
  rating        integer CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  minutes       integer CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 1440),
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_family_watched ON public.watch_sessions (family_id, watched_on DESC);

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['watchlist_titles','watchlist_votes','watch_sessions'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    EXECUTE format('ALTER TABLE public.%1$I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_all ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_all ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
  END LOOP;
END $$;

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['watchlist_titles','watchlist_votes','watch_sessions'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN RETURN; END IF;
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
