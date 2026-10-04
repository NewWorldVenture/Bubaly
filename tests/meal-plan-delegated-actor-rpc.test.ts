import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/0476_meal_plan_delegated_actor_rpcs.sql', 'utf8');
const mealService = readFileSync('lib/services/meals/index.ts', 'utf8');
const cleanupConcurrencyFixture = readFileSync('tests/fixtures/0476-meal-plan-name-concurrency.sql', 'utf8');

describe('delegated meal-plan database boundary', () => {
  it('serializes normalized family/name lookup before creating a custom meal', () => {
    expect(migration).toMatch(/create or replace function public\.meal_ensure_custom_for_actor\([\s\S]*?security definer\s+set search_path = ''/i);
    expect(migration).toMatch(/pg_advisory_xact_lock\(pg_catalog\.hashtextextended\([\s\S]*?'meal-library-name:' \|\| p_family_id::text[\s\S]*?\)\);[\s\S]*?select m\.\* into v_meal from public\.meals/i);
    expect(migration).toMatch(/meal_plan_replace_slots_for_actor\([\s\S]*?public\.meal_ensure_custom_for_actor\(/i);
    expect(migration).toMatch(/create or replace function public\.meal_ensure_custom\([\s\S]*?auth\.uid\(\)[\s\S]*?public\.meal_ensure_custom_for_actor\(/i);
    expect(migration).toMatch(/meal_normalize_custom_ingredients\(m\.ingredients\) = public\.meal_normalize_custom_ingredients\(v_ingredients\)/i);
    expect(migration).toMatch(/revoke all on function public\.meal_ensure_custom_for_actor\([^;]+ from public, anon, authenticated, service_role/i);
    expect(migration).toMatch(/grant execute on function public\.meal_ensure_custom\([^;]+ to authenticated/i);
  });
  it('exposes the two SECURITY DEFINER actor wrappers only to service_role', () => {
    expect(migration).toMatch(/create or replace function public\.meal_plan_replace_slots_for_actor\s*\([\s\S]*?security definer\s+set search_path = ''/i);
    expect(migration).toMatch(/create or replace function public\.meal_plan_remove_slot_for_actor\s*\([\s\S]*?security definer\s+set search_path = ''/i);
    expect(migration).toMatch(/revoke all on function public\.meal_plan_replace_slots_for_actor\([^;]+ from public, anon, authenticated, service_role/i);
    expect(migration).toMatch(/revoke all on function public\.meal_plan_remove_slot_for_actor\([^;]+ from public, anon, authenticated, service_role/i);
    expect(migration).toMatch(/grant execute on function public\.meal_plan_replace_slots_for_actor\([^;]+ to service_role/i);
    expect(migration).toMatch(/grant execute on function public\.meal_plan_remove_slot_for_actor\([^;]+ to service_role/i);
    expect(migration).toMatch(/has_function_privilege\('authenticated', v_replace, 'execute'\)/i);
    expect(migration).toMatch(/has_function_privilege\('service_role', v_replace, 'execute'\)/i);
    expect(migration).toMatch(/has_function_privilege\('authenticated', v_remove, 'execute'\)/i);
    expect(migration).toMatch(/has_function_privilege\('service_role', v_remove, 'execute'\)/i);
  });

  it('binds delegated writes to an active non-guest family actor in the write transaction', () => {
    expect(migration.match(/fm\.family_id = p_family_id and fm\.user_id = p_actor_id and fm\.is_active\s+for share/gi)).toHaveLength(3);
    expect(migration.match(/v_actor_role = 'guest'/gi)).toHaveLength(4);
    expect(migration).toContain("set_config('request.jwt.claim.sub', p_actor_id::text, true)");
    expect(migration).toContain("public.meal_plan_replace_slots(p_family_id, v_inner_request_id, v_normalized_entries)");
    expect(migration).toContain("public.meal_plan_remove_slot(p_family_id, v_inner_request_id, p_plan_id)");
    expect(migration).toMatch(/insert into public\.meals\(family_id, name, meal_type, ingredients, recipe_url, image_url, notes, created_by\)[\s\S]*?p_actor_id/i);
    expect(migration).toMatch(/public\.family_recipes r[\s\S]*?r\.id = \(v_entry->>'recipe_id'\)::uuid and r\.family_id = p_family_id/i);
    expect(migration).toMatch(/public\.meals m where m\.id = v_meal_id and m\.family_id = p_family_id/i);
    expect(migration).toMatch(/v_receipt_request_id := 'actor-replace:'/i);
  });

  it('serializes failed-plan cleanup against FK adoption and retains committed references', () => {
    expect(migration).toMatch(/create or replace function public\.meal_cleanup_unreferenced_custom\([\s\S]*?auth\.uid\(\)[\s\S]*?fm\.family_id = p_family_id and fm\.user_id = v_actor_id and fm\.is_active[\s\S]*?created_by = v_actor_id/i);
    expect(migration).toMatch(/perform 1 from public\.meals m[\s\S]*?for update;[\s\S]*?exists \(select 1 from public\.meal_plans p where p\.meal_id = v_meal_id\)[\s\S]*?exists \(select 1 from public\.grocery_items gi where gi\.source_meal_id = v_meal_id\)[\s\S]*?and not exists \(select 1 from public\.meal_plans p where p\.meal_id = v_meal_id\)[\s\S]*?and not exists \(select 1 from public\.grocery_items gi where gi\.source_meal_id = v_meal_id\)/i);
    expect(migration).toMatch(/v_meal_fk_count <> 2[\s\S]*?public\.meal_plans[\s\S]*?meal_id[\s\S]*?public\.grocery_items[\s\S]*?source_meal_id[\s\S]*?c\.confdeltype = 'n'/i);
    expect(migration).toMatch(/create or replace function public\.meal_cleanup_unreferenced_custom\([\s\S]*?security definer\s+set search_path = ''/i);
    expect(migration).toMatch(/grant execute on function public\.meal_cleanup_unreferenced_custom\([^;]+ to authenticated/i);
    expect(mealService).toMatch(/meal_cleanup_unreferenced_custom[\s\S]*?p_meal_ids: \[\.\.\.new Set\(createdMealIds\)\]/i);
    expect(mealService).not.toMatch(/from\('meals'\)\.delete\(\)\.eq\('family_id', scope\.familyId\)\.in\('id', createdMealIds\)/i);
    expect(cleanupConcurrencyFixture).toContain("'10000000-0000-0000-0000-000000000002','cross-family grocery reference synthetic meal'");
    expect(cleanupConcurrencyFixture).toContain('source_meal_id');
    expect(cleanupConcurrencyFixture).toContain('authenticated Family A can persist its grocery item referencing a Family B meal');
    expect(cleanupConcurrencyFixture).toContain('cleanup retains a cross-family meal referenced by a committed grocery item');
  });
});
