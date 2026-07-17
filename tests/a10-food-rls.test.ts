import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// A-10 — static guard that every Meals / Groceries / Food table is family-scoped
// (tenant-isolated) in its defining migration, so cross-family isolation on the
// A-10 surface cannot silently regress. This complements agent-01's live global
// proof (PLA-0415: 353/353 tables RLS-enabled, family B reads 0 rows of family A,
// cross-family writes blocked, verified on the PG16 harness) with an A-10-specific
// pin so a future migration can't drop the policy on one of these tables unnoticed.
//
// Every policy below scopes to the caller's own family — either via the shared
// SECURITY DEFINER helper `public.is_family_member(family_id)` or the equivalent
// inline `family_id in (select family_id from family_members where user_id =
// auth.uid())`. Neither lets family B touch family A's rows.
const mig = (n: string) => readFileSync(`supabase/migrations/${n}`, 'utf8');

const rls0004 = mig('0004_rls.sql');
const grocery0025 = mig('0025_fix_grocery_lists_rls.sql');
const recipes0014 = mig('0014_core_platform.sql');
const pantry0080 = mig('0080_food_household.sql');
const dining0104 = mig('0104_dining_out.sql');
const hub0115 = mig('0115_meals_hub.sql');

describe('A-10 food tables are family-scoped in their migrations', () => {
  it('meals / meal_plans / grocery_lists / grocery_items get is_family_member RLS in 0004', () => {
    // The loop in 0004 enables RLS + creates all four CRUD policies for each table.
    for (const t of ['meals', 'meal_plans', 'grocery_lists', 'grocery_items']) {
      expect(rls0004, `${t} must be in the 0004 family-scoped RLS loop`).toContain(`'${t}'`);
    }
    expect(rls0004).toMatch(/enable row level security/i);
    expect(rls0004).toContain('for select using (public.is_family_member(family_id))');
    expect(rls0004).toContain('for insert with check (public.is_family_member(family_id))');
    expect(rls0004).toContain('for delete using (public.is_family_member(family_id))');
  });

  it('grocery_lists / grocery_items RLS is re-asserted family-scoped in 0025', () => {
    expect(grocery0025).toContain("ARRAY['grocery_lists', 'grocery_items']");
    expect(grocery0025).toContain('ENABLE ROW LEVEL SECURITY');
    expect(grocery0025).toContain('public.is_family_member(family_id)');
    // insert path was the original bug — must carry a family-scoped WITH CHECK
    expect(grocery0025).toContain('FOR INSERT WITH CHECK (public.is_family_member(family_id))');
  });

  it('family_recipes is RLS-enabled and family-scoped in 0014', () => {
    expect(recipes0014).toContain('alter table public.family_recipes enable row level security');
    expect(recipes0014).toContain('on public.family_recipes for all');
    expect(recipes0014).toContain('family_id in (select family_id from public.family_members where user_id = auth.uid())');
  });

  it('pantry_items is RLS-enabled and family-scoped in 0080', () => {
    expect(pantry0080).toMatch(/pantry_items/);
    expect(pantry0080).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(pantry0080).toContain('USING (public.is_family_member(family_id))');
    expect(pantry0080).toContain('WITH CHECK (public.is_family_member(family_id))');
  });

  it('dining_out is RLS-enabled and family-scoped in 0104', () => {
    expect(dining0104).toContain('alter table public.dining_out enable row level security');
    expect(dining0104).toContain('on public.dining_out');
    expect(dining0104).toContain('using (public.is_family_member(family_id))');
    expect(dining0104).toContain('with check (public.is_family_member(family_id))');
  });

  it('nutrition_logs + family_favorites get is_family_member RLS on all four ops in 0115', () => {
    expect(hub0115).toContain('create table if not exists public.family_favorites');
    expect(hub0115).toContain('create table if not exists public.nutrition_logs');
    expect(hub0115).toMatch(/enable row level security/i);
    // 0115 builds the four policies via format() with is_family_member on each op
    expect(hub0115).toContain('for select using (public.is_family_member(family_id))');
    expect(hub0115).toContain('for insert with check (public.is_family_member(family_id))');
    expect(hub0115).toContain('for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))');
    expect(hub0115).toContain('for delete using (public.is_family_member(family_id))');
  });
});
