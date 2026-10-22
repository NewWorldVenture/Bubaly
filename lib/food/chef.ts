// lib/food/chef.ts — the AI Family Chef. PURE prompt-building + parsing.
//
// The conversational chef that competitors don't have: it answers free-form
// requests ("plan dinners under $150", "we have soccer Tuesday, keep it quick",
// "use the leftover chicken") grounded in the family's REAL context — calendar
// busy-nights, pantry + expiring items, leftovers, dietary constraints, budget,
// and their own recipe library. The route gathers that context from Supabase;
// this module turns it into a grounded prompt and parses the reply.

import { parseModelJSON } from '@/lib/meals/nutrition';
import { allergenConflict, applySubstitutions, parseConstraintText } from '@/lib/meals/substitutions';
import { fenceUntrustedBlock, UNTRUSTED_CONTENT_RULE } from '@/lib/ai/safety/untrusted';

export interface ChefContext {
  /** Free-form user request. */
  request: string;
  /** Household dietary constraints / allergies (e.g. "vegetarian", "no peanuts"), as typed into the dialog. */
  dietary?: string[];
  /** Allergies the household has RECORDED (medical profiles, preference facts). Never served. */
  allergies?: string[];
  /** Diets the household has recorded ("vegetarian", "halal"). */
  diet?: string[];
  /** Foods someone in the household will not eat. */
  dislikes?: string[];
  /** Weekly food budget in dollars, if set. */
  weeklyBudget?: number | null;
  /** Dish names already in the family's library (prefer these). */
  recipeNames?: string[];
  /** Pantry items on hand. */
  pantryItems?: string[];
  /** Pantry items expiring soon — prefer using these. */
  expiringItems?: string[];
  /** Logged leftovers to reuse first. */
  leftovers?: string[];
  /** Busy evenings from the calendar (e.g. "Tue: soccer 6pm", "Thu: dance"). */
  busyNights?: string[];
  /** The planning window, e.g. "this week (Mon–Sun)". */
  window?: string;
}

export interface ChefMeal {
  day: string;            // e.g. "Mon" or a date
  mealType: string;       // breakfast | lunch | dinner | snack
  dish: string;
  reason: string;         // why this fits (busy night, uses leftovers, budget…)
  quick: boolean;         // <30 min / one-pot / crockpot
  usesExpiring: boolean;  // uses an expiring/leftover item
  estCostCents?: number | null;
}

export interface ChefReply {
  message: string;        // warm conversational summary
  meals: ChefMeal[];
  groceryAdds: string[];  // items to buy that aren't on hand
  tips: string[];
}

export function buildChefSystem(): string {
  return [
    'You are the Bubaly AI Family Chef — a warm, practical chef + dietitian + grocery manager rolled into one.',
    'You plan family meals using the REAL context provided: calendar busy-nights, pantry + expiring items, leftovers, dietary rules, budget, and the family\'s own recipes.',
    'Rules you must follow:',
    '- Honor every dietary constraint and allergy strictly. Never suggest a dish that violates one.',
    '- On busy nights, keep dinners quick (≤30 min, one-pot, crockpot, or air-fryer) and say so.',
    '- Prefer dishes that use up EXPIRING items and LEFTOVERS first to cut waste.',
    '- Prefer the family\'s own recipes when they fit; you may add a few new simple dishes for variety.',
    '- Respect the weekly budget if given; keep estimated total at or under it.',
    'Respond with ONLY a JSON object (no markdown, no prose) of this exact shape:',
    '{',
    '  "message": "1-2 warm sentences summarizing the plan",',
    '  "meals": [ { "day": "Mon", "mealType": "dinner", "dish": "Dish name", "reason": "short why", "quick": true, "usesExpiring": false, "estCostCents": 1200 } ],',
    '  "groceryAdds": ["item not on hand", "..."],',
    '  "tips": ["short practical tip"]',
    '}',
    // §44: the context lines below are calendar titles (an external feed can
    // set them), pantry and leftover names and recipe names — data, fenced.
    UNTRUSTED_CONTENT_RULE,
  ].join('\n');
}

