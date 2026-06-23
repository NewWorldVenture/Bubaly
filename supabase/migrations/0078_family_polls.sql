-- ============================================================
-- Migration 0078: Group Voting — family_polls + options + votes
-- Collaborative decisions (where to go, what to do, which restaurant). Polls can
-- optionally attach to a vacation (vacation_id) for trip decisions, or stand
-- alone for any family choice. Single- or multi-choice; live tally. Family RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.family_polls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id uuid REFERENCES public.vacations(id) ON DELETE SET NULL,
  question    text NOT NULL,
  description text,
  kind        text NOT NULL DEFAULT 'single' CHECK (kind IN ('single','multi')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closes_at   timestamptz,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_polls_family ON public.family_polls (family_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.family_poll_options (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  poll_id   uuid NOT NULL REFERENCES public.family_polls(id) ON DELETE CASCADE,
  label     text NOT NULL,
  sort      integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_poll_options_poll ON public.family_poll_options (poll_id, sort);

CREATE TABLE IF NOT EXISTS public.family_poll_votes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  poll_id   uuid NOT NULL REFERENCES public.family_polls(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES public.family_poll_options(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (option_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_family_poll_votes_poll ON public.family_poll_votes (poll_id);

DROP TRIGGER IF EXISTS trg_family_polls_updated ON public.family_polls;
CREATE TRIGGER trg_family_polls_updated BEFORE UPDATE ON public.family_polls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_polls        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_poll_votes   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage family_polls" ON public.family_polls;
CREATE POLICY "Members manage family_polls" ON public.family_polls
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS "Members manage family_poll_options" ON public.family_poll_options;
CREATE POLICY "Members manage family_poll_options" ON public.family_poll_options
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS "Members manage family_poll_votes" ON public.family_poll_votes;
CREATE POLICY "Members manage family_poll_votes" ON public.family_poll_votes
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
