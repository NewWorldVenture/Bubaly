-- ============================================================
-- Migration 0061: Food & Household (Tier 2)
-- Builds the missing Food & Household features into world-class, fully-wired
-- backing tables:
--   • pantry_items    → Pantry Tracking + Expiration Tracking + Household Inventory
--   • meal_polls      → Family Meal Voting ("what's for dinner?" — everyone votes)
--   • meal_nutrition  → AI Nutrition Analysis cache (so we never re-bill the model)
-- All three are family-scoped member data: RLS = is_family_member(family_id).
-- ============================================================

-- ── Pantry / inventory / expiration ────────────────────────
-- One row per physical thing the household keeps on hand — food in the
-- pantry/fridge/freezer AND non-food household supplies. `expires_at` powers
-- expiration alerts; `low_threshold` powers low-stock / restock alerts.
CREATE TABLE IF NOT EXISTS public.pantry_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name          text NOT NULL,
  category      text,                                   -- Produce, Dairy, Meat, Pantry, Household, …
  location      text NOT NULL DEFAULT 'pantry'
                  CHECK (location IN ('pantry','fridge','freezer','counter','garage','other')),
  quantity      numeric(10,2) NOT NULL DEFAULT 1,
  unit          text,                                   -- "boxes", "lbs", "cans", …
  low_threshold numeric(10,2),                          -- restock when quantity <= this (null = not tracked)
  expires_at    date,                                   -- best-by / use-by date (null = non-perishable)
  barcode       text,                                   -- UPC, for future scan-to-add
  is_staple     boolean NOT NULL DEFAULT false,         -- "always keep this stocked"
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pantry_family   ON public.pantry_items(family_id);
CREATE INDEX IF NOT EXISTS idx_pantry_expiry   ON public.pantry_items(family_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_pantry_location ON public.pantry_items(family_id, location);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.pantry_items;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.pantry_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.pantry_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage pantry_items" ON public.pantry_items;
CREATE POLICY "Members can manage pantry_items" ON public.pantry_items
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ── Family meal voting ─────────────────────────────────────
-- A lightweight poll ("What's for dinner Friday?"). Options + the members who
-- voted for each live in a single jsonb array so a poll is one row:
--   options: [{ id, label, meal_id?, recipe_id?, emoji?, voter_ids: [member_id, …] }]
-- Voting is single-choice and toggled in the app layer (a member appears in at
-- most one option's voter_ids). RLS keeps the whole thing family-scoped.
CREATE TABLE IF NOT EXISTS public.meal_polls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  options     jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan_date   date,                                     -- optional: the night this is for
  closes_at   timestamptz,
  winner_label text,                                    -- frozen when closed
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meal_polls_family ON public.meal_polls(family_id, status);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.meal_polls;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.meal_polls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.meal_polls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage meal_polls" ON public.meal_polls;
CREATE POLICY "Members can manage meal_polls" ON public.meal_polls
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ── AI nutrition analysis cache ────────────────────────────
-- Caches the model's nutrition read for a recipe, a single meal, or a whole
-- planned week so we never re-bill the model for unchanged content. Keyed by
-- (family, subject_type, subject_id) where subject_id is the recipe/meal uuid
-- or a week-start date string.
CREATE TABLE IF NOT EXISTS public.meal_nutrition (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  subject_type  text NOT NULL CHECK (subject_type IN ('recipe','meal','week')),
  subject_id    text NOT NULL,
  servings      integer,
  calories      integer,
  protein_g     numeric(8,2),
  carbs_g       numeric(8,2),
  fat_g         numeric(8,2),
  fiber_g       numeric(8,2),
  sugar_g       numeric(8,2),
  sodium_mg     numeric(8,2),
  summary       text,
  details       jsonb,                                  -- per-meal breakdown for week analyses
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_meal_nutrition_family ON public.meal_nutrition(family_id, subject_type);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.meal_nutrition;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.meal_nutrition
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.meal_nutrition ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can read meal_nutrition" ON public.meal_nutrition;
CREATE POLICY "Members can read meal_nutrition" ON public.meal_nutrition
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
