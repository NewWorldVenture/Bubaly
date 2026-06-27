-- ============================================================
-- Migration 0055: Family Meal Voting
-- Parents propose meal options (from the recipe vault or free-text); the family
-- votes; the highest-scoring option wins and can flow to the grocery list.
-- Family-scoped RLS throughout (is_family_member). One ballot per member/option.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.meal_votes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title            text NOT NULL,
  meal_date        date,
  meal_type        text,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  deadline         timestamptz,
  allow_maybe      boolean NOT NULL DEFAULT true,
  winner_option_id uuid,            -- set on close (FK added below, deferrable-style via app)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meal_votes_family ON public.meal_votes (family_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_meal_votes_updated_at ON public.meal_votes;
CREATE TRIGGER trg_meal_votes_updated_at BEFORE UPDATE ON public.meal_votes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.meal_vote_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id     uuid NOT NULL REFERENCES public.meal_votes(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  recipe_id   uuid REFERENCES public.family_recipes(id) ON DELETE SET NULL,
  label       text NOT NULL,         -- denormalized recipe name or free-text option
  photo_url   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meal_vote_options_vote ON public.meal_vote_options (vote_id);

CREATE TABLE IF NOT EXISTS public.meal_vote_ballots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id     uuid NOT NULL REFERENCES public.meal_votes(id) ON DELETE CASCADE,
  option_id   uuid NOT NULL REFERENCES public.meal_vote_options(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  choice      text NOT NULL DEFAULT 'yes' CHECK (choice IN ('yes','no','maybe')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_vote_ballots_once UNIQUE (option_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_meal_vote_ballots_vote ON public.meal_vote_ballots (vote_id);

DROP TRIGGER IF EXISTS trg_meal_vote_ballots_updated_at ON public.meal_vote_ballots;
CREATE TRIGGER trg_meal_vote_ballots_updated_at BEFORE UPDATE ON public.meal_vote_ballots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: family members manage their family's votes/options/ballots ──
ALTER TABLE public.meal_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage meal_votes" ON public.meal_votes;
CREATE POLICY "Members manage meal_votes" ON public.meal_votes
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.meal_vote_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage meal_vote_options" ON public.meal_vote_options;
CREATE POLICY "Members manage meal_vote_options" ON public.meal_vote_options
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.meal_vote_ballots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage meal_vote_ballots" ON public.meal_vote_ballots;
CREATE POLICY "Members manage meal_vote_ballots" ON public.meal_vote_ballots
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Families can propose, vote on, and pick winning meals.
-- ============================================================
