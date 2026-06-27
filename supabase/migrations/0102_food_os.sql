-- Family Food Operating System — two new tables that close the loop on the
-- existing food stack (meals, recipes, pantry, grocery, nutrition):
--   leftover_inventory  — track leftovers so the AI Chef reuses them first
--                         (an industry-first waste-cutting differentiator).
--   family_food_scores  — daily snapshots of the Family Food Health Score so the
--                         Smart Kitchen Dashboard can show a trend over time.

-- ── Leftover inventory ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leftover_inventory (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  source_meal  text,                      -- e.g. "Sunday roast chicken"
  quantity     text,                      -- free-text portion ("2 servings")
  stored_on    date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  use_by       date,                      -- eat-before date
  location     text NOT NULL DEFAULT 'fridge'
                 CHECK (location IN ('fridge','freezer','counter','other')),
  status       text NOT NULL DEFAULT 'fresh'
                 CHECK (status IN ('fresh','eaten','frozen','tossed','donated')),
  notes        text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leftover_family   ON public.leftover_inventory(family_id, status);
CREATE INDEX IF NOT EXISTS idx_leftover_use_by   ON public.leftover_inventory(family_id, use_by);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.leftover_inventory;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.leftover_inventory
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.leftover_inventory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage leftover_inventory" ON public.leftover_inventory;
CREATE POLICY "Members can manage leftover_inventory" ON public.leftover_inventory
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ── Family Food Health Score snapshots ─────────────────────────
CREATE TABLE IF NOT EXISTS public.family_food_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  overall       integer NOT NULL CHECK (overall BETWEEN 0 AND 100),
  grade         text NOT NULL,
  sub_scores    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ key, label, score, detail }]
  coaching      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- string[]
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_food_scores_family ON public.family_food_scores(family_id, snapshot_date DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.family_food_scores;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.family_food_scores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_food_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage family_food_scores" ON public.family_food_scores;
CREATE POLICY "Members can manage family_food_scores" ON public.family_food_scores
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
