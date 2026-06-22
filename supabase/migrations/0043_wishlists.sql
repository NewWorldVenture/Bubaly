-- ============================================================
-- Migration 0043: Wish Lists (gift coordination with surprise-hiding)
-- Bubaly's answer to FamilyWall's "Wish Lists". Each member keeps a list
-- of things they want; OTHER members can privately "claim" an item to
-- coordinate gifts — and the claim is hidden from the wish's owner so the
-- surprise survives (enforced in the app layer; RLS keeps it family-scoped).
-- ============================================================

DO $$ BEGIN
  CREATE TYPE wish_priority AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.wishlist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  -- Whose wish this is.
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  title        text NOT NULL,
  url          text,
  price        numeric(10,2),
  priority     wish_priority NOT NULL DEFAULT 'medium',
  notes        text,
  -- Gift coordination: who has claimed/bought this for the owner. Hidden from
  -- the owner in the UI so it stays a surprise.
  claimed_by   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  claimed_at   timestamptz,
  is_purchased boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wishlist_family ON public.wishlist_items(family_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_member ON public.wishlist_items(family_id, member_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.wishlist_items;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.wishlist_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.wishlist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage wishlist_items" ON public.wishlist_items;
CREATE POLICY "Members can manage wishlist_items" ON public.wishlist_items
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
