-- ============================================================
-- Migration 0083: Family Pet Manager — pets + pet_care_records
-- Complete pet-care operations: a profile per animal plus a dated care ledger
-- (vaccinations, vet visits, medications, grooming, weight) with optional
-- next-due dates that power the AI care-needs engine. Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.pet_species AS ENUM
    ('dog','cat','bird','fish','reptile','small_mammal','horse','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.pet_care_kind AS ENUM
    ('vaccination','vet_visit','medication','grooming','weight','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.pets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name          text NOT NULL,
  species       public.pet_species NOT NULL DEFAULT 'dog',
  breed         text,
  birthday      date,
  adoption_date date,
  weight_kg     numeric(6,2),
  color         text,
  microchip_id  text,
  photo_path    text,
  vet_name      text,
  vet_phone     text,
  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pets_family ON public.pets (family_id, is_active);

CREATE TABLE IF NOT EXISTS public.pet_care_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  pet_id       uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  kind         public.pet_care_kind NOT NULL DEFAULT 'vet_visit',
  title        text NOT NULL,
  record_date  date NOT NULL DEFAULT current_date,
  next_due     date,
  dose         text,
  weight_kg    numeric(6,2),
  notes        text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pet_care_family ON public.pet_care_records (family_id, record_date DESC);
CREATE INDEX IF NOT EXISTS idx_pet_care_pet ON public.pet_care_records (pet_id, record_date DESC);
CREATE INDEX IF NOT EXISTS idx_pet_care_due ON public.pet_care_records (family_id, next_due) WHERE next_due IS NOT NULL;

DROP TRIGGER IF EXISTS trg_pets_updated ON public.pets;
CREATE TRIGGER trg_pets_updated BEFORE UPDATE ON public.pets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_pet_care_updated ON public.pet_care_records;
CREATE TRIGGER trg_pet_care_updated BEFORE UPDATE ON public.pet_care_records
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.pets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage pets" ON public.pets;
CREATE POLICY "Members manage pets" ON public.pets
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.pet_care_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage pet_care_records" ON public.pet_care_records;
CREATE POLICY "Members manage pet_care_records" ON public.pet_care_records
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Families can manage pets + a care ledger with due dates.
-- ============================================================
