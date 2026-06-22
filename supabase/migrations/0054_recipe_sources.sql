-- ============================================================
-- Migration 0054: Recipe source provenance on the family vault
-- When a family saves an external recipe (TheMealDB, USDA, etc.) we copy it into
-- family_recipes so it survives even if the provider API is unavailable. These
-- columns record where it came from for attribution/licensing + re-normalization.
-- Additive only (ADD COLUMN IF NOT EXISTS); family_recipes RLS is unchanged.
-- ============================================================

ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS source_provider   text;
ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS source_recipe_id  text;
ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS attribution       text;
ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS license_notes     text;
ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS imported_at       timestamptz;
ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS raw_payload       jsonb;

-- Dedupe / "already saved" lookups by provider source.
CREATE INDEX IF NOT EXISTS idx_family_recipes_source
  ON public.family_recipes (family_id, source_provider, source_recipe_id);

-- ============================================================
-- Done! Imported recipes carry full source attribution + raw payload.
-- ============================================================
