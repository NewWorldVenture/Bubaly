-- ============================================================
-- Migration 0240: Closet & Outfits — "Don't know what to wear" (TODO-0407)
--   wardrobe_items — per-member garments tagged with warmth, formality and
--                    seasons, plus status (active / laundry / storage /
--                    outgrown / donated / lost) and wear tracking.
--   outfits        — named combinations of items for an occasion + temperature band.
--   outfit_logs    — what was actually worn, on which day, in what weather.
-- Family-owned data: members read/write their own family's rows (RLS).
-- Additive + idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.wardrobe_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  name          text NOT NULL,
  category      text NOT NULL DEFAULT 'top'
                CHECK (category IN ('top','bottom','dress','outerwear','shoes','accessory','uniform','sleepwear','activewear','swim')),
  color         text,
  size          text,
  brand         text,
  warmth        integer NOT NULL DEFAULT 3 CHECK (warmth BETWEEN 1 AND 5),
  formality     integer NOT NULL DEFAULT 2 CHECK (formality BETWEEN 1 AND 5),
  seasons       text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','laundry','storage','outgrown','donated','lost')),
  photo_path    text,
  purchased_on  date,
  price_cents   integer CHECK (price_cents IS NULL OR price_cents >= 0),
  wear_count    integer NOT NULL DEFAULT 0 CHECK (wear_count >= 0),
  last_worn_on  date,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wardrobe_items_family_member ON public.wardrobe_items (family_id, member_id, status);
CREATE INDEX IF NOT EXISTS idx_wardrobe_items_family_category ON public.wardrobe_items (family_id, category);

CREATE TABLE IF NOT EXISTS public.outfits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  name          text NOT NULL,
  occasion      text NOT NULL DEFAULT 'everyday'
                CHECK (occasion IN ('everyday','school','work','sport','dressy','party','outdoor','sleep')),
  item_ids      uuid[] NOT NULL DEFAULT '{}',
  temp_min_c    integer,
  temp_max_c    integer,
  rating        integer CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  is_favorite   boolean NOT NULL DEFAULT false,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outfits_family_member ON public.outfits (family_id, member_id);

CREATE TABLE IF NOT EXISTS public.outfit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  outfit_id     uuid REFERENCES public.outfits(id) ON DELETE SET NULL,
  worn_on       date NOT NULL DEFAULT CURRENT_DATE,
  item_ids      uuid[] NOT NULL DEFAULT '{}',
  occasion      text,
  temp_c        integer,
  weather       text,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outfit_logs_family_worn ON public.outfit_logs (family_id, worn_on DESC);
CREATE INDEX IF NOT EXISTS idx_outfit_logs_member ON public.outfit_logs (member_id, worn_on DESC);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['wardrobe_items','outfits','outfit_logs'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- RLS (family members manage their own family's rows) ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['wardrobe_items','outfits','outfit_logs'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%1$I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_all ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_all ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
  END LOOP;
END $$;

-- ---------- Realtime (live closet across the family's devices) ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['wardrobe_items','outfits','outfit_logs'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN RETURN; END IF;
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
