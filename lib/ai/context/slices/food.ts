// What the family eats: allergies and diets (the only medical detail a meal
// plan needs, projected by `meals.foodProfile`), likes and dislikes, what was
// on the table over the last week and what is already planned for the coming
// one, and the recipes on file. Weeks are family-local day keys.
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { foodProfile, getMealPlan, listRecipes } from '@/lib/services/meals';
import { ok } from '@/lib/services/types';
import type { SliceDefinition } from '../policy';
import { dayKeyLabel, joinNatural, shiftDayKey } from '../render';

const MAX_RECIPES = 20;

export type FoodSliceData = {
  household: { allergies: string[]; diet: string[]; dislikes: string[]; favorites: string[] };
  members: { name: string; allergies: string[]; diet: string[]; dislikes: string[]; favorites: string[] }[];
  recentMeals: { date: string; mealType: string; name: string }[];
  plannedMeals: { date: string; mealType: string; name: string }[];
  recipes: { id: string; name: string; category: string; totalMins: number | null; isFavorite: boolean; allergyFlags: string[] }[];
};

function fenceList(label: string, items: string[]): string {
  return joinNatural(items.map((item) => fenceUntrusted(label, item)));
}

export const foodSlice: SliceDefinition = {
  name: 'food',
  title: 'Food',
  async load(scope, env) {
    const lastWeekStart = shiftDayKey(env.todayKey, -7, env.tz);
    const [profile, lastWeek, thisWeek, recipes] = await Promise.all([
      foodProfile(scope),
      getMealPlan(scope, lastWeekStart),
      getMealPlan(scope, env.todayKey),
      listRecipes(scope, { limit: MAX_RECIPES }),
    ]);
    if (!profile.ok) return profile;
    if (!lastWeek.ok) return lastWeek;
    if (!thisWeek.ok) return thisWeek;
    if (!recipes.ok) return recipes;

    const named = (slots: typeof thisWeek.data.slots) => slots
      .filter((s): s is typeof s & { name: string } => Boolean(s.name))
      .map((s) => ({ date: s.date, mealType: s.mealType, name: s.name }));

    const data: FoodSliceData = {
      household: profile.data.household,
      members: profile.data.members
        .filter((m) => m.allergies.length || m.diet.length || m.dislikes.length || m.favorites.length)
        .map((m) => ({ name: m.name, allergies: m.allergies, diet: m.diet, dislikes: m.dislikes, favorites: m.favorites })),
      recentMeals: named(lastWeek.data.slots).filter((s) => s.date < env.todayKey),
      plannedMeals: named(thisWeek.data.slots),
      recipes: recipes.data.map((r) => ({
        id: r.id, name: r.name, category: r.category,
        totalMins: r.prepTimeMins === null && r.cookTimeMins === null ? null : (r.prepTimeMins ?? 0) + (r.cookTimeMins ?? 0),
        isFavorite: r.isFavorite, allergyFlags: r.allergyFlags,
      })),
    };

    const lines: string[] = [];
    if (data.household.allergies.length) lines.push(`- ALLERGIES (never serve): ${fenceList('allergy', data.household.allergies)}`);
    if (data.household.diet.length) lines.push(`- Diet: ${fenceList('diet', data.household.diet)}`);
    for (const m of data.members) {
      const bits: string[] = [];
      if (m.allergies.length) bits.push(`allergic to ${fenceList('allergy', m.allergies)}`);
      if (m.diet.length) bits.push(`diet ${fenceList('diet', m.diet)}`);
      if (m.dislikes.length) bits.push(`dislikes ${fenceList('dislike', m.dislikes)}`);
      if (m.favorites.length) bits.push(`likes ${fenceList('favorite', m.favorites)}`);
      lines.push(`- ${sanitizeUntrusted(m.name, 40)}: ${bits.join('; ')}`);
    }
    if (data.household.favorites.length && data.members.every((m) => m.favorites.length === 0)) {
      lines.push(`- Family favourites: ${fenceList('favorite', data.household.favorites)}`);
    }
    if (data.plannedMeals.length) {
      lines.push(`- Already planned: ${data.plannedMeals.map((m) => `${dayKeyLabel(m.date)} ${m.mealType} ${fenceUntrusted('meal', m.name)}`).join('; ')}`);
    } else {
      lines.push('- Nothing planned yet for the coming week.');
    }
    if (data.recentMeals.length) {
      lines.push(`- Last week's meals: ${joinNatural(data.recentMeals.map((m) => fenceUntrusted('meal', m.name)), 10)}`);
    }
    if (data.recipes.length) {
      lines.push(`- Recipes on file: ${joinNatural(data.recipes.map((r) => `${fenceUntrusted('recipe', r.name)}${r.totalMins ? ` (${r.totalMins} min)` : ''}${r.isFavorite ? ' ★' : ''}`), 12)}`);
    }

    const count = data.recipes.length + data.plannedMeals.length + data.recentMeals.length + data.members.length;
    return ok({ data, count, lines });
  },
};
