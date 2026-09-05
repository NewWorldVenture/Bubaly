-- ============================================================
-- Migration 0242: Home Inventory — "Can't remember where things are" (TODO-0409)
--   home_locations   — rooms and the containers inside them (nested via parent_id).
--   inventory_items  — the family's possessions: what, where, how many, value,
--                      warranty, status (in place / lent / lost / disposed / in repair).
--   inventory_moves  — every relocation, so "where did it go?" has an answer.
-- Family-owned data: members read/write their own family's rows (RLS).
-- Additive + idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.home_locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'room'
                CHECK (kind IN ('room','closet','garage','attic','basement','shed','storage_unit','box','shelf','drawer','cabinet','vehicle','other')),
  parent_id     uuid REFERENCES public.home_locations(id) ON DELETE SET NULL,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_home_locations_family_parent ON public.home_locations (family_id, parent_id);

CREATE TABLE IF NOT EXISTS public.inventory_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name              text NOT NULL,
  category          text NOT NULL DEFAULT 'other'
                    CHECK (category IN ('electronics','tools','sports','toys','documents','kitchen','furniture','seasonal','clothing','outdoor','medical','keys','jewelry','other')),
  location_id       uuid REFERENCES public.home_locations(id) ON DELETE SET NULL,
  owner_member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  quantity          integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  value_cents       integer CHECK (value_cents IS NULL OR value_cents >= 0),
  purchased_on      date,
  brand             text,
  model             text,
  serial_number     text,
  warranty_until    date,
  photo_path        text,
  tags              text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'in_place'
                    CHECK (status IN ('in_place','lent','lost','disposed','in_repair')),
  lent_to           text,
  lent_on           date,
  notes             text,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_items_family_location ON public.inventory_items (family_id, location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_family_status ON public.inventory_items (family_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_family_category ON public.inventory_items (family_id, category);

CREATE TABLE IF NOT EXISTS public.inventory_moves (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  item_id           uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  from_location_id  uuid REFERENCES public.home_locations(id) ON DELETE SET NULL,
  to_location_id    uuid REFERENCES public.home_locations(id) ON DELETE SET NULL,
  moved_by          uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  moved_at          timestamptz NOT NULL DEFAULT now(),
  reason            text,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_moves_family_item ON public.inventory_moves (family_id, item_id, moved_at DESC);

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['home_locations','inventory_items','inventory_moves'];
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
DECLARE tbls text[] := ARRAY['home_locations','inventory_items','inventory_moves'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN RETURN; END IF;
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
