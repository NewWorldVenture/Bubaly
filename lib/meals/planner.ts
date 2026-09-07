// lib/meals/planner.ts — pure helpers for the AI Meal Planner.
// The route gathers the family's meal library, recipes, votes, dietary flags,
// and soon-to-expire pantry items, asks the model to fill a week, then maps the
// answer back to real rows. All deterministic logic lives here for testing.

import type { MealType } from '@/lib/database.types';
import { parseModelJSON } from '@/lib/meals/nutrition';
import { quickMealHint, type BusyNight } from '@/lib/meals/week-context';

export const PLAN_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export interface Candidate {
  ref: string;            // "meal:<id>" or "recipe:<id>"
  name: string;
  type: string;           // meal_type / recipe category
  flags: string[];        // dietary / allergy flags
  votes: number;          // family vote score (higher = more loved)
}

export interface MealRow { id: string; name: string; meal_type: string }
export interface RecipeRow { id: string; name: string; category: string; allergy_flags?: string[] | null }

/** Build the candidate dish list the model chooses from. Recipes carry their
 *  allergy flags; `voteScore` maps a dish name/id → its family vote tally. */
export function buildCandidates(
  meals: MealRow[],
  recipes: RecipeRow[],
  voteScore: Record<string, number> = {},
): Candidate[] {
  const fromMeals = meals.map((m) => ({
    ref: `meal:${m.id}`, name: m.name, type: m.meal_type, flags: [] as string[],
    votes: voteScore[`meal:${m.id}`] ?? 0,
  }));
  const fromRecipes = recipes.map((r) => ({
    ref: `recipe:${r.id}`, name: r.name, type: r.category, flags: r.allergy_flags ?? [],
    votes: voteScore[`recipe:${r.id}`] ?? 0,
  }));
  // Most-loved first so the model (and any fallback) leans on family favorites.
  return [...fromMeals, ...fromRecipes].sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
}

export interface PlannerRequest {
  weekStart: string;            // YYYY-MM-DD (Monday)
  mealTypes: MealType[];        // which rows to fill (e.g. just ['dinner'])
  candidates: Candidate[];
  dietary?: string[];           // household dietary constraints
  expiring?: string[];          // pantry items to use up
  /**
   * Nights the family's own calendar says they will not be cooking from
   * scratch, with the events that made them busy. Built by
   * `lib/meals/week-context.ts` from `calendar_events`, so it is a fact read
   * from rows rather than a guess about a Tuesday.
   */
  busyNights?: BusyNight[];
  avoidRepeats?: boolean;
  notes?: string;
}

export function buildPlannerSystem(): string {
  return [
    'You are a practical family meal planner. Fill a 7-day plan for the requested meal slots.',
    'Prefer dishes from the provided CANDIDATES list (reference them by their exact ref id).',
    'You may also invent a small number of new, simple dishes when variety helps — mark those with ref "new".',
    'Honor every dietary constraint strictly. When pantry items are expiring, prefer dishes that use them and say so.',
    'On any night listed as busy, choose something that is ready in about 20 minutes, cooks in one pan, or can be made ahead — and say which in the reason.',
    'Avoid repeating the same dish twice in the week unless told otherwise.',
    'Respond with ONLY a JSON object of this exact shape (no prose, no markdown fences):',
    '{ "assignments": [ { "date": "YYYY-MM-DD", "meal_type": "dinner", "ref": "recipe:<id>" | "meal:<id>" | "new", "name": "Dish name", "reason": "short why" } ] }',
  ].join('\n');
}

/** Compose the user message describing the slots + candidates + constraints. */
export function buildPlannerUser(req: PlannerRequest): string {
  const dates = weekDates(req.weekStart);
  const lines: string[] = [];
  lines.push(`Week starting ${req.weekStart} (Mon–Sun: ${dates.join(', ')}).`);
  lines.push(`Fill these meal slots each day: ${req.mealTypes.join(', ')}.`);
  if (req.dietary?.length) lines.push(`Dietary constraints (strict): ${req.dietary.join(', ')}.`);
  if (req.expiring?.length) lines.push(`Use up these expiring pantry items if you can: ${req.expiring.join(', ')}.`);
  // The calendar's own answer to "which nights are we not cooking?". Absent
  // when the week is clear, so the model reads a constraint or nothing at all
  // rather than a negation it has to parse.
  const busy = quickMealHint(req.busyNights ?? []);
  if (busy) lines.push(busy);
  lines.push(`Avoid repeats: ${req.avoidRepeats === false ? 'no' : 'yes'}.`);
  if (req.notes) lines.push(`Family notes: ${req.notes}`);
  lines.push('');
  lines.push('CANDIDATES:');
  if (req.candidates.length === 0) {
    lines.push('(none saved yet — invent simple, family-friendly dishes, all ref "new")');
  } else {
    for (const c of req.candidates.slice(0, 60)) {
      lines.push(`- ${c.ref} | ${c.name} | ${c.type}${c.flags.length ? ` | ${c.flags.join(',')}` : ''}${c.votes ? ` | ♥${c.votes}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Monday→Sunday ISO dates for a week-start. */
export function weekDates(weekStart: string): string[] {
  const base = new Date(`${weekStart}T00:00:00`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

export interface PlanAssignment {
  date: string;
  meal_type: MealType;
  ref: string | null;       // candidate ref, or null for a brand-new dish
  name: string;
  reason?: string;
}

/**
 * Parse the model's JSON into validated assignments. Drops anything that isn't
 * for a requested date+slot or references an unknown candidate. "new" dishes
 * keep ref=null so the route can create a meal row for them.
 */
export function parsePlan(text: string, req: PlannerRequest): PlanAssignment[] {
  const parsed = parseModelJSON(text);
  const rows = Array.isArray((parsed as { assignments?: unknown })?.assignments)
    ? (parsed as { assignments: unknown[] }).assignments
    : [];
  const validDates = new Set(weekDates(req.weekStart));
  const validTypes = new Set(req.mealTypes);
  const validRefs = new Set(req.candidates.map((c) => c.ref));
  const seen = new Set<string>();
  const out: PlanAssignment[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const date = String(o.date ?? '');
    const meal_type = String(o.meal_type ?? '') as MealType;
    const name = String(o.name ?? '').trim();
    let ref: string | null = typeof o.ref === 'string' ? o.ref : null;
    if (ref === 'new' || ref === '') ref = null;
    if (!validDates.has(date) || !validTypes.has(meal_type)) continue;
    if (ref && !validRefs.has(ref)) ref = null;          // unknown ref → treat as new
    if (!name && !ref) continue;
    const slot = `${date}__${meal_type}`;
    if (seen.has(slot)) continue;                        // one dish per slot
    seen.add(slot);
    out.push({ date, meal_type, ref, name, reason: typeof o.reason === 'string' ? o.reason : undefined });
  }
  return out;
}

/** Split a candidate ref back into its table + id. */
export function refParts(ref: string | null): { table: 'meals' | 'recipes'; id: string } | null {
  if (!ref) return null;
  const [kind, id] = ref.split(':');
  if (!id) return null;
  if (kind === 'meal') return { table: 'meals', id };
  if (kind === 'recipe') return { table: 'recipes', id };
  return null;
}
