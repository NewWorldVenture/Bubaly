// Meal-planning tools, plus the shopping-list step that follows a plan.
//
// `meals.planWeek` is `medium` risk although it only creates rows: it REPLACES
// whatever those slots held, and a family who spent Sunday evening planning
// does not want an "also plan dinners" request to overwrite it unasked. The
// approval card therefore says exactly which days are touched.
//
// `groceries.addFromMealPlan` lives here rather than in `groceries.ts`
// because it is the second half of the Plan Meals workflow (spec Workflow A:
// plan → grocery list → prep tasks); it is registered under the `shopping`
// domain so a family's shopping autonomy setting governs it.
//
// The legacy `create_meal_plan_entry` action used `meal_name` / `plan_date` /
// `meal_type`; those keys are accepted on `meals.setSlot` so stored approval
// payloads keep executing.
import 'server-only';
import { z } from 'zod';
import { addFromMealPlan } from '@/lib/services/groceries';
import { foodProfile, getMealPlan, listRecipes, planWeek, setSlot, type PlanSlot } from '@/lib/services/meals';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { defineTool, plural, type ToolDefinition } from './types';

const MEAL_TYPE_ENUM = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const ingredientInput = z.object({
  name: z.string(),
  quantity: z.string().nullish(),
  unit: z.string().nullish(),
});

const slotOutput = z.object({
  id: z.string(),
  date: z.string(),
  meal_type: z.string(),
  meal_id: z.string().nullable(),
  name: z.string().nullable(),
});

function toSlotOutput(slot: PlanSlot) {
  return { id: slot.id, date: slot.date, meal_type: slot.mealType, meal_id: slot.mealId, name: slot.name };
}

/** "Mon 7 Sep" for an approval card or a summary — plain dates, no timezone maths needed for a day key. */
function describeDayKey(key: string): string {
  const ms = Date.parse(`${key}T12:00:00Z`);
  if (!Number.isFinite(ms)) return key;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(ms));
}

const planEntryInput = z.object({
  date: z.string().describe('Calendar date, YYYY-MM-DD'),
  meal_type: z.enum(MEAL_TYPE_ENUM).nullish().describe('Defaults to dinner'),
  meal_name: z.string().nullish().describe('Dish name; reused from the library when it already exists'),
  meal_id: z.string().nullish().describe('An existing meal id, instead of a name'),
  ingredients: z.array(ingredientInput).nullish().describe('Only for a new dish; used to build the grocery list'),
});

