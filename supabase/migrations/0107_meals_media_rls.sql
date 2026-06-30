-- FamilyOS :: 0107 meals media + RLS repair
-- ----------------------------------------------------------------------------
-- 1) Add a photo to planner meals so the Meal Plan grid can show dish images
--    (family_recipes already has photo_url; meals did not).
-- 2) Re-assert the family-scoped RLS policies on the meals-domain tables (same
--    drift safeguard as 0105/0106) so authenticated members can read/write the
--    planner, recipes, grocery list, and votes. Idempotent.

alter table public.meals add column if not exists image_url text;

do $$
declare t text;
begin
  foreach t in array array[
    'meals','meal_plans','grocery_lists','grocery_items',
    'family_recipes','meal_votes','meal_vote_options','meal_vote_ballots','meal_nutrition'
  ] loop
    -- Only touch tables that actually exist + carry family_id.
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'family_id'
    ) then
      execute format('alter table public.%I enable row level security;', t);
      execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
      execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
      execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
      execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
      execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
    end if;
  end loop;
end $$;
