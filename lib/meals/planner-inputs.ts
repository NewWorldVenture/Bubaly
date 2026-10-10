import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { readCountedRows } from '@/lib/calendar/occurrences';
import { PLAN_MEAL_TYPES, type MealRow, type RecipeRow } from './planner';
import { isDayKey } from '@/lib/services/meals';

// A safety budget, never a shortlist: even a household with fifty saved dishes
// or dated pantry items per day for a year fits. Larger libraries refuse rather
// than silently changing the globally ranked prompt choices.
const INPUT_MAX = 20_000;
type Owned = { id: string; family_id: string; name: string };
type PantryRow = Owned & { expires_at: string };
type Page = { data: unknown[] | null; count: number | null; error: { message: string } | null };
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

async function complete<T extends Owned>(
  familyId: string,
  query: () => { limit(n: number): PromiseLike<Page>; range(from: number, to: number): PromiseLike<Page> },
  valid: (row: T) => boolean,
) {
  const fail = () => ({ data: null, error: { message: 'The complete meal planning library could not be loaded.' } });
  if (!nonempty(familyId)) return fail();
  const result = await readCountedRows<T>(() => query().limit(1000), (from, to) => query().range(from, to), INPUT_MAX, 'meal planning inputs');
  if (result.error) return fail();
  if (result.data?.some(row => !nonempty(row.id) || row.family_id !== familyId || !nonempty(row.name) || !valid(row))) return fail();
  return result;
}

/** Complete independently counted sets, not a transaction snapshot. */
export function readPlannerMeals(db: SupabaseClient<Database>, familyId: string) {
  return complete<Owned & MealRow>(familyId,
    () => db.from('meals').select('id,family_id,name,meal_type', { count: 'exact' }).eq('family_id', familyId).order('id'),
    row => PLAN_MEAL_TYPES.some(type => type === row.meal_type));
}

export function readPlannerRecipes(db: SupabaseClient<Database>, familyId: string) {
  return complete<Owned & RecipeRow>(familyId,
    () => db.from('family_recipes').select('id,family_id,name,category,allergy_flags', { count: 'exact' }).eq('family_id', familyId).order('id'),
    row => nonempty(row.category) && (row.allergy_flags == null || (Array.isArray(row.allergy_flags) && row.allergy_flags.every(nonempty))));
}

export function readPlannerPantry(db: SupabaseClient<Database>, familyId: string) {
  return complete<PantryRow>(familyId,
    () => db.from('pantry_items').select('id,family_id,name,expires_at', { count: 'exact' }).eq('family_id', familyId).not('expires_at', 'is', null).order('id'),
    row => isDayKey(row.expires_at));
}