export const mealTools: ToolDefinition[] = [
  defineTool({
    name: 'meals.getMealPlan',
    aliases: ['get_meal_plan', 'list_meal_plan'],
    description: "Read the week's meal plan starting on a given day.",
    domain: 'meal_planning',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ week_start: z.string().describe('YYYY-MM-DD of the first day; Monday by convention') }),
    output: z.object({
      week_start: z.string(),
      dates: z.array(z.string()),
      slots: z.array(slotOutput),
    }),
    summarize: (input, output) => (output.slots.length === 0
      ? `Nothing is planned for the week of ${describeDayKey(input.week_start)} yet`
      : `${plural(output.slots.length, 'meal')} planned for the week of ${describeDayKey(input.week_start)}`),
    execute: async (scope, input) => {
      const res = await getMealPlan(scope, input.week_start);
      if (!res.ok) return res;
      return ok({ week_start: res.data.weekStart, dates: res.data.dates, slots: res.data.slots.map(toSlotOutput) });
    },
  }),

  defineTool({
    name: 'meals.foodProfile',
    aliases: ['get_food_profile', 'get_dietary_preferences'],
    description: "Read everyone's allergies, dislikes, favourites and diets before planning any meal.",
    domain: 'meal_planning',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({}),
    output: z.object({
      members: z.array(z.object({
        member_id: z.string(),
        name: z.string(),
        allergies: z.array(z.string()),
        dislikes: z.array(z.string()),
        favorites: z.array(z.string()),
        diet: z.array(z.string()),
      })),
      household: z.object({
        allergies: z.array(z.string()),
        dislikes: z.array(z.string()),
        favorites: z.array(z.string()),
        diet: z.array(z.string()),
      }),
    }),
    summarize: (_input, output) => {
      const parts: string[] = [];
      if (output.household.allergies.length) parts.push(`allergies: ${output.household.allergies.join(', ')}`);
      if (output.household.dislikes.length) parts.push(`${plural(output.household.dislikes.length, 'dislike')}`);
      if (output.household.diet.length) parts.push(output.household.diet.join(', '));
      return parts.length ? `Checked food preferences — ${parts.join('; ')}` : 'Checked food preferences — no restrictions on file';
    },
    execute: async (scope) => {
      const res = await foodProfile(scope);
      if (!res.ok) return res;
      return ok({
        members: res.data.members.map((m) => ({
          member_id: m.memberId, name: m.name, allergies: m.allergies, dislikes: m.dislikes, favorites: m.favorites, diet: m.diet,
        })),
        household: res.data.household,
      });
    },
  }),

  defineTool({
    name: 'meals.listRecipes',
    aliases: ['list_recipes', 'search_recipes'],
    description: "List the family's saved recipes, optionally filtered by name or category.",
    domain: 'meal_planning',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      query: z.string().nullish(),
      category: z.string().nullish().describe('breakfast, lunch, dinner, snack, dessert, drink, side, appetizer, other'),
      favorites_only: z.boolean().nullish(),
      limit: z.number().int().nullish(),
    }),
    output: z.object({
      recipes: z.array(z.object({
        id: z.string(),
        name: z.string(),
        category: z.string(),
        servings: z.number(),
        total_minutes: z.number().nullable(),
        allergy_flags: z.array(z.string()),
        is_favorite: z.boolean(),
        ingredients: z.array(z.string()),
      })),
    }),
    summarize: (_input, output) => (output.recipes.length === 0
      ? 'No saved recipes match'
      : `Found ${plural(output.recipes.length, 'recipe')}, starting with ${output.recipes[0].name}`),
    execute: async (scope, input) => {
      const res = await listRecipes(scope, {
        query: input.query ?? null, category: input.category ?? null,
        favoritesOnly: input.favorites_only ?? false, limit: input.limit ?? undefined,
      });
      if (!res.ok) return res;
      return ok({
        recipes: res.data.map((r) => ({
          id: r.id, name: r.name, category: r.category, servings: r.servings,
          total_minutes: r.prepTimeMins == null && r.cookTimeMins == null ? null : (r.prepTimeMins ?? 0) + (r.cookTimeMins ?? 0),
          allergy_flags: r.allergyFlags, is_favorite: r.isFavorite,
          ingredients: r.ingredients.map((i) => i.name),
        })),
      });
    },
  }),

  defineTool({
    name: 'meals.setSlot',
    aliases: ['create_meal_plan_entry', 'plan_meal', 'set_meal'],
    description: 'Put one dish on the meal plan for a date, replacing what that slot held.',
    domain: 'meal_planning',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      date: z.string().nullish().describe('Calendar date, YYYY-MM-DD'),
      plan_date: z.string().nullish().describe('Legacy name for date'),
      meal_type: z.enum(MEAL_TYPE_ENUM).nullish().describe('Defaults to dinner'),
      meal_name: z.string().nullish(),
      name: z.string().nullish().describe('Alternative spelling of meal_name'),
      meal_id: z.string().nullish(),
      ingredients: z.array(ingredientInput).nullish(),
    }),
    output: slotOutput.extend({ replaced: z.boolean() }),
    idempotencyFrom: (input) => {
      const date = input.date ?? input.plan_date ?? '';
      const dish = (input.meal_id ?? input.meal_name ?? input.name ?? '').trim().toLowerCase();
      return date && dish ? `meals.setSlot:${date}:${input.meal_type ?? 'dinner'}:${dish}` : null;
    },
    summarize: (_input, output) => `Planned ${output.name ?? 'a meal'} for ${output.meal_type} on ${describeDayKey(output.date)}${output.replaced ? ' (replacing what was there)' : ''}`,
    consequences: (input) => {
      const date = input.date ?? input.plan_date ?? 'that day';
      return [`Replaces whatever is planned for ${input.meal_type ?? 'dinner'} on ${date}.`];
    },
    resource: (output) => ({ table: 'meal_plans', id: output.id }),
    execute: async (scope, input) => {
      const date = (input.date ?? input.plan_date ?? '').trim();
      if (!DAY_KEY.test(date)) return fail('A meal needs a date like 2026-09-07.', { code: SERVICE_CODES.invalidInput });
      const mealName = (input.meal_name ?? input.name ?? '').trim();
      if (!mealName && !input.meal_id) return fail('Which dish should go on the plan?', { code: SERVICE_CODES.invalidInput });

      const res = await setSlot(scope, {
        date,
        mealType: input.meal_type ?? 'dinner',
        mealId: input.meal_id ?? null,
        mealName: mealName || null,
        ingredients: (input.ingredients ?? []).map((i) => ({ name: i.name, quantity: i.quantity ?? null, unit: i.unit ?? null })),
      });
      if (!res.ok) return res;
      return ok({ ...toSlotOutput(res.data), replaced: res.data.replaced });
    },
    verify: async (scope, _input, output) => {
      const { data, error } = await scope.db
        .from('meal_plans')
        .select('id')
        .eq('family_id', scope.familyId)
        .eq('id', output.id)
        .maybeSingle();
      if (error) {
        console.error('[tool:meals.setSlot] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the meal was planned.'), { code: SERVICE_CODES.db });
      }
      const found = Boolean(data);
      return ok({ verified: found, detail: found ? `${output.name ?? 'The meal'} is on the plan.` : 'The meal is not on the plan.' });
    },
  }),

  defineTool({
    name: 'meals.planWeek',
    aliases: ['plan_week_meals', 'create_meal_plan'],
    description: 'Fill several meal slots at once, replacing whatever those slots held. Plan the whole week in one call.',
    domain: 'meal_planning',
    capability: 'create',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      entries: z.array(planEntryInput).describe('One entry per slot; a slot given twice is rejected'),
    }),
    output: z.object({
      planned: z.array(slotOutput),
      replaced: z.number().describe('Slots that held a different dish before'),
      created_meals: z.number().describe('New dishes added to the library'),
    }),
    idempotencyFrom: (input) => {
      const slots = input.entries
        .map((e) => `${e.date}:${e.meal_type ?? 'dinner'}:${(e.meal_id ?? e.meal_name ?? '').trim().toLowerCase()}`)
        .sort();
      return slots.length ? `meals.planWeek:${slots.join('|')}` : null;
    },
    summarize: (_input, output) => {
      if (output.planned.length === 0) return 'Nothing was planned';
      const dates = [...new Set(output.planned.map((p) => p.date))].sort();
      const span = dates.length === 1 ? describeDayKey(dates[0]) : `${describeDayKey(dates[0])} – ${describeDayKey(dates[dates.length - 1])}`;
      const first = output.planned.slice(0, 3).map((p) => p.name).filter(Boolean).join(', ');
      return `Planned ${plural(output.planned.length, 'meal')} for ${span}${first ? ` — ${first}${output.planned.length > 3 ? '…' : ''}` : ''}`;
    },
    consequences: (input) => {
      const entries = Array.isArray(input?.entries) ? input.entries : [];
      const dates = [...new Set(entries.map((e) => e.date))].sort();
      const types = [...new Set(entries.map((e) => e.meal_type ?? 'dinner'))];
      const out = [`Replaces the ${types.join('/')} plan on ${plural(dates.length, 'day')}${dates.length ? ` (${dates.slice(0, 7).map(describeDayKey).join(', ')})` : ''}.`];
      if (entries.some((e) => !e.meal_id && e.meal_name)) out.push('Adds any new dishes to the meal library.');
      return out;
    },
    execute: async (scope, input) => {
      const res = await planWeek(scope, input.entries.map((e) => ({
        date: e.date,
        mealType: e.meal_type ?? 'dinner',
        mealId: e.meal_id ?? null,
        mealName: e.meal_name ?? null,
        ingredients: (e.ingredients ?? []).map((i) => ({ name: i.name, quantity: i.quantity ?? null, unit: i.unit ?? null })),
      })));
      if (!res.ok) return res;
      return ok({ planned: res.data.planned.map(toSlotOutput), replaced: res.data.replaced, created_meals: res.data.createdMeals });
    },
    verify: async (scope, _input, output) => {
      if (output.planned.length === 0) return ok({ verified: true, detail: 'Nothing needed planning.' });
      const { data, error } = await scope.db
        .from('meal_plans')
        .select('id')
        .eq('family_id', scope.familyId)
        .in('id', output.planned.map((p) => p.id));
      if (error) {
        console.error('[tool:meals.planWeek] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the plan was saved.'), { code: SERVICE_CODES.db });
      }
      const found = (data ?? []).length;
      return ok({ verified: found === output.planned.length, detail: `${found} of ${output.planned.length} meals are on the plan.` });
    },
  }),

  defineTool({
    name: 'groceries.addFromMealPlan',
    aliases: ['add_groceries_from_meal_plan', 'grocery_list_from_meal_plan'],
    description: "Add what the planned meals need to the shopping list, leaving out what is in the pantry and what is already on the list.",
    domain: 'shopping',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      from: z.string().nullish().describe('First planned day, YYYY-MM-DD; defaults to today'),
      to: z.string().nullish().describe('Last planned day, YYYY-MM-DD; defaults to six days after `from`'),
      week_start: z.string().nullish().describe('Shortcut for a Monday–Sunday week'),
      list_id: z.string().nullish(),
    }),
    output: z.object({
      list_id: z.string(),
      added: z.array(z.object({ id: z.string(), name: z.string(), quantity: z.string().nullable(), category: z.string().nullable() })),
      skipped: z.array(z.string()).describe('Already on the list'),
      in_pantry: z.array(z.string()).describe('Already in the pantry'),
      meals: z.array(z.object({ id: z.string(), name: z.string(), date: z.string() })),
    }),
    idempotencyFrom: (input) => {
      const from = input.week_start ?? input.from ?? '';
      const to = input.week_start ? '' : input.to ?? '';
      return from || to ? `groceries.addFromMealPlan:${from}:${to}` : null;
    },
    summarize: (_input, output) => {
      const base = output.added.length === 0
        ? `Nothing to buy — everything for ${plural(output.meals.length, 'planned meal')} is covered`
        : `Added ${plural(output.added.length, 'item')} to the shopping list for ${plural(output.meals.length, 'planned meal')}`;
      const notes: string[] = [];
      if (output.skipped.length) notes.push(`${output.skipped.length} already on it`);
      if (output.in_pantry.length) notes.push(`${output.in_pantry.length} in the pantry`);
      return notes.length ? `${base} (${notes.join(', ')})` : base;
    },
    execute: async (scope, input) => {
      let from = input.from ?? null;
      let to = input.to ?? null;
      if (input.week_start) {
        if (!DAY_KEY.test(input.week_start)) return fail('A week start must look like 2026-09-07.', { code: SERVICE_CODES.invalidInput });
        from = input.week_start;
        const ms = Date.parse(`${input.week_start}T00:00:00Z`);
        to = new Date(ms + 6 * 86_400_000).toISOString().slice(0, 10);
      }
      const res = await addFromMealPlan(scope, { from, to, listId: input.list_id ?? null });
      if (!res.ok) return res;
      return ok({
        list_id: res.data.listId,
        added: res.data.added.map((row) => ({ id: row.id, name: row.name, quantity: row.quantity, category: row.category })),
        skipped: res.data.skipped,
        in_pantry: res.data.inPantry,
        meals: res.data.meals,
      });
    },
    verify: async (scope, _input, output) => {
      if (output.added.length === 0) return ok({ verified: true, detail: 'Nothing needed adding.' });
      const { data, error } = await scope.db
        .from('grocery_items')
        .select('id')
        .eq('family_id', scope.familyId)
        .in('id', output.added.map((item) => item.id));
      if (error) {
        console.error('[tool:groceries.addFromMealPlan] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the items were added.'), { code: SERVICE_CODES.db });
      }
      const found = (data ?? []).length;
      return ok({ verified: found === output.added.length, detail: `${found} of ${output.added.length} items are on the list.` });
    },
  }),
];
