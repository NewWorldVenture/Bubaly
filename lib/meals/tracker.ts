// lib/meals/tracker.ts — pure, tested helpers for the Nutrition Tracker and
// Family Favorites pages. No Supabase/React.

import { dayKeyIn } from '@/lib/time/zoned';

export interface NutritionLike {
  member_id: string | null;
  logged_on: string; // YYYY-MM-DD
  meal: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  water_ml: number;
}

export interface DailyTotals {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  water_ml: number;
  count: number;
}

/**
 * The family's `YYYY-MM-DD` at `now`.
 *
 * The zone is required. This used to be `toISOString().slice(0, 10)` —
 * Greenwich's date — so from 17:00 in a Pacific evening the tracker's "today"
 * was tomorrow: breakfast and lunch fell out of today's totals, and dinner was
 * stored under the next day and summed with its breakfast. In a UTC+ zone the
 * morning landed on the day before. The screen asks `useFamilyClock()`.
 */
export function todayKey(timeZone: string, now: Date = new Date()): string {
  return dayKeyIn(now, timeZone);
}

/** Sum a day's nutrition for the whole family (or one member). */
export function dailyTotals(logs: NutritionLike[], date: string, memberId?: string | null): DailyTotals {
  const t: DailyTotals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, water_ml: 0, count: 0 };
  for (const l of logs) {
    if (l.logged_on !== date) continue;
    if (memberId !== undefined && memberId !== null && l.member_id !== memberId) continue;
    t.calories += l.calories || 0;
    t.protein_g += Number(l.protein_g) || 0;
    t.carbs_g += Number(l.carbs_g) || 0;
    t.fat_g += Number(l.fat_g) || 0;
    t.water_ml += l.water_ml || 0;
    t.count += 1;
  }
  t.protein_g = Math.round(t.protein_g * 10) / 10;
  t.carbs_g = Math.round(t.carbs_g * 10) / 10;
  t.fat_g = Math.round(t.fat_g * 10) / 10;
  return t;
}

export const MEAL_META: Record<string, { label: string; emoji: string; order: number }> = {
  breakfast: { label: 'Breakfast', emoji: '🍳', order: 0 },
  lunch: { label: 'Lunch', emoji: '🥪', order: 1 },
  dinner: { label: 'Dinner', emoji: '🍽️', order: 2 },
  snack: { label: 'Snack', emoji: '🍎', order: 3 },
};

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

/** Group a member/day's logs by meal, in meal order. */
export function groupByMeal<T extends { meal: string }>(logs: T[]): { meal: string; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const l of logs) { const a = map.get(l.meal) ?? []; a.push(l); map.set(l.meal, a); }
  return [...map.entries()]
    .sort((a, b) => (MEAL_META[a[0]]?.order ?? 9) - (MEAL_META[b[0]]?.order ?? 9))
    .map(([meal, items]) => ({ meal, items }));
}

export const FAVORITE_KIND_META: Record<string, { label: string; emoji: string }> = {
  recipe: { label: 'Recipe', emoji: '📖' },
  restaurant: { label: 'Restaurant', emoji: '🍴' },
  meal: { label: 'Meal', emoji: '🍽️' },
  snack: { label: 'Snack', emoji: '🍿' },
  drink: { label: 'Drink', emoji: '🥤' },
  other: { label: 'Other', emoji: '⭐' },
};
