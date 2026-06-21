-- ============================================================
-- Migration 0025: Repair grocery_lists / grocery_items RLS
-- Symptom: creating a shopping list fails with "new row violates row-level
-- security policy for table grocery_lists". That happens when RLS is enabled on
-- the table but the family-scoped INSERT policy isn't present (e.g. a DB set up
-- from a partial bundle that ran the table alters but not 0004's policy block).
--
-- This re-asserts the standard family CRUD policies idempotently. It's a no-op
-- on a correctly-migrated database and a fix on one that's missing them.
-- ============================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['grocery_lists', 'grocery_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_select ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_select ON public.%1$I FOR SELECT USING (public.is_family_member(family_id))', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON public.%1$I FOR INSERT WITH CHECK (public.is_family_member(family_id))', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_update ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_update ON public.%1$I FOR UPDATE USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_delete ON public.%1$I FOR DELETE USING (public.is_family_member(family_id))', t);
  END LOOP;
END $$;

-- ============================================================
-- Done! Family members can create/read/update/delete their shopping lists.
-- ============================================================
