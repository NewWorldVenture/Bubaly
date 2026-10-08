import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { readCountedRows } from '@/lib/calendar/occurrences';
import { mealWeekDays } from './week';

type DB = SupabaseClient<Database>;
type Owned = { id: string; family_id: string };
type Page = { data: unknown[] | null; count: number | null; error: { message: string } | null };
type Query = { limit(n: number): PromiseLike<Page>; range(from: number, to: number): PromiseLike<Page> };
type Result<T> = { data: T[] | null; error: { message: string } | null };
export type MealPlanWithDish = Tables<'meal_plans'> & { meal: Tables<'meals'> | null };
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const nullableText = (value: unknown) => value == null || typeof value === 'string';
const mealType = (value: unknown) => ['breakfast', 'lunch', 'dinner', 'snack'].includes(String(value));
const instant = (value: unknown) => value == null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
const failure = <T>(): Result<T> => ({ data: null, error: { message: 'The complete meal collection could not be loaded.' } });

// Twenty thousand is a safety budget, not a display shortlist. Counts, identity,
// family and relevant metadata must validate before any prefix reaches the UI.
// These independently counted reads are not a database transaction snapshot.
async function complete<T extends Owned>(familyId: string, query: () => Query, valid: (row: T) => boolean): Promise<Result<T>> {
  if (!nonempty(familyId)) return failure();
  const result = await readCountedRows<T>(() => query().limit(1000), (from, to) => query().range(from, to), 20_000, 'meal collection');
  if (result.error || !result.data || result.data.some(row => !nonempty(row.id) || row.family_id !== familyId || !valid(row))) return failure();
  return result;
}

const validDish = (row: Tables<'meals'>) => nonempty(row.name) && mealType(row.meal_type)
  && nullableText(row.recipe_url) && nullableText(row.image_url);

export function readMealLibrary(db: DB, familyId: string) {
  return complete<Tables<'meals'>>(familyId,
    () => db.from('meals').select('*', { count: 'exact' }).eq('family_id', familyId).order('name').order('id'), validDish);
}

export function readMealRecipes(db: DB, familyId: string) {
  return complete<Tables<'family_recipes'>>(familyId,
    () => db.from('family_recipes').select('*', { count: 'exact' }).eq('family_id', familyId)
      .order('last_made_at', { ascending: false, nullsFirst: false }).order('name').order('id'),
    row => nonempty(row.name) && nonempty(row.category) && typeof row.is_favorite === 'boolean'
      && instant(row.last_made_at) && nullableText(row.photo_url) && nullableText(row.difficulty)
      && [row.prep_time_mins, row.cook_time_mins].every(value => value == null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)));
}

export function readMealGroceries(db: DB, familyId: string) {
  return complete<Tables<'grocery_items'>>(familyId,
    () => db.from('grocery_items').select('*', { count: 'exact' }).eq('family_id', familyId)
      .order('is_checked').order('created_at', { ascending: false }).order('id'),
    row => nonempty(row.name) && nonempty(row.list_id) && typeof row.is_checked === 'boolean'
      && instant(row.created_at) && nullableText(row.quantity) && nullableText(row.category));
}

export async function readMealWeek(db: DB, familyId: string, days: readonly string[]): Promise<Result<MealPlanWithDish>> {
  if (days.length !== 7 || mealWeekDays(days[0]).some((day, index) => day !== days[index]) || mealWeekDays(days[0]).length !== 7) return failure();
  const result = await complete<Tables<'meal_plans'>>(familyId,
    () => db.from('meal_plans').select('*', { count: 'exact' }).eq('family_id', familyId)
      .gte('plan_date', days[0]).lte('plan_date', days[6]).order('plan_date').order('meal_type').order('id'),
    row => days.includes(row.plan_date) && mealType(row.meal_type) && (row.meal_id === null || nonempty(row.meal_id)));
  if (result.error || !result.data) return failure();
  const slots = new Set(result.data.map(row => `${row.plan_date}:${row.meal_type}`));
  if (slots.size !== result.data.length) return failure();
  const ids = [...new Set(result.data.flatMap(row => row.meal_id === null ? [] : [row.meal_id]))];
  // At most 28 distinct dishes for a valid seven-day, four-meal-type week.
  // Still page the join: a project's response cap can be below this bound.
  const joined = ids.length ? await complete<Tables<'meals'>>(familyId,
    () => db.from('meals').select('*', { count: 'exact' }).eq('family_id', familyId).in('id', ids).order('id'),
    row => ids.includes(row.id) && validDish(row)) : { data: [] as Tables<'meals'>[], error: null };
  if (joined.error || !joined.data || joined.data.length !== ids.length) return failure();
  const byId = new Map(joined.data.map(row => [row.id, row]));
  return { data: result.data.map(row => ({ ...row, meal: row.meal_id === null ? null : byId.get(row.meal_id)! })), error: null };
}