export function buildChefUser(ctx: ChefContext): string {
  const lines: string[] = [];
  lines.push(`Request: ${ctx.request.trim()}`);
  if (ctx.window) lines.push(`Window: ${ctx.window}`);
  if (ctx.dietary?.length) lines.push(`Dietary rules (strict): ${ctx.dietary.join(', ')}`);
  if (ctx.weeklyBudget != null) lines.push(`Weekly food budget: $${ctx.weeklyBudget}`);
  // Row-derived context is fenced (§44); the request, window, dietary rules and
  // budget above are what the person asking typed into this dialog.
  // Recorded household facts are row data, so they are fenced like the rest;
  // the rule they carry is still strict.
  if (ctx.allergies?.length) lines.push(`Recorded household allergies (strict: never serve, never put on the grocery list): ${fenceUntrustedBlock('allergies', ctx.allergies.join(', '), 2_000)}`);
  if (ctx.diet?.length) lines.push(`Recorded household diets (strict): ${fenceUntrustedBlock('diets', ctx.diet.join(', '), 2_000)}`);
  if (ctx.dislikes?.length) lines.push(`Foods the family will not eat (avoid): ${fenceUntrustedBlock('dislikes', ctx.dislikes.join(', '), 2_000)}`);
  if (ctx.busyNights?.length) lines.push(`Busy evenings (keep dinner quick): ${fenceUntrustedBlock('busy_nights', ctx.busyNights.join('; '), 4_000)}`);
  if (ctx.leftovers?.length) lines.push(`Leftovers to use first: ${fenceUntrustedBlock('leftovers', ctx.leftovers.join(', '), 2_000)}`);
  if (ctx.expiringItems?.length) lines.push(`Pantry items expiring soon (use these): ${fenceUntrustedBlock('expiring_pantry', ctx.expiringItems.join(', '), 2_000)}`);
  if (ctx.pantryItems?.length) lines.push(`Other pantry items on hand: ${fenceUntrustedBlock('pantry', ctx.pantryItems.slice(0, 40).join(', '), 4_000)}`);
  if (ctx.recipeNames?.length) lines.push(`Family's saved recipes (prefer these): ${fenceUntrustedBlock('recipes', ctx.recipeNames.slice(0, 40).join(', '), 4_000)}`);
  lines.push('Plan the meals now, grounded in the above.');
  return lines.join('\n');
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}
function asStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Parse the model reply into a typed ChefReply, or null if unusable. */
export function parseChefReply(text: string): ChefReply | null {
  const raw = parseModelJSON(text);
  if (!raw) return null;

  const meals: ChefMeal[] = Array.isArray(raw.meals)
    ? raw.meals.slice(0, 28).map((m) => {
        const x = (m ?? {}) as Record<string, unknown>;
        const costNum = typeof x.estCostCents === 'number' ? Math.round(x.estCostCents) : null;
        return {
          day: asStr(x.day),
          mealType: asStr(x.mealType) || 'dinner',
          dish: asStr(x.dish),
          reason: asStr(x.reason),
          quick: asBool(x.quick),
          usesExpiring: asBool(x.usesExpiring),
          estCostCents: costNum != null && costNum >= 0 ? costNum : null,
        };
      }).filter((m) => m.dish)
    : [];

  const groceryAdds = Array.isArray(raw.groceryAdds)
    ? raw.groceryAdds.map(asStr).filter(Boolean).slice(0, 40)
    : [];
  const tips = Array.isArray(raw.tips) ? raw.tips.map(asStr).filter(Boolean).slice(0, 6) : [];
  const message = asStr(raw.message);

  if (meals.length === 0 && !message && groceryAdds.length === 0) return null;
  return { message: message || 'Here\'s a plan based on what your family has going on.', meals, groceryAdds, tips };
}

/**
 * Hold a plan to the household's recorded allergies: a dish that runs into one
 * is left out, and a grocery add is swapped for its safe stand-in or dropped
 * (the shopping list's own rule, `applySubstitutions`). `removed` counts what
 * the family will not see, so the reply can say something was left out.
 */
export function screenChefReply(reply: ChefReply, allergies: string[]): { reply: ChefReply; removed: number } {
  const terms = (allergies ?? []).flatMap((note) => parseConstraintText(note));
  if (terms.length === 0) return { reply, removed: 0 };
  const meals = reply.meals.filter((meal) => !allergenConflict(meal.dish, terms));
  const groceries = applySubstitutions(reply.groceryAdds.map((name) => ({ name })), { allergies: terms });
  const groceryAdds = groceries.items.map((item) => item.name);
  const dropped = groceries.substitutions.filter((swap) => swap.to === null).length;
  return { reply: { ...reply, meals, groceryAdds }, removed: reply.meals.length - meals.length + dropped };
}

/** Sum the estimated cost of a plan in cents (ignoring meals without an estimate). */
export function planCostCents(meals: ChefMeal[]): number {
  return meals.reduce((sum, m) => sum + (m.estCostCents ?? 0), 0);
}

/**
 * Deterministic, never-fabricated fallback when AI is off: builds a light plan
 * from the family's own recipes + leftovers + expiring items so the feature is
 * still useful. Never invents specific outside dishes.
 */
/**
 * The plan built without a model. `aiConfigured` decides the closing sentence:
 * telling a family to "connect an AI provider" is only true when none is
 * connected — when one is and it failed, the plan is still useful but the
 * advice is wrong.
 */
export function fallbackChefReply(ctx: ChefContext, opts: { aiConfigured?: boolean } = {}): ChefReply {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const pool = [
    ...(ctx.leftovers ?? []).map((l) => ({ dish: `Leftover ${l}`, reason: 'Use up a leftover first', usesExpiring: true })),
    ...(ctx.expiringItems ?? []).map((e) => ({ dish: `Something with ${e}`, reason: `Uses ${e} before it expires`, usesExpiring: true })),
    ...(ctx.recipeNames ?? []).map((r) => ({ dish: r, reason: 'From your saved recipes', usesExpiring: false })),
  ];
  const busyDays = new Set((ctx.busyNights ?? []).map((b) => b.slice(0, 3)));
  const meals: ChefMeal[] = [];
  for (let i = 0; i < Math.min(7, pool.length); i++) {
    const day = days[i];
    meals.push({
      day, mealType: 'dinner', dish: pool[i].dish, reason: pool[i].reason,
      quick: busyDays.has(day), usesExpiring: pool[i].usesExpiring, estCostCents: null,
    });
  }
  return {
    message: meals.length
      ? opts.aiConfigured
        ? "Here's a starter plan from what you already have. Ask again in a moment for a fully tailored week."
        : "Here's a starter plan from what you already have. Connect an AI provider for fully tailored weeks."
      : 'Add a few recipes or pantry items and I can build a plan around them.',
    meals,
    groceryAdds: [],
    tips: [
      ctx.busyNights?.length ? 'On busy nights, lean on the crockpot or air fryer.' : 'Batch-cook on the weekend to ease weeknights.',
      ctx.expiringItems?.length ? `Use ${ctx.expiringItems[0]} soon so it doesn't go to waste.` : 'Check the pantry before shopping to avoid doubles.',
    ],
  };
}
